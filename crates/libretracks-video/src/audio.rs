//! The audio track of a video, written out as a WAV (video plan, paso 11).
//!
//! The WAV becomes an ordinary audio asset of the session: mpv always plays
//! video with `ao=null`, and a package without its videos keeps the audio.
//!
//! libmpv does the decoding, not the Rust decoder the packages use: the
//! symphonia path ignores the mp4 edit list, so AAC came out 1024 samples
//! (21 ms at 48 kHz) behind the picture, and it cannot decode Opus, AC-3 or
//! E-AC-3 at all. mpv is also what told import "this video has audio", so
//! whatever it says has audio, it can extract.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::extract::headless;
use crate::mpv::{EndFileReason, MpvEvent, MpvLibrary};
use crate::VideoError;

/// What the extracted WAV turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
}

/// Decode the first audio track of `source` to `destination`: 16-bit PCM
/// stereo at the track's own rate (the engine resamples it to the device like
/// any imported audio). Blocks; run it off the session lock. Reports progress
/// as a 0–1 fraction of `duration_seconds` and checks `cancel` between events.
/// The file is written next to `destination` and renamed at the end, so a
/// cancelled or failed run leaves nothing behind.
pub fn extract_audio_to_wav(
    api: &Arc<MpvLibrary>,
    source: &Path,
    destination: &Path,
    duration_seconds: f64,
    progress: &dyn Fn(f64),
    cancel: &AtomicBool,
) -> Result<ExtractedAudio, VideoError> {
    let staging = destination.with_extension("wav.part");
    let result = decode(api, source, &staging, duration_seconds, progress, cancel)
        .and_then(|()| read_info(&staging))
        .and_then(|info| {
            std::fs::rename(&staging, destination).map_err(|error| {
                VideoError::Command(format!("no se pudo guardar el audio: {error}"))
            })?;
            Ok(info)
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

fn decode(
    api: &Arc<MpvLibrary>,
    source: &Path,
    staging: &Path,
    duration_seconds: f64,
    progress: &dyn Fn(f64),
    cancel: &AtomicBool,
) -> Result<(), VideoError> {
    let file = staging.to_string_lossy().into_owned();
    // Dropped at the end of this function: mpv writes the WAV sizes when the
    // audio output closes, so the file is only complete after that.
    let mpv = headless(
        api,
        &[
            ("vid", "no"),
            ("audio", "auto"),
            ("aid", "auto"),
            ("ao", "pcm"),
            ("ao-pcm-file", &file),
            ("ao-pcm-waveheader", "yes"),
            ("audio-format", "s16"),
            // With lavf's advanced edit lists mpv trims the AAC encoder delay
            // twice and the audio comes out 1024 samples early; the simple
            // mode matches what ffmpeg extracts (checked with a click at a
            // known sample, see the tests).
            ("demuxer-lavf-o", "advanced_editlist=0"),
            ("audio-channels", "stereo"),
            ("untimed", "yes"),
            ("keep-open", "no"),
            ("replaygain", "no"),
            ("volume", "100"),
        ],
    )?;
    mpv.command(&["loadfile", &source.to_string_lossy()])?;

    // A slow machine still decodes audio far faster than real time.
    let deadline = Instant::now() + Duration::from_secs_f64((duration_seconds * 2.0).max(60.0));
    let mut saw_audio = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(VideoError::Command("cancelado".into()));
        }
        if Instant::now() >= deadline {
            return Err(VideoError::Command("mpv no respondió a tiempo".into()));
        }
        match mpv.wait_event(0.1) {
            Some(MpvEvent::EndFile(EndFileReason::Eof)) => break,
            Some(MpvEvent::EndFile(EndFileReason::Error(reason))) => {
                return Err(VideoError::Command(reason));
            }
            Some(MpvEvent::EndFile(_)) | Some(MpvEvent::Shutdown) => {
                return Err(VideoError::Command("la extracción se interrumpió".into()));
            }
            _ => {}
        }
        if !saw_audio {
            saw_audio = mpv.get_property_string("current-tracks/audio/id").is_ok()
                || mpv.get_property_i64("aid").is_ok();
        }
        if duration_seconds > 0.0 {
            if let Ok(position) = mpv.get_property_f64("audio-pts") {
                progress((position / duration_seconds).clamp(0.0, 1.0));
            }
        }
    }
    drop(mpv);
    if !saw_audio {
        return Err(VideoError::Command("el vídeo no tiene audio".into()));
    }
    progress(1.0);
    Ok(())
}

fn read_info(path: &Path) -> Result<ExtractedAudio, VideoError> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| VideoError::Command(format!("el audio extraído no es válido: {error}")))?;
    let spec = reader.spec();
    let frames = u64::from(reader.duration());
    if frames == 0 {
        return Err(VideoError::Command("el vídeo no tiene audio".into()));
    }
    Ok(ExtractedAudio {
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::libmpv_for_tests;
    use std::path::PathBuf;

    /// A 2 s video whose audio is silence with one click at sample 24 000
    /// (0.5 s at 48 kHz), made with the system ffmpeg.
    fn click_video(dir: &Path, name: &str, audio_codec: Option<&str>) -> Option<PathBuf> {
        let out = dir.join(name);
        let mut command = std::process::Command::new("ffmpeg");
        command
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=30:duration=2",
            ]);
        if let Some(codec) = audio_codec {
            command
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    r"aevalsrc='if(eq(n,24000),0.9,0)':s=48000:d=2",
                ])
                .args(["-c:a", codec, "-shortest"]);
        }
        command.args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ]);
        match command.arg(&out).status() {
            Ok(status) if status.success() && out.exists() => Some(out),
            other => {
                eprintln!("SKIP: no se pudo generar {name} con ffmpeg ({other:?})");
                None
            }
        }
    }

    /// Frame of the loudest sample, the rate, and the length in frames.
    fn click_position(path: &Path) -> (usize, u32, usize) {
        let mut reader = hound::WavReader::open(path).expect("open extracted");
        let spec = reader.spec();
        let samples: Vec<i16> = reader
            .samples::<i16>()
            .map(|s| s.expect("sample"))
            .collect();
        let channels = usize::from(spec.channels);
        let (peak, _) = samples
            .iter()
            .enumerate()
            .max_by_key(|(_, sample)| sample.unsigned_abs())
            .expect("non-empty");
        (peak / channels, spec.sample_rate, samples.len() / channels)
    }

    fn extract(video: &Path, out: &Path) -> Result<ExtractedAudio, VideoError> {
        let api = libmpv_for_tests().expect("libmpv checked by the caller");
        extract_audio_to_wav(&api, video, out, 2.0, &|_| {}, &AtomicBool::new(false))
    }

    #[test]
    fn pcm_audio_comes_out_sample_accurate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (Some(_), Some(video)) = (
            libmpv_for_tests(),
            click_video(dir.path(), "pcm.mov", Some("pcm_s16le")),
        ) else {
            return;
        };
        let out = dir.path().join("pcm (audio).wav");
        let info = extract(&video, &out).expect("extract");
        let (click, rate, frames) = click_position(&out);
        assert_eq!(rate, 48_000);
        assert_eq!(info.channels, 2);
        assert_eq!(info.frames as usize, frames);
        assert_eq!(click, 24_000, "click moved");
        assert!((frames as i64 - 96_000).abs() <= 1024, "duration {frames}");
        assert!(!out.with_extension("wav.part").exists());
    }

    #[test]
    fn aac_encoder_delay_is_trimmed_so_the_audio_lines_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (Some(_), Some(video)) = (
            libmpv_for_tests(),
            click_video(dir.path(), "aac.mp4", Some("aac")),
        ) else {
            return;
        };
        let out = dir.path().join("aac (audio).wav");
        extract(&video, &out).expect("extract");
        let (click, _, frames) = click_position(&out);
        // AAC smears the click over a few samples; ignoring the priming
        // delay would move it by 1024.
        assert!((click as i64 - 24_000).abs() <= 2, "click at {click}");
        assert!((frames as i64 - 96_000).abs() <= 1024, "duration {frames}");
    }

    #[test]
    fn a_video_without_audio_is_refused_and_leaves_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (Some(_), Some(video)) = (
            libmpv_for_tests(),
            click_video(dir.path(), "mute.mp4", None),
        ) else {
            return;
        };
        let out = dir.path().join("mute (audio).wav");
        assert!(extract(&video, &out).is_err());
        assert!(!out.exists());
        assert!(!out.with_extension("wav.part").exists());
    }

    #[test]
    fn a_cancelled_extraction_leaves_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (Some(api), Some(video)) = (
            libmpv_for_tests(),
            click_video(dir.path(), "c.mov", Some("pcm_s16le")),
        ) else {
            return;
        };
        let out = dir.path().join("c (audio).wav");
        let result = extract_audio_to_wav(&api, &video, &out, 2.0, &|_| {}, &AtomicBool::new(true));
        assert!(result.is_err());
        assert!(!out.exists());
        assert!(!out.with_extension("wav.part").exists());
    }
}
