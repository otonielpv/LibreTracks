use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::DesktopError;
use crate::settings::{
    apply_decoding_cache_env, save_app_settings, AppSettings, AppSettingsStore,
};
use crate::state::DesktopState;

#[tauri::command]
pub fn get_settings(settings_store: State<'_, AppSettingsStore>) -> Result<AppSettings, String> {
    settings_store.current().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
) -> Result<AppSettings, String> {
    let previous_settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    settings_store
        .set(settings.clone())
        .map_err(|error| error.to_string())?;
    save_app_settings(&app, &settings).map_err(|error| error.to_string())?;
    if previous_settings != settings {
        app.emit("settings:updated", settings.clone())
            .map_err(|error| error.to_string())?;
    }
    Ok(settings)
}

#[tauri::command]
pub fn update_audio_settings(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let previous_settings = state
        .audio
        .current_settings()
        .map_err(|error| error.to_string())?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let next_settings = session
        .update_audio_settings(settings, &state.audio)
        .map_err(|error| crate::error_log::log_command_err("update_audio_settings", error))?;
    drop(session);

    settings_store
        .set(next_settings.clone())
        .map_err(|error| error.to_string())?;

    if previous_settings.selected_midi_device != next_settings.selected_midi_device {
        state
            .midi
            .restart(
                app.clone(),
                state.audio.command_sender(),
                next_settings.selected_midi_device.clone(),
            )
            .map_err(|error| error.to_string())?;
    }

    if previous_settings != next_settings {
        app.emit("settings:updated", next_settings.clone())
            .map_err(|error| error.to_string())?;
    }

    Ok(next_settings)
}

#[tauri::command]
pub fn set_metronome_enabled_realtime(
    enabled: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .audio
        .set_metronome_enabled_realtime(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_metronome_volume_realtime(
    volume: f64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .audio
        .set_metronome_volume_realtime(volume)
        .map_err(|error| error.to_string())
}

/// Apply metronome sound settings (presets, pitch, subdivision) live without
/// reopening the audio device, and persist them. Used so tweaking the click
/// sound never pauses playback.
#[tauri::command]
pub fn set_metronome_sound_realtime(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    state
        .audio
        .set_metronome_sound_realtime(&settings)
        .map_err(|error| error.to_string())?;
    // Keep the in-memory engine settings in sync so a later device change
    // rebuilds with the right metronome config.
    state
        .audio
        .replace_settings(settings.clone())
        .map_err(|error| error.to_string())?;
    settings_store
        .set(settings.clone())
        .map_err(|error| error.to_string())?;
    save_app_settings(&app, &settings).map_err(|error| error.to_string())?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Decoding cache (Ableton-style "Decoding Cache" preferences)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodingCacheInfo {
    /// Effective directory the engine writes `.rf64` files into.
    pub dir: String,
    /// Bytes currently occupied by cache files on disk.
    pub size_bytes: u64,
    /// Configured maximum in GiB, or `None` for the automatic policy.
    pub max_gb: Option<u32>,
}

/// Persist one mutation to the settings store + disk and re-apply the cache env
/// so the change takes effect live. Emits `settings:updated` when changed.
fn persist_settings(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    next: AppSettings,
) -> Result<AppSettings, String> {
    let previous = settings_store.current().map_err(|e| e.to_string())?;
    settings_store.set(next.clone()).map_err(|e| e.to_string())?;
    save_app_settings(app, &next).map_err(|e| e.to_string())?;
    apply_decoding_cache_env(&next);
    if previous != next {
        app.emit("settings:updated", next.clone())
            .map_err(|e| e.to_string())?;
    }
    Ok(next)
}

#[tauri::command]
pub fn get_decoding_cache_info(
    settings_store: State<'_, AppSettingsStore>,
) -> Result<DecodingCacheInfo, String> {
    let settings = settings_store.current().map_err(|e| e.to_string())?;
    // The engine resolves the effective path from the env we keep in sync; fall
    // back to the configured value if the engine returns nothing (e.g. no-link).
    let mut dir = lt_audio_engine_v2::decoding_cache_dir();
    if dir.is_empty() {
        dir = settings.decoding_cache_dir.clone().unwrap_or_default();
    }
    Ok(DecodingCacheInfo {
        dir,
        size_bytes: lt_audio_engine_v2::decoding_cache_size_bytes(),
        max_gb: settings.decoding_cache_max_gb,
    })
}

/// Set (or clear, with `None`) the decoding-cache folder. Existing files in the
/// old folder are left untouched (matches Ableton Live) — they are reclaimed by
/// LRU eviction or a manual purge.
#[tauri::command]
pub fn set_decoding_cache_dir(
    app: AppHandle,
    dir: Option<String>,
    settings_store: State<'_, AppSettingsStore>,
) -> Result<AppSettings, String> {
    let dir = dir.filter(|d| !d.trim().is_empty());
    if let Some(ref path) = dir {
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("cache folder is not accessible: {e}"))?;
        if !meta.is_dir() {
            return Err("selected path is not a directory".into());
        }
    }
    let mut next = settings_store.current().map_err(|e| e.to_string())?;
    next.decoding_cache_dir = dir;
    persist_settings(&app, &settings_store, next)
}

/// Set (or clear, with `None` = automatic) the decoding-cache size cap in GiB.
#[tauri::command]
pub fn set_decoding_cache_max_gb(
    app: AppHandle,
    max_gb: Option<u32>,
    settings_store: State<'_, AppSettingsStore>,
) -> Result<AppSettings, String> {
    // 0 is meaningless as a cap here (the engine treats env=0 as "disabled",
    // which we don't expose); normalise it to the automatic policy instead.
    let max_gb = max_gb.filter(|gb| *gb > 0);
    let mut next = settings_store.current().map_err(|e| e.to_string())?;
    next.decoding_cache_max_gb = max_gb;
    persist_settings(&app, &settings_store, next)
}

/// Delete all on-disk decoded-PCM cache files. Returns bytes freed.
#[tauri::command]
pub fn purge_decoding_cache() -> Result<u64, String> {
    Ok(lt_audio_engine_v2::purge_decoding_cache())
}
