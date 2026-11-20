//! Controles MIDI del EQ de una pista (plan track-eq-2, paso 05, E5).
//!
//! Cada control mueve un campo de una banda (o el encendido del EQ entero)
//! sobre la curva completa, que es lo que recibe el motor. Las posiciones van
//! de 0 a 1 como las de un fader:
//!
//! - ganancia: lineal en dB, -18..+18 (la mitad = 0 dB);
//! - frecuencia: logarítmica, 20 Hz..20 kHz (la mitad ≈ 632 Hz);
//! - Q: logarítmica, 0,1..18.
//!
//! Una pista sin EQ parte de las bandas por defecto: mover un control le crea
//! uno, como abrir el editor y tocar.

use libretracks_core::midi_control::MixControl;
use libretracks_core::track_eq::{
    TRACK_EQ_MAX_FREQUENCY_HZ, TRACK_EQ_MAX_GAIN_DB, TRACK_EQ_MAX_Q, TRACK_EQ_MIN_FREQUENCY_HZ,
    TRACK_EQ_MIN_GAIN_DB, TRACK_EQ_MIN_Q,
};
use libretracks_core::TrackEq;

fn log_position(value: f64, min: f64, max: f64) -> f64 {
    ((value.max(min) / min).ln() / (max / min).ln()).clamp(0.0, 1.0)
}

fn log_value(position: f64, min: f64, max: f64) -> f64 {
    min * (max / min).powf(position.clamp(0.0, 1.0))
}

/// Posición actual de un control continuo del EQ (`None` si no lo es o la
/// banda no existe).
pub(crate) fn eq_position(eq: Option<&TrackEq>, control: MixControl) -> Option<f64> {
    let eq = eq.cloned().unwrap_or_default();
    let band = |index: u8| eq.bands.get(index as usize);
    Some(match control {
        MixControl::EqGain(index) => {
            let gain = band(index)?.gain_db;
            ((gain - TRACK_EQ_MIN_GAIN_DB) / (TRACK_EQ_MAX_GAIN_DB - TRACK_EQ_MIN_GAIN_DB)).clamp(0.0, 1.0)
        }
        MixControl::EqFreq(index) => log_position(
            band(index)?.frequency_hz,
            TRACK_EQ_MIN_FREQUENCY_HZ,
            TRACK_EQ_MAX_FREQUENCY_HZ,
        ),
        MixControl::EqQ(index) => log_position(band(index)?.q, TRACK_EQ_MIN_Q, TRACK_EQ_MAX_Q),
        _ => return None,
    })
}

/// La curva con un control continuo en `position` (recortada como el core).
pub(crate) fn with_eq_position(
    eq: Option<&TrackEq>,
    control: MixControl,
    position: f64,
) -> Option<TrackEq> {
    let mut eq = eq.cloned().unwrap_or_default();
    let position = position.clamp(0.0, 1.0);
    match control {
        MixControl::EqGain(index) => {
            eq.bands.get_mut(index as usize)?.gain_db =
                TRACK_EQ_MIN_GAIN_DB + position * (TRACK_EQ_MAX_GAIN_DB - TRACK_EQ_MIN_GAIN_DB);
        }
        MixControl::EqFreq(index) => {
            eq.bands.get_mut(index as usize)?.frequency_hz =
                log_value(position, TRACK_EQ_MIN_FREQUENCY_HZ, TRACK_EQ_MAX_FREQUENCY_HZ);
        }
        MixControl::EqQ(index) => {
            eq.bands.get_mut(index as usize)?.q = log_value(position, TRACK_EQ_MIN_Q, TRACK_EQ_MAX_Q);
        }
        _ => return None,
    }
    Some(eq.sanitized())
}

/// Estado de un interruptor del EQ (banda o EQ entero). Sin EQ = apagado.
pub(crate) fn eq_switch(eq: Option<&TrackEq>, control: MixControl) -> Option<bool> {
    match control {
        MixControl::EqOn => Some(eq.is_some_and(|eq| eq.enabled)),
        MixControl::EqBandOn(index) => Some(
            eq.and_then(|eq| eq.bands.get(index as usize))
                .is_some_and(|band| band.enabled),
        ),
        _ => None,
    }
}

/// La curva con un interruptor del EQ puesto a `on`.
pub(crate) fn with_eq_switch(eq: Option<&TrackEq>, control: MixControl, on: bool) -> Option<TrackEq> {
    let mut eq = eq.cloned().unwrap_or_default();
    match control {
        MixControl::EqOn => eq.enabled = on,
        MixControl::EqBandOn(index) => eq.bands.get_mut(index as usize)?.enabled = on,
        _ => return None,
    }
    Some(eq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_middle_of_a_control_is_0_db_and_the_log_centre_of_the_band() {
        let gain = with_eq_position(None, MixControl::EqGain(2), 0.5).unwrap();
        assert!(gain.bands[2].gain_db.abs() < 1e-9);
        let freq = with_eq_position(None, MixControl::EqFreq(2), 0.5).unwrap();
        assert!((freq.bands[2].frequency_hz - 632.455).abs() < 0.01, "{}", freq.bands[2].frequency_hz);
        let q = with_eq_position(None, MixControl::EqQ(2), 0.0).unwrap();
        assert!((q.bands[2].q - 0.1).abs() < 1e-9);
        // Ida y vuelta.
        for control in [MixControl::EqGain(1), MixControl::EqFreq(4), MixControl::EqQ(0)] {
            for position in [0.0, 0.25, 0.5, 0.9, 1.0] {
                let eq = with_eq_position(None, control, position).unwrap();
                let back = eq_position(Some(&eq), control).unwrap();
                assert!((back - position).abs() < 1e-9, "{control:?} {position} {back}");
            }
        }
        // Una banda que no existe no es un control.
        let mut short = TrackEq::default();
        short.bands.truncate(2);
        assert_eq!(with_eq_position(Some(&short), MixControl::EqGain(4), 0.5), None);
    }

    #[test]
    fn switches_toggle_a_band_or_the_whole_eq() {
        assert_eq!(eq_switch(None, MixControl::EqOn), Some(false));
        let off = with_eq_switch(None, MixControl::EqOn, false).unwrap();
        assert!(!off.enabled);
        let band_off = with_eq_switch(Some(&TrackEq::default()), MixControl::EqBandOn(1), false).unwrap();
        assert_eq!(eq_switch(Some(&band_off), MixControl::EqBandOn(1)), Some(false));
        assert_eq!(eq_switch(Some(&band_off), MixControl::EqBandOn(2)), Some(true));
    }
}
