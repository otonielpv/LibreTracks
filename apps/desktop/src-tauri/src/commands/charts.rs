//! Partitura PDF de cada canción. Ver `state/charts.rs`.

use tauri::State;

use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;

/// Copia un PDF elegido por el usuario a la sesión y lo asigna a la canción.
/// Los bytes vienen del selector del WebView (`<input type="file">`), el mismo
/// en escritorio, Android e iOS.
#[tauri::command(async)]
pub fn set_song_region_chart(
    region_id: String,
    file_name: String,
    bytes: Vec<u8>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_song_region_chart_from_bytes(&region_id, &file_name, &bytes, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn clear_song_region_chart(
    region_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .clear_song_region_chart(&region_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn set_song_chart_anchor(
    region_id: String,
    marker_id: String,
    page: u32,
    y: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_song_chart_anchor(&region_id, &marker_id, page, y, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn remove_song_chart_anchor(
    region_id: String,
    marker_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .remove_song_chart_anchor(&region_id, &marker_id, &state.audio)
        .map_err(|error| error.to_string())
}

/// Los bytes del PDF de una canción, en binario (sin pasar por JSON). La ruta
/// se resuelve bajo el lock y el fichero se lee FUERA de él: leer disco con la
/// sesión bloqueada congela la UI.
#[tauri::command(async)]
pub fn read_song_region_chart(
    region_id: String,
    state: State<'_, DesktopState>,
) -> Result<tauri::ipc::Response, String> {
    let path = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .song_region_chart_path(&region_id)
            .map_err(|error| error.to_string())?
    };
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("chart unreadable: {}: {error}", path.display()))
}
