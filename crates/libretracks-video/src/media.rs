//! Analysing a video and making its thumbnail strip without libmpv (plan
//! `video-mobile`, paso 07): the contracts the app's probe and thumbnail
//! worker program against, and the pure parts of the phone's side.
//!
//! - [`VideoProbe`]: duration, size, frame rate, audio. libmpv on the
//!   desktop (`extract::probe`, unchanged); `MediaMetadataRetriever` +
//!   `MediaExtractor` on Android and `AVURLAsset` on iOS, which answer with a
//!   small JSON document parsed by [`parse_native_probe`].
//! - [`FrameExtractor`]: one JPEG at a media time. [`build_strip`] asks it for
//!   the frames of [`thumbs::thumbnail_times`] and packs them with
//!   [`thumbs::strip_from_frames`], the same packer the desktop uses, so the
//!   `.ltthumbs` format is shared.
//!
//! Compiled everywhere so the desktop test run covers it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use libretracks_core::VideoAssetInfo;
use serde::Deserialize;

use crate::thumbs::{self, ThumbnailStrip, THUMBNAIL_WIDTH};

/// Why a video could not be analysed.
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeError {
    /// The file is a video this device cannot decode (ProRes on Android, HEVC
    /// 10-bit on a low-end phone). Not a missing file: it stays in the
    /// session, marked "not playable on this device". `info` carries what
    /// could still be read from the container.
    Unsupported {
        codec: String,
        info: Option<VideoAssetInfo>,
    },
    /// Unreadable, not a video, or the native part failed.
    Failed(String),
}

impl ProbeError {
    pub fn message(&self) -> String {
        match self {
            ProbeError::Unsupported { codec, .. } => {
                format!("no reproducible en este dispositivo (códec {codec})")
            }
            ProbeError::Failed(reason) => reason.clone(),
        }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

/// Analyses a video file. Blocking: call it off the session lock and off the
/// UI thread.
pub trait VideoProbe: Send + Sync {
    fn probe(&self, path: &Path) -> Result<VideoAssetInfo, ProbeError>;
}

/// One thumbnail at `seconds` of media time, as a JPEG at most `max_width`
/// pixels wide. Blocking, like [`VideoProbe`].
pub trait FrameExtractor {
    fn frames(&mut self, path: &Path, times: &[f64], max_width: u32) -> Vec<Option<Vec<u8>>>;
}

/// Width and height as the picture is *shown*: the container's rotation
/// applied (a video shot upright on a phone is 1080×1920, even if its frames
/// are stored 1920×1080 with a 90° flag).
pub fn oriented_size(width: u32, height: u32, rotation_degrees: u32) -> (u32, u32) {
    match rotation_degrees % 360 {
        90 | 270 => (height, width),
        _ => (width, height),
    }
}

/// What the native probe answers, as JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeProbe {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    duration_seconds: f64,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    rotation_degrees: i64,
    #[serde(default)]
    fps: f64,
    #[serde(default)]
    codec: String,
    #[serde(default)]
    has_audio: bool,
    #[serde(default)]
    hardware_decode: bool,
    /// A decoder for the video track exists on this device.
    #[serde(default = "default_true")]
    decodable: bool,
}

fn default_true() -> bool {
    true
}

/// Turn the native probe's JSON into the analysis the library stores.
pub fn parse_native_probe(json: &str, label: &str) -> Result<VideoAssetInfo, ProbeError> {
    let native: NativeProbe = serde_json::from_str(json).map_err(|error| {
        ProbeError::Failed(format!("{label}: respuesta nativa ilegible ({error})"))
    })?;
    if let Some(error) = native.error.filter(|error| !error.trim().is_empty()) {
        return Err(ProbeError::Failed(format!("{label}: {error}")));
    }
    if native.width == 0 || native.height == 0 {
        return Err(ProbeError::Failed(format!(
            "{label}: no contiene una pista de vídeo que se pueda decodificar"
        )));
    }
    let rotation_degrees = native.rotation_degrees.rem_euclid(360) as u32;
    let (width, height) = oriented_size(native.width, native.height, rotation_degrees);
    let codec = if native.codec.trim().is_empty() {
        "desconocido".to_string()
    } else {
        native.codec.trim().to_string()
    };
    let readable_duration = native.duration_seconds.is_finite() && native.duration_seconds > 0.0;
    let info = VideoAssetInfo {
        duration_seconds: if readable_duration {
            native.duration_seconds
        } else {
            0.0
        },
        width,
        height,
        fps: if native.fps.is_finite() && native.fps > 0.0 {
            native.fps
        } else {
            0.0
        },
        rotation_degrees,
        codec: codec.clone(),
        hardware_decode: native.hardware_decode,
        has_audio: native.has_audio,
        keyframe_interval_seconds: None,
    };
    if !native.decodable {
        return Err(ProbeError::Unsupported {
            codec,
            info: readable_duration.then_some(info),
        });
    }
    if !readable_duration {
        return Err(ProbeError::Failed(format!("{label}: duración desconocida")));
    }
    Ok(info)
}

/// Frames asked of the extractor per call: between two batches the worker
/// checks `cancel` (a deleted clip, a closed session) and yields.
pub const FRAMES_PER_BATCH: usize = 8;

/// Make the strip of `source` with `extractor`, in batches, checking
/// `cancel` between them. A frame the decoder could not produce repeats the
/// previous one, so the strip keeps one frame per interval (the reader maps
/// media time to index).
pub fn build_strip(
    source: &Path,
    duration_seconds: f64,
    extractor: &mut dyn FrameExtractor,
    cancel: &AtomicBool,
) -> Result<ThumbnailStrip, String> {
    let (source_size, source_modified_millis) = thumbs::source_freshness(source)
        .ok_or_else(|| format!("{}: no existe", source.display()))?;
    let times = thumbs::thumbnail_times(duration_seconds);
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(times.len());
    for batch in times.chunks(FRAMES_PER_BATCH) {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelado".into());
        }
        let produced = extractor.frames(source, batch, THUMBNAIL_WIDTH);
        for index in 0..batch.len() {
            match produced.get(index).cloned().flatten() {
                Some(jpeg) => frames.push(jpeg),
                None => {
                    if let Some(previous) = frames.last().cloned() {
                        frames.push(previous);
                    } else {
                        return Err(format!(
                            "{}: no se obtuvo el primer fotograma",
                            source.display()
                        ));
                    }
                }
            }
        }
    }
    thumbs::strip_from_frames(
        source_size,
        source_modified_millis,
        thumbs::thumbnail_interval_seconds(duration_seconds),
        frames,
    )
    .ok_or_else(|| format!("{}: no se obtuvo ninguna miniatura", source.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG header with a start-of-frame for `width`×`height`, and `tag`
    /// to tell frames apart.
    fn jpeg(width: u16, height: u16, tag: u8) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, tag, 0xff, 0xd9]);
        bytes
    }

    struct FakeExtractor {
        calls: usize,
        missing: Vec<usize>,
        produced: usize,
    }

    impl FrameExtractor for FakeExtractor {
        fn frames(&mut self, _: &Path, times: &[f64], max_width: u32) -> Vec<Option<Vec<u8>>> {
            assert_eq!(max_width, THUMBNAIL_WIDTH);
            self.calls += 1;
            times
                .iter()
                .map(|_| {
                    let index = self.produced;
                    self.produced += 1;
                    (!self.missing.contains(&index)).then(|| jpeg(160, 90, index as u8))
                })
                .collect()
        }
    }

    /// C2: the phone's strip and the desktop's, made of the same frames, are
    /// the same bytes. The desktop path is `extract::extract_thumbnails`,
    /// which packs mpv's frames with `thumbs::strip_from_frames`.
    #[test]
    fn a_strip_made_on_a_phone_is_byte_identical_to_the_desktop_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("letras.mp4");
        std::fs::write(&source, b"video bytes").unwrap();
        let duration = 23.5;

        let mut extractor = FakeExtractor {
            calls: 0,
            missing: Vec::new(),
            produced: 0,
        };
        let cancel = AtomicBool::new(false);
        let phone = build_strip(&source, duration, &mut extractor, &cancel).expect("strip");

        let (size, modified) = thumbs::source_freshness(&source).unwrap();
        let frames: Vec<Vec<u8>> = (0..24).map(|index| jpeg(160, 90, index as u8)).collect();
        let desktop = thumbs::strip_from_frames(
            size,
            modified,
            thumbs::thumbnail_interval_seconds(duration),
            frames,
        )
        .unwrap();

        assert_eq!(phone.encode(), desktop.encode());
        assert_eq!((phone.width, phone.height), (160, 90));
        assert_eq!(extractor.calls, 3, "24 frames in batches of 8");
    }

    #[test]
    fn the_frame_times_match_the_desktop_filter() {
        assert_eq!(thumbs::thumbnail_times(3.2), vec![0.0, 1.0, 2.0, 3.0]);
        assert_eq!(thumbs::thumbnail_times(3.0), vec![0.0, 1.0, 2.0]);
        let long = thumbs::thumbnail_times(3600.0);
        assert_eq!(long.len(), 360);
        assert_eq!(long[1], 10.0);
        assert!(thumbs::thumbnail_times(0.0).is_empty());
    }

    #[test]
    fn a_frame_that_fails_repeats_the_previous_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("v.mp4");
        std::fs::write(&source, b"x").unwrap();
        let mut extractor = FakeExtractor {
            calls: 0,
            missing: vec![2],
            produced: 0,
        };
        let strip = build_strip(&source, 4.0, &mut extractor, &AtomicBool::new(false)).unwrap();
        assert_eq!(strip.frames.len(), 4);
        assert_eq!(strip.frames[2], strip.frames[1]);
    }

    #[test]
    fn a_cancelled_strip_stops_between_batches() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("v.mp4");
        std::fs::write(&source, b"x").unwrap();
        let mut extractor = FakeExtractor {
            calls: 0,
            missing: Vec::new(),
            produced: 0,
        };
        let cancel = AtomicBool::new(true);
        assert!(build_strip(&source, 60.0, &mut extractor, &cancel).is_err());
        assert_eq!(extractor.calls, 0);
    }

    /// C3: rotation applied before width and height are stored.
    #[test]
    fn a_video_shot_upright_is_upright() {
        assert_eq!(oriented_size(1920, 1080, 90), (1080, 1920));
        assert_eq!(oriented_size(1920, 1080, 270), (1080, 1920));
        assert_eq!(oriented_size(1920, 1080, 180), (1920, 1080));
        assert_eq!(oriented_size(1920, 1080, 0), (1920, 1080));
        let info = parse_native_probe(
            r#"{"durationSeconds":12.5,"width":1920,"height":1080,"rotationDegrees":-270,"fps":29.97,"codec":"avc1","hasAudio":true}"#,
            "v.mov",
        )
        .unwrap();
        assert_eq!(
            (info.width, info.height, info.rotation_degrees),
            (1080, 1920, 90)
        );
        assert_eq!(info.fps, 29.97);
        assert!(info.has_audio);
    }

    #[test]
    fn an_undecodable_codec_is_unsupported_with_what_could_be_read() {
        let error = parse_native_probe(
            r#"{"durationSeconds":30,"width":3840,"height":2160,"codec":"apcn","decodable":false}"#,
            "prores.mov",
        )
        .unwrap_err();
        let ProbeError::Unsupported { codec, info } = &error else {
            panic!("{error:?}");
        };
        assert_eq!(codec, "apcn");
        assert_eq!(info.as_ref().map(|info| info.duration_seconds), Some(30.0));
        assert!(error
            .message()
            .contains("no reproducible en este dispositivo"));
    }

    #[test]
    fn native_errors_and_garbage_fail_with_a_reason() {
        assert!(matches!(
            parse_native_probe(r#"{"error":"setDataSource failed"}"#, "a.mp4"),
            Err(ProbeError::Failed(reason)) if reason.contains("setDataSource")
        ));
        assert!(matches!(
            parse_native_probe("not json", "a.mp4"),
            Err(ProbeError::Failed(_))
        ));
        assert!(matches!(
            parse_native_probe(r#"{"durationSeconds":3,"width":0,"height":0}"#, "song.mp3"),
            Err(ProbeError::Failed(reason)) if reason.contains("pista de vídeo")
        ));
        assert!(matches!(
            parse_native_probe(r#"{"durationSeconds":0,"width":10,"height":10}"#, "a.mp4"),
            Err(ProbeError::Failed(reason)) if reason.contains("duración")
        ));
    }
}
