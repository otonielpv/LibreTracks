//! Las cues de automatización viajan con su canción.
//!
//! Las cues viven en `automation.ltautomation`, no en el `Song`, así que las
//! operaciones que trasladan canciones enteras (`move_song_region`,
//! `reorder_song_region`, y deshacer/rehacer de esas mismas) no las veían: la
//! canción se iba y su salto se quedaba en la posición vieja, dentro de otra
//! canción o en un hueco.
//!
//! La regla es la misma que usan esas operaciones para clips y marcas: una cue
//! pertenece a la canción en cuyo tramo `[inicio - 1 ms, fin)` cae su
//! `at_seconds`. Si esa canción se ha TRASLADADO (misma duración, otro
//! inicio), la cue se traslada lo mismo. Un salto a un instante concreto
//! (`Frame`) sigue a la canción que contiene su destino, que puede ser otra.
//!
//! Las cues están en tiempo de fuente (`upsert_automation_cue` las normaliza
//! con `source_seconds_at_view`), igual que clips y marcas, así que el delta
//! de fuente de la región las deja en el mismo compás visible aunque haya
//! warp: la relación vista↔fuente es lineal dentro de cada región.

use libretracks_core::Song;

use crate::audio::automation::{
    save_automation, AutomationAction, AutomationCue, AutomationJumpTarget,
};
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;

use super::{AudioChangeImpact, DesktopSession, UpdatePhase};

impl DesktopSession {
    /// `persist_song_update_internal` que además arrastra las cues de las
    /// canciones trasladadas entre el `Song` cargado y `song`.
    ///
    /// Todo o nada: el documento de automatización se escribe ANTES que el
    /// `Song`, y si el `Song` no se acepta se vuelve a escribir el viejo. No
    /// puede quedar la canción movida y sus cues no, ni al revés.
    pub(super) fn persist_song_update_carrying_cues(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
        record_history: bool,
        phase: UpdatePhase,
    ) -> Result<(), DesktopError> {
        let previous = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let mut automation = self.automation.clone();
        if !carry_cues_with_regions(&previous, &song, &mut automation.cues) {
            return self.persist_song_update_internal(
                song,
                audio,
                impact,
                record_history,
                true,
                phase,
            );
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        save_automation(&song_dir, &automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        if let Err(error) =
            self.persist_song_update_internal(song, audio, impact, record_history, true, phase)
        {
            // Mejor esfuerzo: si tampoco se puede reescribir, el error que
            // importa al usuario es el primero.
            let _ = save_automation(&song_dir, &self.automation);
            return Err(error);
        }

        self.automation = automation;
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        self.cancel_native_scheduled_jumps(audio)?;
        self.schedule_next_automation_jump(audio)?;
        Ok(())
    }
}

/// Tolerancia para decidir que una canción no ha cambiado de duración.
const SAME_LENGTH_EPS: f64 = 1e-6;
/// Movimientos por debajo de esto no cuentan como traslado.
const MOVED_EPS: f64 = 1e-9;

/// Delta de fuente con el que se trasladó cada canción de `before`, en el
/// mismo orden que `before.regions`. `None` si la canción ya no existe, si no
/// se movió o si cambió de duración (eso no es un traslado: lo que tenga
/// dentro lo recoloca quien la cambió).
fn region_deltas(before: &Song, after: &Song) -> Vec<Option<f64>> {
    before
        .regions
        .iter()
        .map(|old| {
            let new = after.regions.iter().find(|region| region.id == old.id)?;
            let old_length = old.end_seconds - old.start_seconds;
            let new_length = new.end_seconds - new.start_seconds;
            if (old_length - new_length).abs() > SAME_LENGTH_EPS {
                return None;
            }
            let delta = new.start_seconds - old.start_seconds;
            (delta.abs() > MOVED_EPS).then_some(delta)
        })
        .collect()
}

/// Índice de la canción de `song` que contiene `position`, con la misma regla
/// que `move_song_region` y `reorder_song_regions`: 1 ms de tolerancia por la
/// izquierda y, con dos canciones pegadas, gana la que EMPIEZA ahí.
fn owner_index(song: &Song, position: f64) -> Option<usize> {
    let mut owner = None;
    let mut owner_start = f64::NEG_INFINITY;
    for (index, region) in song.regions.iter().enumerate() {
        let inside = position >= region.start_seconds - 0.001 && position < region.end_seconds;
        if inside && region.start_seconds >= owner_start {
            owner = Some(index);
            owner_start = region.start_seconds;
        }
    }
    owner
}

/// Traslada las cues (y los destinos `Frame` de sus saltos) cuya canción se
/// trasladó entre `before` y `after`. Devuelve `true` si cambió algo.
pub(super) fn carry_cues_with_regions(
    before: &Song,
    after: &Song,
    cues: &mut [AutomationCue],
) -> bool {
    let deltas = region_deltas(before, after);
    if deltas.iter().all(Option::is_none) {
        return false;
    }
    let delta_at = |position: f64| owner_index(before, position).and_then(|index| deltas[index]);

    let mut changed = false;
    for cue in cues.iter_mut() {
        if let Some(delta) = delta_at(cue.at_seconds) {
            cue.at_seconds = (cue.at_seconds + delta).max(0.0);
            changed = true;
        }
        for action in &mut cue.actions {
            if let AutomationAction::Jump {
                target: AutomationJumpTarget::Frame { seconds },
                ..
            } = action
            {
                if let Some(delta) = delta_at(*seconds) {
                    *seconds = (*seconds + delta).max(0.0);
                    changed = true;
                }
            }
        }
    }
    if changed {
        cues.sort_by(|left, right| {
            left.at_seconds
                .partial_cmp(&right.at_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    changed
}

#[cfg(test)]
#[path = "cue_follow_tests.rs"]
mod tests;
