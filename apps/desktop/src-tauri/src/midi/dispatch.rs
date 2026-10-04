//! MIDI Learn dispatch: what an incoming message does.
//!
//! Every transport ends here: the listener frames bytes into [`MidiMessage`]s
//! and hands them to [`dispatch_midi_message`], which emits the raw message
//! for the UI (learn mode, monitors) and runs the matching binding, either an
//! `action:*` (play, jump to marker…) or a `param:*` driven by a CC.

use libretracks_audio::PlaybackState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    audio::engine::jump_debug_logging_enabled,
    commands::events::emit_transport_lifecycle_event,
    commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode},
    infra::settings::{save_app_settings, AppSettings, AppSettingsStore, MidiBinding},
    state::DesktopState,
};

const MIDI_RAW_MESSAGE_EVENT: &str = "midi:raw_message";
const SETTINGS_UPDATED_EVENT: &str = "settings:updated";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MidiMessage {
    pub(crate) status: u8,
    pub(crate) data1: u8,
    pub(crate) data2: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiRawMessagePayload {
    status: u8,
    data1: u8,
    data2: u8,
}

pub(crate) fn dispatch_midi_message(app: &AppHandle, message: MidiMessage) -> Result<(), String> {
    app.emit(
        MIDI_RAW_MESSAGE_EVENT,
        MidiRawMessagePayload {
            status: message.status,
            data1: message.data1,
            data2: message.data2,
        },
    )
    .map_err(|error| error.to_string())?;

    let settings_store = app.state::<AppSettingsStore>();
    let settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;

    let Some((binding_key, binding)) = find_matching_binding(&settings, message) else {
        return Ok(());
    };

    if binding_key.starts_with("action:") {
        return dispatch_midi_action(app, &settings_store, &settings, binding_key, message);
    }

    if binding_key.starts_with("param:") {
        return dispatch_midi_parameter(app, &settings_store, binding_key, binding, message);
    }

    Ok(())
}

fn dispatch_midi_action(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    settings: &AppSettings,
    action_key: &str,
    message: MidiMessage,
) -> Result<(), String> {
    if message.status & 0xF0 == 0x90 && message.data2 == 0 {
        return Ok(());
    }

    // Video live control (paso 13) never needs the session.
    if let Some(action) = crate::video::live::VideoLiveAction::from_midi_key(action_key) {
        crate::video::live::run(app, action)?;
        return Ok(());
    }

    let state = app.state::<DesktopState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| "desktop session lock poisoned".to_string())?;

    if let Some(marker_index) = parse_dynamic_jump_index(action_key, "action:jump_marker_") {
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "no song loaded".to_string())?;
        // jump_marker_N targets only song sections — dynamic cues (Build, All
        // In, ...) are not navigation targets. Filter them out before indexing
        // so the index matches the section-only list the UI exposes.
        let mut markers = song
            .section_markers
            .iter()
            .filter(|marker| marker.category() == libretracks_core::MarkerCategory::Section)
            .collect::<Vec<_>>();
        markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let Some(target_marker_id) = markers
            .get(marker_index.saturating_sub(1))
            .map(|marker| marker.id.clone())
        else {
            return Ok(());
        };
        let jump_trigger =
            parse_jump_trigger(&settings.global_jump_mode, Some(settings.global_jump_bars))
                .map_err(|error| error.to_string())?;
        let transition = libretracks_audio::TransitionType::Instant;
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][midi] jump_marker action={action_key} target_marker={target_marker_id} global_mode={} global_bars={} transition=marker_instant parsed_trigger={jump_trigger:?} parsed_transition={transition:?}",
                settings.global_jump_mode,
                settings.global_jump_bars
            );
        }
        let snapshot = session
            .schedule_marker_jump(&target_marker_id, jump_trigger, transition, &state.audio)
            .map_err(|error| error.to_string())?;
        emit_transport_lifecycle_event(app, "sync", &snapshot);
        return Ok(());
    }

    if let Some(region_index) = parse_dynamic_jump_index(action_key, "action:jump_song_") {
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "no song loaded".to_string())?;
        let mut regions = song.regions.iter().collect::<Vec<_>>();
        regions.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let Some(target_region_id) = regions
            .get(region_index.saturating_sub(1))
            .map(|region| region.id.clone())
        else {
            return Ok(());
        };
        let jump_trigger =
            parse_jump_trigger(&settings.song_jump_trigger, Some(settings.song_jump_bars))
                .map_err(|error| error.to_string())?;
        let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
            .map_err(|error| error.to_string())?;
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][midi] jump_region action={action_key} target_region={target_region_id} song_trigger={} song_bars={} transition={} parsed_trigger={jump_trigger:?} parsed_transition={transition:?}",
                settings.song_jump_trigger,
                settings.song_jump_bars,
                settings.song_transition_mode
            );
        }
        let snapshot = session
            .schedule_region_jump(&target_region_id, jump_trigger, transition, &state.audio)
            .map_err(|error| error.to_string())?;
        emit_transport_lifecycle_event(app, "sync", &snapshot);
        return Ok(());
    }

    let _snapshot = match action_key {
        "action:play" => {
            if session.engine.playback_state() == PlaybackState::Playing {
                return Ok(());
            }
            let snapshot = session
                .play(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "play", &snapshot);
            snapshot
        }
        "action:pause" => {
            if session.engine.playback_state() == PlaybackState::Paused
                || session.engine.playback_state() == PlaybackState::Empty
            {
                return Ok(());
            }
            let snapshot = session
                .pause(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "pause", &snapshot);
            snapshot
        }
        "action:stop" => {
            if session.engine.playback_state() == PlaybackState::Empty {
                return Ok(());
            }
            let snapshot = session
                .stop(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "stop", &snapshot);
            snapshot
        }
        "action:create_song" => {
            let Some(snapshot) = session
                .create_song(app, &state.audio)
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:open_project" => {
            let Some(snapshot) = session
                .open_project_from_dialog(app, &state.audio)
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:save_project" => {
            let snapshot = session.save_project().map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:save_project_as" => {
            let Some(snapshot) = session
                .save_project_as()
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:undo" => {
            let snapshot = session
                .undo_action(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:redo" => {
            let snapshot = session
                .redo_action(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:set_global_jump_mode_immediate" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "immediate".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_global_jump_mode_after_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "after_bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_global_jump_mode_next_marker" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "next_marker".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_global_jump_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.global_jump_bars =
                next_settings.global_jump_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_global_jump_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.global_jump_bars =
                next_settings.global_jump_bars.saturating_sub(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_immediate" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "immediate".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_after_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "after_bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_region_end" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "region_end".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_next_marker" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "next_marker".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_song_jump_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_bars = next_settings.song_jump_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_song_jump_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_jump_bars = next_settings.song_jump_bars.saturating_sub(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_transition_instant" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_transition_mode = "instant".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_transition_fade_out" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.song_transition_mode = "fade_out".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_vamp_mode_section" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.vamp_mode = "section".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_vamp_mode_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.vamp_mode = "bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_vamp_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.vamp_bars = next_settings.vamp_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_vamp_bars" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.vamp_bars = next_settings.vamp_bars.saturating_sub(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:toggle_vamp" => {
            let vamp_mode = parse_vamp_mode(&settings.vamp_mode, Some(settings.vamp_bars))
                .map_err(|error| error.to_string())?;
            let snapshot = session
                .toggle_vamp(vamp_mode, &state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:toggle_metronome" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.metronome_enabled = !next_settings.metronome_enabled;
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:toggle_voice_guide" => {
            let mut next_settings = settings_store
                .current()
                .map_err(|error| error.to_string())?;
            next_settings.voice_guide_enabled = !next_settings.voice_guide_enabled;
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:cancel_jump" => {
            let snapshot = session
                .cancel_marker_jump(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:create_marker" => {
            let snapshot = session
                .snapshot_with_sync(&state.audio)
                .map_err(|error| error.to_string())?;
            let position_seconds = snapshot.position_seconds;
            let snapshot = session
                .create_section_marker(position_seconds, None, None, None, &state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:next_song" => {
            let snapshot = jump_to_next_region(&mut session, &state.audio, settings)?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        _ => return Ok(()),
    };

    Ok(())
}

fn parse_dynamic_jump_index(action_key: &str, prefix: &str) -> Option<usize> {
    action_key
        .strip_prefix(prefix)?
        .parse::<usize>()
        .ok()
        .filter(|index| *index > 0)
}

fn dispatch_midi_parameter(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    binding_key: &str,
    binding: &MidiBinding,
    message: MidiMessage,
) -> Result<(), String> {
    if !binding.is_cc {
        return Ok(());
    }

    let previous_settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    let mut next_settings = previous_settings.clone();
    let mut changed = false;

    match binding_key {
        "param:metronome_volume" => {
            // The setting is a linear gain on a fader that runs to +20 dB, so a
            // raw `data2 / 127` (the old 0..1 slider mapping) pinned the knob's
            // whole travel at or below 0 dB. Map the CC across the fader's dB
            // range instead: fully down is silence, ~3/4 up is unity, top is
            // +20 dB — the same places they sit on the on-screen fader.
            let next_volume = metronome_volume_from_cc(message.data2);
            if (next_settings.metronome_volume - next_volume).abs() > f64::EPSILON {
                next_settings.metronome_volume = next_volume;
                changed = true;
            }
        }
        "param:tempo" => {
            let next_bpm = map_cc_to_range(message.data2, 40, 240) as f64;
            let state = app.state::<DesktopState>();
            let mut session = state
                .session
                .lock()
                .map_err(|_| "desktop session lock poisoned".to_string())?;
            let snapshot = session
                .update_song_tempo(next_bpm, &state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            return Ok(());
        }
        "param:vamp_bars" => {
            let next_bars = map_cc_to_range(message.data2, 1, 16);
            if next_settings.vamp_bars != next_bars {
                next_settings.vamp_bars = next_bars;
                changed = true;
            }
        }
        "param:global_jump_mode" => {
            let next_mode = match message.data2 {
                0..=42 => "immediate",
                43..=85 => "after_bars",
                _ => "next_marker",
            };
            if next_settings.global_jump_mode != next_mode {
                next_settings.global_jump_mode = next_mode.to_string();
                changed = true;
            }
        }
        "param:global_jump_bars" => {
            let next_bars = map_cc_to_range(message.data2, 1, 16);
            if next_settings.global_jump_bars != next_bars {
                next_settings.global_jump_bars = next_bars;
                changed = true;
            }
        }
        "param:song_jump_trigger" => {
            let next_trigger = match message.data2 {
                0..=31 => "immediate",
                32..=63 => "after_bars",
                64..=95 => "region_end",
                _ => "next_marker",
            };
            if next_settings.song_jump_trigger != next_trigger {
                next_settings.song_jump_trigger = next_trigger.to_string();
                changed = true;
            }
        }
        "param:song_jump_bars" => {
            let next_bars = map_cc_to_range(message.data2, 1, 16);
            if next_settings.song_jump_bars != next_bars {
                next_settings.song_jump_bars = next_bars;
                changed = true;
            }
        }
        "param:song_transition_mode" => {
            let next_mode = if message.data2 < 64 {
                "instant"
            } else {
                "fade_out"
            };
            if next_settings.song_transition_mode != next_mode {
                next_settings.song_transition_mode = next_mode.to_string();
                changed = true;
            }
        }
        "param:vamp_mode" => {
            let next_mode = if message.data2 < 64 {
                "section"
            } else {
                "bars"
            };
            if next_settings.vamp_mode != next_mode {
                next_settings.vamp_mode = next_mode.to_string();
                changed = true;
            }
        }
        "param:jump_bars" => {
            let next_bars = map_cc_to_range(message.data2, 1, 16);
            if next_settings.global_jump_mode == "after_bars" {
                if next_settings.global_jump_bars != next_bars {
                    next_settings.global_jump_bars = next_bars;
                    changed = true;
                }
            }
            if next_settings.song_jump_trigger == "after_bars" {
                if next_settings.song_jump_bars != next_bars {
                    next_settings.song_jump_bars = next_bars;
                    changed = true;
                }
            }
            if next_settings.global_jump_mode != "after_bars"
                && next_settings.song_jump_trigger != "after_bars"
                && (next_settings.global_jump_bars != next_bars
                    || next_settings.song_jump_bars != next_bars)
            {
                next_settings.global_jump_bars = next_bars;
                next_settings.song_jump_bars = next_bars;
                changed = true;
            }
        }
        _ => return Ok(()),
    }

    if !changed {
        return Ok(());
    }

    apply_midi_settings_update(app, settings_store, next_settings)
}

fn apply_midi_settings_update(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    next_settings: AppSettings,
) -> Result<(), String> {
    let previous_settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    if previous_settings == next_settings {
        return Ok(());
    }

    settings_store
        .set(next_settings.clone())
        .map_err(|error| error.to_string())?;

    let state = app.state::<DesktopState>();
    state
        .audio
        .apply_settings(next_settings.clone())
        .map_err(|error| error.to_string())?;

    save_app_settings(app, &next_settings).map_err(|error| error.to_string())?;

    app.emit(SETTINGS_UPDATED_EVENT, next_settings)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn jump_to_next_region(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio::engine::AudioController,
    settings: &AppSettings,
) -> Result<crate::models::TransportSnapshot, String> {
    let song = session
        .engine
        .song()
        .cloned()
        .ok_or_else(|| "no song loaded".to_string())?;

    if song.regions.is_empty() {
        return session
            .snapshot_with_sync(audio)
            .map_err(|error| error.to_string());
    }

    let position_seconds = session.engine.position_seconds();
    let next_region = song
        .regions
        .iter()
        .find(|region| region.start_seconds > position_seconds + f64::EPSILON)
        .or_else(|| song.regions.first())
        .ok_or_else(|| "no song regions available".to_string())?;

    let jump_trigger =
        parse_jump_trigger(&settings.song_jump_trigger, Some(settings.song_jump_bars))
            .map_err(|error| error.to_string())?;
    let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
        .map_err(|error| error.to_string())?;

    session
        .schedule_region_jump(&next_region.id, jump_trigger, transition, audio)
        .map_err(|error| error.to_string())
}

fn find_matching_binding<'a>(
    settings: &'a AppSettings,
    message: MidiMessage,
) -> Option<(&'a str, &'a MidiBinding)> {
    settings
        .midi_mappings
        .iter()
        .find(|(_, binding)| binding.status == message.status && binding.data1 == message.data1)
        .map(|(key, binding)| (key.as_str(), binding))
}

/// Map a CC value (0-127) onto the click fader's travel, as a linear gain.
///
/// Mirrors the shape of `AUX_FADER_SCALE` (packages/shared/src/faderScale.ts)
/// at its two anchors: unity sits ~3/4 of the way up and the top is +20 dB.
/// Below unity the real fader uses a piecewise taper; replicating it here would
/// duplicate a curve that can drift out of sync, so this interpolates linearly
/// in dB down to the -60 dB floor — close enough for a knob, and the fader
/// itself remains the single source of truth for the on-screen shape.
fn metronome_volume_from_cc(value: u8) -> f64 {
    /// Fader position that means unity gain / 0 dB.
    const UNITY_POSITION: f64 = 0.75;
    const MAX_DB: f64 = 20.0;
    const FLOOR_DB: f64 = -60.0;

    let position = f64::from(value) / 127.0;
    if position <= 0.0 {
        return 0.0;
    }

    let db = if position >= UNITY_POSITION {
        let t = (position - UNITY_POSITION) / (1.0 - UNITY_POSITION);
        t * MAX_DB
    } else {
        let t = position / UNITY_POSITION;
        FLOOR_DB + t * -FLOOR_DB
    };

    10f64.powf(db / 20.0).clamp(0.0, 10.0)
}

fn map_cc_to_range(value: u8, min: u32, max: u32) -> u32 {
    if min >= max {
        return min;
    }

    let span = max - min;
    let normalized = f64::from(value) / 127.0;
    min + (normalized * f64::from(span)).round() as u32
}

#[cfg(test)]
mod tests {
    use super::map_cc_to_range;

    #[test]
    fn maps_cc_values_to_useful_ranges() {
        assert_eq!(map_cc_to_range(0, 1, 16), 1);
        assert_eq!(map_cc_to_range(127, 1, 16), 16);
        assert_eq!(map_cc_to_range(64, 1, 16), 9);
    }
}
