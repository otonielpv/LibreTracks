//! Guardia de edición de las canciones con arreglo aplicado.
//!
//! Invariante: si una región tiene `applied_arrangement_id`, su contenido es
//! exactamente `build_arrangement(original, bloques)` colocado en su inicio.
//! Una edición de clips o marcas que lo rompa se perdería en silencio la
//! próxima vez que se aplique el arreglo, así que se rechaza con
//! `DesktopError::SongStructureLocked` y la UI ofrece "Editar original".
//!
//! Se comprueba en `persist_song_update_internal`, por donde pasan todas las
//! ediciones (UI, atajos, MIDI, remote, arrastres en vivo, deshacer), antes de
//! tocar nada.
//!
//! Excepciones que no se bloquean porque se pueden reflejar en el original:
//! - borrar una pista: sus clips salen también del original;
//! - mover o reordenar la canción: el original no cambia (se compara en
//!   relativo);
//! - renombrar o recolorear una marca: se propaga a sus copias `~n` y al
//!   original.
//!
//! Lo que es de la pista (volumen, mute, solo, pan, rutas, color, nombre) no
//! toca el contenido de la región y nunca dispara la guardia.

use std::collections::{HashMap, HashSet};

use libretracks_core::song_structure::owning_region_id;
use libretracks_core::{Clip, Marker, MidiClip, Song, TempoMarker, TimeSignatureMarker, VideoClip};
use serde::Serialize;
use serde_json::Value;

use crate::audio::automation::AutomationCue;
use crate::infra::error::DesktopError;

use super::song_structure::built_for_region;

/// Tolerancia al comparar posiciones: mover una canción suma el delta en coma
/// flotante y puede no coincidir bit a bit con colocar el original.
const POSITION_TOLERANCE: f64 = 1e-6;

/// Id base de una copia: `"coro~2"` → `"coro"`.
fn base_id(id: &str) -> &str {
    match id.rsplit_once('~') {
        Some((base, suffix))
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => id,
    }
}

/// Aplica las excepciones a `song` y comprueba el invariante en las regiones
/// con arreglo aplicado cuyo contenido cambió respecto a `previous`.
pub(super) fn reconcile_song_structures(
    previous: &Song,
    song: &mut Song,
) -> Result<(), DesktopError> {
    if !song.regions.iter().any(|region| region.structure.is_some()) {
        return Ok(());
    }
    drop_deleted_tracks_from_originals(song);
    propagate_marker_renames(previous, song);
    check_applied_regions(previous, song)
}

/// Borrar una pista saca sus clips del original: reaplicar no la resucita.
fn drop_deleted_tracks_from_originals(song: &mut Song) {
    let tracks: HashSet<String> = song.tracks.iter().map(|track| track.id.clone()).collect();
    for structure in song
        .regions
        .iter_mut()
        .filter_map(|region| region.structure.as_mut())
    {
        let original = &mut structure.original;
        original
            .clips
            .retain(|clip| tracks.contains(&clip.track_id));
        original
            .midi_clips
            .retain(|clip| tracks.contains(&clip.track_id));
        original
            .video_clips
            .retain(|clip| tracks.contains(&clip.track_id));
    }
}

/// Renombrar o recolorear una marca de una canción con arreglo aplicado
/// cambia también sus copias y el original, por el id base.
fn propagate_marker_renames(previous: &Song, song: &mut Song) {
    let before: HashMap<&str, &Marker> = previous
        .section_markers
        .iter()
        .map(|marker| (marker.id.as_str(), marker))
        .collect();
    let mut changes: Vec<(String, String, Option<String>)> = Vec::new();
    for marker in &song.section_markers {
        let Some(old) = before.get(marker.id.as_str()) else {
            continue;
        };
        if old.name == marker.name && old.color == marker.color {
            continue;
        }
        let applied = owning_region_id(song, marker.start_seconds)
            .and_then(|id| song.regions.iter().find(|region| region.id == id))
            .and_then(|region| region.structure.as_ref())
            .is_some_and(|structure| structure.applied_arrangement_id.is_some());
        if applied {
            changes.push((
                base_id(&marker.id).to_string(),
                marker.name.clone(),
                marker.color.clone(),
            ));
        }
    }
    for (base, name, color) in changes {
        for marker in song
            .section_markers
            .iter_mut()
            .filter(|marker| base_id(&marker.id) == base)
        {
            marker.name = name.clone();
            marker.color = color.clone();
        }
        for structure in song
            .regions
            .iter_mut()
            .filter_map(|region| region.structure.as_mut())
        {
            for marker in structure
                .original
                .section_markers
                .iter_mut()
                .filter(|marker| marker.id == base)
            {
                marker.name = name.clone();
                marker.color = color.clone();
            }
        }
    }
}

fn content_lists_equal(previous: &Song, song: &Song) -> bool {
    previous.clips == song.clips
        && previous.midi_clips == song.midi_clips
        && previous.video_clips == song.video_clips
        && previous.section_markers == song.section_markers
        && previous.tempo_markers == song.tempo_markers
        && previous.time_signature_markers == song.time_signature_markers
}

fn check_applied_regions(previous: &Song, song: &Song) -> Result<(), DesktopError> {
    let lists_equal = content_lists_equal(previous, song);
    for region in &song.regions {
        let Some(structure) = &region.structure else {
            continue;
        };
        let Some(arrangement) = structure.applied_arrangement() else {
            continue;
        };
        let old_region = previous.regions.iter().find(|r| r.id == region.id);
        let same_place = old_region.is_some_and(|old| {
            old.start_seconds == region.start_seconds
                && old.end_seconds == region.end_seconds
                && old.structure.as_ref() == Some(structure)
        });
        if lists_equal && same_place {
            continue;
        }
        let locked = || DesktopError::SongStructureLocked {
            region_id: region.id.clone(),
            arrangement_name: arrangement.name.clone(),
        };
        let Ok(expected) = built_for_region(structure, region.start_seconds) else {
            return Err(locked());
        };
        let length = region.end_seconds - region.start_seconds;
        if (length - expected.duration_seconds).abs() > POSITION_TOLERANCE {
            return Err(locked());
        }
        let mine = |position: f64| owning_region_id(song, position) == Some(region.id.as_str());
        let matches = same_items(
            &expected.clips,
            song.clips.iter().filter(|c| mine(c.timeline_start_seconds)),
            |c: &Clip| &c.id,
        ) && same_items(
            &expected.midi_clips,
            song.midi_clips
                .iter()
                .filter(|c| mine(c.timeline_start_seconds)),
            |c: &MidiClip| &c.id,
        ) && same_items(
            &expected.video_clips,
            song.video_clips
                .iter()
                .filter(|c| mine(c.timeline_start_seconds)),
            |c: &VideoClip| &c.id,
        ) && same_items(
            &expected.section_markers,
            song.section_markers
                .iter()
                .filter(|m| mine(m.start_seconds)),
            |m: &Marker| &m.id,
        ) && same_items(
            &expected.tempo_markers,
            song.tempo_markers.iter().filter(|m| mine(m.start_seconds)),
            |m: &TempoMarker| &m.id,
        ) && same_items(
            &expected.time_signature_markers,
            song.time_signature_markers
                .iter()
                .filter(|m| mine(m.start_seconds)),
            |m: &TimeSignatureMarker| &m.id,
        );
        if !matches {
            return Err(locked());
        }
    }
    Ok(())
}

/// Mismos elementos (por id, sin importar el orden) y mismos valores, con
/// tolerancia en los números.
fn same_items<'a, T: Serialize + 'a>(
    expected: &[T],
    actual: impl Iterator<Item = &'a T>,
    id_of: impl Fn(&T) -> &String,
) -> bool {
    let actual: Vec<&T> = actual.collect();
    if actual.len() != expected.len() {
        return false;
    }
    let by_id: HashMap<&String, &T> = actual.iter().map(|item| (id_of(item), *item)).collect();
    expected.iter().all(|item| {
        by_id.get(id_of(item)).is_some_and(|found| {
            match (serde_json::to_value(item), serde_json::to_value(found)) {
                (Ok(left), Ok(right)) => values_close(&left, &right),
                _ => false,
            }
        })
    })
}

fn values_close(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => (a - b).abs() <= POSITION_TOLERANCE,
            _ => a == b,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| values_close(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| values_close(x, y)))
        }
        _ => left == right,
    }
}

/// Las cues viven fuera del `Song`: crear, editar o borrar una cue dentro de
/// una canción con arreglo aplicado también se bloquea (se perdería al
/// reaplicar).
pub(super) fn ensure_cue_editable(song: &Song, position: f64) -> Result<(), DesktopError> {
    let Some(region) = owning_region_id(song, position)
        .and_then(|id| song.regions.iter().find(|region| region.id == id))
    else {
        return Ok(());
    };
    match region
        .structure
        .as_ref()
        .and_then(|structure| structure.applied_arrangement())
    {
        Some(arrangement) => Err(DesktopError::SongStructureLocked {
            region_id: region.id.clone(),
            arrangement_name: arrangement.name.clone(),
        }),
        None => Ok(()),
    }
}

/// Igual que [`ensure_cue_editable`] para una cue existente (su posición
/// vieja también cuenta: sacar una cue de la canción arreglada la borra de
/// allí).
pub(super) fn ensure_existing_cue_editable(
    song: &Song,
    cues: &[AutomationCue],
    cue_id: &str,
) -> Result<(), DesktopError> {
    match cues.iter().find(|cue| cue.id == cue_id) {
        Some(cue) => ensure_cue_editable(song, cue.at_seconds),
        None => Ok(()),
    }
}

#[cfg(test)]
#[path = "structure_guard_tests.rs"]
mod tests;
