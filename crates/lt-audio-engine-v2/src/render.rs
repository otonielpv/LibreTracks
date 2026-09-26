//! Offline render ("Render audio"): bounce a timeline range to WAV files.
//!
//! Wraps `lt_audio_engine_render_offline`. It needs no `Engine` handle — the
//! C++ side builds its own session from `project_json` — so a render never
//! touches (or waits on) the live engine and playback keeps running.

use serde::{Deserialize, Serialize};

use crate::error::EngineError;
use crate::ffi::*;

/// Sample format of the written WAV files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderSampleFormat {
    Pcm16,
    Pcm24,
    Float32,
}

/// One file to write: a mix is one output with every chosen track, stems are
/// one output per track.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderOutput {
    pub path: String,
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub include_metronome: bool,
    #[serde(default)]
    pub include_voice_guide: bool,
}

/// Mirrors `lt::MetronomeConfig` (sound only: the render forces the click on
/// and onto the master route).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderMetronome {
    pub volume: f32,
    pub accent_enabled: bool,
    pub accent_preset: i32,
    pub beat_preset: i32,
    pub accent_pitch: f32,
    pub beat_pitch: f32,
    pub subdivision: i32,
    pub subdivision_preset: i32,
    pub subdivision_pitch: f32,
    pub subdivision_gain: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderVoiceGuide {
    pub volume: f32,
    pub lead_bars: i32,
    pub count_in_enabled: bool,
    pub voices_dir: String,
    pub lang: String,
}

/// Mirrors `lt::OfflineRenderRequest` (see offline_renderer.h).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderRequest {
    /// The same JSON `LoadSession` receives.
    pub project_json: String,
    pub sample_rate: u32,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub outputs: Vec<RenderOutput>,
    pub format: RenderSampleFormat,
    pub channels: u32,
    pub normalize: bool,
    pub normalize_peak_db: f64,
    pub apply_mixer: bool,
    pub dither: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metronome: Option<RenderMetronome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_guide: Option<RenderVoiceGuide>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderedFile {
    pub path: String,
    pub frames: i64,
    /// Linear peak before normalisation / limiter.
    pub peak: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderReport {
    pub files: Vec<RenderedFile>,
    /// Clips whose audio file could not be opened (rendered as silence).
    pub missing_clips: u32,
    pub missing_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RenderResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    cancelled: bool,
    #[serde(default)]
    files: Vec<RenderedFile>,
    #[serde(default)]
    missing_clips: u32,
    #[serde(default)]
    missing_files: Vec<String>,
}

/// Why a render did not produce its files.
#[derive(Debug)]
pub enum RenderError {
    /// The progress callback asked to stop. Partial files were removed.
    Cancelled,
    Failed(EngineError),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::Cancelled => write!(f, "render cancelled"),
            RenderError::Failed(error) => write!(f, "{error}"),
        }
    }
}

/// Trampoline handed to C. `ctx` is a `*mut &mut dyn FnMut(f64) -> bool`.
unsafe extern "C" fn render_progress_trampoline(ctx: *mut std::ffi::c_void, fraction: f64) -> i32 {
    if ctx.is_null() {
        return 1;
    }
    let callback = unsafe { &mut *(ctx as *mut &mut dyn FnMut(f64) -> bool) };
    // Runs on the rendering thread; a panic must not unwind into C++.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(fraction))) {
        Ok(true) => 1,
        Ok(false) | Err(_) => 0,
    }
}

/// Render synchronously on the calling thread. `on_progress` gets the overall
/// fraction done and returns `false` to cancel.
pub fn render_offline(
    request: &RenderRequest,
    on_progress: &mut dyn FnMut(f64) -> bool,
) -> Result<RenderReport, RenderError> {
    let json = serde_json::to_string(request)
        .map_err(|e| RenderError::Failed(EngineError::Serialization(e.to_string())))?;
    let json = std::ffi::CString::new(json)
        .map_err(|e| RenderError::Failed(EngineError::Serialization(e.to_string())))?;
    let mut callback: &mut dyn FnMut(f64) -> bool = on_progress;
    let ctx = &mut callback as *mut &mut dyn FnMut(f64) -> bool;
    let ptr = unsafe {
        lt_audio_engine_render_offline(json.as_ptr(), Some(render_progress_trampoline), ctx.cast())
    };
    if ptr.is_null() {
        return Err(RenderError::Failed(EngineError::Internal(
            "render returned null".into(),
        )));
    }
    let text = unsafe { std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    parse_render_response(&text)
}

fn parse_render_response(text: &str) -> Result<RenderReport, RenderError> {
    let response: RenderResponse = serde_json::from_str(text)
        .map_err(|e| RenderError::Failed(EngineError::Serialization(e.to_string())))?;
    if response.cancelled {
        return Err(RenderError::Cancelled);
    }
    if !response.ok {
        return Err(RenderError::Failed(EngineError::Internal(
            response.error.unwrap_or_else(|| "render failed".into()),
        )));
    }
    Ok(RenderReport {
        files: response.files,
        missing_clips: response.missing_clips,
        missing_files: response.missing_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serializes_to_the_engine_schema() {
        let request = RenderRequest {
            project_json: "{}".into(),
            sample_rate: 44100,
            start_seconds: 1.0,
            end_seconds: 2.0,
            outputs: vec![RenderOutput {
                path: "a.wav".into(),
                track_ids: vec!["t".into()],
                include_metronome: true,
                include_voice_guide: false,
            }],
            format: RenderSampleFormat::Float32,
            channels: 2,
            normalize: false,
            normalize_peak_db: -0.3,
            apply_mixer: true,
            dither: true,
            metronome: None,
            voice_guide: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["format"], "float32");
        assert_eq!(value["outputs"][0]["track_ids"][0], "t");
        assert!(value.get("metronome").is_none());
        assert_eq!(
            serde_json::to_value(RenderSampleFormat::Pcm16).unwrap(),
            "pcm16"
        );
    }

    #[test]
    fn cancelled_and_failed_responses_are_told_apart() {
        assert!(matches!(
            parse_render_response(r#"{"ok":false,"error":"cancelled","cancelled":true}"#),
            Err(RenderError::Cancelled)
        ));
        assert!(matches!(
            parse_render_response(r#"{"ok":false,"error":"boom"}"#),
            Err(RenderError::Failed(_))
        ));
        let report = parse_render_response(
            r#"{"ok":true,"files":[{"path":"a.wav","frames":10,"peak":0.5}],"missing_clips":1,"missing_files":["x"]}"#,
        )
        .unwrap();
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.missing_clips, 1);
    }
}
