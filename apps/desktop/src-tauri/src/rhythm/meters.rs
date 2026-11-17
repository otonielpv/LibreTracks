//! Estado en directo de loops y one shots para la UI (`audio:rhythm`).
//!
//! Sale del mismo snapshot ligero que los medidores y solo se emite si cambia.
//! Va en su propio evento: `audio:meters` lleva un array de niveles de pista y
//! cambiarle la forma rompería a quien ya lo escucha (remoto incluido).

use lt_audio_engine_v2::LoopSnapshot;
use serde::Serialize;

pub const RHYTHM_EVENT: &str = "audio:rhythm";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRowMeter {
    pub enabled: bool,
    /// 0..3 (A-D).
    pub variation: u8,
    /// Variación pedida que entrará en el próximo límite (cuantizada).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_variation: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RhythmMeterPayload {
    /// Paso del patrón que suena (-1 parado). La UI lo pinta por ref + rAF.
    pub loop_step: i32,
    pub loop_bar: i32,
    pub loop_playing: bool,
    pub loop_rows: Vec<LoopRowMeter>,
    /// Pads de one shot sonando (bits 0..11).
    pub one_shots_active: u32,
}

/// Desempaqueta el estado de las filas (8 bits por fila, ver
/// `LoopRenderer::rows_state` en el motor).
pub fn decode_rows(rows_state: u64, row_count: i32) -> Vec<LoopRowMeter> {
    (0..row_count.clamp(0, 8))
        .map(|row| {
            let bits = ((rows_state >> (8 * row)) & 0xFF) as u8;
            LoopRowMeter {
                enabled: bits & 1 != 0,
                variation: (bits >> 1) & 3,
                pending_variation: (bits & 0x08 != 0).then_some((bits >> 4) & 3),
                pending_enabled: (bits & 0x40 != 0).then_some(bits & 0x80 != 0),
            }
        })
        .collect()
}

pub fn rhythm_meter_payload(snapshot: &LoopSnapshot) -> RhythmMeterPayload {
    RhythmMeterPayload {
        loop_step: if snapshot.playing { snapshot.current_step } else { -1 },
        loop_bar: snapshot.current_bar,
        loop_playing: snapshot.playing,
        loop_rows: decode_rows(snapshot.rows_state, snapshot.row_count),
        one_shots_active: snapshot.one_shot_mask & 0x0FFF,
    }
}

/// Solo se emite cuando algo cambió respecto a lo último emitido.
pub fn should_emit(previous: Option<&RhythmMeterPayload>, next: &RhythmMeterPayload) -> bool {
    previous != Some(next)
}

/// Mientras suena algo el hilo de medidores va a su ritmo rápido.
pub fn wants_fast_poll(snapshot: &LoopSnapshot) -> bool {
    snapshot.wants_audio || snapshot.one_shot_wants_audio
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_carries_step_rows_and_pads() {
        let snapshot = LoopSnapshot {
            playing: true,
            wants_audio: true,
            current_step: 5,
            current_bar: 1,
            active_voices: 2,
            // fila 0: encendida en B; fila 1: apagada en A con C pendiente y
            // encendido pendiente.
            rows_state: 0x03 | ((0x08 | (2 << 4) | 0x40 | 0x80) << 8),
            row_count: 2,
            one_shot_mask: 0b1_0000_0001,
            one_shot_wants_audio: true,
            one_shot_dropped: 0,
        };
        let payload = rhythm_meter_payload(&snapshot);
        assert_eq!(payload.loop_step, 5);
        assert_eq!(payload.loop_bar, 1);
        assert!(payload.loop_playing);
        assert_eq!(payload.one_shots_active, 0b1_0000_0001);
        assert_eq!(
            payload.loop_rows,
            vec![
                LoopRowMeter { enabled: true, variation: 1, pending_variation: None, pending_enabled: None },
                LoopRowMeter {
                    enabled: false,
                    variation: 0,
                    pending_variation: Some(2),
                    pending_enabled: Some(true)
                },
            ]
        );
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["loopStep"], 5);
        assert_eq!(json["loopRows"][1]["pendingVariation"], 2);
        assert!(json["loopRows"][0].get("pendingVariation").is_none());
        assert_eq!(json["oneShotsActive"], 257);
    }

    #[test]
    fn not_emitted_when_nothing_changes() {
        let snapshot = LoopSnapshot { playing: true, current_step: 3, ..Default::default() };
        let first = rhythm_meter_payload(&snapshot);
        assert!(should_emit(None, &first));
        assert!(!should_emit(Some(&first), &rhythm_meter_payload(&snapshot)));
        let next = rhythm_meter_payload(&LoopSnapshot { current_step: 4, ..snapshot.clone() });
        assert!(should_emit(Some(&first), &next));
        // Parado, el paso es -1 aunque el motor recuerde el último.
        let stopped = rhythm_meter_payload(&LoopSnapshot { playing: false, ..snapshot });
        assert_eq!(stopped.loop_step, -1);
    }
}
