//! «Fade out y parar»: cortar en directo la canción que suena con un fade de
//! salida en vez de un corte seco.
//!
//! Reutiliza la rampa de ganancia que ya usan los saltos con fade
//! (`start_master_fade`): actúa sólo sobre las pistas, así que el clic y la voz
//! guía no se atenúan. La rampa la lleva el motor; aquí sólo se recuerda cuándo
//! termina para parar el transporte, en el mismo tick de sincronización que
//! remata los saltos con fade (`sync_position`).
//!
//! - Primera pulsación: rampa a silencio durante la duración configurada.
//! - Al terminar: se pausa o se para según el ajuste y se restaura la ganancia.
//! - Segunda pulsación durante el fade: parada inmediata (salida de emergencia).
//! - Pausa o Stop manual durante el fade: lo cancelan y devuelven la ganancia.
//!
//! «Fade in y reproducir» es el mismo botón con el transporte parado o en
//! pausa: arranca desde el cursor con las pistas en silencio y las sube
//! durante la misma duración. Pensado para volver a un coro espontáneo sin
//! que todo entre de golpe. Pulsar otra vez mientras sube hace el fade out
//! desde donde esté la ganancia.

use std::time::{Duration, Instant};

use libretracks_audio::PlaybackState;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::view::TransportSnapshot;

use super::DesktopSession;

/// Limits for the configured duration: below 0.1 s it is a click, beyond 30 s
/// nobody is waiting for it on stage.
const MIN_FADE_SECONDS: f64 = 0.1;
const MAX_FADE_SECONDS: f64 = 30.0;

#[derive(Debug, Clone, Copy)]
pub(crate) struct FadeStop {
    started_at: Instant,
    duration: Duration,
    pause: bool,
}

/// The configured duration, made safe to use.
pub(crate) fn sanitize_fade_stop_seconds(seconds: f64) -> f64 {
    if seconds.is_finite() {
        seconds.clamp(MIN_FADE_SECONDS, MAX_FADE_SECONDS)
    } else {
        crate::infra::settings::DEFAULT_FADE_OUT_STOP_SECONDS
    }
}

impl DesktopSession {
    /// The «Fade out y parar» action. Does nothing unless playing.
    /// Applies the change without telling redundancy; the public wrapper in
    /// `state/redundancy.rs` calls this and emits the intent.
    pub(super) fn apply_fade_out_and_stop(
        &mut self,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if self.fade_stop.is_some() {
            // Second press while fading: stop now.
            return self.stop(audio);
        }
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(self.snapshot());
        }

        let seconds = sanitize_fade_stop_seconds(duration_seconds);
        let pause = audio.current_settings()?.fade_out_pause;
        // From wherever a fade in left the gain; fade_stop now owns the reset.
        audio.start_master_fade(0.0, seconds)?;
        self.fade_in = false;
        self.fade_stop = Some(FadeStop {
            started_at: Instant::now(),
            duration: Duration::from_secs_f64(seconds),
            pause,
        });
        Ok(self.snapshot())
    }

    /// «Fade in y reproducir». Does nothing while playing.
    /// Applies the change without telling redundancy; the public wrapper in
    /// `state/redundancy.rs` calls this and emits the intent.
    pub(super) fn apply_fade_in_and_play(
        &mut self,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if self.engine.playback_state() == PlaybackState::Playing {
            return Ok(self.snapshot());
        }
        let seconds = sanitize_fade_stop_seconds(duration_seconds);
        // Silent before Play, so the first block never sounds at full level.
        audio.start_master_fade(0.0, 0.0)?;
        let snapshot = match self.apply_play(audio) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                audio.start_master_fade(1.0, 0.0)?;
                return Err(error);
            }
        };
        // One request carrying its start: the mixer keeps only the latest
        // request per block, so the mute above may be coalesced into this.
        audio.start_master_fade_from(Some(0.0), 1.0, seconds)?;
        self.fade_in = true;
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(super) fn is_fading_in(&self) -> bool {
        self.fade_in
    }

    /// Called from the transport sync tick when the fade has run out.
    pub(super) fn finish_fade_stop_if_due(
        &mut self,
        audio: &AudioController,
    ) -> Result<bool, DesktopError> {
        let Some(fade) = self.fade_stop else {
            return Ok(false);
        };
        if fade.started_at.elapsed() < fade.duration {
            return Ok(false);
        }
        let _origin = self
            .transport_locked()
            .then(|| self.intent_origin_scope(super::IntentOrigin::Follower));
        if fade.pause {
            // pause synchronizes the transport, so remove the expired fade
            // first to avoid re-entering this method.
            self.fade_stop = None;
            if let Err(error) = self.pause(audio) {
                self.fade_stop = Some(fade);
                return Err(error);
            }
            audio.start_master_fade(1.0, 0.0)?;
        } else {
            self.stop(audio)?;
        }
        Ok(true)
    }

    /// Drop a running fade (out or in) and give the tracks their level back.
    /// Every way out of playback calls this (stop, pause, play).
    pub(super) fn cancel_fade_stop(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        let was_fading_in = std::mem::take(&mut self.fade_in);
        // A programmed jump's fade out also leaves the master down.
        let was_jump_fading = std::mem::take(&mut self.pending_jump_fade_started);
        if self.fade_stop.take().is_some() || was_fading_in || was_jump_fading {
            audio.start_master_fade(1.0, 0.0)?;
        }
        Ok(())
    }

    pub(super) fn is_fading_to_stop(&self) -> bool {
        self.fade_stop.is_some()
    }

    /// Tests: pretend the fade has already run its course.
    #[cfg(test)]
    pub(super) fn expire_fade_stop_for_test(&mut self) {
        if let Some(fade) = self.fade_stop.as_mut() {
            fade.started_at = Instant::now() - fade.duration;
        }
    }
}
