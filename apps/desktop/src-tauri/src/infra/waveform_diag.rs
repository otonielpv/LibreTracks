//! Timing instrumentation for the waveform request path.
//!
//! Why this exists: a 25-stem multitrack of native WAVs freezes the UI for 6-7
//! seconds with no progress feedback. Measurements so far (see
//! `bench_waveform_peaks`) show `analyze_file_peaks` costs ~260 ms per stem
//! (6567 ms for 25), and code reading points at `get_waveform_summaries`
//! holding the session lock across `prime_waveforms_from_engine_peaks`.
//!
//! That chain is inferred, not observed. These logs close the gap: they record
//! how long each stage actually takes in a real run, so the fix targets a
//! measured cause rather than a plausible one.
//!
//! Enable with `LIBRETRACKS_WAVEFORM_DIAG=1`. Off by default and cheap when
//! off (one relaxed atomic load per call site). Lines go to
//! `waveform-diag.log` next to the other diagnostic logs.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("LIBRETRACKS_WAVEFORM_DIAG")
            .map(|value| value != "0" && !value.is_empty())
            .unwrap_or(false)
    })
}

pub fn is_enabled() -> bool {
    enabled()
}

fn log_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = {
            #[cfg(target_os = "windows")]
            {
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .map(|dir| dir.join("LibreTracks"))
            }
            #[cfg(not(target_os = "windows"))]
            {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|dir| dir.join(".libretracks"))
            }
        }?;
        create_dir_all(&dir).ok()?;
        Some(dir.join("waveform-diag.log"))
    })
    .as_ref()
}

/// Monotonic sequence so interleaved lines from the command thread and the
/// waveform worker can be ordered even when their timestamps collide.
fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

pub fn log(line: impl AsRef<str>) {
    if !enabled() {
        return;
    }
    let Some(path) = log_path() else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let thread = std::thread::current()
        .name()
        .map(|n| n.to_string())
        .unwrap_or_else(|| format!("{:?}", std::thread::current().id()));
    let _ = writeln!(file, "[{ms}] #{} <{thread}> {}", next_seq(), line.as_ref());
}

/// Marks the start of a session and notes it in the log, so a run can be told
/// apart from the previous one in the same file.
pub fn mark_run_start(context: &str) {
    if !enabled() {
        return;
    }
    static ANNOUNCED: AtomicBool = AtomicBool::new(false);
    if !ANNOUNCED.swap(true, Ordering::Relaxed) {
        log("=== waveform diagnostics enabled (LIBRETRACKS_WAVEFORM_DIAG) ===");
    }
    log(format!("--- run: {context} ---"));
}

/// Times a scope and logs its duration on drop. Logs regardless of how the
/// scope exits, so an early return or a `?` still reports.
pub struct Span {
    label: String,
    started: Instant,
    threshold_ms: u128,
}

impl Span {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            started: Instant::now(),
            threshold_ms: 0,
        }
    }

    /// Only log if the scope took at least `ms` — keeps per-file noise down
    /// while still catching the slow ones.
    pub fn slow_only(label: impl Into<String>, ms: u128) -> Self {
        Self {
            label: label.into(),
            started: Instant::now(),
            threshold_ms: ms,
        }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.started.elapsed().as_millis()
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        if !enabled() {
            return;
        }
        let ms = self.started.elapsed().as_millis();
        if ms >= self.threshold_ms {
            log(format!("{} took {ms}ms", self.label));
        }
    }
}
