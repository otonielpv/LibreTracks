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
//! - Al terminar: se para y la ganancia vuelve a 1, para que el siguiente Play
//!   suene a volumen normal.
//! - Segunda pulsación durante el fade: parada inmediata (salida de emergencia).
//! - Pausa o Stop manual durante el fade: lo cancelan y devuelven la ganancia.

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
    pub fn fade_out_and_stop(
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
        audio.start_master_fade(0.0, seconds)?;
        self.fade_stop = Some(FadeStop {
            started_at: Instant::now(),
            duration: Duration::from_secs_f64(seconds),
        });
        Ok(self.snapshot())
    }

    /// Called from the transport sync tick: stop once the fade has run out.
    /// Returns true when it stopped the transport.
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
        self.stop(audio)?;
        Ok(true)
    }

    /// Drop a running fade-to-stop and give the tracks their level back.
    /// Every way out of playback calls this (stop, pause, play).
    pub(super) fn cancel_fade_stop(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        if self.fade_stop.take().is_some() {
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
