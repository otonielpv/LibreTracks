//! Ecualizador por pista (plan `track-eq`, paso 05): confirmar un cambio.
//!
//! Mismo reparto que el pan: el arrastre va solo al motor
//! (`AudioController::update_live_track_eq`, sin modelo ni historial) y al
//! soltar se confirma aquí una vez: modelo + paso de deshacer + un comando
//! dirigido al motor. Deshacer y rehacer reconstruyen por `UpsertSongTracks`,
//! que lleva el EQ de cada pista.

use libretracks_core::{TrackEq, TrackKind};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::DesktopSession;

/// Qué pistas llevan EQ. Hoy solo las de audio.
pub(crate) fn track_kind_takes_eq(kind: TrackKind) -> bool {
    kind == TrackKind::Audio
}

impl DesktopSession {
    /// Guarda el EQ (recortado) en la pista, apila un paso de deshacer y lo
    /// manda al motor. `None` quita el EQ. Solo pistas de audio.
    pub fn commit_track_eq_model_and_command(
        &mut self,
        track_id: &str,
        eq: Option<TrackEq>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.commit_track_eqs_model_and_command(vec![(track_id.to_string(), eq)], audio)
    }

    /// El mismo commit para varias pistas a la vez (plan track-eq-2, paso 02):
    /// **un** paso de deshacer y una orden al motor por pista que cambia. Si
    /// una pista no existe o no lleva EQ, no se cambia ninguna. Si ninguna
    /// cambia, no apila nada.
    pub fn commit_track_eqs_model_and_command(
        &mut self,
        changes: Vec<(String, Option<TrackEq>)>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let changes: Vec<(String, Option<TrackEq>)> = changes
            .into_iter()
            .map(|(track_id, eq)| (track_id, eq.map(|eq| eq.sanitized())))
            .collect();
        let pending: Vec<(String, Option<TrackEq>)> = {
            let song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
            let mut pending = Vec::new();
            for (track_id, eq) in &changes {
                let track = song
                    .tracks
                    .iter()
                    .find(|track| &track.id == track_id)
                    .ok_or_else(|| DesktopError::TrackNotFound(track_id.clone()))?;
                if !track_kind_takes_eq(track.kind) {
                    return Err(DesktopError::AudioCommand(format!(
                        "el ecualizador solo existe en pistas de audio ({track_id})"
                    )));
                }
                if &track.eq != eq {
                    pending.push((track_id.clone(), eq.clone()));
                }
            }
            pending
        };
        if pending.is_empty() {
            return Ok(self.snapshot());
        }

        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();
        self.transpose_history_group = None;
        // Tocar el EQ a mano saca la pista de las escenas puestas (E3).
        for (track_id, _) in &pending {
            self.mix_touched_by_user(track_id);
        }
        {
            let song = self.engine.song_mut()?;
            for (track_id, eq) in &pending {
                if let Some(track) = song.tracks.iter_mut().find(|track| &track.id == track_id) {
                    track.eq = eq.clone();
                }
            }
        }
        for (track_id, eq) in &pending {
            audio.set_track_eq(track_id, eq.as_ref())?;
        }
        audio.record_commit_mix();

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        Ok(self.snapshot())
    }

    /// Una cue cambia el EQ (plan track-eq-2, E4): UNA orden al motor con la
    /// rampa (el motor la recorre entera, sin escalones) y el valor final en
    /// el modelo, sin paso de deshacer ni revisión, como el resto de la
    /// automatización (`mirror_track_mix_into_model`). Pistas sin EQ posible
    /// o inexistentes se ignoran.
    pub(super) fn apply_track_eq_from_automation(
        &mut self,
        track_id: &str,
        eq: Option<TrackEq>,
        ramp_seconds: f64,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let eq = eq.map(|eq| eq.sanitized());
        let Ok(song) = self.engine.song_mut() else {
            return Ok(());
        };
        let Some(track) = song.tracks.iter_mut().find(|track| track.id == track_id) else {
            return Ok(());
        };
        if !track_kind_takes_eq(track.kind) || track.eq == eq {
            return Ok(());
        }
        track.eq = eq.clone();
        audio.set_track_eq_with_ramp(track_id, eq.as_ref(), ramp_seconds.max(0.0))?;
        self.bump_mix_revision();
        Ok(())
    }
}
