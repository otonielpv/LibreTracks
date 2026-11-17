//! Banco de muestras de loops de batería y one shots (plan drum-loops, paso 02).
//!
//! `SampleLoader` es el equivalente de `PadClipLoader`: se obtiene bajo un lock
//! breve y se usa sin él, porque decodificar bloquea el hilo que llama.

use serde::{Deserialize, Serialize};

use crate::ffi::{lt_audio_engine_load_samples, LtEngine};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleSlotPath {
    /// Slot asignado por Rust; el motor no conoce ids de texto.
    pub slot: i32,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SampleLoadRequest {
    pub samples: Vec<SampleSlotPath>,
    /// Tope de RAM del banco (D11). `None` deja el que haya.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// `None` = la SR del dispositivo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SampleLoadEntryResult {
    pub slot: i32,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub channels: i32,
    #[serde(default)]
    pub frames: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SampleLoadResult {
    /// `false` = no se publicó nada (petición inválida o tope superado).
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub sample_rate: i32,
    #[serde(default)]
    pub entries: Vec<SampleLoadEntryResult>,
}

impl SampleLoadResult {
    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            ..Self::default()
        }
    }
}

/// Carga de muestras fuera del lock del motor. Solo válida mientras viva el
/// motor del que sale (igual que `PadClipLoader`).
#[derive(Clone, Copy)]
pub struct SampleLoader {
    pub(crate) handle: *mut LtEngine,
}

// SAFETY: la FFI solo decodifica ficheros y publica una versión nueva del banco
// por puntero atómico (con su propio mutex de hilo de comandos); no toca estado
// del motor que no sea seguro entre hilos.
unsafe impl Send for SampleLoader {}

impl SampleLoader {
    /// Decodifica y publica. Bloquea lo que dure la decodificación.
    pub fn load(&self, request: &SampleLoadRequest) -> SampleLoadResult {
        let Ok(json) = serde_json::to_string(request) else {
            return SampleLoadResult::failed("serialize request");
        };
        let Ok(json) = std::ffi::CString::new(json) else {
            return SampleLoadResult::failed("nul byte in request");
        };
        let raw = unsafe { lt_audio_engine_load_samples(self.handle, json.as_ptr()) };
        if raw.is_null() {
            return SampleLoadResult::failed("no response");
        }
        let text = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy();
        serde_json::from_str(&text).unwrap_or_else(|error| SampleLoadResult::failed(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_serializes_as_the_engine_expects() {
        let request = SampleLoadRequest {
            samples: vec![SampleSlotPath { slot: 3, path: "C:/k.wav".into() }],
            max_bytes: Some(1024),
            sample_rate: None,
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({ "samples": [{ "slot": 3, "path": "C:/k.wav" }], "maxBytes": 1024 })
        );
    }

    #[test]
    fn result_parses_engine_json() {
        let result: SampleLoadResult = serde_json::from_value(json!({
            "ok": true, "totalBytes": 400, "sampleRate": 48000,
            "entries": [
                { "slot": 0, "ok": true, "channels": 1, "frames": 100 },
                { "slot": 1, "ok": false, "error": "missing", "channels": 0, "frames": 0 }
            ]
        }))
        .unwrap();
        assert!(result.ok);
        assert_eq!(result.entries[0].frames, 100);
        assert_eq!(result.entries[1].error.as_deref(), Some("missing"));
    }
}
