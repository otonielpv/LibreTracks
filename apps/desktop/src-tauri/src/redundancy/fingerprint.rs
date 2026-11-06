//! Session fingerprint adapter (redundancy step 03): builds the input of the
//! pure `libretracks_core::session_fingerprint` from the session and the app
//! settings, and reads file sizes from disk. Never under the session lock.

use std::path::Path;

use libretracks_core::session_fingerprint::{
    fingerprint, AudioFileInfo, FingerprintInput, SessionFingerprint, TimingSettings,
};
use tauri::State;

use crate::infra::settings::AppSettings;
use crate::state::{DesktopState, FingerprintSource};

/// The settings that change WHEN something sounds (step 03 §3). Paths in
/// `infra/settings.rs`: `global_jump_mode`, `global_jump_bars`,
/// `song_jump_trigger`, `song_jump_bars`, `song_transition_mode`,
/// `fade_out_stop_seconds`, `vamp_mode`, `vamp_bars`, `pause_at_song_end`,
/// `vamp_between_songs`, `voice_guide_lead_bars`,
/// `voice_guide_count_in_enabled`. Left out on purpose: theme, locale, UI
/// sizes, audio device and buffer, meters, library, MIDI ports, metronome
/// and guide volumes/sounds (they change what is heard, never when).
pub fn timing_settings(settings: &AppSettings) -> TimingSettings {
    TimingSettings {
        global_jump_mode: settings.global_jump_mode.clone(),
        global_jump_bars: settings.global_jump_bars,
        song_jump_trigger: settings.song_jump_trigger.clone(),
        song_jump_bars: settings.song_jump_bars,
        song_transition_mode: settings.song_transition_mode.clone(),
        fade_out_stop_seconds: settings.fade_out_stop_seconds,
        vamp_mode: settings.vamp_mode.clone(),
        vamp_bars: settings.vamp_bars,
        pause_at_song_end: settings.pause_at_song_end,
        vamp_between_songs: settings.vamp_between_songs,
        voice_guide_lead_bars: settings.voice_guide_lead_bars,
        voice_guide_count_in_enabled: settings.voice_guide_count_in_enabled,
    }
}

/// Size of a clip's file: relative paths resolve against the session folder.
/// Content is never read (multi-GB sessions).
pub fn file_info(song_dir: Option<&Path>, file_path: &str) -> Option<AudioFileInfo> {
    let path = Path::new(file_path);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir?.join(path)
    };
    std::fs::metadata(resolved).ok().map(|meta| AudioFileInfo {
        size_bytes: meta.len(),
    })
}

pub fn compute(source: &FingerprintSource, settings: &AppSettings) -> SessionFingerprint {
    let timing = timing_settings(settings);
    fingerprint(
        &FingerprintInput {
            song: &source.song,
            automation_cues: &source.automation_cues,
            timing: &timing,
        },
        |file_path| file_info(source.song_dir.as_deref(), file_path),
    )
}

/// Clone under the lock, hash after releasing it.
pub fn current(state: &DesktopState) -> Result<Option<SessionFingerprint>, String> {
    let source = state
        .session
        .lock()
        .map_err(|_| "state poisoned".to_string())?
        .fingerprint_source();
    let Some(source) = source else {
        return Ok(None);
    };
    let settings = state
        .audio
        .current_settings()
        .map_err(|error| error.to_string())?;
    Ok(Some(compute(&source, &settings)))
}

/// Debugging: the current session's fingerprint, or null without a session.
#[tauri::command(async)]
pub fn get_session_fingerprint(
    state: State<'_, DesktopState>,
) -> Result<Option<SessionFingerprint>, String> {
    current(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_settings_follow_the_app_settings() {
        let mut settings = AppSettings::default();
        let before = timing_settings(&settings);
        settings.locale = Some("en".into());
        assert_eq!(timing_settings(&settings), before, "language is not timing");
        settings.vamp_between_songs = !settings.vamp_between_songs;
        assert_ne!(timing_settings(&settings), before);
    }

    #[test]
    fn relative_paths_resolve_against_the_session_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("audio")).unwrap();
        std::fs::write(dir.path().join("audio").join("a.wav"), [0u8; 42]).unwrap();
        assert_eq!(
            file_info(Some(dir.path()), "audio/a.wav"),
            Some(AudioFileInfo { size_bytes: 42 })
        );
        assert_eq!(file_info(None, "audio/a.wav"), None);
        assert_eq!(file_info(Some(dir.path()), "audio/missing.wav"), None);
    }
}
