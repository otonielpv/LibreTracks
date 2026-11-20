//! RTA para invitados de red y para el remote (plan track-eq-2, paso 07, E8).
//!
//! El analizador del anfitrión tiene una sola ranura: la última pista que se
//! pidió. Con él puesto, el hilo de medidores lee las bandas a su ritmo
//! (~30 Hz) y emite `audio:eq_spectrum { trackId, bands }`, que se retransmite
//! a los invitados y al remote. Solo sale si hay analizador y las bandas
//! cambian: con el transporte parado y la pista en silencio no hay tráfico.
//! El editor de cada cliente pinta el evento solo si trae SU pista.

use serde::Serialize;

pub(crate) const EQ_SPECTRUM_EVENT: &str = "audio:eq_spectrum";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EqSpectrumEvent {
    pub track_id: String,
    pub bands: Vec<f32>,
}

#[derive(Debug, Default)]
pub(crate) struct EqSpectrumEmitter {
    last: Option<EqSpectrumEvent>,
}

impl EqSpectrumEmitter {
    /// El evento a emitir en este tick, si toca. `analyzer` es la pista
    /// analizada (`None` = apagado) y `read` lee las bandas del motor (solo
    /// se llama con analizador, para no pagar la lectura sin él).
    pub(crate) fn next(
        &mut self,
        analyzer: Option<&str>,
        read: impl FnOnce() -> Vec<f32>,
    ) -> Option<EqSpectrumEvent> {
        let Some(track_id) = analyzer.filter(|id| !id.is_empty()) else {
            self.last = None;
            return None;
        };
        let bands = read();
        if bands.is_empty() {
            return None;
        }
        let event = EqSpectrumEvent { track_id: track_id.to_string(), bands };
        if self.last.as_ref() == Some(&event) {
            return None;
        }
        self.last = Some(event.clone());
        Some(event)
    }

    /// Si el analizador sigue vivo (para mantener el hilo a ritmo activo).
    pub(crate) fn is_active(&self) -> bool {
        self.last.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_event_only_goes_out_with_the_analyzer_on_and_carries_the_track() {
        let mut emitter = EqSpectrumEmitter::default();
        let mut reads = 0;
        assert_eq!(emitter.next(None, || { reads += 1; vec![-20.0] }), None);
        assert_eq!(emitter.next(Some(""), || { reads += 1; vec![-20.0] }), None);
        assert_eq!(reads, 0, "sin analizador no se lee el motor");

        let event = emitter.next(Some("voz"), || vec![-20.0, -30.0]).expect("emits");
        assert_eq!(event.track_id, "voz");
        assert_eq!(event.bands, vec![-20.0, -30.0]);
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json, serde_json::json!({"trackId": "voz", "bands": [-20.0, -30.0]}));

        // Las mismas bandas no se repiten; otras sí; otra pista también.
        assert_eq!(emitter.next(Some("voz"), || vec![-20.0, -30.0]), None);
        assert!(emitter.next(Some("voz"), || vec![-21.0, -30.0]).is_some());
        assert_eq!(
            emitter.next(Some("bajo"), || vec![-21.0, -30.0]).map(|e| e.track_id),
            Some("bajo".to_string())
        );
        // Sin bandas (aún no hay análisis), nada.
        assert_eq!(emitter.next(Some("bajo"), Vec::new), None);
        // Al apagarlo, deja de estar activo.
        assert!(emitter.is_active());
        assert_eq!(emitter.next(None, || vec![-1.0]), None);
        assert!(!emitter.is_active());
    }
}
