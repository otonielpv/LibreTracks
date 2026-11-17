//! Loops de batería y one shots desde MIDI (plan drum-loops, paso 10).
//!
//! Los disparos (`loop:*`, `oneshot:<n>`, `action:loop_toggle`,
//! `action:oneshots_stop_all`) van por `Engine::trigger` (D9): nunca por
//! `send_command`, ni con el lock de la sesión. Cambiar de patrón, de banco o
//! el tap del modo libre son configuración y van por el camino normal.

use libretracks_core::midi_control::{FeedbackValue, LoopMidiTarget, MidiTarget, OneShotMidiTarget};
use lt_audio_engine_v2::TriggerKind;

use crate::rhythm::meters::RhythmMeterPayload;

/// Qué disparo produce un mensaje sobre un destino de ritmo. `velocity` es el
/// byte de datos 2 del mensaje (nota o CC); `pressed` si cuenta como pulsar.
/// `None` = no dispara (soltar un botón de fila, otro destino…).
pub fn rhythm_trigger_for(target: &MidiTarget, pressed: bool, velocity: u8) -> Option<(TriggerKind, i32, i32)> {
    match target {
        MidiTarget::Action(name) if pressed => match name.as_str() {
            "loop_toggle" => Some((TriggerKind::LoopToggle, 0, 0)),
            "oneshots_stop_all" => Some((TriggerKind::OneShotStopAll, 0, 0)),
            _ => None,
        },
        MidiTarget::Loop(loop_target) if pressed => match loop_target {
            LoopMidiTarget::RowToggle(row) => Some((TriggerKind::LoopRow, i32::from(*row), 0)),
            LoopMidiTarget::RowVariation { row, variation } => {
                Some((TriggerKind::LoopVariation, i32::from(*row), i32::from(*variation)))
            }
            LoopMidiTarget::AllVariation(variation) => Some((TriggerKind::LoopVariation, -1, i32::from(*variation))),
            LoopMidiTarget::Pattern(_) => None,
        },
        // Un pad suena mientras se pulsa: nota on = down con su velocidad,
        // nota off (o velocidad 0) = up.
        MidiTarget::OneShot(OneShotMidiTarget::Pad(pad)) => Some(if pressed {
            (TriggerKind::OneShotDown, i32::from(*pad), i32::from(velocity.clamp(1, 127)))
        } else {
            (TriggerKind::OneShotUp, i32::from(*pad), 0)
        }),
        _ => None,
    }
}

/// LED de un destino de ritmo según el último estado en directo. `None` si el
/// destino no tiene LED de ritmo.
pub fn rhythm_led(target: &MidiTarget, rhythm: &RhythmMeterPayload) -> Option<FeedbackValue> {
    let on = match target {
        MidiTarget::Action(name) if name == "loop_toggle" => rhythm.loop_playing,
        MidiTarget::Loop(LoopMidiTarget::RowToggle(row)) => {
            rhythm.loop_rows.get(usize::from(*row)).is_some_and(|r| r.enabled)
        }
        MidiTarget::Loop(LoopMidiTarget::RowVariation { row, variation }) => rhythm
            .loop_rows
            .get(usize::from(*row))
            .is_some_and(|r| r.variation == *variation),
        MidiTarget::Loop(LoopMidiTarget::AllVariation(variation)) => {
            !rhythm.loop_rows.is_empty() && rhythm.loop_rows.iter().all(|r| r.variation == *variation)
        }
        MidiTarget::OneShot(OneShotMidiTarget::Pad(pad)) => rhythm.one_shots_active & (1 << pad) != 0,
        _ => return None,
    };
    Some(FeedbackValue::Switch(on))
}

/// Tap del modo libre (D16): BPM con los toques recientes, como `tapTempo.ts`
/// (se reinicia tras 2,5 s, guarda 8 toques).
pub fn next_tap_bpm(taps: &mut Vec<std::time::Instant>, now: std::time::Instant) -> Option<f64> {
    if taps.last().is_some_and(|last| now.duration_since(*last).as_millis() > 2500) {
        taps.clear();
    }
    taps.push(now);
    if taps.len() > 8 {
        taps.remove(0);
    }
    if taps.len() < 2 {
        return None;
    }
    let total = taps.last()?.duration_since(taps[0]).as_secs_f64();
    let intervals = (taps.len() - 1) as f64;
    (total > 0.0).then(|| (60.0 * intervals / total).clamp(30.0, 300.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rhythm::meters::LoopRowMeter;

    fn target(key: &str) -> MidiTarget {
        MidiTarget::parse(key).unwrap()
    }

    #[test]
    fn oneshot_note_on_and_off_trigger_down_and_up_with_velocity() {
        assert_eq!(
            rhythm_trigger_for(&target("oneshot:3"), true, 96),
            Some((TriggerKind::OneShotDown, 2, 96))
        );
        assert_eq!(rhythm_trigger_for(&target("oneshot:3"), false, 0), Some((TriggerKind::OneShotUp, 2, 0)));
    }

    #[test]
    fn loop_targets_fire_on_press_only() {
        assert_eq!(rhythm_trigger_for(&target("action:loop_toggle"), true, 127), Some((TriggerKind::LoopToggle, 0, 0)));
        assert_eq!(rhythm_trigger_for(&target("action:loop_toggle"), false, 0), None);
        assert_eq!(rhythm_trigger_for(&target("loop:row:2:toggle"), true, 127), Some((TriggerKind::LoopRow, 1, 0)));
        assert_eq!(
            rhythm_trigger_for(&target("loop:row:1:var:c"), true, 127),
            Some((TriggerKind::LoopVariation, 0, 2))
        );
        assert_eq!(rhythm_trigger_for(&target("loop:var:b"), true, 127), Some((TriggerKind::LoopVariation, -1, 1)));
        assert_eq!(
            rhythm_trigger_for(&target("action:oneshots_stop_all"), true, 127),
            Some((TriggerKind::OneShotStopAll, 0, 0))
        );
        // Patrón y banco no son disparos: configuración por el camino normal.
        assert_eq!(rhythm_trigger_for(&target("loop:pattern:next"), true, 127), None);
        assert_eq!(rhythm_trigger_for(&target("oneshot:bank:b"), true, 127), None);
        assert_eq!(rhythm_trigger_for(&target("action:play"), true, 127), None);
    }

    #[test]
    fn leds_follow_rows_variations_loop_and_pads() {
        let rhythm = RhythmMeterPayload {
            loop_step: 3,
            loop_bar: 0,
            loop_playing: true,
            loop_rows: vec![
                LoopRowMeter { enabled: true, variation: 1, pending_variation: None, pending_enabled: None },
                LoopRowMeter { enabled: false, variation: 1, pending_variation: None, pending_enabled: None },
            ],
            one_shots_active: 0b100,
        };
        let led = |key: &str| rhythm_led(&target(key), &rhythm);
        assert_eq!(led("action:loop_toggle"), Some(FeedbackValue::Switch(true)));
        assert_eq!(led("loop:row:1:toggle"), Some(FeedbackValue::Switch(true)));
        assert_eq!(led("loop:row:2:toggle"), Some(FeedbackValue::Switch(false)));
        assert_eq!(led("loop:row:1:var:b"), Some(FeedbackValue::Switch(true)));
        assert_eq!(led("loop:row:1:var:a"), Some(FeedbackValue::Switch(false)));
        assert_eq!(led("loop:var:b"), Some(FeedbackValue::Switch(true)));
        assert_eq!(led("oneshot:3"), Some(FeedbackValue::Switch(true)));
        assert_eq!(led("oneshot:1"), Some(FeedbackValue::Switch(false)));
        assert_eq!(led("action:play"), None);
    }

    #[test]
    fn tap_tempo_averages_recent_taps() {
        let start = std::time::Instant::now();
        let mut taps = Vec::new();
        assert_eq!(next_tap_bpm(&mut taps, start), None);
        let bpm = next_tap_bpm(&mut taps, start + std::time::Duration::from_millis(500)).unwrap();
        assert!((bpm - 120.0).abs() < 0.01);
        // Tras una pausa larga empieza de nuevo.
        assert_eq!(next_tap_bpm(&mut taps, start + std::time::Duration::from_secs(10)), None);
    }
}
