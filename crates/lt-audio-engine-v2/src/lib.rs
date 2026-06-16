//! Rust FFI bindings for the LibreTracks C++ Audio Engine v2.
//!
//! Exposes a safe `Engine` wrapper around the raw C ABI.
//! The C++ shared library is loaded at link time (build.rs).

mod commands;
mod error;
mod events;
mod ffi;
mod snapshot;

#[cfg(test)]
mod tests;

pub use commands::*;
pub use error::EngineError;
pub use events::*;
pub use snapshot::*;

use ffi::*;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Safe wrapper
// ---------------------------------------------------------------------------

/// A handle to the C++ audio engine.
///
/// ## Thread safety
/// `Engine` is `Send` but not `Sync`.  All interaction should go through a
/// single command thread (the Tauri async handler).
pub struct Engine {
    handle: *mut LtEngine,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SourcePeaks {
    pub sample_rate: u32,
    pub duration_frames: i64,
    pub resolution_frames: usize,
    pub min_peaks: Vec<f32>,
    pub max_peaks: Vec<f32>,
    pub min_peaks_right: Vec<f32>,
    pub max_peaks_right: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct SourcePeaksResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    sample_rate: u32,
    #[serde(default)]
    duration_frames: i64,
    #[serde(default)]
    resolution_frames: usize,
    #[serde(default)]
    min_peaks: Vec<f32>,
    #[serde(default)]
    max_peaks: Vec<f32>,
    #[serde(default)]
    min_peaks_right: Vec<f32>,
    #[serde(default)]
    max_peaks_right: Vec<f32>,
}

// SAFETY: EngineImpl internally synchronises its state.  The Rust wrapper
// does not expose &-sharing across threads.
unsafe impl Send for Engine {}

impl Engine {
    /// Allocate a new engine instance.
    pub fn new() -> Result<Self, EngineError> {
        let handle = unsafe { lt_audio_engine_create() };
        if handle.is_null() {
            return Err(EngineError::CreateFailed);
        }
        Ok(Self { handle })
    }

    pub fn initialize(&self) -> Result<(), EngineError> {
        let rc = unsafe { lt_audio_engine_initialize(self.handle) };
        lt_result_to_rust(rc)
    }

    pub fn shutdown(&self) -> Result<(), EngineError> {
        let rc = unsafe { lt_audio_engine_shutdown(self.handle) };
        lt_result_to_rust(rc)
    }

    pub fn version(&self) -> String {
        let ptr = unsafe { lt_audio_engine_get_version(self.handle) };
        if ptr.is_null() {
            return "0.0.0".into();
        }
        unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }

    pub fn diagnostics(&self) -> String {
        let ptr = unsafe { lt_audio_engine_get_diagnostics(self.handle) };
        if ptr.is_null() {
            return "{}".into();
        }
        unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }

    pub fn send_command(&self, cmd: &EngineCommand) -> Result<(), EngineError> {
        let json =
            serde_json::to_string(cmd).map_err(|e| EngineError::Serialization(e.to_string()))?;
        let log_failures = audio_debug_enabled();
        let json_for_log = if log_failures {
            Some(json.clone())
        } else {
            None
        };
        let c_str =
            std::ffi::CString::new(json).map_err(|e| EngineError::Serialization(e.to_string()))?;
        // Snapshot of the device.last_error BEFORE the command so we can
        // distinguish a fresh error caused by this command from a stale
        // one left over from a previous failure (e.g. bootstrap failed to
        // open the output device → last_error stays "Couldn't open the
        // output device!" forever, and every subsequent unrelated failure
        // would surface that wrong message).
        let last_error_before = self
            .get_snapshot()
            .ok()
            .map(|s| s.device.last_error)
            .unwrap_or_default();
        let rc = unsafe { lt_audio_engine_send_command(self.handle, c_str.as_ptr()) };
        match lt_result_to_rust(rc) {
            Ok(()) => Ok(()),
            Err(error) => {
                // Pull the post-command last_error and report it only if
                // it's different from the snapshot we took before — that
                // way we surface the real cause of *this* failure instead
                // of an outdated message.
                let last_error_after = self
                    .get_snapshot()
                    .ok()
                    .map(|s| s.device.last_error)
                    .unwrap_or_default();
                let detail =
                    if last_error_after != last_error_before && !last_error_after.is_empty() {
                        Some(last_error_after.clone())
                    } else {
                        None
                    };
                let command_kind = command_tag(cmd);
                if let Some(ref payload) = json_for_log {
                    let truncated_json = truncate_command_json(payload);
                    eprintln!(
                        "[engine] send_command failed: kind={command_kind} error={error:?} \
                         fresh_detail={detail:?} stale_last_error={last_error_after:?} \
                         payload={truncated_json}"
                    );
                }
                Err(match (error, detail) {
                    (EngineError::InvalidCommand, Some(message)) => {
                        EngineError::Internal(format!("{command_kind}: {message}"))
                    }
                    (EngineError::InvalidCommand, None) => EngineError::Internal(format!(
                        "{command_kind}: engine returned invalid-command with no fresh \
                         detail (stale device.last_error: {last_error_after:?})"
                    )),
                    (other, Some(message)) => {
                        EngineError::Internal(format!("{command_kind}: {other}: {message}"))
                    }
                    (other, None) => other,
                })
            }
        }
    }

    /// Service control-thread housekeeping tasks (pitch repair etc.).
    /// Call once before dispatching a batch of `send_command` calls.
    pub fn service_control_thread(&self) {
        unsafe { lt_audio_engine_service_control_thread(self.handle) };
    }

    /// Drain all pending events from the engine.
    /// Returns `None` when the queue is empty.
    pub fn poll_event(&self) -> Option<EngineEvent> {
        let ptr = unsafe { lt_audio_engine_poll_event(self.handle) };
        if ptr.is_null() {
            return None;
        }
        let s = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy() };
        serde_json::from_str(&s).ok()
    }

    /// Drain all available events into a `Vec`.
    pub fn drain_events(&self) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        while let Some(ev) = self.poll_event() {
            events.push(ev);
        }
        events
    }

    pub fn get_snapshot(&self) -> Result<EngineSnapshot, EngineError> {
        let ptr = unsafe { lt_audio_engine_get_snapshot(self.handle) };
        if ptr.is_null() {
            return Err(EngineError::SnapshotFailed);
        }
        let s = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy() };
        serde_json::from_str(&s).map_err(|e| EngineError::Serialization(e.to_string()))
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>, EngineError> {
        let ptr = unsafe { lt_audio_engine_list_devices(self.handle) };
        if ptr.is_null() {
            return Ok(vec![]);
        }
        let s = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy() };
        serde_json::from_str(&s).map_err(|e| EngineError::Serialization(e.to_string()))
    }

    pub fn source_peaks(
        &self,
        source_id: &str,
        resolution_frames: usize,
    ) -> Result<SourcePeaks, EngineError> {
        let source_id = std::ffi::CString::new(source_id)
            .map_err(|e| EngineError::Serialization(e.to_string()))?;
        let ptr = unsafe {
            lt_audio_engine_get_source_peaks(
                self.handle,
                source_id.as_ptr(),
                resolution_frames.min(i32::MAX as usize) as i32,
            )
        };
        if ptr.is_null() {
            return Err(EngineError::Internal("source peaks returned null".into()));
        }
        let s = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy() };
        let response: SourcePeaksResponse =
            serde_json::from_str(&s).map_err(|e| EngineError::Serialization(e.to_string()))?;
        if !response.ok {
            return Err(EngineError::Internal(
                response
                    .error
                    .unwrap_or_else(|| "source peaks unavailable".into()),
            ));
        }
        Ok(SourcePeaks {
            sample_rate: response.sample_rate,
            duration_frames: response.duration_frames,
            resolution_frames: response.resolution_frames,
            min_peaks: response.min_peaks,
            max_peaks: response.max_peaks,
            min_peaks_right: response.min_peaks_right,
            max_peaks_right: response.max_peaks_right,
        })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { lt_audio_engine_destroy(self.handle) };
    }
}

// ---------------------------------------------------------------------------
// Decoding-cache maintenance (engine-independent)
//
// These operate on the on-disk decoded-PCM cache directory, which the C++ side
// resolves from $LIBRETRACKS_CACHE_DIR. They do NOT need a live `Engine`, so a
// host can report or clear the cache from a plain command without holding the
// engine lock.
// ---------------------------------------------------------------------------

/// The effective on-disk decoded-PCM cache directory (honours
/// `LIBRETRACKS_CACHE_DIR`). Empty string if the engine could not resolve it.
pub fn decoding_cache_dir() -> String {
    let ptr = unsafe { lt_audio_engine_source_cache_dir() };
    if ptr.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

pub fn file_peaks(
    file_path: &str,
    resolution_frames: usize,
) -> Result<SourcePeaks, EngineError> {
    let file_path = std::ffi::CString::new(file_path)
        .map_err(|e| EngineError::Serialization(e.to_string()))?;
    let ptr = unsafe {
        lt_audio_engine_analyze_file_peaks(
            file_path.as_ptr(),
            resolution_frames.min(i32::MAX as usize) as i32,
        )
    };
    source_peaks_from_json(ptr)
}

/// Total bytes occupied by the on-disk decoded-PCM cache (.rf64 files).
pub fn decoding_cache_size_bytes() -> u64 {
    unsafe { lt_audio_engine_source_cache_size_bytes() }
}

/// Delete all on-disk decoded-PCM cache files. Returns bytes freed.
pub fn purge_decoding_cache() -> u64 {
    unsafe { lt_audio_engine_purge_source_cache() }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------
fn lt_result_to_rust(rc: LtResult) -> Result<(), EngineError> {
    match rc {
        LT_OK => Ok(()),
        LT_ERR_INVALID_HANDLE => Err(EngineError::InvalidHandle),
        LT_ERR_ALREADY_INIT => Err(EngineError::AlreadyInitialized),
        LT_ERR_NOT_INIT => Err(EngineError::NotInitialized),
        LT_ERR_INVALID_COMMAND => Err(EngineError::InvalidCommand),
        LT_ERR_DEVICE => Err(EngineError::Device("device error".into())),
        _ => Err(EngineError::Internal("unknown error code".into())),
    }
}

fn source_peaks_from_json(ptr: *const std::ffi::c_char) -> Result<SourcePeaks, EngineError> {
    if ptr.is_null() {
        return Err(EngineError::Internal("source peaks returned null".into()));
    }
    let s = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy() };
    let response: SourcePeaksResponse =
        serde_json::from_str(&s).map_err(|e| EngineError::Serialization(e.to_string()))?;
    if !response.ok {
        return Err(EngineError::Internal(
            response
                .error
                .unwrap_or_else(|| "source peaks unavailable".into()),
        ));
    }
    Ok(SourcePeaks {
        sample_rate: response.sample_rate,
        duration_frames: response.duration_frames,
        resolution_frames: response.resolution_frames,
        min_peaks: response.min_peaks,
        max_peaks: response.max_peaks,
        min_peaks_right: response.min_peaks_right,
        max_peaks_right: response.max_peaks_right,
    })
}

/// Short, human-readable tag for an EngineCommand variant, used in error
/// messages and logs so "Invalid or unknown command" actually tells us
/// *which* command failed. We read it from the serialized JSON to avoid
/// having to update a giant match every time someone adds a variant.
fn command_tag(cmd: &EngineCommand) -> String {
    let serialized = match serde_json::to_value(cmd) {
        Ok(value) => value,
        Err(_) => return "EngineCommand(?)".to_string(),
    };
    serialized
        .get("type")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| "EngineCommand(?)".to_string())
}

/// Avoid dumping a multi-megabyte LoadSession payload into the log.
/// Keeps the first chunk so the kind/tag is visible plus enough context
/// to spot obvious garbage.
fn truncate_command_json(json: &str) -> String {
    const MAX: usize = 512;
    if json.len() <= MAX {
        return json.to_string();
    }
    let mut truncated = json[..MAX].to_string();
    truncated.push_str(&format!("…[truncated, total {} bytes]", json.len()));
    truncated
}

/// Cached check for `LIBRETRACKS_AUDIO_DEBUG`. Used to gate the
/// per-command failure dump in `send_command` so production runs stay
/// quiet but support can flip the env var to get the full trail without
/// recompiling. Cached because it's read on every failed command.
fn audio_debug_enabled() -> bool {
    use std::sync::OnceLock;
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var("LIBRETRACKS_AUDIO_DEBUG")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false)
    })
}
