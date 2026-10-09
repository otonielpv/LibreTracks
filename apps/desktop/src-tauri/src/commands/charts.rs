//! Letra y acordes de cada canción. Ver `state/charts.rs`.

use libretracks_core::SongChart;
use tauri::State;

use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;

/// Sustituye la letra de una canción; `chart: null` la quita.
#[tauri::command(async)]
pub fn set_song_region_chart(
    region_id: String,
    chart: Option<SongChart>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_song_region_chart(&region_id, chart, &state.audio)
        .map_err(|error| error.to_string())
}
