//! "Rate this app" sheet from the App Store (iOS) and Google Play (Android).
//!
//! The one hard rule: the sheet is NEVER requested while audio may be playing.
//! The frontend already waits for a quiet moment, but this is the last check
//! before the OS is asked, so it lives here, next to the engine, and fails
//! closed: any error reading the state counts as "audio may be playing".
//!
//! What counts as audio:
//! - the transport playing, holding a vamp between songs, or fading out;
//! - ambient pads switched on with a pad chosen (they sound without Play);
//! - anything on the master output meter, sampled several times so a quiet
//!   passage between two notes is not mistaken for silence.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::DesktopState;

/// Peak below which the master output counts as silent (about -80 dBFS).
const SILENCE_PEAK: f32 = 1.0e-4;
const METER_SAMPLES: usize = 5;
const METER_SAMPLE_GAP: std::time::Duration = std::time::Duration::from_millis(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoreReviewOutcome {
    /// Handed to the OS. The OS alone decides whether the sheet appears.
    Requested,
    /// Something may be sounding (or the state could not be read).
    AudioActive,
    /// Desktop: there is no store sheet to ask for.
    Unsupported,
}

#[derive(Debug, Clone, Default)]
struct AudioState {
    playback_state: String,
    song_gap_vamp: bool,
    fading_to_stop: bool,
    pad_enabled: bool,
    pad_selected: bool,
    pad_stop_with_transport: bool,
}

fn transport_is_quiet(state: &AudioState) -> bool {
    let transport_running = state.playback_state == "playing";
    if transport_running || state.song_gap_vamp || state.fading_to_stop {
        return false;
    }
    // A pad set to stop with the transport is silent once the transport is
    // stopped (its fade-out is caught by the meter). Any other enabled pad
    // keeps sounding on its own.
    let pad_sounding = state.pad_enabled && state.pad_selected && !state.pad_stop_with_transport;
    !pad_sounding
}

fn meter_is_silent(peaks: &[(f32, f32)]) -> bool {
    !peaks.is_empty()
        && peaks.iter().all(|(left, right)| {
            left.is_finite() && right.is_finite() && left.abs() < SILENCE_PEAK && right.abs() < SILENCE_PEAK
        })
}

fn read_audio_state(state: &DesktopState) -> Option<AudioState> {
    let snapshot = {
        let mut session = state.session.lock().ok()?;
        session.snapshot_with_sync(&state.audio).ok()?
    };
    let settings = state.audio.current_settings().ok()?;
    Some(AudioState {
        playback_state: snapshot.playback_state,
        song_gap_vamp: snapshot.song_gap_vamp,
        fading_to_stop: snapshot.fading_to_stop,
        pad_enabled: settings.pad_enabled,
        pad_selected: !settings.pad_id.trim().is_empty(),
        pad_stop_with_transport: settings.pad_stop_with_transport,
    })
}

fn sample_output_meter(state: &DesktopState) -> Option<Vec<(f32, f32)>> {
    let mut peaks = Vec::with_capacity(METER_SAMPLES);
    for index in 0..METER_SAMPLES {
        if index > 0 {
            std::thread::sleep(METER_SAMPLE_GAP);
        }
        let level = state.audio.current_output_meter_level().ok()?;
        peaks.push((level.left_peak, level.right_peak));
    }
    Some(peaks)
}

/// Blocking: sleeps between meter samples. Run off the async runtime.
fn audio_is_silent(state: &DesktopState) -> bool {
    let Some(before) = read_audio_state(state) else { return false };
    if !transport_is_quiet(&before) {
        return false;
    }
    let Some(peaks) = sample_output_meter(state) else { return false };
    if !meter_is_silent(&peaks) {
        return false;
    }
    // Play may have been pressed while the meter was being sampled.
    read_audio_state(state).is_some_and(|after| transport_is_quiet(&after))
}

#[tauri::command]
pub async fn request_store_review(app: AppHandle) -> Result<StoreReviewOutcome, String> {
    if !cfg!(any(target_os = "ios", target_os = "android")) {
        return Ok(StoreReviewOutcome::Unsupported);
    }
    let guard_app = app.clone();
    let silent = tauri::async_runtime::spawn_blocking(move || {
        audio_is_silent(&guard_app.state::<DesktopState>())
    })
    .await
    .unwrap_or(false);
    if !silent {
        return Ok(StoreReviewOutcome::AudioActive);
    }

    #[cfg(target_os = "ios")]
    libretracks_ios_folder_picker::request_store_review(app).await?;
    #[cfg(target_os = "android")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(crate::platform::android_store_review::request_store_review)
            .await
            .map_err(|error| format!("store review worker failed: {error}"))??;
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let _ = app;
    Ok(StoreReviewOutcome::Requested)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stopped() -> AudioState {
        AudioState { playback_state: "stopped".into(), ..AudioState::default() }
    }

    #[test]
    fn stopped_transport_without_pads_is_quiet() {
        assert!(transport_is_quiet(&stopped()));
        assert!(transport_is_quiet(&AudioState { playback_state: "paused".into(), ..stopped() }));
        assert!(transport_is_quiet(&AudioState { playback_state: "empty".into(), ..stopped() }));
    }

    #[test]
    fn playing_vamp_or_fade_is_never_quiet() {
        assert!(!transport_is_quiet(&AudioState { playback_state: "playing".into(), ..stopped() }));
        assert!(!transport_is_quiet(&AudioState { song_gap_vamp: true, ..stopped() }));
        assert!(!transport_is_quiet(&AudioState { fading_to_stop: true, ..stopped() }));
    }

    #[test]
    fn enabled_pad_sounds_without_play() {
        let pad = AudioState { pad_enabled: true, pad_selected: true, ..stopped() };
        assert!(!transport_is_quiet(&pad));
        assert!(transport_is_quiet(&AudioState { pad_selected: false, ..pad.clone() }));
        assert!(transport_is_quiet(&AudioState { pad_stop_with_transport: true, ..pad }));
    }

    #[test]
    fn meter_needs_every_sample_silent() {
        assert!(meter_is_silent(&[(0.0, 0.0), (0.00001, 0.0)]));
        assert!(!meter_is_silent(&[(0.0, 0.0), (0.0, 0.2)]));
        assert!(!meter_is_silent(&[]));
        assert!(!meter_is_silent(&[(f32::NAN, 0.0)]));
    }
}
