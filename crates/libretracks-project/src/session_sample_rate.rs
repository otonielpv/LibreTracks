//! Deciding which sample rate the engine should run a session at.
//!
//! The engine has ONE working sample rate, so any source file that doesn't
//! match it is decoded, resampled and written to a PCM cache before it can
//! play. That conversion is the expensive path: measured over 25 real 44.1k
//! stems, an engine at 44.1k streamed them natively in 2 ms, while an engine at
//! 48k spent 13.9 s and wrote 3.6 GB to disk. Same audio, same machine — the
//! only difference was whether the rates matched.
//!
//! So we pick the engine rate that leaves the LEAST audio needing conversion,
//! the way Ableton Live and Reaper align the interface to the project. With a
//! set that mixes rates there is no free answer — some file always converts —
//! and the best available outcome is to convert the smaller pile.
//!
//! Weighting is by BYTES, not by file count: one long 44.1k song outweighs
//! three short 48k ones, and bytes are what the conversion actually has to
//! chew through.

use std::collections::HashMap;
use std::path::Path;

use symphonia::core::{formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions,
                      probe::Hint};

/// How much audio sits at each sample rate in a session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionSampleRateProfile {
    /// Total bytes of source audio per sample rate.
    pub bytes_by_rate: HashMap<u32, u64>,
    /// Files whose sample rate could not be read (missing, unreadable or an
    /// unsupported container). Counted separately so callers can tell "no
    /// mismatch" apart from "we couldn't tell".
    pub unreadable_files: usize,
}

impl SessionSampleRateProfile {
    pub fn is_empty(&self) -> bool {
        self.bytes_by_rate.is_empty()
    }

    /// Every rate present, most audio first. Ties break toward the lower rate
    /// so the result is deterministic rather than hash-order dependent.
    pub fn rates_by_weight(&self) -> Vec<(u32, u64)> {
        let mut rates: Vec<(u32, u64)> = self
            .bytes_by_rate
            .iter()
            .map(|(rate, bytes)| (*rate, *bytes))
            .collect();
        rates.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
        rates
    }

    /// The rate that covers the most audio, if any.
    pub fn dominant_rate(&self) -> Option<u32> {
        self.rates_by_weight().first().map(|(rate, _)| *rate)
    }

    /// Bytes that would need converting if the engine ran at `engine_rate`.
    pub fn bytes_needing_conversion(&self, engine_rate: u32) -> u64 {
        self.bytes_by_rate
            .iter()
            .filter(|(rate, _)| **rate != engine_rate)
            .map(|(_, bytes)| *bytes)
            .sum()
    }
}

/// Read a file's sample rate from its header, without decoding it.
///
/// Symphonia's probe only parses container/codec metadata, so this stays cheap
/// even for a multi-hundred-MB stem — which matters because we call it once per
/// file in the session before anything plays.
pub fn read_sample_rate(path: impl AsRef<Path>) -> Option<u32> {
    let path = path.as_ref();
    let file = std::fs::File::open(path).ok()?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            // No seek index: we only want the header, and building an index
            // would read the whole file.
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    probed
        .format
        .tracks()
        .iter()
        .find_map(|track| track.codec_params.sample_rate)
        .filter(|rate| *rate > 0)
}

/// Build the sample-rate profile for a set of source audio files.
///
/// Probing runs in parallel: this sits on the session-open path (under the
/// session lock), and a multitrack can be dozens of files. Each probe is a
/// couple of header reads, so the work is I/O-bound and parallelises cleanly.
pub fn profile_sample_rates<P: AsRef<Path> + Sync>(
    audio_files: impl IntoIterator<Item = P>,
) -> SessionSampleRateProfile {
    use rayon::prelude::*;

    let paths: Vec<P> = audio_files.into_iter().collect();
    let probed: Vec<Option<(u32, u64)>> = paths
        .par_iter()
        .map(|path| {
            let path = path.as_ref();
            let rate = read_sample_rate(path)?;
            // Size stands in for "how much work converting this costs". A file
            // we can read the header of but not stat is still worth counting,
            // so fall back to a nominal 1 byte rather than dropping it.
            let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(1);
            Some((rate, bytes))
        })
        .collect();

    let mut profile = SessionSampleRateProfile::default();
    for entry in probed {
        match entry {
            Some((rate, bytes)) => *profile.bytes_by_rate.entry(rate).or_insert(0) += bytes,
            None => profile.unreadable_files += 1,
        }
    }
    profile
}

/// What the engine should do about a session's sample rate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SampleRatePlan {
    /// Nothing to do: the engine rate already covers every file, or we have no
    /// usable information to act on.
    KeepCurrent,
    /// Reopen the device at `target_rate`, avoiding `bytes_saved` of decode +
    /// resample + cache writing.
    SwitchDevice { target_rate: u32, bytes_saved: u64 },
    /// The best rate isn't available on this device, so conversion is
    /// unavoidable — tell the user what it will cost instead of freezing
    /// silently. `preferred_rate` is what the audio wanted.
    ConvertUnavoidable {
        preferred_rate: u32,
        bytes_to_convert: u64,
    },
}

/// Decide the sample rate for a session.
///
/// `device_supported_rates` empty means "unknown" (we only learn a device's
/// rates once it is open, and rate-lying backends report none) — never "this
/// device supports nothing". In that case we don't try to switch: acting on a
/// guess could reopen the device at a rate it silently resamples, which is the
/// playback-speed bug all over again.
///
/// `user_pinned_rate` is a rate the user chose by hand in Settings. That's a
/// deliberate decision — an interface that only behaves at 48k, say — so it
/// always wins and we never move it.
pub fn plan_sample_rate(
    profile: &SessionSampleRateProfile,
    engine_rate: u32,
    device_supported_rates: &[u32],
    user_pinned_rate: Option<u32>,
) -> SampleRatePlan {
    if profile.is_empty() || engine_rate == 0 {
        return SampleRatePlan::KeepCurrent;
    }
    let Some(target_rate) = profile.dominant_rate() else {
        return SampleRatePlan::KeepCurrent;
    };
    if target_rate == engine_rate {
        return SampleRatePlan::KeepCurrent;
    }

    let bytes_to_convert = profile.bytes_needing_conversion(engine_rate);
    if bytes_to_convert == 0 {
        return SampleRatePlan::KeepCurrent;
    }

    // A hand-picked rate is honoured even when it costs conversion, but the
    // user still deserves to know what that costs.
    if let Some(pinned) = user_pinned_rate {
        if pinned == engine_rate {
            return SampleRatePlan::ConvertUnavoidable {
                preferred_rate: target_rate,
                bytes_to_convert,
            };
        }
    }

    if device_supported_rates.is_empty() || !device_supported_rates.contains(&target_rate) {
        return SampleRatePlan::ConvertUnavoidable {
            preferred_rate: target_rate,
            bytes_to_convert,
        };
    }

    // Switching only helps if it converts less than staying put does.
    let bytes_after_switch = profile.bytes_needing_conversion(target_rate);
    if bytes_after_switch >= bytes_to_convert {
        return SampleRatePlan::KeepCurrent;
    }
    SampleRatePlan::SwitchDevice {
        target_rate,
        bytes_saved: bytes_to_convert - bytes_after_switch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn profile(entries: &[(u32, u64)]) -> SessionSampleRateProfile {
        let mut result = SessionSampleRateProfile::default();
        for (rate, bytes) in entries {
            *result.bytes_by_rate.entry(*rate).or_insert(0) += *bytes;
        }
        result
    }

    #[test]
    fn switches_to_the_rate_the_whole_session_shares() {
        // The common case: a 44.1k multitrack on a device Windows left at 48k.
        let session = profile(&[(44_100, 5_000_000_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], None);
        assert_eq!(
            plan,
            SampleRatePlan::SwitchDevice {
                target_rate: 44_100,
                bytes_saved: 5_000_000_000,
            }
        );
    }

    #[test]
    fn keeps_current_rate_when_everything_already_matches() {
        let session = profile(&[(48_000, 900)]);
        assert_eq!(
            plan_sample_rate(&session, 48_000, &[44_100, 48_000], None),
            SampleRatePlan::KeepCurrent
        );
    }

    #[test]
    fn mixed_session_switches_to_whichever_rate_holds_more_audio() {
        // 20 songs at 44.1k against 2 at 48k: converting the 2 beats converting
        // the 20. No rate avoids conversion entirely here.
        let session = profile(&[(44_100, 20_000), (48_000, 2_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], None);
        assert_eq!(
            plan,
            SampleRatePlan::SwitchDevice {
                target_rate: 44_100,
                bytes_saved: 18_000,
            }
        );
    }

    #[test]
    fn weighs_by_bytes_not_by_file_count() {
        // Three small 48k files against one big 44.1k one: the byte weight has
        // to win, because bytes are what conversion actually processes.
        let session = profile(&[(48_000, 10), (48_000, 10), (48_000, 10), (44_100, 5_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], None);
        assert_eq!(
            plan,
            SampleRatePlan::SwitchDevice {
                target_rate: 44_100,
                bytes_saved: 4_970,
            }
        );
    }

    #[test]
    fn reports_unavoidable_conversion_when_the_device_lacks_the_rate() {
        let session = profile(&[(88_200, 4_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], None);
        assert_eq!(
            plan,
            SampleRatePlan::ConvertUnavoidable {
                preferred_rate: 88_200,
                bytes_to_convert: 4_000,
            }
        );
    }

    #[test]
    fn unknown_device_rates_never_trigger_a_switch() {
        // Empty means "we couldn't ask", not "supports nothing". Switching on a
        // guess risks reopening at a rate the backend silently resamples.
        let session = profile(&[(44_100, 4_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[], None);
        assert_eq!(
            plan,
            SampleRatePlan::ConvertUnavoidable {
                preferred_rate: 44_100,
                bytes_to_convert: 4_000,
            }
        );
    }

    #[test]
    fn a_hand_picked_rate_is_never_overridden() {
        let session = profile(&[(44_100, 4_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], Some(48_000));
        assert_eq!(
            plan,
            SampleRatePlan::ConvertUnavoidable {
                preferred_rate: 44_100,
                bytes_to_convert: 4_000,
            }
        );
    }

    #[test]
    fn a_hand_picked_rate_elsewhere_does_not_block_the_switch() {
        // The pin only protects the rate the engine is actually running at; a
        // stale pin for some other device shouldn't freeze this decision.
        let session = profile(&[(44_100, 4_000)]);
        let plan = plan_sample_rate(&session, 48_000, &[44_100, 48_000], Some(96_000));
        assert_eq!(
            plan,
            SampleRatePlan::SwitchDevice {
                target_rate: 44_100,
                bytes_saved: 4_000,
            }
        );
    }

    #[test]
    fn a_device_locked_to_one_rate_reports_conversion_rather_than_switching() {
        // The real shape of the dev machine this was verified on: the output
        // device advertises 44100 ONLY. A 48k session cannot be aligned, so the
        // correct answer is to tell the user what the conversion costs instead
        // of silently doing nothing (which is what an empty/unknown rate list
        // produces, and is indistinguishable to the user).
        let session = profile(&[(48_000, 7_000)]);
        let plan = plan_sample_rate(&session, 44_100, &[44_100], None);
        assert_eq!(
            plan,
            SampleRatePlan::ConvertUnavoidable {
                preferred_rate: 48_000,
                bytes_to_convert: 7_000,
            }
        );
    }

    #[test]
    fn an_empty_session_asks_for_nothing() {
        assert_eq!(
            plan_sample_rate(&SessionSampleRateProfile::default(), 48_000, &[44_100], None),
            SampleRatePlan::KeepCurrent
        );
    }

    #[test]
    fn ties_resolve_deterministically_toward_the_lower_rate() {
        let session = profile(&[(48_000, 1_000), (44_100, 1_000)]);
        // Equal weight either way, so switching saves nothing and we stay put.
        assert_eq!(
            plan_sample_rate(&session, 48_000, &[44_100, 48_000], None),
            SampleRatePlan::KeepCurrent
        );
        // The ordering itself must not depend on HashMap iteration order.
        assert_eq!(session.rates_by_weight()[0].0, 44_100);
    }

    fn write_wav(path: &Path, sample_rate: u32, frames: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav writer");
        for _ in 0..frames {
            writer.write_sample(0_i16).expect("write sample");
        }
        writer.finalize().expect("finalize");
    }

    #[test]
    fn profiles_real_files_end_to_end_and_picks_the_heavier_rate() {
        // Guards the whole chain against real headers: probing reads the rate
        // without decoding, sizes come from the filesystem, and the plan falls
        // out of both. The 44.1k file is deliberately the longer one.
        let dir = tempfile::tempdir().expect("tempdir");
        let big_441 = dir.path().join("long-44100.wav");
        let small_48 = dir.path().join("short-48000.wav");
        write_wav(&big_441, 44_100, 20_000);
        write_wav(&small_48, 48_000, 500);

        assert_eq!(read_sample_rate(&big_441), Some(44_100));
        assert_eq!(read_sample_rate(&small_48), Some(48_000));

        let profile = profile_sample_rates([&big_441, &small_48]);
        assert_eq!(profile.unreadable_files, 0);
        assert_eq!(profile.bytes_by_rate.len(), 2);
        assert_eq!(profile.dominant_rate(), Some(44_100));

        let plan = plan_sample_rate(&profile, 48_000, &[44_100, 48_000], None);
        match plan {
            SampleRatePlan::SwitchDevice { target_rate, .. } => assert_eq!(target_rate, 44_100),
            other => panic!("expected a switch to 44.1k, got {other:?}"),
        }
    }

    #[test]
    fn unreadable_files_are_counted_not_silently_dropped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bogus = dir.path().join("not-audio.wav");
        std::fs::write(&bogus, b"this is not a wav file").expect("write");
        let profile = profile_sample_rates([bogus]);
        assert_eq!(profile.unreadable_files, 1);
        assert!(profile.is_empty());
        // With nothing readable there is no basis for a decision.
        assert_eq!(
            plan_sample_rate(&profile, 48_000, &[44_100, 48_000], None),
            SampleRatePlan::KeepCurrent
        );
    }
}
