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

impl DesktopSession {
    /// Guarda el EQ (recortado) en la pista, apila un paso de deshacer y lo
    /// manda al motor. `None` quita el EQ. Solo pistas de audio.
    pub fn commit_track_eq_model_and_command(
        &mut self,
        track_id: &str,
        eq: Option<TrackEq>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let eq = eq.map(|eq| eq.sanitized());
        {
            let song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
            let track = song
                .tracks
                .iter()
                .find(|track| track.id == track_id)
                .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
            if track.kind != TrackKind::Audio {
                return Err(DesktopError::AudioCommand(format!(
                    "el ecualizador solo existe en pistas de audio ({track_id})"
                )));
            }
            if track.eq == eq {
                return Ok(self.snapshot());
            }
        }

        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();
        self.transpose_history_group = None;
        if let Some(track) = self
            .engine
            .song_mut()?
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
        {
            track.eq = eq.clone();
        }
        audio.set_track_eq(track_id, eq.as_ref())?;
        audio.record_commit_mix();

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        Ok(self.snapshot())
    }
}
