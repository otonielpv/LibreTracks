//! Reading a video file with libmpv without showing it: the analysis that
//! import runs ([`probe`]) and the thumbnail strip for the timeline
//! ([`extract_thumbnails`]).
//!
//! Both open their own headless mpv instance (`vo=null` / `vo=image`,
//! `ao=null`), block the calling thread while they work, and must therefore
//! run on a background thread — never under the session lock.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use libretracks_core::VideoAssetInfo;

use crate::mpv::{EndFileReason, Mpv, MpvEvent, MpvLibrary};
#[cfg(test)]
use crate::thumbs::jpeg_dimensions;
use crate::thumbs::{strip_from_frames, thumbnail_interval_seconds, ThumbnailStrip, THUMBNAIL_WIDTH};
use crate::VideoError;

/// Options every headless instance shares: no config files, scripts, OSD,
/// input or audio output.
pub(crate) fn headless(api: &Arc<MpvLibrary>, extra: &[(&str, &str)]) -> Result<Mpv, VideoError> {
    let mpv = Mpv::create(api)?;
    for (name, value) in crate::mpv::SCRIPT_OPTIONS {
        mpv.set_option_if_known(name, value)?;
    }
    for (name, value) in [
        ("config", "no"),
        ("terminal", "no"),
        ("input-default-bindings", "no"),
        ("ao", "null"),
        ("audio", "no"),
        ("sub", "no"),
    ]
    .iter()
    .chain(extra.iter())
    {
        mpv.set_option(name, value)?;
    }
    mpv.initialize()?;
    Ok(mpv)
}

/// Wait for the first event `want` accepts. Fails on a file error, a
/// timeout or cancellation.
fn wait_until(
    mpv: &Mpv,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
    want: impl Fn(&MpvEvent) -> bool,
) -> Result<MpvEvent, VideoError> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(VideoError::Command("cancelado".into()));
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(VideoError::Command("mpv no respondió a tiempo".into()));
        }
        if let Some(event) = mpv.wait_event(left.as_secs_f64().min(0.25)) {
            if let MpvEvent::EndFile(EndFileReason::Error(reason)) = &event {
                return Err(VideoError::Command(reason.clone()));
            }
            if want(&event) {
                return Ok(event);
            }
        }
    }
}

/// Analyse `path`: duration, size, frame rate, rotation, codec, hardware
/// decoding, audio track and keyframe spacing. Fails with a readable reason
/// ("códec no soportado", "no es un vídeo") when mpv cannot decode it.
pub fn probe(api: &Arc<MpvLibrary>, path: &Path) -> Result<VideoAssetInfo, VideoError> {
    let mpv = headless(
        api,
        &[
            ("vo", "null"),
            ("pause", "yes"),
            ("hwdec", "auto-copy-safe"),
            ("hr-seek", "no"),
        ],
    )?;
    let file = path.to_string_lossy();
    mpv.command(&["loadfile", &file])?;
    wait_until(&mpv, Duration::from_secs(20), None, |event| {
        matches!(event, MpvEvent::PlaybackRestart)
    })
    .map_err(|error| VideoError::Command(format!("{}: {error}", file_label(path))))?;

    let codec = mpv.get_property_string("video-codec").ok();
    let width = mpv.get_property_i64("width").ok();
    let height = mpv.get_property_i64("height").ok();
    let (Some(codec), Some(width), Some(height)) = (codec, width, height) else {
        return Err(VideoError::Command(format!(
            "{}: no contiene una pista de vídeo que se pueda decodificar",
            file_label(path)
        )));
    };
    let duration_seconds = mpv.get_property_f64("duration").unwrap_or(0.0);
    if !(duration_seconds.is_finite() && duration_seconds > 0.0) {
        return Err(VideoError::Command(format!(
            "{}: duración desconocida",
            file_label(path)
        )));
    }
    let fps = mpv
        .get_property_f64("container-fps")
        .ok()
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .unwrap_or(0.0);
    let rotation_degrees = mpv
        .get_property_i64("video-params/rotate")
        .unwrap_or(0)
        .rem_euclid(360) as u32;
    let hwdec = mpv.get_property_string("hwdec-current").unwrap_or_default();
    let hardware_decode = !hwdec.is_empty() && hwdec != "no";
    let track_count = mpv.get_property_i64("track-list/count").unwrap_or(0);
    let has_audio = (0..track_count).any(|index| {
        mpv.get_property_string(&format!("track-list/{index}/type"))
            .is_ok_and(|kind| kind == "audio")
    });
    let keyframe_interval_seconds = sample_keyframe_interval(&mpv, duration_seconds);

    Ok(VideoAssetInfo {
        duration_seconds,
        width: width.max(0) as u32,
        height: height.max(0) as u32,
        fps,
        rotation_degrees,
        codec,
        hardware_decode,
        has_audio,
        keyframe_interval_seconds,
    })
}

/// Longest gap between two consecutive keyframes around three points of the
/// file. `hr-seek=no` makes an absolute seek land on the keyframe at or before
/// the target and a small relative keyframe seek jump to the next one, so the
/// difference is one GOP. Sampling instead of scanning keeps a 2-hour file as
/// cheap as a 2-minute one; it only has to answer "long GOP or not".
fn sample_keyframe_interval(mpv: &Mpv, duration: f64) -> Option<f64> {
    if duration < 1.0 {
        return None;
    }
    let seek_and_read = |args: &[&str]| -> Option<f64> {
        mpv.command(args).ok()?;
        wait_until(mpv, Duration::from_secs(5), None, |event| {
            matches!(event, MpvEvent::PlaybackRestart)
        })
        .ok()?;
        mpv.get_property_f64("time-pos").ok()
    };
    let mut longest: Option<f64> = None;
    for fraction in [0.25, 0.5, 0.75] {
        let target = format!("{:.3}", duration * fraction);
        let Some(previous) = seek_and_read(&["seek", &target, "absolute+keyframes"]) else {
            continue;
        };
        let Some(next) = seek_and_read(&["seek", "0.001", "relative+keyframes"]) else {
            continue;
        };
        let gap = next - previous;
        // At the end of the file the "next" keyframe is the same one.
        if gap > 1e-3 {
            longest = Some(longest.map_or(gap, |known: f64| known.max(gap)));
        }
    }
    longest
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Decode the whole file once, keeping one [`THUMBNAIL_WIDTH`]-wide JPEG every
/// `thumbnail_interval_seconds(duration)` seconds. `work_dir` is scratch space
/// for mpv's image writer and is emptied afterwards. Checks `cancel` between
/// events so a deleted clip or a closed session stops the work promptly.
pub fn extract_thumbnails(
    api: &Arc<MpvLibrary>,
    source: &Path,
    duration_seconds: f64,
    work_dir: &Path,
    cancel: &AtomicBool,
) -> Result<ThumbnailStrip, VideoError> {
    let (source_size, source_modified_millis) = crate::thumbs::source_freshness(source)
        .ok_or_else(|| VideoError::Command(format!("{}: no existe", file_label(source))))?;
    let interval = thumbnail_interval_seconds(duration_seconds);
    let _ = std::fs::remove_dir_all(work_dir);
    std::fs::create_dir_all(work_dir)
        .map_err(|error| VideoError::Command(format!("carpeta temporal: {error}")))?;

    // `fps` keeps one frame per interval (pts 0, interval, 2·interval…) and
    // numbers them sequentially, so frame N shows media time N·interval.
    let filter = format!("fps=fps=1/{interval}:round=down,scale=w={THUMBNAIL_WIDTH}:h=-2");
    let outdir = work_dir.to_string_lossy().into_owned();
    let result = (|| {
        let mpv = headless(
            api,
            &[
                ("vo", "image"),
                ("vo-image-format", "jpg"),
                ("vo-image-jpeg-quality", "72"),
                ("vo-image-outdir", &outdir),
                ("vf", &filter),
                ("untimed", "yes"),
                ("hwdec", "auto-copy-safe"),
                ("vd-lavc-skiploopfilter", "all"),
                ("vd-lavc-fast", "yes"),
                ("sws-scaler", "fast-bilinear"),
                ("keep-open", "no"),
            ],
        )?;
        mpv.command(&["loadfile", &source.to_string_lossy()])?;
        // Budget: generous, a slow machine decodes 1080p at ~2x real time.
        let budget = Duration::from_secs_f64((duration_seconds * 2.0).max(60.0));
        wait_until(&mpv, budget, Some(cancel), |event| {
            matches!(event, MpvEvent::EndFile(_))
        })?;
        Ok::<_, VideoError>(())
    })();

    let collected = collect_frames(work_dir);
    let _ = std::fs::remove_dir_all(work_dir);
    result?;
    let frames = collected?;
    // mpv's properties for the output size are gone once the file has
    // ended; the JPEG is the ground truth anyway (`strip_from_frames`).
    strip_from_frames(source_size, source_modified_millis, interval, frames).ok_or_else(|| {
        VideoError::Command(format!(
            "{}: no se obtuvo ninguna miniatura",
            file_label(source)
        ))
    })
}

fn collect_frames(dir: &Path) -> Result<Vec<Vec<u8>>, VideoError> {
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .map_err(|error| VideoError::Command(error.to_string()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        })
        .collect();
    // mpv names them 00000001.jpg, 00000002.jpg…: lexical order is frame order.
    names.sort();
    names
        .iter()
        .map(|path| std::fs::read(path).map_err(|error| VideoError::Command(error.to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{generate_fixture, libmpv_for_tests};

    #[test]
    fn jpeg_dimensions_come_from_the_start_of_frame() {
        // SOI, APP0 (length 4), SOF0 with height 120 and width 160.
        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00,
            0x78, 0x00, 0xa0, 0x03, 0x01, 0x22, 0x00,
        ];
        assert_eq!(jpeg_dimensions(&jpeg), Some((160, 120)));
        assert_eq!(jpeg_dimensions(b"not a jpeg"), None);
    }

    #[test]
    fn probe_reads_duration_size_fps_and_audio() {
        let Some(api) = libmpv_for_tests() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(with_audio) = generate_fixture(dir.path(), "a.mp4", 4.0, 25, 1, true) else {
            return;
        };
        let info = probe(&api, &with_audio).expect("probe");
        assert!(
            (info.duration_seconds - 4.0).abs() <= 1.0 / 25.0 + 0.03,
            "{info:?}"
        );
        assert_eq!((info.width, info.height), (320, 240));
        assert!((info.fps - 25.0).abs() < 0.01, "{info:?}");
        assert!(info.has_audio);
        assert_eq!(info.rotation_degrees, 0);

        let Some(silent) = generate_fixture(dir.path(), "b.mp4", 4.0, 30, 1, false) else {
            return;
        };
        let info = probe(&api, &silent).expect("probe");
        assert!(!info.has_audio);
        assert!((info.fps - 30.0).abs() < 0.01);
    }

    #[test]
    fn probe_measures_keyframe_spacing() {
        let Some(api) = libmpv_for_tests() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let (Some(short), Some(long)) = (
            generate_fixture(dir.path(), "gop1.mp4", 24.0, 25, 1, false),
            generate_fixture(dir.path(), "gop10.mp4", 24.0, 25, 10, false),
        ) else {
            return;
        };
        let short = probe(&api, &short).expect("probe short gop");
        let long = probe(&api, &long).expect("probe long gop");
        assert!(!short.has_slow_seeks(), "{short:?}");
        assert!(long.has_slow_seeks(), "{long:?}");
    }

    #[test]
    fn a_file_that_is_not_a_video_fails_with_a_reason() {
        let Some(api) = libmpv_for_tests() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let bogus = dir.path().join("roto.mp4");
        std::fs::write(&bogus, vec![0x42_u8; 64 * 1024]).expect("write junk");
        let error = probe(&api, &bogus).expect_err("junk must not probe");
        assert!(error.to_string().contains("roto.mp4"), "{error}");
    }

    #[test]
    fn thumbnails_cover_the_file_at_the_planned_interval() {
        let Some(api) = libmpv_for_tests() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(video) = generate_fixture(dir.path(), "t.mp4", 6.0, 25, 1, false) else {
            return;
        };
        let cancel = AtomicBool::new(false);
        let strip = extract_thumbnails(&api, &video, 6.0, &dir.path().join("work"), &cancel)
            .expect("thumbnails");
        assert_eq!(strip.interval_seconds, 1.0);
        assert!(
            (5..=7).contains(&strip.frames.len()),
            "{}",
            strip.frames.len()
        );
        assert_eq!(strip.width, THUMBNAIL_WIDTH);
        assert_eq!(strip.height, 120);
        assert!(strip
            .frames
            .iter()
            .all(|jpeg| jpeg.starts_with(&[0xff, 0xd8])));
        assert!(!dir.path().join("work").exists(), "scratch dir cleaned up");
    }

    #[test]
    fn thumbnail_extraction_stops_when_cancelled() {
        let Some(api) = libmpv_for_tests() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(video) = generate_fixture(dir.path(), "c.mp4", 6.0, 25, 1, false) else {
            return;
        };
        let cancel = AtomicBool::new(true);
        assert!(extract_thumbnails(&api, &video, 6.0, &dir.path().join("work"), &cancel).is_err());
    }
}
