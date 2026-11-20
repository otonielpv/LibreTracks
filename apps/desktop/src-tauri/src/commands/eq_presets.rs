//! Presets de ecualizador (plan `track-eq-2`, paso 01).
//!
//! Biblioteca de cada máquina en `<app_local_data>/eq-presets/` (comandos
//! `local` en sesiones de red). Cargar un preset en una pista no pasa por aquí:
//! es el `commit_track_eq_change` de siempre.

use libretracks_core::TrackEq;
use libretracks_project::eq_presets::{EqPreset, EqPresetLibrary};
use tauri::{AppHandle, Manager};

fn library(app: &AppHandle) -> Result<EqPresetLibrary, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| format!("no app data dir: {error}"))?;
    Ok(EqPresetLibrary::new(base.join("eq-presets")))
}

/// Fábrica primero, después los del usuario por nombre.
#[tauri::command(async)]
pub fn list_eq_presets(app: AppHandle) -> Result<Vec<EqPreset>, String> {
    library(&app)?.list().map_err(|e| e.to_string())
}

/// Sin `preset_id` crea uno nuevo; con él lo sustituye (renombrar). Devuelve
/// la lista completa ya actualizada.
#[tauri::command(async)]
pub fn save_eq_preset(
    preset_id: Option<String>,
    name: String,
    eq: TrackEq,
    app: AppHandle,
) -> Result<Vec<EqPreset>, String> {
    let library = library(&app)?;
    library
        .save(preset_id.as_deref(), &name, &eq)
        .map_err(|e| e.to_string())?;
    library.list().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_eq_preset(preset_id: String, app: AppHandle) -> Result<Vec<EqPreset>, String> {
    let library = library(&app)?;
    library.delete(&preset_id).map_err(|e| e.to_string())?;
    library.list().map_err(|e| e.to_string())
}
