//! Loops de batería y one shots en el `AudioController` (plan drum-loops,
//! paso 05). Submódulo de `engine.rs` para usar su estado sin engordarlo.
//!
//! Orden de locks: `rhythm_sync` → `rhythm` → (suelta) → `state`. Nunca se
//! toma `rhythm` con `state` cogido, así que no hay ciclo con los caminos del
//! motor. Decodificar muestras va fuera de `state` (como los pads).

use std::sync::atomic::Ordering;

use lt_audio_engine_v2::{EngineCommand, EngineTrigger, LoopSnapshot, TriggerKind, TriggerOutcome};

use super::{ensure_engine, AudioController};
use crate::infra::error::DesktopError;
use crate::rhythm::RhythmSyncPlan;

impl AudioController {
    /// Configura las carpetas de la biblioteca (al adjuntar la app).
    pub fn configure_rhythm(&self, loops_root: std::path::PathBuf, builtin_root: std::path::PathBuf) {
        if let Ok(mut runtime) = self.rhythm.lock() {
            runtime.configure(loops_root, builtin_root);
        }
    }

    pub fn rhythm_library(&self) -> Option<libretracks_project::rhythm_library::RhythmLibrary> {
        self.rhythm.lock().ok().and_then(|r| r.library().cloned())
    }

    /// Recalcula patrones, loops de canción y one shots y los manda al motor.
    pub fn sync_rhythm(&self) -> Result<(), DesktopError> {
        let _serial = self
            .rhythm_sync
            .lock()
            .map_err(|_| DesktopError::AudioCommand("rhythm sync lock poisoned".into()))?;
        let settings = self.current_settings()?;
        let plan = {
            let mut runtime = self
                .rhythm
                .lock()
                .map_err(|_| DesktopError::AudioCommand("rhythm lock poisoned".into()))?;
            runtime
                .plan(&settings.active_loop_pattern_id, settings.active_one_shot_bank as usize)
                .map_err(DesktopError::AudioCommand)?
        };
        self.apply_rhythm_plan(plan)
    }

    /// Lo mismo tras cargar la sesión o cambiar sus canciones (D5, D8).
    pub fn sync_rhythm_for_song(&self, song: &libretracks_core::Song) -> Result<(), DesktopError> {
        if let Ok(mut runtime) = self.rhythm.lock() {
            if runtime.library().is_none() {
                return Ok(());  // sin app adjunta (tests): nada que resolver
            }
            runtime.set_song(song);
        }
        self.sync_rhythm()
    }

    fn apply_rhythm_plan(&self, plan: RhythmSyncPlan) -> Result<(), DesktopError> {
        if let Some(request) = plan.load {
            let loader = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
                ensure_engine(&mut state)?.sample_loader()
            };
            let result = loader.load(&request);
            if !result.ok {
                return Err(DesktopError::AudioCommand(
                    result.error.unwrap_or_else(|| "sample bank load failed".into()),
                ));
            }
            for entry in result.entries.iter().filter(|e| !e.ok) {
                eprintln!(
                    "[libretracks-rhythm] sample slot {} not loaded: {}",
                    entry.slot,
                    entry.error.as_deref().unwrap_or("?")
                );
            }
        }
        if plan.commands.is_empty() {
            return Ok(());
        }
        self.with_engine_state("rhythm_sync", None, |engine, _state| {
            for command in &plan.commands {
                engine.send_command(command)?;
            }
            Ok(())
        })
    }

    /// Camino lento (configuración): un comando del motor.
    pub fn send_rhythm_command(&self, kind: &str, command: EngineCommand) -> Result<(), DesktopError> {
        self.with_engine_state(kind, None, |engine, _state| {
            engine.send_command(&command)?;
            Ok(())
        })
    }

    /// Reaplica la configuración de loops y one shots de los ajustes.
    pub fn apply_rhythm_config(&self, settings: &crate::infra::settings::AppSettings) -> Result<(), DesktopError> {
        self.with_engine_state("rhythm_config", None, |engine, _state| {
            engine.send_command(&rhythm_loop_config(settings))?;
            engine.send_command(&EngineCommand::SetOneShotConfig {
                route: settings.one_shot_output.clone(),
                gain: settings.one_shot_volume as f32,
            })?;
            Ok(())
        })
    }

    /// Camino rápido (D9): sin JSON ni snapshot. Solo toma el lock del motor
    /// la primera vez, para obtener el manejador; el motor vive lo que el
    /// controlador (solo se destruye en su `Drop`).
    pub fn rhythm_trigger(&self, kind: TriggerKind, index: i32, value: i32) -> Result<TriggerOutcome, DesktopError> {
        let handle = self.rhythm_trigger_handle()?;
        let outcome = handle.trigger(kind, index, value);
        if outcome == TriggerOutcome::QueuedStreamSuspended {
            // El disparo no reanuda el stream por sí mismo: lo hace el camino
            // normal, como Play o encender el pad.
            self.send_rhythm_command(
                "rhythm_resume_output",
                EngineCommand::SetOutputSuspended { suspended: false },
            )?;
        }
        if outcome == TriggerOutcome::Dropped {
            self.rhythm_dropped_triggers.fetch_add(1, Ordering::Relaxed);
        }
        Ok(outcome)
    }

    fn rhythm_trigger_handle(&self) -> Result<EngineTrigger, DesktopError> {
        if let Ok(cached) = self.rhythm_trigger.lock() {
            if let Some(handle) = *cached {
                return Ok(handle);
            }
        }
        let handle = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
            ensure_engine(&mut state)?.trigger_handle()
        };
        if let Ok(mut cached) = self.rhythm_trigger.lock() {
            *cached = Some(handle);
        }
        Ok(handle)
    }

    /// Estado en directo (lectura puntual; el continuo va por `audio:rhythm`).
    pub fn rhythm_live_state(&self) -> Result<LoopSnapshot, DesktopError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
        let engine = ensure_engine(&mut state)?;
        engine
            .get_meter_snapshot()
            .map(|s| s.loops)
            .map_err(|e| DesktopError::AudioCommand(e.to_string()))
    }
}

pub fn rhythm_loop_config(settings: &crate::infra::settings::AppSettings) -> EngineCommand {
    EngineCommand::SetLoopConfig {
        clock_mode: settings.loop_clock_mode.clone(),
        free_bpm: settings.loop_free_bpm,
        quantize: settings.loop_quantize.clone(),
        route: settings.loop_output.clone(),
        gain: settings.loop_volume as f32,
    }
}
