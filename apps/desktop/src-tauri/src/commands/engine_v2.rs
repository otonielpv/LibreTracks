//! Tauri commands for the C++ Audio Engine v2.
//!
//! This is now the desktop audio command surface; the old Rust runtime was
//! removed during the C++ engine v2 cutover.

use lt_audio_engine_v2::{Engine, EngineCommand, EngineError, EngineSnapshot};
use std::sync::Mutex;
use tauri::State;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct EngineV2State(pub Mutex<Option<Engine>>);

impl EngineV2State {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
fn with_engine<F, T>(state: &State<'_, EngineV2State>, f: F) -> Result<T, String>
where
    F: FnOnce(&Engine) -> Result<T, EngineError>,
{
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(engine) => f(engine).map_err(|e| e.to_string()),
        None => Err("Engine v2 not initialized".into()),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn engine_v2_initialize(state: State<'_, EngineV2State>) -> Result<String, String> {
    let engine = Engine::new().map_err(|e| e.to_string())?;
    engine.initialize().map_err(|e| e.to_string())?;
    let version = engine.version();
    *state.0.lock().map_err(|e| e.to_string())? = Some(engine);
    Ok(version)
}

#[tauri::command]
pub fn engine_v2_shutdown(state: State<'_, EngineV2State>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(engine) = guard.as_ref() {
        engine.shutdown().map_err(|e| e.to_string())?;
    }
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn engine_v2_get_version(state: State<'_, EngineV2State>) -> Result<String, String> {
    with_engine(&state, |e| Ok(e.version()))
}

#[tauri::command]
pub fn engine_v2_get_snapshot(state: State<'_, EngineV2State>) -> Result<EngineSnapshot, String> {
    with_engine(&state, |e| e.get_snapshot().map_err(|err| err))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_v2_send_command(
    state: State<'_, EngineV2State>,
    command: EngineCommand,
) -> Result<(), String> {
    with_engine(&state, |e| e.send_command(&command))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_v2_poll_events(
    state: State<'_, EngineV2State>,
) -> Result<Vec<lt_audio_engine_v2::EngineEvent>, String> {
    with_engine(&state, |e| Ok(e.drain_events()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_v2_list_devices(
    state: State<'_, EngineV2State>,
) -> Result<Vec<lt_audio_engine_v2::DeviceInfo>, String> {
    with_engine(&state, |e| e.list_devices())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_v2_get_diagnostics(state: State<'_, EngineV2State>) -> Result<String, String> {
    with_engine(&state, |e| Ok(e.diagnostics()))
        .map_err(|e| e.to_string())
}

/// Load a session from a serialized libretracks-project JSON string.
/// Decodes all sources and installs the Mixer callback.
#[tauri::command]
pub fn engine_v2_load_session(
    state: State<'_, EngineV2State>,
    project_json: String,
) -> Result<(), String> {
    with_engine(&state, |e| {
        e.send_command(&EngineCommand::LoadSession { project_json })
    })
    .map_err(|e| e.to_string())
}
