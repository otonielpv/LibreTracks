//! Arreglos de canción en la sesión: capturar el original, guardar arreglos y
//! aplicarlos escribiendo el resultado en el timeline.
//!
//! La lógica difícil (partir clips, marcas, tempo, saltos) es la función pura
//! `libretracks_core::song_structure::build_arrangement`. Aquí sólo se
//! sustituye el contenido de la región por lo que devuelve, se empujan las
//! canciones siguientes con la misma política que reordenar
//! (`lay_out_songs`) y se guarda todo en una sola actualización: un
//! snapshot, una entrada de deshacer.
//!
//! En el código la feature se llama `structure` porque `state/arrangement.rs`
//! ya existe y es la edición de clips; en la interfaz se llama "Arreglo".

use std::collections::HashSet;

use libretracks_core::song_structure::{
    beats_per_bar, build_arrangement, capture_original, governing_bpm_at, owning_region_id,
    BuiltRegion, CaptureWarning, StructureError,
};
use libretracks_core::{
    warp_timeline_seconds_at, Arrangement, ArrangementBlock, MarkerCategory, OriginalSection, Song,
    SongStructure, TempoMarker, TimeSignatureMarker,
};

use crate::audio::automation::AutomationCue;
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::{
    DroppedArrangementBlocksSummary, SongStructureResult, StructureWarningSummary,
};

use super::cue_follow::carry_cues_with_regions;
use super::song_reorder::{lay_out_songs, owning_span, region_spans, Owners};
use super::{
    next_downbeat_after_in_view_timeline, refresh_song_duration, sort_song_regions,
    AudioChangeImpact, DesktopSession, UpdatePhase,
};

impl From<StructureError> for DesktopError {
    fn from(error: StructureError) -> Self {
        DesktopError::SongStructure(error.to_string())
    }
}

/// Lo que cambió al aplicar, para reubicar el playhead.
#[derive(Debug, Clone)]
pub(super) struct AppliedChange {
    pub(super) region_id: String,
    /// Bloques (sección, destino relativo, duración) antes y después.
    pub(super) old_blocks: Vec<PlacedBlock>,
    pub(super) new_blocks: Vec<PlacedBlock>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct PlacedBlock {
    pub(super) section_marker_id: String,
    pub(super) start: f64,
    pub(super) length: f64,
}

/// Dónde cae cada bloque en la canción arreglada (relativo, fuente).
pub(super) fn placed_blocks(
    sections: &[OriginalSection],
    section_ids: &[String],
) -> Vec<PlacedBlock> {
    let mut cursor = 0.0;
    section_ids
        .iter()
        .filter_map(|id| {
            let section = sections.iter().find(|section| &section.marker_id == id)?;
            let length = section.end_seconds - section.start_seconds;
            let block = PlacedBlock {
                section_marker_id: id.clone(),
                start: cursor,
                length,
            };
            cursor += length;
            Some(block)
        })
        .collect()
}

/// Secciones (por id) que suenan con el arreglo aplicado, o en el orden
/// original si no hay ninguno.
fn sounding_section_ids(structure: &SongStructure) -> Vec<String> {
    match structure.applied_arrangement() {
        Some(arrangement) => arrangement
            .blocks
            .iter()
            .map(|block| block.section_marker_id.clone())
            .collect(),
        None => structure
            .sections
            .iter()
            .map(|section| section.marker_id.clone())
            .collect(),
    }
}

/// Bloques del orden original, para "volver al original".
fn original_blocks(sections: &[OriginalSection]) -> Vec<ArrangementBlock> {
    sections
        .iter()
        .enumerate()
        .map(|(index, section)| ArrangementBlock {
            id: format!("original-{index}"),
            section_marker_id: section.marker_id.clone(),
        })
        .collect()
}

/// Contenido construido para el estado aplicado de `structure`, colocado en
/// una región que ahora empieza en `region_start`.
pub(super) fn built_for_region(
    structure: &SongStructure,
    region_start: f64,
) -> Result<BuiltRegion, StructureError> {
    let blocks = match structure.applied_arrangement() {
        Some(arrangement) => arrangement.blocks.clone(),
        None => original_blocks(&structure.sections),
    };
    let mut built = build_arrangement(&structure.original, &structure.sections, &blocks)?;
    built.translate(region_start - structure.original.origin_seconds);
    Ok(built)
}

/// Sustituye en `list` lo que pertenece a la región por `built`, conservando
/// el orden: un elemento de la región cuyo id sigue en `built` se reemplaza en
/// su sitio, el que ya no está se quita, y los nuevos (copias `~n`) se añaden
/// tras el último de la región. Así aplicar el orden original deja la lista
/// idéntica, byte a byte. Devuelve, por posición final, si es de la región.
fn replace_region_items<T>(
    list: &mut Vec<T>,
    built: Vec<T>,
    id_of: impl Fn(&T) -> &str,
    owned: impl Fn(&T) -> bool,
) -> Vec<bool> {
    let mut pending: Vec<Option<T>> = built.into_iter().map(Some).collect();
    let built_ids: Vec<String> = pending
        .iter()
        .flatten()
        .map(|item| id_of(item).to_string())
        .collect();
    let mut result: Vec<T> = Vec::with_capacity(list.len() + pending.len());
    let mut flags: Vec<bool> = Vec::with_capacity(result.capacity());
    let mut insert_at: Option<usize> = None;
    for item in list.drain(..) {
        if !owned(&item) {
            result.push(item);
            flags.push(false);
            continue;
        }
        let id = id_of(&item).to_string();
        if let Some(index) = built_ids.iter().position(|built_id| *built_id == id) {
            if let Some(replacement) = pending[index].take() {
                result.push(replacement);
                flags.push(true);
            }
        }
        insert_at = Some(result.len());
    }
    let at = insert_at.unwrap_or(result.len());
    let rest: Vec<T> = pending.into_iter().flatten().collect();
    let added = rest.len();
    result.splice(at..at, rest);
    flags.splice(at..at, std::iter::repeat(true).take(added));
    *list = result;
    flags
}

/// Tempo y compás que rigen en `position` según las marcas de `song` que
/// cumplen `keep`, o la base del proyecto.
fn governing_in_song(song: &Song, position: f64, keep: impl Fn(f64) -> bool) -> (f64, String) {
    let bpm = song
        .tempo_markers
        .iter()
        .filter(|m| m.start_seconds <= position + 0.001 && keep(m.start_seconds))
        .max_by(|l, r| l.start_seconds.total_cmp(&r.start_seconds))
        .map(|m| m.bpm)
        .unwrap_or(song.bpm);
    let signature = song
        .time_signature_markers
        .iter()
        .filter(|m| m.start_seconds <= position + 0.001 && keep(m.start_seconds))
        .max_by(|l, r| l.start_seconds.total_cmp(&r.start_seconds))
        .map(|m| m.signature.clone())
        .unwrap_or_else(|| song.time_signature.clone());
    (bpm, signature)
}

/// Aplica a la región el arreglo `arrangement_id` (`None` = el original) y
/// empuja las canciones siguientes. Trabaja sobre `song` y `cues` en memoria;
/// quien llama los persiste juntos.
pub(super) fn apply_structure(
    song: &mut Song,
    cues: &mut Vec<AutomationCue>,
    region_id: &str,
    arrangement_id: Option<&str>,
) -> Result<AppliedChange, DesktopError> {
    sort_song_regions(&mut song.regions);
    let previous = song.clone();
    let index = previous
        .regions
        .iter()
        .position(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    let region = previous.regions[index].clone();
    let mut structure = region
        .structure
        .clone()
        .ok_or_else(|| DesktopError::SongStructure("la canción no tiene original".into()))?;
    if let Some(id) = arrangement_id {
        if !structure.arrangements.iter().any(|a| a.id == id) {
            return Err(DesktopError::SongStructure(format!(
                "arreglo desconocido: {id}"
            )));
        }
    }
    let old_blocks = placed_blocks(&structure.sections, &sounding_section_ids(&structure));
    structure.applied_arrangement_id = arrangement_id.map(str::to_string);
    let new_blocks = placed_blocks(&structure.sections, &sounding_section_ids(&structure));
    let built = built_for_region(&structure, region.start_seconds)?;

    let spans = region_spans(&previous);
    let mine = |position: f64| owning_span(&spans, position) == Some(index);
    let old_length = region.end_seconds - region.start_seconds;
    let length_changes = (built.duration_seconds - old_length).abs() > 1e-9;

    // Lo que regía al empezar la canción siguiente, antes de tocar nada: si
    // el arreglo acaba con otro tempo o compás y la siguiente no tiene marca
    // propia en su inicio, heredaría el del final del arreglo.
    let next_guard = previous.regions.get(index + 1).map(|next| {
        let next_start = next.start_seconds;
        let owns_start = |position: f64| (position - next_start).abs() <= 0.001;
        let has_tempo = previous
            .tempo_markers
            .iter()
            .any(|m| owns_start(m.start_seconds));
        let has_signature = previous
            .time_signature_markers
            .iter()
            .any(|m| owns_start(m.start_seconds));
        let before = governing_in_song(&previous, next_start, |_| true);
        (
            next.id.clone(),
            next_start,
            has_tempo,
            has_signature,
            before,
        )
    });

    // 1. Sustituir el contenido de la región.
    let BuiltRegion {
        duration_seconds: new_length,
        clips,
        midi_clips,
        video_clips,
        tempo_markers,
        time_signature_markers,
        section_markers,
        automation_cues,
    } = built;
    let outside_before = governing_in_song(&previous, region.start_seconds, |p| !mine(p));
    let arranged_end_tempo = tempo_markers
        .iter()
        .max_by(|l, r| l.start_seconds.total_cmp(&r.start_seconds))
        .map(|m| m.bpm)
        .unwrap_or(outside_before.0);
    let arranged_end_signature = time_signature_markers
        .iter()
        .max_by(|l, r| l.start_seconds.total_cmp(&r.start_seconds))
        .map(|m| m.signature.clone())
        .unwrap_or_else(|| outside_before.1.clone());

    let clip_flags = replace_region_items(
        &mut song.clips,
        clips,
        |c| &c.id,
        |c| mine(c.timeline_start_seconds),
    );
    let video_flags = replace_region_items(
        &mut song.video_clips,
        video_clips,
        |c| &c.id,
        |c| mine(c.timeline_start_seconds),
    );
    let midi_flags = replace_region_items(
        &mut song.midi_clips,
        midi_clips,
        |c| &c.id,
        |c| mine(c.timeline_start_seconds),
    );
    let mut tempo_flags = replace_region_items(
        &mut song.tempo_markers,
        tempo_markers,
        |m| &m.id,
        |m| mine(m.start_seconds),
    );
    let mut signature_flags = replace_region_items(
        &mut song.time_signature_markers,
        time_signature_markers,
        |m| &m.id,
        |m| mine(m.start_seconds),
    );
    let marker_flags = replace_region_items(
        &mut song.section_markers,
        section_markers,
        |m| &m.id,
        |m| mine(m.start_seconds),
    );

    // 2. Mantener el tempo y el compás con los que arrancaba la siguiente.
    if let Some((next_id, next_start, has_tempo, has_signature, (bpm, signature))) = next_guard {
        if !has_tempo && (arranged_end_tempo - bpm).abs() > 1e-9 {
            song.tempo_markers.push(TempoMarker {
                id: unique_id(
                    song.tempo_markers.iter().map(|m| m.id.as_str()),
                    &next_id,
                    "tempo",
                ),
                start_seconds: next_start,
                bpm,
            });
            tempo_flags.push(false);
        }
        if !has_signature && arranged_end_signature != signature {
            song.time_signature_markers.push(TimeSignatureMarker {
                id: unique_id(
                    song.time_signature_markers.iter().map(|m| m.id.as_str()),
                    &next_id,
                    "signature",
                ),
                start_seconds: next_start,
                signature,
            });
            signature_flags.push(false);
        }
    }

    // 3. Ajustar la región y empujar las siguientes.
    if let Some(target) = song.regions.iter_mut().find(|r| r.id == region_id) {
        if length_changes {
            target.end_seconds = target.start_seconds + new_length;
        }
        target.structure = Some(structure);
    }
    if length_changes {
        let mut owners = Owners::of(song, &spans);
        // El contenido nuevo es de la región aunque pase de su fin viejo.
        let claim = |owners: &mut Vec<Option<usize>>, flags: &[bool]| {
            for (owner, &is_region) in owners.iter_mut().zip(flags) {
                if is_region {
                    *owner = Some(index);
                }
            }
        };
        claim(&mut owners.clips, &clip_flags);
        claim(&mut owners.video_clips, &video_flags);
        claim(&mut owners.midi_clips, &midi_flags);
        claim(&mut owners.tempo_markers, &tempo_flags);
        claim(&mut owners.time_signature_markers, &signature_flags);
        claim(&mut owners.section_markers, &marker_flags);
        let mut lengths: Vec<f64> = spans.iter().map(|&(start, end)| end - start).collect();
        lengths[index] = new_length;
        let order: Vec<usize> = (0..spans.len()).collect();
        lay_out_songs(song, &previous, &owners, &order, index + 1, &lengths);
        refresh_song_duration(song);
    } else {
        // Sin empujar nada (la duración no cambia: reordenar secciones de igual
        // longitud) nadie ordena las listas, y las marcas tienen que ir en
        // orden. Sólo se ordena lo que está desordenado: una lista ya válida no
        // cambia (la identidad tiene que salir byte a byte).
        sort_markers_if_needed(song);
    }

    // 4. Cues: fuera las de la región, las de las canciones empujadas viajan
    // con ellas, y entran las construidas.
    cues.retain(|cue| owning_region_id(&previous, cue.at_seconds) != Some(region_id));
    carry_cues_with_regions(&previous, song, cues);
    cues.extend(automation_cues);
    sort_cues(cues);

    Ok(AppliedChange {
        region_id: region_id.to_string(),
        old_blocks,
        new_blocks,
    })
}

/// Rebuild from its original every song (not in `existing`) that carries an
/// applied arrangement: what an imported package needs, since the import may
/// have renamed ids or dropped redundant tempo markers. Returns whether any
/// song was rebuilt.
pub(super) fn rebuild_applied_structures(
    song: &mut Song,
    cues: &mut Vec<AutomationCue>,
    existing: &[String],
) -> Result<bool, DesktopError> {
    let pending: Vec<(String, String)> = song
        .regions
        .iter()
        .filter(|region| !existing.contains(&region.id))
        .filter_map(|region| {
            let applied = region.structure.as_ref()?.applied_arrangement_id.clone()?;
            Some((region.id.clone(), applied))
        })
        .collect();
    for (region_id, arrangement_id) in &pending {
        apply_structure(song, cues, region_id, Some(arrangement_id))?;
    }
    Ok(!pending.is_empty())
}

/// Ordena por inicio las listas de marcas que lo necesiten. Las de sección se
/// validan en orden por categoría (sección y cue cada una en su carril), así
/// que una lista válida se deja tal cual aunque mezcle carriles.
fn sort_markers_if_needed(song: &mut Song) {
    let by_start = |l: f64, r: f64| l.total_cmp(&r);
    let section_lanes_sorted = [MarkerCategory::Section, MarkerCategory::Cue]
        .iter()
        .all(|lane| {
            let starts: Vec<f64> = song
                .section_markers
                .iter()
                .filter(|marker| marker.category() == *lane)
                .map(|marker| marker.start_seconds)
                .collect();
            starts.windows(2).all(|pair| pair[0] < pair[1])
        });
    if !section_lanes_sorted {
        song.section_markers
            .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    }
    if !song
        .tempo_markers
        .windows(2)
        .all(|p| p[0].start_seconds < p[1].start_seconds)
    {
        song.tempo_markers
            .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    }
    if !song
        .time_signature_markers
        .windows(2)
        .all(|p| p[0].start_seconds < p[1].start_seconds)
    {
        song.time_signature_markers
            .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    }
}

fn sort_cues(cues: &mut [AutomationCue]) {
    cues.sort_by(|left, right| left.at_seconds.total_cmp(&right.at_seconds));
}

fn unique_id<'a>(existing: impl Iterator<Item = &'a str>, base: &str, kind: &str) -> String {
    let taken: HashSet<&str> = existing.collect();
    let first = format!("{base}~{kind}");
    if !taken.contains(first.as_str()) {
        return first;
    }
    (2..)
        .map(|n| format!("{base}~{kind}~{n}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .unwrap_or(first)
}

/// Dónde debe quedar el playhead (fuente) tras aplicar. En la canción
/// arreglada, en el mismo punto del primer bloque equivalente (misma sección)
/// buscando desde el índice que tenía; si no hay, al inicio de la canción. En
/// otra canción, se mueve lo mismo que ella. Fuera de toda canción no se toca.
pub(super) fn relocate_playhead(
    position: f64,
    before: &Song,
    after: &Song,
    change: &AppliedChange,
) -> f64 {
    let Some(owner) = owning_region_id(before, position) else {
        return position;
    };
    let start_in = |song: &Song, id: &str| {
        song.regions
            .iter()
            .find(|region| region.id == id)
            .map(|region| region.start_seconds)
    };
    let (Some(old_start), Some(new_start)) = (start_in(before, owner), start_in(after, owner))
    else {
        return position;
    };
    if owner != change.region_id {
        return position + (new_start - old_start);
    }
    let relative = position - old_start;
    let Some(old_index) = change
        .old_blocks
        .iter()
        .rposition(|block| relative >= block.start - 1e-9)
    else {
        return new_start;
    };
    let old_block = &change.old_blocks[old_index];
    let offset = (relative - old_block.start).clamp(0.0, old_block.length);
    let same_section =
        |block: &&PlacedBlock| block.section_marker_id == old_block.section_marker_id;
    let target = change
        .new_blocks
        .iter()
        .skip(old_index)
        .find(same_section)
        .or_else(|| change.new_blocks.iter().take(old_index).find(same_section));
    match target {
        Some(block) => new_start + block.start + offset,
        None => new_start,
    }
}

/// Cues tras pasar de `before` a `after` (deshacer, rehacer, mover…): las de
/// las canciones trasladadas viajan con ellas, y las de una canción cuyo
/// arreglo aplicado cambió se re-derivan de su original. El historial sólo
/// apila `Song`, así que sin esto deshacer un "Aplicar" dejaría las cues del
/// arreglo en una canción que vuelve a ser la original.
pub(super) fn cues_for_song_transition(
    before: &Song,
    after: &Song,
    cues: &mut Vec<AutomationCue>,
) -> bool {
    let mut rederived: Vec<(String, Vec<AutomationCue>)> = Vec::new();
    for region in &after.regions {
        let Some(after_structure) = &region.structure else {
            continue;
        };
        let before_region = before.regions.iter().find(|r| r.id == region.id);
        let before_structure = before_region.and_then(|r| r.structure.as_ref());
        let before_applied = before_structure.and_then(|s| s.applied_arrangement_id.as_deref());
        let after_applied = after_structure.applied_arrangement_id.as_deref();
        let source = if after_applied.is_some() {
            // Con un arreglo aplicado, las cues son siempre las construidas.
            // Sólo hace falta rehacerlas si algo de eso cambió.
            (before_structure != Some(after_structure)
                || before_region.map(|r| r.start_seconds) != Some(region.start_seconds))
            .then_some(after_structure)
        } else if before_applied.is_some() {
            // Vuelve al original: el de `before` se capturó justo antes de
            // aplicar, así que es exactamente lo que había.
            before_structure
        } else {
            None
        };
        let Some(source) = source else {
            continue;
        };
        let mut state = source.clone();
        state.applied_arrangement_id = after_applied.map(str::to_string);
        if let Ok(built) = built_for_region(&state, region.start_seconds) {
            rederived.push((region.id.clone(), built.automation_cues));
        }
    }

    let mut changed = false;
    if !rederived.is_empty() {
        let before_len = cues.len();
        cues.retain(|cue| {
            let owner = owning_region_id(before, cue.at_seconds);
            !rederived.iter().any(|(id, _)| Some(id.as_str()) == owner)
        });
        changed |= cues.len() != before_len;
    }
    changed |= carry_cues_with_regions(before, after, cues);
    for (_, built) in rederived {
        changed |= !built.is_empty();
        cues.extend(built);
    }
    if changed {
        sort_cues(cues);
    }
    changed
}

/// Avisos de marcas de sección que no caen en el primer tiempo de un compás,
/// comparadas en vista con la rejilla del timeline. Llevan el tiempo fuerte
/// más cercano (vista) para que la UI ofrezca ajustarlas.
fn off_beat_warnings(
    song: &Song,
    region_start: f64,
    structure: &SongStructure,
) -> Vec<StructureWarningSummary> {
    const TOLERANCE_SECONDS: f64 = 0.02;
    let mut warnings = Vec::new();
    for section in &structure.sections {
        if !structure
            .original
            .section_markers
            .iter()
            .any(|m| m.id == section.marker_id)
        {
            continue;
        }
        let view = warp_timeline_seconds_at(song, region_start + section.start_seconds);
        let next = next_downbeat_after_in_view_timeline(song, view - TOLERANCE_SECONDS);
        if (next - view).abs() <= TOLERANCE_SECONDS {
            continue;
        }
        let bpm = governing_bpm_at(&structure.original, section.start_seconds).max(1.0);
        let signature = libretracks_core::song_structure::governing_signature_at(
            &structure.original,
            section.start_seconds,
        );
        let bar = beats_per_bar(&signature) * 60.0 / bpm;
        let previous = next_downbeat_after_in_view_timeline(song, (view - bar).max(0.0));
        let nearest = if (view - previous).abs() < (next - view).abs() && previous <= view {
            previous
        } else {
            next
        };
        warnings.push(StructureWarningSummary::off_beat(
            &section.marker_id,
            nearest,
        ));
    }
    warnings
}

/// Captura (o recaptura) el original de la región dentro de `song`. Si ya
/// tenía arreglos, se conservan; los bloques cuya sección ya no existe se
/// quitan y se informa. Error si hay un arreglo aplicado: el timeline no es el
/// original.
fn capture_into(
    song: &mut Song,
    cues: &[AutomationCue],
    region_id: &str,
) -> Result<
    (
        Vec<StructureWarningSummary>,
        Vec<DroppedArrangementBlocksSummary>,
    ),
    DesktopError,
> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    let previous_structure = region.structure.clone();
    if previous_structure
        .as_ref()
        .is_some_and(|s| s.applied_arrangement_id.is_some())
    {
        return Err(DesktopError::SongStructure(
            "la canción tiene un arreglo aplicado; vuelve al original antes de capturarlo".into(),
        ));
    }
    let region_start = region.start_seconds;
    let (original, sections, capture_warnings) = capture_original(song, cues, region_id)?;

    let (old_arrangements, old_original) = match previous_structure {
        Some(structure) => (structure.arrangements, Some(structure.original)),
        None => (Vec::new(), None),
    };
    let section_name = |marker_id: &str| {
        old_original
            .as_ref()
            .and_then(|o| o.section_markers.iter().find(|m| m.id == marker_id))
            .map(|m| m.name.clone())
            .unwrap_or_else(|| marker_id.to_string())
    };
    let mut arrangements: Vec<Arrangement> = Vec::new();
    let mut dropped = Vec::new();
    for mut arrangement in old_arrangements {
        let mut missing: Vec<String> = Vec::new();
        arrangement.blocks.retain(|block| {
            let exists = sections
                .iter()
                .any(|section| section.marker_id == block.section_marker_id);
            if !exists {
                let name = section_name(&block.section_marker_id);
                if !missing.contains(&name) {
                    missing.push(name);
                }
            }
            exists
        });
        if !missing.is_empty() {
            dropped.push(DroppedArrangementBlocksSummary {
                arrangement_id: arrangement.id.clone(),
                arrangement_name: arrangement.name.clone(),
                section_names: missing,
                arrangement_removed: arrangement.blocks.is_empty(),
            });
        }
        if !arrangement.blocks.is_empty() {
            arrangements.push(arrangement);
        }
    }

    let structure = SongStructure {
        original,
        sections,
        arrangements,
        applied_arrangement_id: None,
    };
    let mut warnings = off_beat_warnings(song, region_start, &structure);
    warnings.extend(capture_warnings.iter().map(StructureWarningSummary::from));
    if let Some(region) = song
        .regions
        .iter_mut()
        .find(|region| region.id == region_id)
    {
        region.structure = Some(structure);
    }
    Ok((warnings, dropped))
}

impl DesktopSession {
    fn structure_song(&self) -> Result<Song, DesktopError> {
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)
    }

    /// Persiste `song` y las cues en una sola actualización, y reubica el
    /// playhead si la región que suena (o una posterior) se ha movido.
    fn commit_structure_change(
        &mut self,
        song: Song,
        cues: Vec<AutomationCue>,
        change: Option<AppliedChange>,
        audio: &AudioController,
        warnings: Vec<StructureWarningSummary>,
        dropped: Vec<DroppedArrangementBlocksSummary>,
    ) -> Result<SongStructureResult, DesktopError> {
        self.sync_position(audio)?;
        let before = self.structure_song()?;
        let position = self.engine.position_seconds();
        let relocated = change
            .as_ref()
            .map(|change| relocate_playhead(position, &before, &song, change));
        let mut automation = self.automation.clone();
        automation.cues = cues;

        audio.update_live_song_regions(&song)?;
        self.persist_song_and_automation(
            song,
            Some(automation),
            audio,
            AudioChangeImpact::TimelineWindow,
            true,
            UpdatePhase::Commit,
        )?;

        if let Some(target) = relocated {
            if (target - position).abs() > 1e-6 {
                let view = self
                    .engine
                    .song()
                    .map(|song| warp_timeline_seconds_at(song, target))
                    .unwrap_or(target);
                self.seek(view, audio)?;
            }
        }
        Ok(SongStructureResult {
            snapshot: self.snapshot(),
            warnings,
            dropped_blocks: dropped,
        })
    }

    /// Guarda el original de la canción tal como está ahora. Si ya tenía uno
    /// (sin arreglo aplicado), lo recaptura conservando los arreglos.
    pub fn capture_song_structure(
        &mut self,
        region_id: &str,
        audio: &AudioController,
    ) -> Result<SongStructureResult, DesktopError> {
        let mut song = self.structure_song()?;
        let (warnings, dropped) = capture_into(&mut song, &self.automation.cues, region_id)?;
        let cues = self.automation.cues.clone();
        self.commit_structure_change(song, cues, None, audio, warnings, dropped)
    }

    /// Crea o actualiza un arreglo. Con `apply` (o si es el aplicado, para no
    /// romper el invariante) además lo escribe en el timeline, en la misma
    /// actualización. Si la canción no tenía arreglo aplicado, primero se
    /// recaptura el original: el usuario pudo editarlo.
    pub fn save_song_arrangement(
        &mut self,
        region_id: &str,
        mut arrangement: Arrangement,
        apply: bool,
        audio: &AudioController,
    ) -> Result<SongStructureResult, DesktopError> {
        let mut song = self.structure_song()?;
        let mut cues = self.automation.cues.clone();
        let region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        let applied = region
            .structure
            .as_ref()
            .and_then(|s| s.applied_arrangement_id.clone());
        let (mut warnings, mut dropped) = (Vec::new(), Vec::new());
        if applied.is_none() {
            (warnings, dropped) = capture_into(&mut song, &cues, region_id)?;
        }

        arrangement.name = arrangement.name.trim().to_string();
        if arrangement.name.is_empty() {
            arrangement.name = "Arreglo".into();
        }
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        let structure = region
            .structure
            .as_mut()
            .ok_or_else(|| DesktopError::SongStructure("la canción no tiene original".into()))?;
        // Bloques de secciones que la recaptura ya no encuentra: fuera.
        arrangement
            .blocks
            .retain(|block| structure.section(&block.section_marker_id).is_some());
        if arrangement.blocks.is_empty() {
            return Err(StructureError::EmptyArrangement.into());
        }
        let arrangement_id = arrangement.id.clone();
        match structure
            .arrangements
            .iter_mut()
            .find(|existing| existing.id == arrangement_id)
        {
            Some(existing) => *existing = arrangement,
            None => structure.arrangements.push(arrangement),
        }

        let reapply = apply || applied.as_deref() == Some(arrangement_id.as_str());
        let change = if reapply {
            Some(apply_structure(
                &mut song,
                &mut cues,
                region_id,
                Some(&arrangement_id),
            )?)
        } else {
            None
        };
        self.commit_structure_change(song, cues, change, audio, warnings, dropped)
    }

    /// Borra un arreglo. Si estaba aplicado, antes vuelve al original.
    pub fn delete_song_arrangement(
        &mut self,
        region_id: &str,
        arrangement_id: &str,
        audio: &AudioController,
    ) -> Result<SongStructureResult, DesktopError> {
        let mut song = self.structure_song()?;
        let mut cues = self.automation.cues.clone();
        let applied = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .and_then(|region| region.structure.as_ref())
            .and_then(|s| s.applied_arrangement_id.clone());
        let change = if applied.as_deref() == Some(arrangement_id) {
            Some(apply_structure(&mut song, &mut cues, region_id, None)?)
        } else {
            None
        };
        if let Some(structure) = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .and_then(|region| region.structure.as_mut())
        {
            structure.arrangements.retain(|a| a.id != arrangement_id);
        }
        self.commit_structure_change(song, cues, change, audio, Vec::new(), Vec::new())
    }

    /// Aplica un arreglo guardado (`None` = vuelve al original). Aplicar desde
    /// el original recaptura antes, por si se editó.
    pub fn apply_song_arrangement(
        &mut self,
        region_id: &str,
        arrangement_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<SongStructureResult, DesktopError> {
        let mut song = self.structure_song()?;
        let mut cues = self.automation.cues.clone();
        let applied = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?
            .structure
            .as_ref()
            .and_then(|s| s.applied_arrangement_id.clone());
        let (mut warnings, mut dropped) = (Vec::new(), Vec::new());
        if applied.is_none() && arrangement_id.is_some() {
            (warnings, dropped) = capture_into(&mut song, &cues, region_id)?;
        }
        if applied.is_none() && arrangement_id.is_none() {
            // Ya es el original: nada que hacer.
            return Ok(SongStructureResult {
                snapshot: self.snapshot(),
                warnings,
                dropped_blocks: dropped,
            });
        }
        let change = apply_structure(&mut song, &mut cues, region_id, arrangement_id)?;
        self.commit_structure_change(song, cues, Some(change), audio, warnings, dropped)
    }

    /// Vuelve al original y olvida original y arreglos.
    pub fn discard_song_structure(
        &mut self,
        region_id: &str,
        audio: &AudioController,
    ) -> Result<SongStructureResult, DesktopError> {
        let mut song = self.structure_song()?;
        let mut cues = self.automation.cues.clone();
        let applied = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?
            .structure
            .as_ref()
            .and_then(|s| s.applied_arrangement_id.clone());
        let change = if applied.is_some() {
            Some(apply_structure(&mut song, &mut cues, region_id, None)?)
        } else {
            None
        };
        if let Some(region) = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
        {
            region.structure = None;
        }
        self.commit_structure_change(song, cues, change, audio, Vec::new(), Vec::new())
    }
}

impl From<&CaptureWarning> for StructureWarningSummary {
    fn from(warning: &CaptureWarning) -> Self {
        match warning {
            CaptureWarning::OffBeatSection { marker_id } => {
                StructureWarningSummary::off_beat(marker_id, f64::NAN)
            }
            CaptureWarning::MidiClipCrossesSection { clip_id, marker_id } => {
                StructureWarningSummary {
                    kind: "midiClipCrossesSection".into(),
                    marker_id: marker_id.clone(),
                    clip_id: Some(clip_id.clone()),
                    suggested_start_seconds: None,
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "song_structure_tests.rs"]
pub(super) mod tests;
