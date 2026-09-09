//! Decoding audio once, at export time, so the playback device never has to.
//!
//! A "Full" package ships the original files, which means every device that
//! opens it repeats the same work: decode each source, resample it to the
//! engine's rate, and write the result to a PCM cache. On a desktop that costs
//! seconds. On a phone it is the dominant cost of opening a session — 36 stems
//! took roughly 36 minutes to prepare on an Oppo CPH1931, and tracks that had
//! not got there yet simply played silence.
//!
//! An "Optimized" package does that work once, on the machine that has the
//! CPU for it, and ships the result: 16-bit PCM WAV at a declared sample rate.
//! The receiving device reads and plays. Same format the engine already uses
//! for its own cache (see `cache_sample_format()` in source_manager.cpp), for
//! the same reason: half the size and I/O of float32, and int16 is plenty for
//! playback.
//!
//! The trade is honest and worth stating: a prepared package is BIGGER than the
//! original (compressed sources become PCM), so it moves cost from the phone's
//! CPU to the transfer. See docs/plans/android-low-end/06-export-optimizado.md.

use std::fs;
use std::io;
use std::path::Path;

use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::song_store::ProjectError;

/// What a prepared file turned out to be, for the manifest and for the caller's
/// progress reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedAudioInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
}

/// Decode `source` and write it to `destination` as 16-bit PCM WAV at its own
/// sample rate.
///
/// Deliberately does NOT resample: the package declares the rate it carries and
/// the importing device matches its output to it (the engine already does this
/// via `align_engine_sample_rate_to_session`). Resampling here would pick a
/// rate for a device we know nothing about, and a wrong guess costs the
/// receiver exactly the conversion this feature exists to avoid.
pub fn prepare_audio_to_wav(
    source: &Path,
    destination: &Path,
) -> Result<PreparedAudioInfo, ProjectError> {
    let file = fs::File::open(source)?;
    let mut hint = Hint::new();
    if let Some(extension) = source.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            MediaSourceStream::new(Box::new(file), Default::default()),
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| ProjectError::UnsupportedAudioFormat {
            path: source.to_path_buf(),
        })?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| ProjectError::UnsupportedAudioFormat {
            path: source.to_path_buf(),
        })?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let sample_rate = codec_params.sample_rate.ok_or_else(|| {
        ProjectError::AudioDecode(format!("missing sample rate for {}", source.display()))
    })?;
    let channels = codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .unwrap_or(1)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(destination, spec)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;

    let mut frames: u64 = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // A damaged packet mid-file: skip it rather than abandoning the
            // export, which is what the waveform decoder does too.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };

        let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buffer.copy_interleaved_ref(decoded);

        let channel_count = usize::from(channels);
        for frame in sample_buffer.samples().chunks(channel_count) {
            for channel in 0..channel_count {
                let sample = frame.get(channel).copied().unwrap_or(0.0).clamp(-1.0, 1.0);
                // Symmetric scaling: i16::MAX rather than 32768, so +1.0 maps to
                // full scale without wrapping to a large negative value.
                let quantised = (sample * f32::from(i16::MAX)).round() as i16;
                writer
                    .write_sample(quantised)
                    .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
            }
            frames += 1;
        }
    }

    writer
        .finalize()
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;

    Ok(PreparedAudioInfo {
        sample_rate,
        channels,
        frames,
    })
}

/// The name a prepared source takes inside the package: the original stem with
/// a `.wav` extension, since the payload is now PCM whatever it started as.
pub fn prepared_relative_path(original_relative: &str) -> String {
    match original_relative.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => format!("{stem}.wav"),
        _ => format!("{original_relative}.wav"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for frame in 0..frames {
            for channel in 0..channels {
                // A ramp, so a round trip that silently zeroed or reordered
                // samples would be visible.
                let value = ((frame as i32 * 7 + i32::from(channel) * 3) % 1000) as i16;
                writer.write_sample(value).expect("write sample");
            }
        }
        writer.finalize().expect("finalize");
    }

    #[test]
    fn preparing_a_wav_preserves_rate_channels_and_frames() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("stem.wav");
        write_test_wav(&source, 44_100, 2, 500);

        let destination = dir.path().join("out/stem.wav");
        let info = prepare_audio_to_wav(&source, &destination).expect("prepare");

        assert_eq!(info.sample_rate, 44_100);
        assert_eq!(info.channels, 2);
        assert_eq!(info.frames, 500);
        assert!(destination.is_file());
    }

    #[test]
    fn prepared_audio_is_16_bit_pcm_at_the_source_rate() {
        // The receiving device matches its output to the declared rate, so the
        // export must not quietly resample to something else.
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("stem.wav");
        write_test_wav(&source, 48_000, 1, 128);

        let destination = dir.path().join("prepared.wav");
        prepare_audio_to_wav(&source, &destination).expect("prepare");

        let reader = hound::WavReader::open(&destination).expect("open prepared");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 48_000, "rate must be carried through");
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);
        assert_eq!(spec.channels, 1);
    }

    #[test]
    fn samples_survive_the_round_trip() {
        // Not just "a file appeared": the audio has to still be the audio.
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("stem.wav");
        write_test_wav(&source, 44_100, 2, 64);

        let destination = dir.path().join("prepared.wav");
        prepare_audio_to_wav(&source, &destination).expect("prepare");

        let original: Vec<i16> = hound::WavReader::open(&source)
            .expect("open source")
            .into_samples::<i16>()
            .map(|sample| sample.expect("sample"))
            .collect();
        let prepared: Vec<i16> = hound::WavReader::open(&destination)
            .expect("open prepared")
            .into_samples::<i16>()
            .map(|sample| sample.expect("sample"))
            .collect();

        assert_eq!(original.len(), prepared.len());
        for (index, (before, after)) in original.iter().zip(prepared.iter()).enumerate() {
            // One LSB of tolerance: the round trip goes through f32.
            let drift = (i32::from(*before) - i32::from(*after)).abs();
            assert!(drift <= 1, "sample {index} drifted by {drift}");
        }
    }

    #[test]
    fn a_prepared_source_is_named_wav_whatever_it_started_as() {
        // The failure this guards: leaving a compressed extension on PCM bytes.
        // The engine picks its decoder by extension, so "Bass.mp3" holding WAV
        // data fails to open — silently, as a missing track.
        assert_eq!(prepared_relative_path("audio/Bass.mp3"), "audio/Bass.wav");
        assert_eq!(prepared_relative_path("audio/Keys.flac"), "audio/Keys.wav");
        assert_eq!(prepared_relative_path("audio/Drums.wav"), "audio/Drums.wav");
        // Collision suffixes survive: they live in the stem.
        assert_eq!(prepared_relative_path("audio/Bass-1.mp3"), "audio/Bass-1.wav");
        // No extension at all still yields a usable name.
        assert_eq!(prepared_relative_path("audio/Odd"), "audio/Odd.wav");
    }

    #[test]
    fn preparing_a_missing_file_fails_rather_than_writing_an_empty_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let destination = dir.path().join("prepared.wav");

        let result = prepare_audio_to_wav(&dir.path().join("nope.wav"), &destination);

        assert!(result.is_err());
        assert!(
            !destination.exists(),
            "a failed preparation must not leave a broken file behind"
        );
    }
}
