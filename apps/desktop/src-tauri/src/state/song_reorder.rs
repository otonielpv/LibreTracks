//! Reordenar canciones como una lista: "la canción 3 pasa a ser la 1".
//!
//! Las vistas compacta y live muestran las canciones como una secuencia, no
//! como una línea de tiempo, así que su arrastre no habla en segundos (eso es
//! `move_song_region`, el de la DAW) sino en posiciones de la lista.
//!
//! Cada canción viaja entera —región, clips de audio, vídeo y MIDI, y las
//! marcas de tempo, compás y sección que empiezan dentro de ella— y los HUECOS
//! se quedan donde estaban: el hueco entre la 1ª y la 2ª posición de la lista
//! sigue siendo el mismo, la ocupe quien la ocupe. Si una frontera caía en un
//! tiempo fuerte (lo normal: importar y "Nueva canción" colocan cada canción en
//! el compás siguiente al final de la anterior), la nueva frontera también: la
//! canción que llega se coloca en el primer tiempo fuerte tras la anterior.
//!
//! Lo que no pertenece a ninguna canción (una marca suelta entre dos) no se
//! mueve. Las cues de automatización, que no están en el `Song`, las arrastra
//! `cue_follow` con la misma regla de pertenencia.

use libretracks_core::{source_seconds_at_view, warp_timeline_seconds_at, Song};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    next_downbeat_after_in_view_timeline, refresh_song_duration,
    region_boundary_was_downbeat_aligned, sort_song_regions, AudioChangeImpact, DesktopSession,
    UpdatePhase,
};

impl DesktopSession {
    /// Lleva la canción `region_id` a la posición `target_index` de la lista
    /// (0 = primera). Un índice fuera de rango la deja la última. Una sola
    /// actualización persistida: un snapshot, una entrada de deshacer.
    pub fn reorder_song_region(
        &mut self,
        region_id: &str,
        target_index: usize,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if !song.regions.iter().any(|region| region.id == region_id) {
            return Err(DesktopError::RegionNotFound(region_id.to_string()));
        }
        if !reorder_song_regions(&mut song, region_id, target_index) {
            return Ok(self.snapshot());
        }

        refresh_song_duration(&mut song);
        audio.update_live_song_regions(&song)?;
        // TimelineWindow, como `move_song_region`: se trasladan clips y marcas,
        // no cambian fuentes ni pistas. Las cues de automatización viajan con
        // su canción en el mismo paso (`cue_follow`).
        self.persist_song_update_carrying_cues(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            true,
            UpdatePhase::Commit,
        )?;

        Ok(self.snapshot())
    }
}

/// Índice (en `spans`, ordenado por inicio) de la canción que contiene
/// `position`. Misma regla que `move_song_region`: 1 ms de tolerancia por la
/// izquierda para que la marca de tempo clavada en el inicio viaje con su
/// canción. Con dos canciones pegadas gana la que EMPIEZA ahí.
pub(super) fn owning_span(spans: &[(f64, f64)], position: f64) -> Option<usize> {
    spans
        .iter()
        .rposition(|&(start, end)| position >= start - 0.001 && position < end)
}

/// Inicio y fin de cada canción, en el orden de `song.regions`.
pub(super) fn region_spans(song: &Song) -> Vec<(f64, f64)> {
    song.regions
        .iter()
        .map(|region| (region.start_seconds, region.end_seconds))
        .collect()
}

/// Reordena en el sitio. Devuelve `false` si no había nada que mover.
pub(super) fn reorder_song_regions(song: &mut Song, region_id: &str, target_index: usize) -> bool {
    sort_song_regions(&mut song.regions);
    let count = song.regions.len();
    let Some(from) = song
        .regions
        .iter()
        .position(|region| region.id == region_id)
    else {
        return false;
    };
    let to = target_index.min(count - 1);
    if from == to {
        return false;
    }

    let previous = song.clone();
    let spans = region_spans(&previous);
    // A quién pertenece cada elemento, decidido UNA vez sobre las posiciones
    // de partida: durante la recolocación las canciones se cruzan.
    let owners = Owners::of(song, &spans);
    let lengths: Vec<f64> = spans.iter().map(|&(start, end)| end - start).collect();

    let mut order: Vec<usize> = (0..count).collect();
    let moved = order.remove(from);
    order.insert(to, moved);

    lay_out_songs(song, &previous, &owners, &order, 0, &lengths);
    true
}

/// Coloca las canciones una tras otra en el orden `order`, que indexa
/// `previous.regions` (ordenadas por inicio). Lo comparten reordenar y aplicar
/// un arreglo.
///
/// - Los HUECOS se quedan con su posición en la lista: el hueco entre la 1ª y
///   la 2ª posición sigue siendo el mismo, la ocupe quien la ocupe.
/// - Si una frontera caía en un tiempo fuerte, la nueva también: la canción
///   que llega se coloca en el primer tiempo fuerte tras la anterior.
/// - Las `keep_first` primeras posiciones no se mueven (aplicar un arreglo no
///   toca las canciones de antes ni la arreglada).
///
/// `lengths[i]` es la duración que tiene AHORA la canción `i` (aplicar un
/// arreglo la cambia); `song` ya la refleja en el fin de su región. `owners`
/// dice de quién es cada elemento de `song`: lo decide quien llama porque, al
/// aplicar un arreglo, el contenido nuevo de una canción puede pasar de su
/// fin viejo y ya no se puede deducir de las posiciones.
pub(super) fn lay_out_songs(
    song: &mut Song,
    previous: &Song,
    owners: &Owners,
    order: &[usize],
    keep_first: usize,
    lengths: &[f64],
) {
    let count = order.len();
    let spans = region_spans(previous);
    // Hueco y alineación de cada frontera de la lista, por posición.
    let gaps: Vec<f64> = spans
        .windows(2)
        .map(|pair| (pair[1].0 - pair[0].1).max(0.0))
        .collect();
    let aligned: Vec<bool> = previous
        .regions
        .windows(2)
        .map(|pair| region_boundary_was_downbeat_aligned(previous, &pair[0], &pair[1]))
        .collect();
    let ids: Vec<String> = previous
        .regions
        .iter()
        .map(|region| region.id.clone())
        .collect();

    // Se aparcan las canciones que se recolocan lejos, más allá de donde
    // pueda acabar la nueva disposición, y se traen de vuelta una a una en el
    // orden nuevo. Así la rejilla de compases que decide dónde cae cada una
    // sólo ve las que ya están colocadas, nunca una que todavía ocupa su
    // sitio viejo.
    let horizon = spans
        .iter()
        .zip(lengths)
        .map(|(&(start, end), &length)| end.max(start + length))
        .fold(song.duration_seconds, f64::max);
    let park = horizon + 3600.0 * (count as f64 + 1.0);
    for &index in order.iter().skip(keep_first) {
        owners.translate(song, &ids[index], index, park);
    }

    let mut previous_end: Option<f64> = None;
    for (slot, &index) in order.iter().enumerate() {
        let start = spans[index].0;
        if slot < keep_first {
            previous_end = Some(start + lengths[index]);
            continue;
        }
        let target_start = match previous_end {
            None => spans[0].0,
            Some(prev_end) if aligned[slot - 1] => {
                let view_start = next_downbeat_after_in_view_timeline(
                    song,
                    warp_timeline_seconds_at(song, prev_end),
                );
                source_seconds_at_view(song, view_start).max(prev_end)
            }
            Some(prev_end) => prev_end + gaps[slot - 1],
        };
        owners.translate(song, &ids[index], index, target_start - (start + park));
        sort_song_regions(&mut song.regions);
        previous_end = Some(target_start + lengths[index]);
    }

    let by_start = |left: f64, right: f64| {
        left.partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    song.tempo_markers
        .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    song.time_signature_markers
        .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    song.section_markers
        .sort_by(|l, r| by_start(l.start_seconds, r.start_seconds));
    song.midi_clips
        .sort_by(|l, r| by_start(l.timeline_start_seconds, r.timeline_start_seconds));
}

fn owners_of(spans: &[(f64, f64)], positions: impl Iterator<Item = f64>) -> Vec<Option<usize>> {
    positions
        .map(|position| owning_span(spans, position))
        .collect()
}

/// Dueño de cada elemento, en el mismo orden que su lista en `Song`.
pub(super) struct Owners {
    pub(super) clips: Vec<Option<usize>>,
    pub(super) video_clips: Vec<Option<usize>>,
    pub(super) midi_clips: Vec<Option<usize>>,
    pub(super) tempo_markers: Vec<Option<usize>>,
    pub(super) time_signature_markers: Vec<Option<usize>>,
    pub(super) section_markers: Vec<Option<usize>>,
}

impl Owners {
    /// Dueños por posición, con la regla de `owning_span`.
    pub(super) fn of(song: &Song, spans: &[(f64, f64)]) -> Self {
        Owners {
            clips: owners_of(spans, song.clips.iter().map(|c| c.timeline_start_seconds)),
            video_clips: owners_of(
                spans,
                song.video_clips.iter().map(|c| c.timeline_start_seconds),
            ),
            midi_clips: owners_of(
                spans,
                song.midi_clips.iter().map(|c| c.timeline_start_seconds),
            ),
            tempo_markers: owners_of(spans, song.tempo_markers.iter().map(|m| m.start_seconds)),
            time_signature_markers: owners_of(
                spans,
                song.time_signature_markers.iter().map(|m| m.start_seconds),
            ),
            section_markers: owners_of(
                spans,
                song.section_markers.iter().map(|m| m.start_seconds),
            ),
        }
    }

    /// Traslada la canción `index` (región `region_id`) y todo lo suyo.
    ///
    /// Las listas de elementos no se reordenan hasta el final de
    /// `lay_out_songs`, así que los índices de `self` siguen valiendo.
    fn translate(&self, song: &mut Song, region_id: &str, index: usize, delta: f64) {
        let mine = |owner: &Option<usize>| *owner == Some(index);
        if let Some(region) = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
        {
            region.start_seconds += delta;
            region.end_seconds += delta;
        }
        for (clip, owner) in song.clips.iter_mut().zip(&self.clips) {
            if mine(owner) {
                clip.timeline_start_seconds += delta;
            }
        }
        for (clip, owner) in song.video_clips.iter_mut().zip(&self.video_clips) {
            if mine(owner) {
                clip.timeline_start_seconds += delta;
            }
        }
        for (clip, owner) in song.midi_clips.iter_mut().zip(&self.midi_clips) {
            if mine(owner) {
                clip.timeline_start_seconds += delta;
            }
        }
        for (marker, owner) in song.tempo_markers.iter_mut().zip(&self.tempo_markers) {
            if mine(owner) {
                marker.start_seconds += delta;
            }
        }
        for (marker, owner) in song
            .time_signature_markers
            .iter_mut()
            .zip(&self.time_signature_markers)
        {
            if mine(owner) {
                marker.start_seconds += delta;
            }
        }
        for (marker, owner) in song.section_markers.iter_mut().zip(&self.section_markers) {
            if mine(owner) {
                marker.start_seconds += delta;
            }
        }
    }
}

#[cfg(test)]
#[path = "song_reorder_tests.rs"]
mod tests;
