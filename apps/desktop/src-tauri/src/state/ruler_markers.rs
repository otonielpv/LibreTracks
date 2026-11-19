//! Edición POR LOTES de las marcas de la regla: secciones/avisos, tempo y
//! compás. Mover, duplicar o borrar una selección múltiple es UNA operación —un
//! solo paso de deshacer y un solo realineado del warp—, no N llamadas sueltas.
//!
//! Las posiciones llegan en tiempo de VISTA, como todo lo que manda el
//! frontend, y se convierten a fuente contra la canción de ANTES del cambio:
//! mover una marca de tempo cambia el mapeo, y convertir unas marcas contra el
//! mapeo nuevo y otras contra el viejo descolocaría el grupo.

use libretracks_core::{source_seconds_at_view, MarkerCategory, Song};
use serde::Deserialize;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    realign_regions_after_warp_tempo_change, song_has_active_warp, timestamp_suffix,
    AudioChangeImpact, DesktopSession, UpdatePhase,
};

/// Por debajo de esto una marca de tempo/compás está "en el cero", que no es
/// una marca sino el valor base de la canción (como en `upsert_*_marker`).
const ORIGIN_EPSILON: f64 = 0.0001;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RulerMarkerKind {
    /// Sección o aviso: los dos son `Marker`, cambia sólo el carril.
    Section,
    Tempo,
    TimeSignature,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulerMarkerRef {
    pub kind: RulerMarkerKind,
    pub id: String,
}

/// Una marca y dónde debe quedar (mover) o dónde va su copia (duplicar).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulerMarkerPlacement {
    pub kind: RulerMarkerKind,
    pub id: String,
    pub start_seconds: f64,
    /// Sólo secciones, al duplicar: el carril donde cae la copia (Alt+arrastrar
    /// una marca al carril de avisos). Sin él, la copia hereda el del original.
    #[serde(default)]
    pub category_override: Option<MarkerCategory>,
}

fn sort_by_start<T>(items: &mut [T], start: impl Fn(&T) -> f64) {
    items.sort_by(|left, right| {
        start(left)
            .partial_cmp(&start(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Dos marcas de tempo (o de compás) no pueden compartir posición: la que
/// acaba de llegar ahí —movida o copiada— gana, como pasa al insertar una
/// encima de otra. `fresh` dice cuáles son las recién colocadas.
fn dedupe_by_position<T>(
    items: Vec<T>,
    start: impl Fn(&T) -> f64,
    fresh: impl Fn(&T) -> bool,
) -> Vec<T> {
    let mut kept: Vec<T> = Vec::with_capacity(items.len());
    for item in items {
        match kept
            .iter()
            .position(|other| (start(other) - start(&item)).abs() < ORIGIN_EPSILON)
        {
            Some(index) if fresh(&item) || !fresh(&kept[index]) => kept[index] = item,
            Some(_) => {}
            None => kept.push(item),
        }
    }
    kept
}

/// Lo que tocó una edición, para saber qué hay que recalcular al guardar.
#[derive(Default)]
struct Touched {
    sections: bool,
    tempo: bool,
}

impl DesktopSession {
    /// Mueve cada marca a su nueva posición (tiempo de vista).
    pub fn move_ruler_markers(
        &mut self,
        moves: &[RulerMarkerPlacement],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.edit_ruler_markers(audio, |previous, song, touched| {
            let source = |view: f64| source_seconds_at_view(previous, view).max(0.0);
            let mut moved_tempo = Vec::new();
            let mut moved_signature = Vec::new();
            for placement in moves {
                match placement.kind {
                    RulerMarkerKind::Section => {
                        let marker = song
                            .section_markers
                            .iter_mut()
                            .find(|marker| marker.id == placement.id)
                            .ok_or_else(|| DesktopError::SectionNotFound(placement.id.clone()))?;
                        marker.start_seconds = source(placement.start_seconds);
                        touched.sections = true;
                    }
                    RulerMarkerKind::Tempo => {
                        let marker = song
                            .tempo_markers
                            .iter_mut()
                            .find(|marker| marker.id == placement.id)
                            .ok_or_else(|| {
                                DesktopError::AudioCommand("tempo marker not found".into())
                            })?;
                        marker.start_seconds = source(placement.start_seconds);
                        moved_tempo.push(marker.id.clone());
                        touched.tempo = true;
                    }
                    RulerMarkerKind::TimeSignature => {
                        let marker = song
                            .time_signature_markers
                            .iter_mut()
                            .find(|marker| marker.id == placement.id)
                            .ok_or_else(|| {
                                DesktopError::AudioCommand(
                                    "time signature marker not found".into(),
                                )
                            })?;
                        marker.start_seconds = source(placement.start_seconds);
                        moved_signature.push(marker.id.clone());
                    }
                }
            }
            settle_tempo_and_signature(song, &moved_tempo, &moved_signature);
            Ok(())
        })
    }

    /// Crea una copia de cada marca en la posición indicada (tiempo de vista).
    /// Las copias de secciones no heredan la tecla numérica: dos marcas con el
    /// mismo dígito harían ambiguo el salto.
    pub fn duplicate_ruler_markers(
        &mut self,
        copies: &[RulerMarkerPlacement],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.edit_ruler_markers(audio, |previous, song, touched| {
            let source = |view: f64| source_seconds_at_view(previous, view).max(0.0);
            let suffix = timestamp_suffix();
            let mut new_tempo = Vec::new();
            let mut new_signature = Vec::new();
            for (index, copy) in copies.iter().enumerate() {
                match copy.kind {
                    RulerMarkerKind::Section => {
                        let original = previous
                            .section_markers
                            .iter()
                            .find(|marker| marker.id == copy.id)
                            .ok_or_else(|| DesktopError::SectionNotFound(copy.id.clone()))?;
                        let mut marker = original.clone();
                        marker.id = format!("section_{suffix}_{index}");
                        marker.start_seconds = source(copy.start_seconds);
                        marker.digit = None;
                        // Mismo criterio que mover: su carril natural no se fija.
                        if let Some(category) = copy.category_override {
                            marker.category_override =
                                (category != marker.kind.category()).then_some(category);
                        }
                        song.section_markers.push(marker);
                        touched.sections = true;
                    }
                    RulerMarkerKind::Tempo => {
                        let original = previous
                            .tempo_markers
                            .iter()
                            .find(|marker| marker.id == copy.id)
                            .ok_or_else(|| {
                                DesktopError::AudioCommand("tempo marker not found".into())
                            })?;
                        let mut marker = original.clone();
                        marker.id = format!("tempo_marker_{suffix}_{index}");
                        marker.start_seconds = source(copy.start_seconds);
                        new_tempo.push(marker.id.clone());
                        song.tempo_markers.push(marker);
                        touched.tempo = true;
                    }
                    RulerMarkerKind::TimeSignature => {
                        let original = previous
                            .time_signature_markers
                            .iter()
                            .find(|marker| marker.id == copy.id)
                            .ok_or_else(|| {
                                DesktopError::AudioCommand(
                                    "time signature marker not found".into(),
                                )
                            })?;
                        let mut marker = original.clone();
                        marker.id = format!("time_signature_marker_{suffix}_{index}");
                        marker.start_seconds = source(copy.start_seconds);
                        new_signature.push(marker.id.clone());
                        song.time_signature_markers.push(marker);
                    }
                }
            }
            settle_tempo_and_signature(song, &new_tempo, &new_signature);
            Ok(())
        })
    }

    /// Borra las marcas indicadas. Una que ya no exista se ignora: el lote
    /// puede llegar justo después de otra edición que se la llevó.
    pub fn delete_ruler_markers(
        &mut self,
        markers: &[RulerMarkerRef],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.edit_ruler_markers(audio, |_previous, song, touched| {
            let ids = |kind: RulerMarkerKind| {
                markers
                    .iter()
                    .filter(move |marker| marker.kind == kind)
                    .map(|marker| marker.id.as_str())
                    .collect::<Vec<_>>()
            };
            let sections = ids(RulerMarkerKind::Section);
            let tempo = ids(RulerMarkerKind::Tempo);
            let signatures = ids(RulerMarkerKind::TimeSignature);
            touched.sections = !sections.is_empty();
            touched.tempo = !tempo.is_empty();
            song.section_markers
                .retain(|marker| !sections.contains(&marker.id.as_str()));
            song.tempo_markers
                .retain(|marker| !tempo.contains(&marker.id.as_str()));
            song.time_signature_markers
                .retain(|marker| !signatures.contains(&marker.id.as_str()));
            Ok(())
        })
    }

    /// Esqueleto común: clona la canción, aplica la edición y la guarda con
    /// lo que haga falta según qué marcas tocó. Un solo `persist`, así que es
    /// un solo paso del historial.
    fn edit_ruler_markers(
        &mut self,
        audio: &AudioController,
        edit: impl FnOnce(&Song, &mut Song, &mut Touched) -> Result<(), DesktopError>,
    ) -> Result<TransportSnapshot, DesktopError> {
        let previous = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let mut song = previous.clone();
        let mut touched = Touched::default();
        edit(&previous, &mut song, &mut touched)?;
        if song == previous {
            return Ok(self.snapshot());
        }

        sort_by_start(&mut song.section_markers, |marker| marker.start_seconds);
        if touched.sections {
            audio.update_live_section_markers(&song)?;
        }
        if touched.tempo {
            realign_regions_after_warp_tempo_change(&previous, &mut song);
            let impact = if song_has_active_warp(&song) {
                AudioChangeImpact::TimelineWindow
            } else {
                AudioChangeImpact::TransportOnly
            };
            // Realinear traslada las canciones siguientes: sus cues van con
            // ellas (igual que `upsert_song_tempo_marker`).
            self.persist_song_update_carrying_cues(song, audio, impact, true, UpdatePhase::Commit)?;
        } else {
            let impact = if touched.sections {
                AudioChangeImpact::MixerOnly
            } else {
                AudioChangeImpact::TransportOnly
            };
            self.persist_song_update(song, audio, impact, true)?;
        }
        Ok(self.snapshot())
    }
}

/// Tras colocar marcas de tempo y compás: una que cae en el cero pasa a ser
/// el valor base de la canción, dos en el mismo sitio se funden (gana la
/// recién colocada) y todo queda ordenado.
///
/// Sólo se asienta el tipo que se colocó: una sesión puede tener marcas de
/// tempo y compás en el cero (las de su primera canción), y mover o copiar
/// sólo secciones no debe absorberlas en el valor base, que las borraba.
fn settle_tempo_and_signature(song: &mut Song, fresh_tempo: &[String], fresh_signature: &[String]) {
    if !fresh_tempo.is_empty() {
        settle_tempo(song, fresh_tempo);
    }
    if !fresh_signature.is_empty() {
        settle_signature(song, fresh_signature);
    }
}

fn settle_tempo(song: &mut Song, fresh_tempo: &[String]) {
    let mut tempo = std::mem::take(&mut song.tempo_markers);
    sort_by_start(&mut tempo, |marker| marker.start_seconds);
    if let Some(origin) = tempo
        .iter()
        .rev()
        .find(|marker| marker.start_seconds <= ORIGIN_EPSILON)
    {
        song.bpm = origin.bpm;
    }
    tempo.retain(|marker| marker.start_seconds > ORIGIN_EPSILON);
    song.tempo_markers = dedupe_by_position(
        tempo,
        |marker| marker.start_seconds,
        |marker| fresh_tempo.contains(&marker.id),
    );
}

fn settle_signature(song: &mut Song, fresh_signature: &[String]) {
    let mut signatures = std::mem::take(&mut song.time_signature_markers);
    sort_by_start(&mut signatures, |marker| marker.start_seconds);
    if let Some(origin) = signatures
        .iter()
        .rev()
        .find(|marker| marker.start_seconds <= ORIGIN_EPSILON)
    {
        song.time_signature = origin.signature.clone();
    }
    signatures.retain(|marker| marker.start_seconds > ORIGIN_EPSILON);
    song.time_signature_markers = dedupe_by_position(
        signatures,
        |marker| marker.start_seconds,
        |marker| fresh_signature.contains(&marker.id),
    );
}
