//! Arreglos de canción: capturar el original de una región y construir la
//! canción arreglada a partir de él.
//!
//! Todo aquí trabaja en tiempo de fuente y con posiciones relativas al inicio
//! de la región: el warp y la colocación en el timeline son cosa de quien
//! llama (la sesión de escritorio).

use crate::model::{Marker, MarkerCategory, OriginalSnapshot};

/// Tempo que rige en `position` (relativa) del original: la última marca de
/// tempo en o antes de ella, o el tempo base si no hay ninguna.
pub fn governing_bpm_at(snapshot: &OriginalSnapshot, position: f64) -> f64 {
    snapshot
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds - snapshot.origin_seconds <= position + POSITION_EPS)
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|marker| marker.bpm)
        .unwrap_or(snapshot.base_bpm)
}

/// Compás que rige en `position` (relativa) del original, igual que
/// [`governing_bpm_at`].
pub fn governing_signature_at(snapshot: &OriginalSnapshot, position: f64) -> String {
    snapshot
        .time_signature_markers
        .iter()
        .filter(|marker| marker.start_seconds - snapshot.origin_seconds <= position + POSITION_EPS)
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|marker| marker.signature.clone())
        .unwrap_or_else(|| snapshot.base_time_signature.clone())
}

/// Tiempos por compás de una firma "N/D"; 4 si no se entiende.
pub fn beats_per_bar(signature: &str) -> f64 {
    signature
        .split_once('/')
        .and_then(|(numerator, _)| numerator.trim().parse::<u32>().ok())
        .filter(|numerator| *numerator > 0)
        .unwrap_or(4) as f64
}

/// Duración en compases de `view_seconds` de timeline con el tempo y el compás
/// que rigen en `position` del original. Las marcas de tempo describen la
/// rejilla del timeline (en vista), así que la duración tiene que venir ya en
/// vista.
pub fn bars_for_view_duration(
    snapshot: &OriginalSnapshot,
    position: f64,
    view_seconds: f64,
) -> f64 {
    let bpm = governing_bpm_at(snapshot, position).max(1.0);
    let bar_seconds = beats_per_bar(&governing_signature_at(snapshot, position)) * 60.0 / bpm;
    view_seconds / bar_seconds
}

/// Marca de sección (no de cue) del original con este id.
pub fn section_marker<'a>(snapshot: &'a OriginalSnapshot, marker_id: &str) -> Option<&'a Marker> {
    snapshot
        .section_markers
        .iter()
        .find(|marker| marker.id == marker_id && marker.category() == MarkerCategory::Section)
}

/// Igualdad de posiciones dentro del original.
pub(crate) const POSITION_EPS: f64 = 1e-9;
