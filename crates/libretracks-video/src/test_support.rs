//! Helpers for the tests that need a real libmpv and real video files.
//!
//! Neither is guaranteed on a CI runner, so each helper returns `None` and
//! prints an explicit `SKIP` line instead of failing. The logic those tests
//! exercise always has a pure counterpart that runs everywhere (the harness
//! rule of the video plan: no criterion may rest only on skipped tests).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use crate::mpv::MpvLibrary;

/// libmpv from `LIBRETRACKS_LIBMPV`, or the one `scripts/libmpv-fetch.mjs`
/// leaves in `vendor/bin/libmpv/`.
pub fn libmpv_for_tests() -> Option<Arc<MpvLibrary>> {
    let vendored = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../vendor/bin/libmpv")
        .join(if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "unix"
        })
        .join(crate::library::bundled_file_name());
    let candidates: Vec<PathBuf> = std::env::var(crate::LIBMPV_ENV_VAR)
        .ok()
        .map(PathBuf::from)
        .into_iter()
        .chain(std::iter::once(vendored))
        .collect();
    for path in &candidates {
        if path.exists() {
            if let Ok(library) = MpvLibrary::load(path) {
                return Some(library);
            }
        }
    }
    eprintln!(
        "SKIP: libmpv no disponible (probado {candidates:?}); \
         ejecuta scripts/libmpv-fetch.mjs o define LIBRETRACKS_LIBMPV"
    );
    None
}

/// A small H.264 test clip made with the system ffmpeg: 320x240, `seconds`
/// long, a keyframe every `gop_seconds`, optionally with a 1 kHz tone.
pub fn generate_fixture(
    dir: &Path,
    name: &str,
    seconds: f64,
    fps: u32,
    gop_seconds: u32,
    with_audio: bool,
) -> Option<PathBuf> {
    let out = dir.join(name);
    let gop = (fps * gop_seconds).to_string();
    let mut command = Command::new("ffmpeg");
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
    ]);
    command.arg(format!(
        "testsrc=size=320x240:rate={fps}:duration={seconds}"
    ));
    if with_audio {
        command.args(["-f", "lavfi", "-i"]);
        command.arg(format!(
            "sine=frequency=1000:sample_rate=48000:duration={seconds}"
        ));
        command.args(["-c:a", "aac", "-shortest"]);
    }
    command.args([
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-g",
        &gop,
        "-keyint_min",
        &gop,
        "-sc_threshold",
        "0",
    ]);
    command.arg(&out);
    match command.status() {
        Ok(status) if status.success() && out.exists() => Some(out),
        other => {
            eprintln!("SKIP: no se pudo generar {name} con ffmpeg ({other:?})");
            None
        }
    }
}
