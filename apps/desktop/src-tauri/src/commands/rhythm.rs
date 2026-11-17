//! Comandos Tauri de loops de batería y one shots (plan drum-loops, paso 05).
//!
//! - Biblioteca y canción: camino normal (disco, sesión, `send_command`).
//! - Directo (`loop_*`, `one_shot_*`): camino rápido `AudioController::rhythm_trigger`,
//!   sin JSON ni snapshot (D9).

use libretracks_core::drum_loops::{DrumKit, LoopPattern, LoopRowLiveState, OneShotSet, RegionLoop, SampleRef};
use lt_audio_engine_v2::{EngineCommand, TriggerKind, TriggerOutcome};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::audio::engine::rhythm_loop_config;
use crate::infra::error::DesktopError;
use crate::infra::settings::{save_app_settings, AppSettings, AppSettingsStore};
use crate::models::TransportSnapshot;
use crate::rhythm::import::{import_user_sample as import_sample, UserSampleKind};
use crate::rhythm::meters::{rhythm_meter_payload, RhythmMeterPayload};
use crate::state::DesktopState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmLibraryView {
    pub kits: Vec<DrumKit>,
    pub patterns: Vec<LoopPattern>,
    pub one_shots: OneShotSet,
}

fn library_view(state: &DesktopState) -> Result<RhythmLibraryView, String> {
    let library = state.audio.rhythm_library().ok_or("rhythm library not configured")?;
    let data = library.load().map_err(|e| e.to_string())?;
    Ok(RhythmLibraryView {
        kits: data.kits,
        patterns: data.patterns,
        one_shots: data.one_shots,
    })
}

/// Tras tocar la biblioteca: el motor recibe lo que cambió. Un fallo del
/// motor no deshace lo guardado en disco.
fn resync(state: &DesktopState) {
    if let Err(error) = state.audio.sync_rhythm() {
        eprintln!("[libretracks-rhythm] sync failed: {error}");
    }
}

fn with_library<T>(
    state: &DesktopState,
    f: impl FnOnce(&libretracks_project::rhythm_library::RhythmLibrary) -> Result<T, libretracks_project::ProjectError>,
) -> Result<RhythmLibraryView, String> {
    let library = state.audio.rhythm_library().ok_or("rhythm library not configured")?;
    f(&library).map_err(|e| e.to_string())?;
    resync(state);
    library_view(state)
}

#[tauri::command(async)]
pub fn get_rhythm_library(state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    library_view(&state)
}

#[tauri::command(async)]
pub fn get_rhythm_state(state: State<'_, DesktopState>) -> Result<RhythmMeterPayload, String> {
    state
        .audio
        .rhythm_live_state()
        .map(|loops| rhythm_meter_payload(&loops))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn save_loop_pattern(pattern: LoopPattern, state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    with_library(&state, |lib| lib.save_pattern(&pattern))
}

#[tauri::command(async)]
pub fn delete_loop_pattern(pattern_id: String, state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    with_library(&state, |lib| lib.delete_pattern(&pattern_id))
}

#[tauri::command(async)]
pub fn save_drum_kit(kit: DrumKit, state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    with_library(&state, |lib| lib.save_kit(&kit))
}

#[tauri::command(async)]
pub fn delete_drum_kit(kit_id: String, state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    with_library(&state, |lib| lib.delete_kit(&kit_id))
}

#[tauri::command(async)]
pub fn save_one_shot_set(set: OneShotSet, state: State<'_, DesktopState>) -> Result<RhythmLibraryView, String> {
    with_library(&state, |lib| lib.save_one_shot_set(&set))
}

/// Asigna a la canción una copia del patrón con su kit incrustado (D5):
/// editarla después no toca la biblioteca y viaja con la sesión.
#[tauri::command(async)]
pub fn assign_loop_to_song(
    region_id: String,
    pattern: LoopPattern,
    autostart: Option<bool>,
    initial_rows: Option<Vec<LoopRowLiveState>>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let library = state.audio.rhythm_library().ok_or("rhythm library not configured")?;
    let kits = library.list_kits().map_err(|e| e.to_string())?;
    let embedded = crate::rhythm::embed_kit(&pattern, &kits).ok_or("pattern kit not found")?;
    let region_loop = RegionLoop {
        pattern: embedded,
        autostart: autostart.unwrap_or(true),
        initial_rows: initial_rows.unwrap_or_default(),
    };
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_song_region_loop(&region_id, Some(region_loop), &state.audio)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn clear_song_loop(region_id: String, state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_song_region_loop(&region_id, None, &state.audio)
        .map_err(|e| e.to_string())
}

fn trigger(state: &DesktopState, kind: TriggerKind, index: i32, value: i32) -> Result<bool, String> {
    state
        .audio
        .rhythm_trigger(kind, index, value)
        .map(|outcome| outcome != TriggerOutcome::Dropped)
        .map_err(|e| e.to_string())
}

/// Arranca o para el loop (cuantizado). `false` = disparo descartado.
#[tauri::command(async)]
pub fn loop_toggle(state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::LoopToggle, 0, 0)
}

/// Enciende o apaga una fila (cuantizado).
#[tauri::command(async)]
pub fn loop_toggle_row(row: i32, state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::LoopRow, row, 0)
}

/// Cambia la variación de una fila (cuantizado).
#[tauri::command(async)]
pub fn loop_set_row(row: i32, variation: i32, state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::LoopVariation, row, variation.clamp(0, 3))
}

#[tauri::command(async)]
pub fn loop_set_all_rows(variation: i32, state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::LoopVariation, -1, variation.clamp(0, 3))
}

#[tauri::command(async)]
pub fn one_shot_down(pad: i32, velocity: Option<i32>, state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::OneShotDown, pad, velocity.unwrap_or(127).clamp(1, 127))
}

#[tauri::command(async)]
pub fn one_shot_up(pad: i32, state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::OneShotUp, pad, 0)
}

#[tauri::command(async)]
pub fn one_shots_stop_all(state: State<'_, DesktopState>) -> Result<bool, String> {
    trigger(&state, TriggerKind::OneShotStopAll, 0, 0)
}

fn update_settings(
    app: &AppHandle,
    store: &AppSettingsStore,
    state: &DesktopState,
    f: impl FnOnce(&mut AppSettings),
) -> Result<AppSettings, String> {
    let mut settings = store.current().map_err(|e| e.to_string())?;
    f(&mut settings);
    state.audio.replace_settings(settings.clone()).map_err(|e| e.to_string())?;
    store.set(settings.clone()).map_err(|e| e.to_string())?;
    save_app_settings(app, &settings).map_err(|e| e.to_string())?;
    // Toda la UI (no solo el panel que lo pidió) ve los ajustes nuevos.
    let _ = app.emit("settings:updated", &settings);
    Ok(settings)
}

#[tauri::command(async)]
pub fn set_loop_config(
    clock_mode: String,
    free_bpm: f64,
    quantize: String,
    output: String,
    volume: f64,
    app: AppHandle,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let settings = update_settings(&app, &settings_store, &state, |s| {
        s.loop_clock_mode = if clock_mode == "free" { "free".into() } else { "follow".into() };
        s.loop_free_bpm = if free_bpm > 0.0 { free_bpm.clamp(30.0, 300.0) } else { 0.0 };
        s.loop_quantize = match quantize.as_str() {
            "beat" | "immediate" => quantize.clone(),
            _ => "bar".into(),
        };
        s.loop_output = output.clone();
        s.loop_volume = volume.clamp(0.0, 4.0);
    })?;
    state
        .audio
        .send_rhythm_command("set_loop_config", rhythm_loop_config(&settings))
        .map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command(async)]
pub fn set_one_shot_config(
    output: String,
    volume: f64,
    app: AppHandle,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let settings = update_settings(&app, &settings_store, &state, |s| {
        s.one_shot_output = output.clone();
        s.one_shot_volume = volume.clamp(0.0, 4.0);
    })?;
    state
        .audio
        .send_rhythm_command(
            "set_one_shot_config",
            EngineCommand::SetOneShotConfig {
                route: settings.one_shot_output.clone(),
                gain: settings.one_shot_volume as f32,
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command(async)]
pub fn set_active_pattern(
    pattern_id: String,
    app: AppHandle,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let settings = update_settings(&app, &settings_store, &state, |s| s.active_loop_pattern_id = pattern_id.clone())?;
    resync(&state);
    Ok(settings)
}

#[tauri::command(async)]
pub fn set_one_shot_bank(
    bank: u8,
    app: AppHandle,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let settings = update_settings(&app, &settings_store, &state, |s| s.active_one_shot_bank = bank.min(3))?;
    resync(&state);
    Ok(settings)
}

/// Importa una muestra propia a `loops/user/` (WAV 16 bit, límites de D11).
#[tauri::command(async)]
pub fn import_user_sample(path: String, kind: UserSampleKind, state: State<'_, DesktopState>) -> Result<SampleRef, String> {
    let library = state.audio.rhythm_library().ok_or("rhythm library not configured")?;
    import_sample(std::path::Path::new(&path), &library.user_dir(), kind)
}
