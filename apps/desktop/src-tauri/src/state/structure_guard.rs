//! Guardia de edición de las canciones con arreglo aplicado.
//!
//! Invariante: si una región tiene `applied_arrangement_id`, su contenido es
//! exactamente `build_arrangement(original, bloques)` colocado en su inicio,
//! donde un bloque puede traer su propio contenido.
//!
//! Una edición de clips, MIDI, vídeo o avisos dentro de una canción arreglada
//! se queda en el bloque donde cae: ese bloque guarda lo que ahora hay en su
//! tramo (`ArrangementBlock::content`) y la región se reescribe con lo que
//! construye el arreglo, así que el invariante vuelve a cumplirse
//! (`absorb_block_edits`). Lo que cambia la forma de la canción (marcas de
//! sección, tempo, compás, nota, duración) se rechaza con
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
//!   original;
//! - cambiar la nota de una canción que no modula: se propaga al original.
//!
//! Lo que es de la pista (volumen, mute, solo, pan, rutas, color, nombre) no
//! toca el contenido de la región y nunca dispara la guardia.

use std::collections::{HashMap, HashSet};

use libretracks_core::song_structure::{
    block_windows, extract_block_content, owning_region_id, BlockWindow, BuiltRegion,
};
use libretracks_core::{
    ArrangementBlock, BlockContent, Clip, KeyChange, Marker, MarkerCategory, MidiClip, Song,
    TempoMarker, TimeSignatureMarker, VideoClip,
};
use serde::Serialize;
use serde_json::Value;

use crate::audio::automation::AutomationCue;
use crate::infra::error::DesktopError;

use super::song_structure::{built_for_region, replace_region_items, sort_markers_if_needed};

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
    propagate_single_key_edits(previous, song);
    absorb_block_edits(previous, song)?;
    check_applied_regions(previous, song)
}

/// Borrar una pista saca sus clips del original y de los bloques editados:
/// reaplicar no la resucita.
fn drop_deleted_tracks_from_originals(song: &mut Song) {
    let tracks: HashSet<String> = song.tracks.iter().map(|track| track.id.clone()).collect();
    for structure in song.structures_mut() {
        structure.retain_tracks(|track_id| tracks.contains(track_id));
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
        // Un aviso de un bloque editado es suyo: renombrarlo no toca las
        // copias ni el original (`absorb_block_edits` lo guarda en su bloque).
        if applied && !in_edited_block(song, marker.start_seconds) {
            changes.push((
                base_id(&marker.id).to_string(),
                marker.name.clone(),
                marker.color.clone(),
            ));
        }
    }
    for (base, name, color) in changes {
        let edited: Vec<bool> = song
            .section_markers
            .iter()
            .map(|marker| in_edited_block(song, marker.start_seconds))
            .collect();
        for (marker, _) in song
            .section_markers
            .iter_mut()
            .zip(edited)
            .filter(|(marker, edited)| !edited && base_id(&marker.id) == base)
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

/// Cambiar la nota de una canción arreglada que no modula no rompe nada: todas
/// sus secciones están en esa nota, así que se apunta también en el original.
/// Con cambios de nota no hay una sola respuesta y la guardia lo rechaza.
fn propagate_single_key_edits(previous: &Song, song: &mut Song) {
    for region in &mut song.regions {
        let Some(old) = previous.regions.iter().find(|old| old.id == region.id) else {
            continue;
        };
        if old.key == region.key || !region.key_changes.is_empty() {
            continue;
        }
        let Some(structure) = region.structure.as_mut() else {
            continue;
        };
        if structure.applied_arrangement_id.is_none() {
            continue;
        }
        if let Some(keys) = structure.original.keys.as_mut() {
            if keys.changes.is_empty() {
                keys.key = region.key.clone();
            }
        }
    }
}

/// Si `position` cae en un bloque con contenido propio del arreglo aplicado.
fn in_edited_block(song: &Song, position: f64) -> bool {
    let Some(region) = owning_region_id(song, position)
        .and_then(|id| song.regions.iter().find(|region| region.id == id))
    else {
        return false;
    };
    let Some(structure) = region.structure.as_ref() else {
        return false;
    };
    let Some(arrangement) = structure.applied_arrangement() else {
        return false;
    };
    let Ok(windows) = block_windows(&structure.sections, &arrangement.blocks) else {
        return false;
    };
    let relative = position - region.start_seconds;
    windows
        .iter()
        .zip(&arrangement.blocks)
        .any(|(window, block)| {
            block.content.is_some()
                && relative >= window.start_seconds - POSITION_TOLERANCE
                && relative < window.end_seconds - POSITION_TOLERANCE
        })
}

/// Lo de la región en las listas del timeline.
struct RegionItems<'a> {
    clips: Vec<Clip>,
    midi_clips: Vec<MidiClip>,
    video_clips: Vec<VideoClip>,
    markers: Vec<Marker>,
    tempo_markers: Vec<&'a TempoMarker>,
    signature_markers: Vec<&'a TimeSignatureMarker>,
}

fn region_items<'a>(song: &'a Song, region_id: &str) -> RegionItems<'a> {
    let mine = |position: f64| owning_region_id(song, position) == Some(region_id);
    RegionItems {
        clips: song
            .clips
            .iter()
            .filter(|c| mine(c.timeline_start_seconds))
            .cloned()
            .collect(),
        midi_clips: song
            .midi_clips
            .iter()
            .filter(|c| mine(c.timeline_start_seconds))
            .cloned()
            .collect(),
        video_clips: song
            .video_clips
            .iter()
            .filter(|c| mine(c.timeline_start_seconds))
            .cloned()
            .collect(),
        markers: song
            .section_markers
            .iter()
            .filter(|m| mine(m.start_seconds))
            .cloned()
            .collect(),
        tempo_markers: song.tempo_markers.iter().filter(|m| mine(m.start_seconds)).collect(),
        signature_markers: song
            .time_signature_markers
            .iter()
            .filter(|m| mine(m.start_seconds))
            .collect(),
    }
}

/// Lo que cambia la forma de la canción sigue como lo construye el arreglo:
/// duración, marcas de sección, tempo, compás y nota.
fn shape_matches(
    expected: &BuiltRegion,
    length: f64,
    items: &RegionItems<'_>,
    region: &libretracks_core::SongRegion,
) -> bool {
    let sections = |markers: &[Marker]| -> Vec<Marker> {
        markers
            .iter()
            .filter(|m| m.category() == MarkerCategory::Section)
            .cloned()
            .collect()
    };
    (length - expected.duration_seconds).abs() <= POSITION_TOLERANCE
        && same_items(
            &sections(&expected.section_markers),
            sections(&items.markers).iter(),
            |m: &Marker| &m.id,
        )
        && same_items(
            &expected.tempo_markers,
            items.tempo_markers.iter().copied(),
            |m: &TempoMarker| &m.id,
        )
        && same_items(
            &expected.time_signature_markers,
            items.signature_markers.iter().copied(),
            |m: &TimeSignatureMarker| &m.id,
        )
        && expected.keys.as_ref().is_none_or(|keys| {
            keys.key == region.key
                && same_items(&keys.changes, region.key_changes.iter(), |c: &KeyChange| &c.id)
        })
}

/// El contenido de un bloque en `items` (sus cues, siempre las construidas:
/// una edición del `Song` no las toca).
fn block_content_in(
    window: &BlockWindow,
    region_start: f64,
    is_last: bool,
    clips: &[Clip],
    midi_clips: &[MidiClip],
    video_clips: &[VideoClip],
    markers: &[Marker],
    expected: &BuiltRegion,
) -> BlockContent {
    extract_block_content(
        window,
        region_start,
        is_last,
        clips,
        midi_clips,
        video_clips,
        markers,
        &expected.automation_cues,
    )
}

fn contents_close(left: &BlockContent, right: &BlockContent) -> bool {
    match (serde_json::to_value(left), serde_json::to_value(right)) {
        (Ok(left), Ok(right)) => values_close(&left, &right),
        _ => false,
    }
}

/// Las ediciones de clips, MIDI, vídeo y avisos en una canción arreglada se
/// quedan en el bloque donde caen: cada bloque cuyo tramo ya no es lo que
/// construía guarda lo que ahora tiene, y la región se reescribe con lo que
/// construye el arreglo con esos bloques (un clip que cruza la frontera de un
/// bloque editado queda partido en ella). Si cambió la forma de la canción no
/// absorbe nada: `check_applied_regions` lo rechaza.
fn absorb_block_edits(previous: &Song, song: &mut Song) -> Result<(), DesktopError> {
    if content_lists_equal(previous, song) {
        return Ok(());
    }
    let applied: Vec<String> = song
        .regions
        .iter()
        .filter(|region| {
            region
                .structure
                .as_ref()
                .is_some_and(|structure| structure.applied_arrangement_id.is_some())
        })
        .map(|region| region.id.clone())
        .collect();
    for region_id in applied {
        let Some(region) = song.regions.iter().find(|r| r.id == region_id) else {
            continue;
        };
        let structure = region.structure.as_ref().expect("filtrada arriba");
        let Some(arrangement) = structure.applied_arrangement() else {
            continue;
        };
        let Ok(expected) = built_for_region(structure, region.start_seconds) else {
            continue;
        };
        let items = region_items(song, &region_id);
        let length = region.end_seconds - region.start_seconds;
        if !shape_matches(&expected, length, &items, region) {
            continue;
        }
        let Ok(windows) = block_windows(&structure.sections, &arrangement.blocks) else {
            continue;
        };
        let last = windows.len().saturating_sub(1);
        let start = region.start_seconds;
        let mut updated: Vec<ArrangementBlock> = arrangement.blocks.clone();
        let mut changed = false;
        for (index, window) in windows.iter().enumerate() {
            let now = block_content_in(
                window,
                start,
                index == last,
                &items.clips,
                &items.midi_clips,
                &items.video_clips,
                &items.markers,
                &expected,
            );
            let before = block_content_in(
                window,
                start,
                index == last,
                &expected.clips,
                &expected.midi_clips,
                &expected.video_clips,
                &expected.section_markers,
                &expected,
            );
            if !contents_close(&now, &before) {
                updated[index].content = Some(now);
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        let arrangement_id = arrangement.id.clone();
        let region = song
            .regions
            .iter_mut()
            .find(|r| r.id == region_id)
            .expect("región");
        let structure = region.structure.as_mut().expect("estructura");
        if let Some(target) = structure
            .arrangements
            .iter_mut()
            .find(|a| a.id == arrangement_id)
        {
            target.blocks = updated;
        }
        let Ok(rebuilt) = built_for_region(structure, region.start_seconds) else {
            return Err(DesktopError::SongStructureLocked {
                region_id: region_id.clone(),
                arrangement_name: structure
                    .applied_arrangement()
                    .map(|a| a.name.clone())
                    .unwrap_or_default(),
            });
        };
        write_region_content(song, &region_id, rebuilt);
    }
    Ok(())
}

/// Sustituye clips, MIDI, vídeo y marcas de la región por los construidos. El
/// tempo, el compás y la nota no cambian (lo garantiza `shape_matches`).
fn write_region_content(song: &mut Song, region_id: &str, built: BuiltRegion) {
    // La pertenencia solo depende de las regiones, que no cambian aquí.
    let regions = song.clone();
    let mine = |position: f64| owning_region_id(&regions, position) == Some(region_id);
    replace_region_items(&mut song.clips, built.clips, |c| &c.id, |c| {
        mine(c.timeline_start_seconds)
    });
    replace_region_items(&mut song.video_clips, built.video_clips, |c| &c.id, |c| {
        mine(c.timeline_start_seconds)
    });
    replace_region_items(&mut song.midi_clips, built.midi_clips, |c| &c.id, |c| {
        mine(c.timeline_start_seconds)
    });
    replace_region_items(&mut song.section_markers, built.section_markers, |m| &m.id, |m| {
        mine(m.start_seconds)
    });
    sort_markers_if_needed(song);
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
                && old.key == region.key
                && old.key_changes == region.key_changes
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
        ) && expected.keys.as_ref().is_none_or(|keys| {
            keys.key == region.key
                && same_items(&keys.changes, region.key_changes.iter(), |c: &KeyChange| &c.id)
        });
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
