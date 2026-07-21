//! Dedicated application *error* log — separate from the ad-hoc debug logs
//! (`transport-dnd.log`, `update-check.log`, the `eprintln!`-gated audio jump
//! traces). Those are developer debug streams that can grow huge; this file is
//! reserved for actual errors a user might need to send us when reporting a
//! problem: Rust panics, critical command failures, and frontend exceptions.
//!
//! Writes to `<app_data>/logs/errors.log` with size-based rotation (one old
//! generation). The logger is best-effort and MUST never panic or propagate:
//! if the log directory is not writable it degrades to a silent no-op so the
//! app is unaffected.

use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate once the active log reaches ~1 MB. Keeps the error log small enough
/// to copy/paste or attach to a bug report.
const MAX_BYTES: u64 = 1_048_576;

struct ErrorLogger {
    dir: PathBuf,
    path: PathBuf,
    /// `None` when the log dir could not be created/opened — every write then
    /// becomes a no-op instead of erroring.
    file: Mutex<Option<File>>,
}

static LOGGER: OnceLock<ErrorLogger> = OnceLock::new();

/// Initialize the error logger. Call once from Tauri's `setup()` after
/// `app_data_dir()` resolves. Safe to call more than once (later calls are
/// ignored). Never panics.
pub fn init(app_data_dir: PathBuf) {
    let dir = app_data_dir.join("logs");
    let path = dir.join("errors.log");
    let file = match fs::create_dir_all(&dir) {
        Ok(()) => OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok(),
        Err(_) => None,
    };
    let _ = LOGGER.set(ErrorLogger {
        dir,
        path,
        file: Mutex::new(file),
    });
}

/// Path to the active `errors.log`, once `init` has run.
pub fn errors_path() -> Option<PathBuf> {
    LOGGER.get().map(|logger| logger.path.clone())
}

/// Append one error line. Thread-safe and panic-free — callable from any
/// thread, including the panic hook. A no-op until `init` runs or if the log
/// dir is not writable.
pub fn write_error(message: &str) {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    // Recover a poisoned lock rather than unwrapping: if a thread panicked
    // while holding this lock, unwrapping here (often from the panic hook
    // itself) would double-panic and abort the process.
    let mut guard = match logger.file.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(file) = guard.as_mut() else {
        return;
    };

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    // Ignore write/flush failures (disk full, revoked handle): logging must
    // never fail the app.
    let _ = writeln!(file, "[{timestamp_ms}] {message}");
    let _ = file.flush();

    // Rotate inside the same critical section as the write that tripped the
    // threshold, so two threads can never rotate concurrently.
    if let Ok(metadata) = file.metadata() {
        if metadata.len() >= MAX_BYTES {
            rotate(logger, &mut guard);
        }
    }
}

/// Rotate `errors.log` -> `errors.log.1` (keeping one generation) and reopen a
/// fresh active file. Caller already holds the file lock. On Windows a file
/// cannot be renamed while a handle is open, so we drop the handle first.
fn rotate(logger: &ErrorLogger, guard: &mut Option<File>) {
    *guard = None;
    let rotated = logger.dir.join("errors.log.1");
    let _ = fs::remove_file(&rotated);
    let _ = fs::rename(&logger.path, &rotated);
    *guard = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&logger.path)
        .ok();
}

/// Install a panic hook that records every Rust panic (message, location,
/// backtrace) to the error log while preserving the default panic output for
/// development. Call once, as early as possible in `main()` — BEFORE building
/// the Tauri app — so panics during plugin/setup also get captured. The hook
/// needs no `AppHandle`; it only calls [`write_error`], which is a no-op until
/// [`init`] runs.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Print the default panic output first so a logger bug can't suppress it.
        default_hook(info);

        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|message| (*message).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();

        write_error(&format!(
            "PANIC at {location}: {payload}\nbacktrace:\n{backtrace}"
        ));
    }));
}

/// Helper for command `map_err`: records a failed command and returns the
/// message unchanged so the command's `Result<T, String>` contract is intact.
///
/// ```ignore
/// .map_err(|error| crate::infra::error_log::log_command_err("save_project", error))
/// ```
pub fn log_command_err(command: &str, message: impl Display) -> String {
    let message = message.to_string();
    write_error(&format!("command {command} failed: {message}"));
    message
}
