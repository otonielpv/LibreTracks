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
        let c_str =
            std::ffi::CString::new(json).map_err(|e| EngineError::Serialization(e.to_string()))?;
        let rc = unsafe { lt_audio_engine_send_command(self.handle, c_str.as_ptr()) };
        lt_result_to_rust(rc)
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
        })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { lt_audio_engine_destroy(self.handle) };
    }
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
