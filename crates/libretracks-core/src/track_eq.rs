//! Ecualizador paramétrico por pista (plan `track-eq`, D2/D3).
//!
//! Hasta 6 bandas estilo EQ Eight. El motor C++ lo procesa antes del fader
//! (`render/track_eq.h`); aquí solo vive el modelo, sus valores por defecto y
//! la única función que recorta rangos ([`TrackEq::sanitized`]), que usan los
//! comandos y el import. Sus reglas son las mismas que `lt::clamp_params` del
//! motor: si cambian aquí, cambian allí.
//!
//! En disco va en `Track.eq` como `Option`: `None` es una pista que nunca ha
//! tenido EQ, se omite al guardar y no cuesta nada en el motor.

use serde::{Deserialize, Serialize};

pub const TRACK_EQ_MAX_BANDS: usize = 6;
pub const TRACK_EQ_MIN_FREQUENCY_HZ: f64 = 20.0;
pub const TRACK_EQ_MAX_FREQUENCY_HZ: f64 = 20_000.0;
pub const TRACK_EQ_MIN_GAIN_DB: f64 = -18.0;
pub const TRACK_EQ_MAX_GAIN_DB: f64 = 18.0;
pub const TRACK_EQ_MIN_Q: f64 = 0.1;
pub const TRACK_EQ_MAX_Q: f64 = 18.0;
pub const TRACK_EQ_DEFAULT_Q: f64 = 0.71;

const FALLBACK_FREQUENCY_HZ: f64 = 1000.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqBandKind {
    LowCut,
    LowShelf,
    #[default]
    Peak,
    HighShelf,
    HighCut,
    Notch,
}

impl EqBandKind {
    /// Los cortes no tienen ganancia; usan `slope`.
    pub fn is_cut(self) -> bool {
        matches!(self, EqBandKind::LowCut | EqBandKind::HighCut)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqBand {
    pub enabled: bool,
    pub kind: EqBandKind,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
    /// Pendiente de los cortes en dB/oct: 12 o 24. Ignorada en los demás tipos.
    pub slope: u8,
}

impl Default for EqBand {
    fn default() -> Self {
        Self {
            enabled: true,
            kind: EqBandKind::Peak,
            frequency_hz: FALLBACK_FREQUENCY_HZ,
            gain_db: 0.0,
            q: TRACK_EQ_DEFAULT_Q,
            slope: 12,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackEq {
    /// Bypass global: apagado, la pista suena exactamente como sin EQ.
    pub enabled: bool,
    pub bands: Vec<EqBand>,
}

impl Default for TrackEq {
    /// El EQ recién creado: encendido con las 6 bandas de [`TrackEq::default_bands`].
    fn default() -> Self {
        Self {
            enabled: true,
            bands: Self::default_bands(),
        }
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// Qué pistas llevan EQ: las de audio y, desde el plan track-eq-2 (E9), las
/// carpetas (sobre la suma de sus hijas).
pub fn track_kind_takes_eq(kind: crate::model::TrackKind) -> bool {
    matches!(kind, crate::model::TrackKind::Audio | crate::model::TrackKind::Folder)
}

impl TrackEq {
    /// Las 6 bandas de D2: corte bajo a 40 Hz y corte alto a 18 kHz apagados;
    /// shelf bajo 100 Hz, campanas 400 Hz y 2,5 kHz, shelf alto 8 kHz; todo a
    /// 0 dB y Q 0,71.
    pub fn default_bands() -> Vec<EqBand> {
        let band = |enabled, kind, frequency_hz| EqBand {
            enabled,
            kind,
            frequency_hz,
            gain_db: 0.0,
            q: TRACK_EQ_DEFAULT_Q,
            slope: 12,
        };
        vec![
            band(false, EqBandKind::LowCut, 40.0),
            band(true, EqBandKind::LowShelf, 100.0),
            band(true, EqBandKind::Peak, 400.0),
            band(true, EqBandKind::Peak, 2500.0),
            band(true, EqBandKind::HighShelf, 8000.0),
            band(false, EqBandKind::HighCut, 18000.0),
        ]
    }

    /// Recorta frecuencia, ganancia y Q a sus rangos, limita a 6 bandas,
    /// sustituye no finitos por su valor por defecto y normaliza la pendiente a
    /// 12 o 24. Un EQ válido sale idéntico.
    pub fn sanitized(&self) -> Self {
        let bands = self
            .bands
            .iter()
            .take(TRACK_EQ_MAX_BANDS)
            .map(|band| EqBand {
                enabled: band.enabled,
                kind: band.kind,
                frequency_hz: finite_or(band.frequency_hz, FALLBACK_FREQUENCY_HZ)
                    .clamp(TRACK_EQ_MIN_FREQUENCY_HZ, TRACK_EQ_MAX_FREQUENCY_HZ),
                gain_db: finite_or(band.gain_db, 0.0).clamp(TRACK_EQ_MIN_GAIN_DB, TRACK_EQ_MAX_GAIN_DB),
                q: finite_or(band.q, TRACK_EQ_DEFAULT_Q).clamp(TRACK_EQ_MIN_Q, TRACK_EQ_MAX_Q),
                slope: if band.slope >= 18 { 24 } else { 12 },
            })
            .collect();
        Self {
            enabled: self.enabled,
            bands,
        }
    }

    /// Encendido y con alguna banda encendida que cambie algo: lo que ilumina
    /// el botón «EQ» de la pista.
    pub fn is_active(&self) -> bool {
        self.enabled
            && self.bands.iter().any(|band| {
                band.enabled
                    && (band.kind.is_cut() || band.kind == EqBandKind::Notch || band.gain_db != 0.0)
            })
    }
}
