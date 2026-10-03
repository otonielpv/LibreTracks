//! Arreglos de canción: capturar el original de una región y construir la
//! canción arreglada a partir de él.
//!
//! Una canción con arreglo aplicado es `build_arrangement(original, bloques)`:
//! una función pura que, a partir de la instantánea del original y de la lista
//! de secciones del arreglo, produce el contenido lineal de la canción. Todo
//! aquí trabaja en tiempo de fuente; el warp y la colocación en el timeline
//! son cosa de quien llama (la sesión de escritorio).
//!
//! Coordenadas: la instantánea guarda las posiciones del timeline al capturar
//! y su `origin_seconds` (ver [`OriginalSnapshot`]). [`BuiltRegion`] sale en
//! ese mismo sistema: colocarla en una región que empieza en `s` es sumar
//! `s - origin_seconds`. Las secciones y los tramos se razonan en relativo
//! (`posición - origin`).

use std::collections::HashMap;

use serde::Serialize;
use thiserror::Error;

use crate::automation::{AutomationAction, AutomationCue, AutomationJumpTarget};
use crate::model::{
    implicit_start_section_id, ArrangementBlock, Clip, Marker, MarkerCategory, MidiClip,
    MidiEventKind, OriginalSection, OriginalSnapshot, Song, TempoMarker, TimeSignatureMarker,
    VideoClip,
};

/// Fundido que recibe un borde recortado de un clip, si no tenía ya uno mayor.
/// Lo justo para que el corte en seco no haga clic.
pub const CUT_FADE_SECONDS: f64 = 0.005;

/// Igualdad de posiciones dentro del original.
pub(crate) const POSITION_EPS: f64 = 1e-9;

/// Tolerancia en las fronteras de sección: lo que cae a menos de esto de una
/// frontera cuenta como de la sección que empieza ahí, y un clip que la pisa
/// por menos de esto no se parte.
const EDGE_EPS: f64 = 1e-6;

/// Regla de pertenencia a una canción: 1 ms de tolerancia por la izquierda,
/// la misma que usan mover y reordenar canciones, para que la marca de tempo
/// clavada en el inicio viaje con su canción.
const OWNER_TOLERANCE_SECONDS: f64 = 0.001;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum StructureError {
    #[error("region {0} not found")]
    RegionNotFound(String),
    #[error("a song needs at least two sections to capture its original")]
    TooFewSections,
    #[error("an arrangement needs at least one block")]
    EmptyArrangement,
    #[error("unknown section {0}")]
    UnknownSection(String),
    #[error("non-finite value in {0}")]
    NonFinite(String),
}

/// Avisos al capturar: no impiden capturar, pero el usuario debe saberlos.
// `rename_all` renombra las VARIANTES; los campos necesitan `rename_all_fields`
// (la misma trampa que documenta `MidiEventKind`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CaptureWarning {
    /// La marca de sección no cae en el primer tiempo de un compás: al
    /// repetirla, la sección quedará desfasada. La comprobación es en vista
    /// con la rejilla del timeline, así que la emite la sesión de escritorio,
    /// no [`capture_original`].
    OffBeatSection { marker_id: String },
    /// Un clip MIDI cruza la frontera que abre `marker_id`. Al separar las
    /// secciones, los eventos de un lado no viajan con el otro (no se inventan
    /// eventos): si un program change del verso regía también en el coro, el
    /// coro colocado sin el verso delante ya no lo recibe.
    MidiClipCrossesSection { clip_id: String, marker_id: String },
}

/// Contenido de la región arreglada, en el sistema de coordenadas de la
/// instantánea de la que salió.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BuiltRegion {
    pub duration_seconds: f64,
    pub clips: Vec<Clip>,
    pub midi_clips: Vec<MidiClip>,
    pub video_clips: Vec<VideoClip>,
    pub tempo_markers: Vec<TempoMarker>,
    pub time_signature_markers: Vec<TimeSignatureMarker>,
    pub section_markers: Vec<Marker>,
    pub automation_cues: Vec<AutomationCue>,
}

impl BuiltRegion {
    /// Traslada todo el contenido `delta` segundos. Con `delta == 0.0` no
    /// toca nada, que es lo que mantiene exacta la identidad.
    pub fn translate(&mut self, delta: f64) {
        if delta == 0.0 {
            return;
        }
        self.clips
            .iter_mut()
            .for_each(|c| c.timeline_start_seconds += delta);
        self.midi_clips
            .iter_mut()
            .for_each(|c| c.timeline_start_seconds += delta);
        self.video_clips
            .iter_mut()
            .for_each(|c| c.timeline_start_seconds += delta);
        self.tempo_markers
            .iter_mut()
            .for_each(|m| m.start_seconds += delta);
        self.time_signature_markers
            .iter_mut()
            .for_each(|m| m.start_seconds += delta);
        self.section_markers
            .iter_mut()
            .for_each(|m| m.start_seconds += delta);
        for cue in &mut self.automation_cues {
            cue.at_seconds += delta;
            // Los saltos a un instante de la propia canción se mueven con
            // ella. Los que apuntan fuera ya se resolvieron al construir.
            for action in &mut cue.actions {
                if let AutomationAction::Jump {
                    target: AutomationJumpTarget::Frame { seconds },
                    ..
                } = action
                {
                    *seconds += delta;
                }
            }
        }
    }
}

// ── Helpers de tempo y compás ──────────────────────────────────────────────

/// Tempo que rige en `position` (relativa) del original: la última marca de
/// tempo en o antes de ella, o el tempo base si no hay ninguna.
pub fn governing_bpm_at(snapshot: &OriginalSnapshot, position: f64) -> f64 {
    governing_tempo_marker(snapshot, position)
        .map(|marker| marker.bpm)
        .unwrap_or(snapshot.base_bpm)
}

/// Compás que rige en `position` (relativa) del original, igual que
/// [`governing_bpm_at`].
pub fn governing_signature_at(snapshot: &OriginalSnapshot, position: f64) -> String {
    governing_signature_marker(snapshot, position)
        .map(|marker| marker.signature.clone())
        .unwrap_or_else(|| snapshot.base_time_signature.clone())
}

fn governing_tempo_marker(snapshot: &OriginalSnapshot, position: f64) -> Option<&TempoMarker> {
    snapshot
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds - snapshot.origin_seconds <= position + POSITION_EPS)
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
}

fn governing_signature_marker(
    snapshot: &OriginalSnapshot,
    position: f64,
) -> Option<&TimeSignatureMarker> {
    snapshot
        .time_signature_markers
        .iter()
        .filter(|marker| marker.start_seconds - snapshot.origin_seconds <= position + POSITION_EPS)
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
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

// ── Capturar ───────────────────────────────────────────────────────────────

/// Id de la canción de `song` que contiene `position`: 1 ms de tolerancia por
/// la izquierda y, con dos canciones pegadas, gana la que EMPIEZA ahí. Misma
/// regla que `move_song_region` y `reorder_song_regions`.
pub fn owning_region_id(song: &Song, position: f64) -> Option<&str> {
    song.regions
        .iter()
        .filter(|region| {
            position >= region.start_seconds - OWNER_TOLERANCE_SECONDS
                && position < region.end_seconds
        })
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|region| region.id.as_str())
}

/// Captura el original desde el contenido actual de la región: todo lo que
/// pertenece a ella (regla de [`owning_region_id`]) más el tempo y el compás
/// que la rigen desde fuera. Devuelve también sus secciones y los avisos.
pub fn capture_original(
    song: &Song,
    cues: &[AutomationCue],
    region_id: &str,
) -> Result<(OriginalSnapshot, Vec<OriginalSection>, Vec<CaptureWarning>), StructureError> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| StructureError::RegionNotFound(region_id.to_string()))?;
    let origin = region.start_seconds;
    let duration = region.end_seconds - region.start_seconds;
    if !origin.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return Err(StructureError::NonFinite(format!("region {region_id}")));
    }
    let mine = |position: f64| owning_region_id(song, position) == Some(region_id);
    // Lo que rige al entrar en la región viene de fuera: de una marca anterior
    // que no es suya, o de la base del proyecto.
    let from_outside =
        |position: f64| position <= origin + OWNER_TOLERANCE_SECONDS && !mine(position);
    let base_bpm = song
        .tempo_markers
        .iter()
        .filter(|marker| from_outside(marker.start_seconds))
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|marker| marker.bpm)
        .unwrap_or(song.bpm);
    let base_time_signature = song
        .time_signature_markers
        .iter()
        .filter(|marker| from_outside(marker.start_seconds))
        .max_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
        .map(|marker| marker.signature.clone())
        .unwrap_or_else(|| song.time_signature.clone());

    let snapshot = OriginalSnapshot {
        origin_seconds: origin,
        duration_seconds: duration,
        base_bpm,
        base_time_signature,
        clips: filtered(&song.clips, |c| mine(c.timeline_start_seconds)),
        midi_clips: filtered(&song.midi_clips, |c| mine(c.timeline_start_seconds)),
        video_clips: filtered(&song.video_clips, |c| mine(c.timeline_start_seconds)),
        tempo_markers: filtered(&song.tempo_markers, |m| mine(m.start_seconds)),
        time_signature_markers: filtered(&song.time_signature_markers, |m| mine(m.start_seconds)),
        section_markers: filtered(&song.section_markers, |m| mine(m.start_seconds)),
        automation_cues: filtered(cues, |c| mine(c.at_seconds)),
    };
    check_snapshot_finite(&snapshot)?;

    let sections = sections_of(&snapshot, region_id);
    if sections.len() < 2 {
        return Err(StructureError::TooFewSections);
    }
    let warnings = midi_crossing_warnings(&snapshot, &sections);
    Ok((snapshot, sections, warnings))
}

fn filtered<T: Clone>(items: &[T], keep: impl Fn(&T) -> bool) -> Vec<T> {
    items.iter().filter(|item| keep(item)).cloned().collect()
}

fn check_snapshot_finite(snapshot: &OriginalSnapshot) -> Result<(), StructureError> {
    let bad = |what: String| Err(StructureError::NonFinite(what));
    if !snapshot.base_bpm.is_finite() || snapshot.base_bpm <= 0.0 {
        return bad("base tempo".into());
    }
    for clip in &snapshot.clips {
        if ![
            clip.timeline_start_seconds,
            clip.source_start_seconds,
            clip.duration_seconds,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return bad(format!("clip {}", clip.id));
        }
    }
    for clip in &snapshot.video_clips {
        if ![
            clip.timeline_start_seconds,
            clip.source_start_seconds,
            clip.duration_seconds,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return bad(format!("video clip {}", clip.id));
        }
    }
    for clip in &snapshot.midi_clips {
        let events_ok = clip
            .events
            .iter()
            .all(|e| e.at_seconds.is_finite() && e.duration_seconds().is_finite());
        if !clip.timeline_start_seconds.is_finite() || !events_ok {
            return bad(format!("midi clip {}", clip.id));
        }
    }
    for marker in &snapshot.tempo_markers {
        if !marker.start_seconds.is_finite() || !marker.bpm.is_finite() {
            return bad(format!("tempo marker {}", marker.id));
        }
    }
    let positions = snapshot
        .time_signature_markers
        .iter()
        .map(|m| (m.start_seconds, &m.id))
        .chain(
            snapshot
                .section_markers
                .iter()
                .map(|m| (m.start_seconds, &m.id)),
        )
        .chain(
            snapshot
                .automation_cues
                .iter()
                .map(|c| (c.at_seconds, &c.id)),
        );
    for (position, id) in positions {
        if !position.is_finite() {
            return bad(id.clone());
        }
    }
    Ok(())
}

/// Secciones del original: de cada marca de categoría Section (siempre por
/// `Marker::category()`) a la siguiente o al final. Si la primera no está en el
/// inicio, el tramo inicial es la sección implícita "Inicio". Las marcas de
/// cue no cortan.
fn sections_of(snapshot: &OriginalSnapshot, region_id: &str) -> Vec<OriginalSection> {
    let origin = snapshot.origin_seconds;
    let duration = snapshot.duration_seconds;
    let mut markers: Vec<(&Marker, f64)> = snapshot
        .section_markers
        .iter()
        .filter(|marker| marker.category() == MarkerCategory::Section)
        .map(|marker| (marker, marker.start_seconds - origin))
        .collect();
    markers.sort_by(|left, right| left.1.total_cmp(&right.1));

    let mut starts: Vec<(String, f64)> = Vec::new();
    for (marker, relative) in markers {
        // La marca clavada en el inicio (con la tolerancia de pertenencia)
        // abre la canción en 0.
        let start = if relative <= OWNER_TOLERANCE_SECONDS {
            0.0
        } else {
            relative
        };
        if starts.is_empty() && start > 0.0 {
            starts.push((implicit_start_section_id(region_id), 0.0));
        }
        // Dos marcas en el mismo sitio: la segunda no abre una sección vacía
        // (viaja dentro de la de la primera).
        if starts
            .last()
            .is_some_and(|(_, last)| start - last < EDGE_EPS)
        {
            continue;
        }
        starts.push((marker.id.clone(), start));
    }
    starts
        .iter()
        .enumerate()
        .map(|(index, (marker_id, start))| OriginalSection {
            marker_id: marker_id.clone(),
            start_seconds: *start,
            end_seconds: starts
                .get(index + 1)
                .map(|(_, next)| *next)
                .unwrap_or(duration),
        })
        .collect()
}

/// Índice de la sección que contiene `relative` (las fronteras van con la
/// sección que empieza en ellas).
fn section_index_at(sections: &[OriginalSection], relative: f64) -> usize {
    sections
        .iter()
        .rposition(|section| relative >= section.start_seconds - EDGE_EPS)
        .unwrap_or(0)
}

fn midi_crossing_warnings(
    snapshot: &OriginalSnapshot,
    sections: &[OriginalSection],
) -> Vec<CaptureWarning> {
    let mut warnings = Vec::new();
    for clip in &snapshot.midi_clips {
        let start = clip.timeline_start_seconds - snapshot.origin_seconds;
        let first = section_index_at(sections, start);
        // El último instante que ocupa algún evento (una nota sostenida
        // también cruza aunque empiece antes de la frontera).
        let reach = start + clip.duration_seconds() - EDGE_EPS;
        let last = section_index_at(sections, reach.max(start));
        if last > first {
            warnings.push(CaptureWarning::MidiClipCrossesSection {
                clip_id: clip.id.clone(),
                marker_id: sections[first + 1].marker_id.clone(),
            });
        }
    }
    warnings
}

// ── Construir ──────────────────────────────────────────────────────────────

/// Un tramo: bloques consecutivos que ya eran consecutivos en el original.
/// Se copia de una pieza, así que el orden original es un solo tramo y no
/// corta nada.
#[derive(Debug, Clone)]
struct Span {
    /// Inicio y fin relativos en el original.
    start: f64,
    end: f64,
    /// Posición relativa de destino en la canción arreglada.
    destination: f64,
    /// Empieza en la primera sección: no tiene borde izquierdo (lo que la
    /// tolerancia de pertenencia dejó un pelo antes del inicio va con él).
    opens_song: bool,
    /// Acaba en la última sección: no tiene borde derecho (la cola de un clip
    /// o una nota que pase del final se conserva, como en el original).
    closes_song: bool,
}

impl Span {
    /// Desplazamiento que lleva una posición del original a la arreglada.
    fn shift(&self) -> f64 {
        self.destination - self.start
    }

    /// Si un instante relativo del original cae en este tramo.
    fn contains(&self, relative: f64) -> bool {
        (self.opens_song || relative >= self.start - EDGE_EPS)
            && (self.closes_song || relative < self.end - EDGE_EPS)
    }
}

/// Numerador de apariciones: la primera conserva el id original (la identidad
/// y los saltos a "Coro" dependen de ello); las siguientes reciben
/// `"{id}~{n}"`, determinista para que aplicar dos veces dé el mismo `Song`.
#[derive(Default)]
struct Appearances(HashMap<String, u32>);

impl Appearances {
    fn next(&mut self, id: &str) -> String {
        let count = self.0.entry(id.to_string()).or_insert(0);
        *count += 1;
        if *count == 1 {
            id.to_string()
        } else {
            format!("{id}~{count}")
        }
    }
}

/// Construye el contenido de la región para una lista de bloques. Ver §6 del
/// diseño (`docs/plans/song-arrangement/00-DISENO.md`).
pub fn build_arrangement(
    snapshot: &OriginalSnapshot,
    sections: &[OriginalSection],
    blocks: &[ArrangementBlock],
) -> Result<BuiltRegion, StructureError> {
    if blocks.is_empty() {
        return Err(StructureError::EmptyArrangement);
    }
    if !snapshot.origin_seconds.is_finite() || !snapshot.duration_seconds.is_finite() {
        return Err(StructureError::NonFinite("original".into()));
    }
    check_snapshot_finite(snapshot)?;
    if sections
        .iter()
        .any(|s| !s.start_seconds.is_finite() || !s.end_seconds.is_finite())
    {
        return Err(StructureError::NonFinite("sections".into()));
    }

    let spans = spans_of(sections, blocks)?;
    let origin = snapshot.origin_seconds;
    let relative = |position: f64| position - origin;
    let mut built = BuiltRegion {
        duration_seconds: spans
            .last()
            .map(|s| s.destination + s.end - s.start)
            .unwrap_or(0.0),
        ..BuiltRegion::default()
    };

    // 1. Clips de audio y vídeo, recortados al tramo.
    let mut clip_ids = Appearances::default();
    let mut video_ids = Appearances::default();
    let mut midi_ids = Appearances::default();
    for span in &spans {
        for clip in &snapshot.clips {
            let start = relative(clip.timeline_start_seconds);
            if let Some(cut) = cut_window(span, start, clip.duration_seconds) {
                let mut copy = clip.clone();
                copy.id = clip_ids.next(&clip.id);
                apply_cut(
                    &cut,
                    span,
                    origin,
                    &mut copy.timeline_start_seconds,
                    &mut copy.source_start_seconds,
                    &mut copy.duration_seconds,
                    &mut copy.fade_in_seconds,
                    &mut copy.fade_out_seconds,
                );
                built.clips.push(copy);
            }
        }
        for clip in &snapshot.video_clips {
            let start = relative(clip.timeline_start_seconds);
            if let Some(cut) = cut_window(span, start, clip.duration_seconds) {
                let mut copy = clip.clone();
                copy.id = video_ids.next(&clip.id);
                apply_cut(
                    &cut,
                    span,
                    origin,
                    &mut copy.timeline_start_seconds,
                    &mut copy.source_start_seconds,
                    &mut copy.duration_seconds,
                    &mut copy.fade_in_seconds,
                    &mut copy.fade_out_seconds,
                );
                built.video_clips.push(copy);
            }
        }
        // 2. MIDI: sólo los eventos del tramo; las notas se acortan al borde.
        for clip in &snapshot.midi_clips {
            if let Some(mut copy) = midi_copy(clip, span, origin) {
                copy.id = midi_ids.next(&clip.id);
                built.midi_clips.push(copy);
            }
        }
    }

    // 3. Marcas (sección y cue), tempo y compás. Se apunta qué copia de cada
    // marca quedó en cada tramo para redirigir los saltos.
    let mut marker_ids = Appearances::default();
    let mut tempo_ids = Appearances::default();
    let mut signature_ids = Appearances::default();
    let mut marker_copy_in_span: HashMap<(usize, &str), String> = HashMap::new();
    let mut first_marker_copy: HashMap<&str, String> = HashMap::new();
    // Marcas de tempo y compás generadas (copias `~n` o insertadas al
    // arrancar un tramo): son las únicas que se pueden quitar por redundantes.
    let mut generated_tempo: Vec<bool> = Vec::new();
    let mut generated_signature: Vec<bool> = Vec::new();
    let mut tempo_before = snapshot.base_bpm;
    let mut signature_before = snapshot.base_time_signature.clone();
    let mut base_inserts = 0u32;
    let base_id = sections
        .first()
        .map(|section| section.marker_id.clone())
        .unwrap_or_default();

    for (span_index, span) in spans.iter().enumerate() {
        for marker in &snapshot.section_markers {
            if span.contains(relative(marker.start_seconds)) {
                let id = marker_ids.next(&marker.id);
                marker_copy_in_span.insert((span_index, marker.id.as_str()), id.clone());
                first_marker_copy
                    .entry(marker.id.as_str())
                    .or_insert_with(|| id.clone());
                built.section_markers.push(Marker {
                    id,
                    start_seconds: marker.start_seconds + span.shift(),
                    ..marker.clone()
                });
            }
        }

        // Tempo de arranque: el que regía en el inicio del tramo en el
        // original, si no es ya el que rige al llegar y no hay una marca justo
        // ahí. Un verso que viene después de un coro con otro tempo no hereda
        // el del coro.
        let wanted = governing_bpm_at(snapshot, span.start);
        let has_own = snapshot.tempo_markers.iter().any(|m| {
            span.contains(relative(m.start_seconds))
                && (relative(m.start_seconds) - span.start).abs() <= start_tolerance(span)
        });
        if !has_own && !same_bpm(wanted, tempo_before) {
            let id = match governing_tempo_marker(snapshot, span.start) {
                Some(marker) => tempo_ids.next(&marker.id),
                None => {
                    base_inserts += 1;
                    format!("{base_id}~tempo~{base_inserts}")
                }
            };
            built.tempo_markers.push(TempoMarker {
                id,
                start_seconds: origin + span.destination,
                bpm: wanted,
            });
            generated_tempo.push(true);
        }
        for marker in &snapshot.tempo_markers {
            if span.contains(relative(marker.start_seconds)) {
                let id = tempo_ids.next(&marker.id);
                generated_tempo.push(id != marker.id);
                built.tempo_markers.push(TempoMarker {
                    id,
                    start_seconds: marker.start_seconds + span.shift(),
                    bpm: marker.bpm,
                });
            }
        }
        tempo_before = governing_bpm_at(snapshot, span_end_probe(span));

        let wanted = governing_signature_at(snapshot, span.start);
        let has_own = snapshot.time_signature_markers.iter().any(|m| {
            span.contains(relative(m.start_seconds))
                && (relative(m.start_seconds) - span.start).abs() <= start_tolerance(span)
        });
        if !has_own && wanted != signature_before {
            let id = match governing_signature_marker(snapshot, span.start) {
                Some(marker) => signature_ids.next(&marker.id),
                None => {
                    base_inserts += 1;
                    format!("{base_id}~signature~{base_inserts}")
                }
            };
            built.time_signature_markers.push(TimeSignatureMarker {
                id,
                start_seconds: origin + span.destination,
                signature: wanted,
            });
            generated_signature.push(true);
        }
        for marker in &snapshot.time_signature_markers {
            if span.contains(relative(marker.start_seconds)) {
                let id = signature_ids.next(&marker.id);
                generated_signature.push(id != marker.id);
                built.time_signature_markers.push(TimeSignatureMarker {
                    id,
                    start_seconds: marker.start_seconds + span.shift(),
                    signature: marker.signature.clone(),
                });
            }
        }
        signature_before = governing_signature_at(snapshot, span_end_probe(span));
    }
    drop_redundant(
        &mut built.tempo_markers,
        &generated_tempo,
        snapshot.base_bpm,
        |m| m.start_seconds,
        |m| m.bpm,
        |a, b| same_bpm(*a, *b),
    );
    drop_redundant(
        &mut built.time_signature_markers,
        &generated_signature,
        snapshot.base_time_signature.clone(),
        |m| m.start_seconds,
        |m| m.signature.clone(),
        |a, b| a == b,
    );

    // 4. Cues de automatización, con los saltos redirigidos.
    let mut cue_ids = Appearances::default();
    for (span_index, span) in spans.iter().enumerate() {
        for cue in &snapshot.automation_cues {
            if !span.contains(relative(cue.at_seconds)) {
                continue;
            }
            let mut copy = cue.clone();
            copy.id = cue_ids.next(&cue.id);
            copy.at_seconds = cue.at_seconds + span.shift();
            for action in &mut copy.actions {
                let AutomationAction::Jump { target, .. } = action else {
                    continue;
                };
                match target {
                    // Dentro de una copia, el salto va a la copia de la marca
                    // de su mismo tramo; si no la hay, a la primera aparición.
                    AutomationJumpTarget::Marker { marker_id } => {
                        let redirected = marker_copy_in_span
                            .get(&(span_index, marker_id.as_str()))
                            .or_else(|| first_marker_copy.get(marker_id.as_str()));
                        if let Some(id) = redirected {
                            *marker_id = id.clone();
                        }
                    }
                    AutomationJumpTarget::Frame { seconds } => {
                        *seconds = frame_target(*seconds, snapshot, &spans, span_index);
                    }
                    AutomationJumpTarget::Region { .. } => {}
                }
            }
            built.automation_cues.push(copy);
        }
    }

    Ok(built)
}

/// Agrupa los bloques en tramos.
fn spans_of(
    sections: &[OriginalSection],
    blocks: &[ArrangementBlock],
) -> Result<Vec<Span>, StructureError> {
    let mut indexes = Vec::with_capacity(blocks.len());
    for block in blocks {
        let index = sections
            .iter()
            .position(|section| section.marker_id == block.section_marker_id)
            .ok_or_else(|| StructureError::UnknownSection(block.section_marker_id.clone()))?;
        indexes.push(index);
    }
    let last_section = sections.len() - 1;
    let mut spans: Vec<Span> = Vec::new();
    let mut previous: Option<usize> = None;
    for index in indexes {
        let section = &sections[index];
        match (previous, spans.last_mut()) {
            (Some(prev), Some(span)) if index == prev + 1 => {
                span.end = section.end_seconds;
                span.closes_song = index == last_section;
            }
            _ => {
                let destination = spans
                    .last()
                    .map(|span| span.destination + (span.end - span.start))
                    .unwrap_or(0.0);
                spans.push(Span {
                    start: section.start_seconds,
                    end: section.end_seconds,
                    destination,
                    opens_song: index == 0,
                    closes_song: index == last_section,
                });
            }
        }
        previous = Some(index);
    }
    Ok(spans)
}

/// Tolerancia para "hay una marca justo al inicio del tramo".
fn start_tolerance(span: &Span) -> f64 {
    if span.opens_song {
        OWNER_TOLERANCE_SECONDS
    } else {
        EDGE_EPS
    }
}

/// Un instante relativo que cae justo antes del final del tramo, para leer lo
/// que rige al salir de él.
fn span_end_probe(span: &Span) -> f64 {
    if span.closes_song {
        f64::INFINITY
    } else {
        span.end - EDGE_EPS
    }
}

fn same_bpm(left: f64, right: f64) -> bool {
    (left - right).abs() < 1e-9
}

/// Quita las marcas generadas que repiten el valor que ya regía. Las del
/// original se quedan aunque sean redundantes: son del usuario y la identidad
/// tiene que devolverlas.
fn drop_redundant<T, V>(
    markers: &mut Vec<T>,
    generated: &[bool],
    base: V,
    position: impl Fn(&T) -> f64,
    value: impl Fn(&T) -> V,
    same: impl Fn(&V, &V) -> bool,
) {
    let mut order: Vec<usize> = (0..markers.len()).collect();
    order.sort_by(|&left, &right| position(&markers[left]).total_cmp(&position(&markers[right])));
    let mut keep = vec![true; markers.len()];
    let mut current = base;
    for index in order {
        let marker_value = value(&markers[index]);
        if generated.get(index).copied().unwrap_or(false) && same(&marker_value, &current) {
            keep[index] = false;
        } else {
            current = marker_value;
        }
    }
    let mut index = 0;
    markers.retain(|_| {
        let kept = keep[index];
        index += 1;
        kept
    });
}

/// Cómo cortar un clip de `[start, start + duration)` (relativo) al tramo.
struct Cut {
    start: f64,
    end: f64,
    trims_start: bool,
    trims_end: bool,
}

fn cut_window(span: &Span, start: f64, duration: f64) -> Option<Cut> {
    let end = start + duration;
    let overlaps = (span.opens_song || end > span.start + EDGE_EPS)
        && (span.closes_song || start < span.end - EDGE_EPS);
    if !overlaps {
        return None;
    }
    let trims_start = !span.opens_song && start < span.start - EDGE_EPS;
    let trims_end = !span.closes_song && end > span.end + EDGE_EPS;
    let cut = Cut {
        start: if trims_start { span.start } else { start },
        end: if trims_end { span.end } else { end },
        trims_start,
        trims_end,
    };
    (cut.end - cut.start > EDGE_EPS || (!trims_start && !trims_end)).then_some(cut)
}

/// Aplica el corte a la geometría de un clip (audio o vídeo comparten forma).
/// Un clip que cabía entero conserva posición relativa, duración y fundidos
/// exactos; un borde recortado recibe `CUT_FADE_SECONDS` salvo que ya tuviera
/// un fundido mayor.
#[allow(clippy::too_many_arguments)]
fn apply_cut(
    cut: &Cut,
    span: &Span,
    origin: f64,
    timeline_start: &mut f64,
    source_start: &mut f64,
    duration: &mut f64,
    fade_in: &mut Option<f64>,
    fade_out: &mut Option<f64>,
) {
    if cut.trims_start {
        *source_start += cut.start - (*timeline_start - origin);
        *timeline_start = origin + span.destination;
        *fade_in = Some(fade_in.unwrap_or(0.0).max(CUT_FADE_SECONDS));
    } else {
        *timeline_start += span.shift();
    }
    if cut.trims_start || cut.trims_end {
        *duration = cut.end - cut.start;
    }
    if cut.trims_end {
        *fade_out = Some(fade_out.unwrap_or(0.0).max(CUT_FADE_SECONDS));
    }
    if cut.trims_start || cut.trims_end {
        // Un fundido no puede durar más que el clip que queda.
        for value in [fade_in, fade_out].into_iter().flatten() {
            *value = value.min(*duration);
        }
    }
}

/// Copia de un clip MIDI con sólo los eventos del tramo. `None` si no queda
/// ninguno. No se inventan eventos.
fn midi_copy(clip: &MidiClip, span: &Span, origin: f64) -> Option<MidiClip> {
    let start = clip.timeline_start_seconds - origin;
    let starts_inside = span.opens_song || start >= span.start - EDGE_EPS;
    let mut events = Vec::new();
    for event in &clip.events {
        let at = start + event.at_seconds;
        if !span.contains(at) {
            continue;
        }
        let mut copy = event.clone();
        if !starts_inside {
            copy.at_seconds = at - span.start;
        }
        if !span.closes_song {
            let room = span.end - at;
            match &mut copy.kind {
                MidiEventKind::Note {
                    duration_seconds, ..
                }
                | MidiEventKind::ControlCurve {
                    duration_seconds, ..
                } if *duration_seconds > room + EDGE_EPS => {
                    *duration_seconds = room.max(0.0);
                }
                _ => {}
            }
        }
        events.push(copy);
    }
    if events.is_empty() {
        return None;
    }
    let timeline_start_seconds = if starts_inside {
        clip.timeline_start_seconds + span.shift()
    } else {
        origin + span.destination
    };
    Some(MidiClip {
        timeline_start_seconds,
        events,
        ..clip.clone()
    })
}

/// Destino de un salto a un instante. Si cae dentro de la canción va a su
/// copia del mismo tramo, o a la primera que lo contenga; si su sección ya no
/// está en el arreglo, al inicio de la canción. Si apunta fuera de la canción
/// no se toca (lo recoloca la sesión si su canción se mueve).
fn frame_target(seconds: f64, snapshot: &OriginalSnapshot, spans: &[Span], own: usize) -> f64 {
    let relative = seconds - snapshot.origin_seconds;
    let inside = relative >= -OWNER_TOLERANCE_SECONDS && relative < snapshot.duration_seconds;
    if !inside {
        return seconds;
    }
    let span = spans
        .get(own)
        .filter(|span| span.contains(relative))
        .or_else(|| spans.iter().find(|span| span.contains(relative)));
    match span {
        Some(span) => seconds + span.shift(),
        None => snapshot.origin_seconds,
    }
}

#[cfg(test)]
#[path = "song_structure_tests.rs"]
mod tests;
