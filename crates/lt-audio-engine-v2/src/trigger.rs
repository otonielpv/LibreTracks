//! Disparo rápido de one shots y controles de loop (plan drum-loops, paso 04,
//! D9): una llamada FFI con tres enteros. Sin JSON, sin snapshot y sin el
//! lock del motor, para que tocar un pad (UI o MIDI) suene en el siguiente
//! bloque.

use crate::ffi::{lt_audio_engine_trigger, LtEngine};

/// Valores fijados en la FFI (`lt_audio_engine_trigger`): no reordenar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum TriggerKind {
    /// `index` = pad, `value` = velocidad 0-127.
    OneShotDown = 0,
    /// `index` = pad (solo cuenta en los pads en modo mantener).
    OneShotUp = 1,
    OneShotStopAll = 2,
    LoopToggle = 3,
    /// `index` = fila: la enciende o la apaga.
    LoopRow = 4,
    /// `index` = fila (-1 todas), `value` = variación 0-3.
    LoopVariation = 5,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerOutcome {
    Queued,
    /// Encolado, pero el stream está suspendido: el host debe mandar
    /// `SetOutputSuspended { suspended: false }` para oírlo.
    QueuedStreamSuspended,
    /// Cola llena o tipo desconocido: descartado (el motor lo cuenta).
    Dropped,
}

/// Manejador separado para disparar sin tomar el lock del motor. Solo válido
/// mientras vive el motor del que sale (como `PadClipLoader`).
#[derive(Clone, Copy)]
pub struct EngineTrigger {
    pub(crate) handle: *mut LtEngine,
}

// SAFETY: la FFI solo escribe en colas sin bloqueo (los productores se
// serializan dentro del motor) y lee un atómico; es segura desde cualquier hilo.
unsafe impl Send for EngineTrigger {}
unsafe impl Sync for EngineTrigger {}

impl EngineTrigger {
    pub fn trigger(&self, kind: TriggerKind, index: i32, value: i32) -> TriggerOutcome {
        let rc = unsafe { lt_audio_engine_trigger(self.handle, kind as i32, index, value) };
        match rc {
            0 => TriggerOutcome::Queued,
            1 => TriggerOutcome::QueuedStreamSuspended,
            _ => TriggerOutcome::Dropped,
        }
    }
}

#[cfg(all(test, feature = "no-link"))]
mod tests {
    use super::*;
    use crate::ffi::{STUB_SNAPSHOT_CALLS, STUB_TRIGGER_CALLS};
    use crate::{Engine, EngineCommand};

    #[test]
    fn trigger_never_asks_for_a_snapshot() {
        let engine = Engine::new().expect("stub engine");
        let snapshots_before = STUB_SNAPSHOT_CALLS.with(|c| c.get());
        let triggers_before = STUB_TRIGGER_CALLS.with(|c| c.get());
        for pad in 0..12 {
            assert_eq!(engine.trigger(TriggerKind::OneShotDown, pad, 127), TriggerOutcome::Queued);
        }
        assert_eq!(engine.trigger_handle().trigger(TriggerKind::LoopToggle, 0, 0), TriggerOutcome::Queued);
        assert_eq!(STUB_TRIGGER_CALLS.with(|c| c.get()) - triggers_before, 13);
        assert_eq!(STUB_SNAPSHOT_CALLS.with(|c| c.get()), snapshots_before);

        // El contador sí ve el snapshot que pide send_command (control).
        engine.send_command(&EngineCommand::SetLoopTransport { playing: true }).unwrap();
        assert!(STUB_SNAPSHOT_CALLS.with(|c| c.get()) > snapshots_before);
    }
}
