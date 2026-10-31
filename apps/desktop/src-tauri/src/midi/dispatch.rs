//! MIDI Learn dispatch: what an incoming message does.
//!
//! Every transport ends here: the listener frames bytes into [`MidiMessage`]s
//! and hands them to [`dispatch_midi_message`], which emits the raw message
//! for the UI (learn mode, monitors) and runs the matching binding, either an
//! `action:*` (play, jump to marker…), a `param:*` driven by a value, or a
//! mixer target (plan midi-controllers). One control can drive several.
//!
//! Continuous controls never touch the disk or the session lock per message
//! (D5): settings change in memory and [`super::control`] writes them once
//! the controls go quiet.

use std::sync::atomic::Ordering;

use libretracks_audio::PlaybackState;
use libretracks_core::midi_control::{
    decode_relative, fader, normalized_value, ButtonEvent, ButtonState, ControlMode, MidiBinding,
    MidiTarget, MixControl, MixerTarget, RELATIVE_STEP,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::control::{control, SongMasterSync, TrackMix};
use crate::{
    audio::engine::jump_debug_logging_enabled,
    commands::events::emit_transport_lifecycle_event,
    commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode},
    infra::settings::{AppSettings, AppSettingsStore},
    state::DesktopState,
};

const MIDI_RAW_MESSAGE_EVENT: &str = "midi:raw_message";

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

    let control = control();
    control.diagnostics.messages.fetch_add(1, Ordering::Relaxed);
    let settings_store = app.state::<AppSettingsStore>();
    let index = control.index(&settings_store);
    let bindings = index.lookup(message.status, message.data1);
    if bindings.is_empty() {
        return Ok(());
    }
    let normalized = normalized_value(message.status, message.data1, message.data2);

    let mut first_error = None;
    for (target, binding) in bindings {
        let result = match target {
            MidiTarget::Action(_) => {
                if !action_fires(binding, target, normalized) {
                    continue;
                }
                let settings = settings_store
                    .current()
                    .map_err(|error| error.to_string())?;
                dispatch_midi_action(app, &settings_store, &settings, &target.key())
            }
            MidiTarget::Param(name) => dispatch_midi_parameter(
                app,
                &settings_store,
                name,
                &target.key(),
                binding,
                target,
                message,
                normalized,
            ),
            MidiTarget::Track { track_id, control } => dispatch_track(
                app,
                track_id,
                *control,
                &target.key(),
                binding,
                target,
                message,
                normalized,
            ),
            MidiTarget::Strip { strip, control: mix_control } => {
                let track_id = control
                    .with_mix(|mix| mix.bank.track(&mix.strip_order, *strip).map(str::to_string));
                match track_id {
                    Some(track_id) => dispatch_track(
                        app,
                        &track_id,
                        *mix_control,
                        &target.key(),
                        binding,
                        target,
                        message,
                        normalized,
                    ),
                    None => Ok(()),
                }
            }
            MidiTarget::Bank(step) => {
                if ButtonState::is_press(normalized) {
                    control.step_bank(app, *step);
                }
                Ok(())
            }
            MidiTarget::Mixer(mixer) => dispatch_mixer(
                app,
                &settings_store,
                *mixer,
                &target.key(),
                binding,
                target,
                message,
                normalized,
            ),
            MidiTarget::Scene { .. } | MidiTarget::SceneSlot(_) => {
                if !action_fires(binding, target, normalized) {
                    continue;
                }
                dispatch_scene(app, target)
            }
        };
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Whether a message fires an action. Buttons fire on press; a momentary
/// binding on a `toggle_*` action or a scene toggle fires on release too, so
/// holding the button holds the switch.
fn action_fires(binding: &MidiBinding, target: &MidiTarget, normalized: f64) -> bool {
    let pressed = ButtonState::is_press(normalized);
    match binding.effective_mode(target) {
        ControlMode::Momentary => pressed || target.toggles(),
        _ => pressed,
    }
}

/// A scene button (plan live-scenes, paso 05): the same command as the
/// on-screen button, one session lock per firing (releases of a trigger
/// never get here). A slot past the last scene or a scene of another
/// session does nothing.
fn dispatch_scene(app: &AppHandle, target: &MidiTarget) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    control()
        .diagnostics
        .session_lock_takes
        .fetch_add(1, Ordering::Relaxed);
    let mut session = state
        .session
        .lock()
        .map_err(|_| "desktop session lock poisoned".to_string())?;
    let Some((scene_id, mode)) = target.scene_trigger(&session.mix_scene_ids()) else {
        return Ok(());
    };
    let snapshot = session
        .trigger_mix_scene(&scene_id, mode, &state.audio)
        .map_err(|error| error.to_string())?;
    drop(session);
    emit_transport_lifecycle_event(app, "sync", &snapshot);
    Ok(())
}

fn dispatch_midi_action(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    settings: &AppSettings,
    action_key: &str,
) -> Result<(), String> {
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
        "action:fade_out_stop" => {
            let snapshot = session
                .fade_out_and_stop(settings.fade_out_stop_seconds, &state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
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
        "action:set_global_jump_mode_next_section" | "action:set_global_jump_mode_next_cue" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = action_key.trim_start_matches("action:set_global_jump_mode_").into();
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
        "action:set_song_jump_trigger_next_section" | "action:set_song_jump_trigger_next_cue" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = action_key.trim_start_matches("action:set_song_jump_trigger_").into();
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
        "action:set_vamp_mode_section_marker" | "action:set_vamp_mode_cue" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.vamp_mode = action_key.trim_start_matches("action:set_vamp_mode_").into();
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
        "action:previous_song" => {
            let snapshot = jump_to_previous_region(&mut session, &state.audio, settings)?;
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

/// A track's mixer control (paso 03). The value comes from the mix mirror
/// and goes to the engine through the realtime path; the model and the undo
/// entry are committed by the control worker once the control is still.
#[allow(clippy::too_many_arguments)]
pub(crate) fn dispatch_track(
    app: &AppHandle,
    track_id: &str,
    mix_control: MixControl,
    target_key: &str,
    binding: &MidiBinding,
    target: &MidiTarget,
    message: MidiMessage,
    normalized: f64,
) -> Result<(), String> {
    let control = control();
    // A track the UI has not told us about (another session's binding, or
    // the UI not synced yet) is left alone.
    let Some(current) = control.with_mix(|mix| mix.tracks.get(track_id).cloned()) else {
        return Ok(());
    };
    let Some(next) = next_track_mix(binding, target, target_key, mix_control, message, normalized, &current)
    else {
        return Ok(());
    };

    let audio = &app.state::<DesktopState>().audio;
    let pick = |field: MixControl| (field == mix_control).then_some(());
    audio
        .update_live_track_mix(
            track_id,
            pick(MixControl::Volume).map(|()| next.volume),
            pick(MixControl::Pan).map(|()| next.pan),
            pick(MixControl::Mute).map(|()| next.muted),
            pick(MixControl::Solo).map(|()| next.solo),
            None,
        )
        .map_err(|error| error.to_string())?;
    control.with_mix(|mix| mix.set_track(track_id, mix_control, next));
    control.track_dirty(app, track_id);
    if mix_control.is_switch() {
        super::feedback::refresh(app);
    }
    Ok(())
}

/// The track's mix after this message, or `None` if it does not move it.
pub(crate) fn next_track_mix(
    binding: &MidiBinding,
    target: &MidiTarget,
    target_key: &str,
    mix_control: MixControl,
    message: MidiMessage,
    normalized: f64,
    current: &TrackMix,
) -> Option<TrackMix> {
    let mode = binding.effective_mode(target);
    let mut next = current.clone();
    match mix_control {
        MixControl::Volume => {
            let position = fader::gain_to_position(current.volume, fader::TRACK_MAX_DB);
            let position =
                continuous_position(binding, mode, target_key, message, normalized, position)?;
            next.volume = fader::position_to_gain(position, fader::TRACK_MAX_DB);
        }
        MixControl::Pan => {
            let position = fader::pan_to_position(current.pan);
            let position =
                continuous_position(binding, mode, target_key, message, normalized, position)?;
            next.pan = fader::position_to_pan(position);
        }
        MixControl::Mute | MixControl::Solo => {
            let value = if mix_control == MixControl::Mute {
                &mut next.muted
            } else {
                &mut next.solo
            };
            match ButtonState::decide(mode, normalized, *value) {
                ButtonEvent::Set(on) if on != *value => *value = on,
                ButtonEvent::Fire => *value = !*value,
                _ => return None,
            }
        }
    }
    (next != *current).then_some(next)
}

/// Click, voice guide, pads and the active song's master (paso 03).
#[allow(clippy::too_many_arguments)]
fn dispatch_mixer(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    mixer: MixerTarget,
    target_key: &str,
    binding: &MidiBinding,
    target: &MidiTarget,
    message: MidiMessage,
    normalized: f64,
) -> Result<(), String> {
    let mode = binding.effective_mode(target);
    let audio = &app.state::<DesktopState>().audio;

    if mixer == MixerTarget::SongMaster {
        let Some(master) = control().with_mix(|mix| mix.song_master.clone()) else {
            return Ok(());
        };
        let position = fader::gain_to_position(master.gain, fader::TRACK_MAX_DB);
        let Some(position) =
            continuous_position(binding, mode, target_key, message, normalized, position)
        else {
            return Ok(());
        };
        let gain = fader::position_to_gain(position, fader::TRACK_MAX_DB).min(MAX_SONG_MASTER_GAIN);
        audio
            .update_live_region_master_gain(&master.region_id, gain as f32)
            .map_err(|error| error.to_string())?;
        control().with_mix(|mix| {
            mix.set_song_master(SongMasterSync {
                region_id: master.region_id,
                gain,
            })
        });
        control().song_master_dirty(app);
        return Ok(());
    }

    let read = |settings: &AppSettings| match mixer {
        MixerTarget::Metronome => settings.metronome_volume,
        MixerTarget::VoiceGuide => settings.voice_guide_volume,
        _ => settings.pad_volume,
    };
    let (current, _) = settings_store
        .read(|settings| fader::gain_to_position(read(settings), fader::AUX_MAX_DB))
        .map_err(|error| error.to_string())?;
    let Some(position) = continuous_position(binding, mode, target_key, message, normalized, current)
    else {
        return Ok(());
    };
    let gain = fader::position_to_gain(position, fader::AUX_MAX_DB);
    let changed = settings_store
        .update(|settings| match mixer {
            MixerTarget::Metronome => settings.metronome_volume = gain,
            MixerTarget::VoiceGuide => settings.voice_guide_volume = gain,
            _ => settings.pad_volume = gain,
        })
        .map_err(|error| error.to_string())?;
    if !changed {
        return Ok(());
    }
    match mixer {
        MixerTarget::Metronome => audio.set_metronome_volume_realtime(gain),
        MixerTarget::VoiceGuide => audio.set_voice_guide_volume_realtime(gain),
        _ => audio.set_pad_volume_realtime(gain),
    }
    .map_err(|error| error.to_string())?;
    control().settings_dirty(app);
    Ok(())
}

/// `MAX_SONG_MASTER_GAIN` in levelSongs/levelSongsPlan.ts.
const MAX_SONG_MASTER_GAIN: f64 = 2.0;

/// Where a continuous control puts its target (0..1), or `None` when the
/// message must not move it: an absolute fader that has not caught the
/// current value yet under the takeover mode (D6), or an encoder that did
/// not turn.
pub(crate) fn continuous_position(
    binding: &MidiBinding,
    mode: ControlMode,
    target_key: &str,
    message: MidiMessage,
    normalized: f64,
    current: f64,
) -> Option<f64> {
    if mode.is_relative() {
        let steps = decode_relative(message.data2, mode);
        if steps == 0 {
            return None;
        }
        let next = (current + f64::from(steps) * RELATIVE_STEP).clamp(0.0, 1.0);
        return Some(next);
    }
    if mode != ControlMode::Absolute {
        return None;
    }
    let value = binding.scale(normalized);
    if !binding.takeover_enabled() {
        return Some(value);
    }
    let takeover_mode = control().takeover_mode();
    control().with_takeover(target_key, |takeover| {
        takeover.sync(current);
        let next = takeover.next(takeover_mode, value, current, (binding.min, binding.max))?;
        takeover.wrote(next);
        Some(next)
    })
}

/// A discrete parameter's value from a control, as the 0-127 the mapping
/// tables below were written for.
fn discrete_value(binding: &MidiBinding, normalized: f64) -> u8 {
    (binding.scale(normalized) * 127.0).round() as u8
}

#[allow(clippy::too_many_arguments)]
fn dispatch_midi_parameter(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    name: &str,
    target_key: &str,
    binding: &MidiBinding,
    target: &MidiTarget,
    message: MidiMessage,
    normalized: f64,
) -> Result<(), String> {
    let mode = binding.effective_mode(target);
    if mode != ControlMode::Absolute && !mode.is_relative() {
        return Ok(());
    }

    match name {
        "metronome_volume" => {
            // The setting is a linear gain on a fader that runs to +20 dB:
            // map the control across the on-screen fader's taper, so fully
            // down is silence, ~3/4 up is unity and the top is +20 dB.
            let (current, _) = settings_store
                .read(|settings| {
                    fader::gain_to_position(settings.metronome_volume, fader::AUX_MAX_DB)
                })
                .map_err(|error| error.to_string())?;
            let Some(position) =
                continuous_position(binding, mode, target_key, message, normalized, current)
            else {
                return Ok(());
            };
            let gain = fader::position_to_gain(position, fader::AUX_MAX_DB);
            let changed = settings_store
                .update(|settings| settings.metronome_volume = gain)
                .map_err(|error| error.to_string())?;
            if changed {
                app.state::<DesktopState>()
                    .audio
                    .set_metronome_volume_realtime(gain)
                    .map_err(|error| error.to_string())?;
                control().settings_dirty(app);
            }
            return Ok(());
        }
        "tempo" => {
            // The tempo lives in the session, which a knob must not lock per
            // message: absolute only, applied by the control worker at a
            // bounded rate (the latest value wins).
            if mode != ControlMode::Absolute {
                return Ok(());
            }
            let next_bpm = map_cc_to_range(discrete_value(binding, normalized), 40, 240) as f64;
            control().tempo(app, next_bpm);
            return Ok(());
        }
        _ => {}
    }

    let relative_steps = mode
        .is_relative()
        .then(|| decode_relative(message.data2, mode));
    let value = discrete_value(binding, normalized);
    let bars = |current: u32| match relative_steps {
        Some(steps) => (i64::from(current) + i64::from(steps)).clamp(1, 16) as u32,
        None => map_cc_to_range(value, 1, 16),
    };
    // Enum parameters only make sense as positions.
    let absolute = relative_steps.is_none();

    let changed = settings_store
        .update(|next_settings| match name {
            "vamp_bars" => next_settings.vamp_bars = bars(next_settings.vamp_bars),
            "global_jump_mode" if absolute => {
                next_settings.global_jump_mode = match value {
                    0..=42 => "immediate",
                    43..=85 => "after_bars",
                    _ => "next_marker",
                }
                .to_string();
            }
            "global_jump_bars" => {
                next_settings.global_jump_bars = bars(next_settings.global_jump_bars);
            }
            "song_jump_trigger" if absolute => {
                next_settings.song_jump_trigger = match value {
                    0..=31 => "immediate",
                    32..=63 => "after_bars",
                    64..=95 => "region_end",
                    _ => "next_marker",
                }
                .to_string();
            }
            "song_jump_bars" => {
                next_settings.song_jump_bars = bars(next_settings.song_jump_bars);
            }
            "song_transition_mode" if absolute => {
                next_settings.song_transition_mode =
                    if value < 64 { "instant" } else { "fade_out" }.to_string();
            }
            "vamp_mode" if absolute => {
                next_settings.vamp_mode = if value < 64 { "section" } else { "bars" }.to_string();
            }
            "jump_bars" => {
                let global_after = next_settings.global_jump_mode == "after_bars";
                let song_after = next_settings.song_jump_trigger == "after_bars";
                if global_after {
                    next_settings.global_jump_bars = bars(next_settings.global_jump_bars);
                }
                if song_after {
                    next_settings.song_jump_bars = bars(next_settings.song_jump_bars);
                }
                if !global_after && !song_after {
                    let next = bars(next_settings.global_jump_bars);
                    next_settings.global_jump_bars = next;
                    next_settings.song_jump_bars = next;
                }
            }
            _ => {}
        })
        .map_err(|error| error.to_string())?;

    if changed {
        apply_settings_in_memory(app, settings_store)?;
    }
    Ok(())
}

/// Hand the in-memory settings to the engine (never reopening the device:
/// the old path did, once per CC) and schedule the JSON write and the UI
/// update on the control worker.
fn apply_settings_in_memory(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
) -> Result<(), String> {
    let settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    app.state::<DesktopState>()
        .audio
        .apply_settings_with_stream_rebuild(settings, false)
        .map_err(|error| error.to_string())?;
    control().settings_dirty(app);
    super::feedback::refresh(app);
    Ok(())
}

/// Replace the settings from a MIDI action (or a Bluetooth reconnect): in
/// memory and to the engine now, disk and UI through the control worker.
pub(crate) fn apply_midi_settings_update(
    app: &AppHandle,
    settings_store: &AppSettingsStore,
    next_settings: AppSettings,
) -> Result<(), String> {
    let changed = settings_store
        .update(|settings| *settings = next_settings)
        .map_err(|error| error.to_string())?;
    if !changed {
        return Ok(());
    }
    apply_settings_in_memory(app, settings_store)
}

fn jump_to_next_region(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio::engine::AudioController,
    settings: &AppSettings,
) -> Result<crate::models::TransportSnapshot, String> {
    jump_to_neighbour_region(session, audio, settings, next_region_index)
}

fn jump_to_previous_region(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio::engine::AudioController,
    settings: &AppSettings,
) -> Result<crate::models::TransportSnapshot, String> {
    jump_to_neighbour_region(session, audio, settings, previous_region_index)
}

/// Mirrors `findNextSongRegion` in the frontend (timeline/songNavigation.ts):
/// the first song starting after the cursor, wrapping to the first.
fn next_region_index(starts: &[f64], position_seconds: f64) -> Option<usize> {
    if starts.is_empty() {
        return None;
    }
    starts
        .iter()
        .position(|start| *start > position_seconds + f64::EPSILON)
        .or(Some(0))
}

/// Mirrors `findPreviousSongRegion` in the frontend: the song before the one
/// under the cursor, wrapping from the first song to the last.
fn previous_region_index(starts: &[f64], position_seconds: f64) -> Option<usize> {
    if starts.is_empty() {
        return None;
    }
    let current = starts
        .iter()
        .rposition(|start| *start <= position_seconds + f64::EPSILON);
    match current {
        Some(index) if index > 0 => Some(index - 1),
        _ => Some(starts.len() - 1),
    }
}

fn jump_to_neighbour_region(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio::engine::AudioController,
    settings: &AppSettings,
    pick: fn(&[f64], f64) -> Option<usize>,
) -> Result<crate::models::TransportSnapshot, String> {
    let song = session
        .engine
        .song()
        .cloned()
        .ok_or_else(|| "no song loaded".to_string())?;

    let mut regions = song.regions.iter().collect::<Vec<_>>();
    regions.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let starts = regions
        .iter()
        .map(|region| region.start_seconds)
        .collect::<Vec<_>>();
    let position_seconds = session.engine.position_seconds();
    let Some(index) = pick(&starts, position_seconds) else {
        return session
            .snapshot_with_sync(audio)
            .map_err(|error| error.to_string());
    };
    let region_id = regions[index].id.clone();

    let jump_trigger =
        parse_jump_trigger(&settings.song_jump_trigger, Some(settings.song_jump_bars))
            .map_err(|error| error.to_string())?;
    let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
        .map_err(|error| error.to_string())?;

    session
        .schedule_region_jump(&region_id, jump_trigger, transition, audio)
        .map_err(|error| error.to_string())
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
    use super::{
        continuous_position, map_cc_to_range, next_region_index, next_track_mix,
        previous_region_index, ControlMode, MidiBinding, MidiMessage, MidiTarget, MixControl,
        TrackMix,
    };

    fn unity() -> TrackMix {
        TrackMix { volume: 1.0, pan: 0.0, muted: false, solo: false }
    }

    #[test]
    fn track_volume_follows_the_on_screen_taper_and_mute_toggles_on_press() {
        let mut binding = MidiBinding::new(0xB0, 7);
        binding.takeover = Some(false);
        let volume = MidiTarget::parse("track:t1:volume").unwrap();
        // 3/4 of the travel is unity on the on-screen fader.
        let value = 95u8; // 95/127 ~ 0.748
        let next = next_track_mix(&binding, &volume, "test:t1v", MixControl::Volume, cc(value), f64::from(value) / 127.0, &TrackMix { volume: 0.0, ..unity() })
            .expect("moves");
        assert!((next.volume - 1.0).abs() < 0.03, "{}", next.volume);
        let bottom = next_track_mix(&binding, &volume, "test:t1v", MixControl::Volume, cc(0), 0.0, &unity()).unwrap();
        assert_eq!(bottom.volume, 0.0);

        let mute = MidiTarget::parse("track:t1:mute").unwrap();
        let note = MidiBinding::new(0x90, 40);
        let press = MidiMessage { status: 0x90, data1: 40, data2: 127 };
        let release = MidiMessage { status: 0x80, data1: 40, data2: 0 };
        let muted = next_track_mix(&note, &mute, "test:t1m", MixControl::Mute, press, 1.0, &unity()).unwrap();
        assert!(muted.muted);
        assert_eq!(next_track_mix(&note, &mute, "test:t1m", MixControl::Mute, release, 0.0, &muted), None, "release does nothing");
        let unmuted = next_track_mix(&note, &mute, "test:t1m", MixControl::Mute, press, 1.0, &muted).unwrap();
        assert!(!unmuted.muted);
    }

    fn cc(value: u8) -> MidiMessage {
        MidiMessage {
            status: 0xB0,
            data1: 7,
            data2: value,
        }
    }

    #[test]
    fn absolute_fader_waits_for_pickup_then_follows() {
        let binding = MidiBinding::new(0xB0, 7);
        let key = "test:pickup";
        let at = |value: u8, current: f64| {
            continuous_position(&binding, ControlMode::Absolute, key, cc(value), f64::from(value) / 127.0, current)
        };
        assert_eq!(at(10, 0.8), None, "far below the value: ignored");
        let picked = at(102, 0.8).expect("reached the value");
        assert!((picked - 102.0 / 127.0).abs() < 1e-9);
        let current = picked;
        assert!(at(20, current).is_some(), "follows once picked up");
        // The screen moved the target to 0.9: the fader lets go.
        assert_eq!(at(25, 0.9), None);
    }

    #[test]
    fn takeover_off_follows_at_once_and_encoders_step_from_the_current_value() {
        let mut binding = MidiBinding::new(0xB0, 7);
        binding.takeover = Some(false);
        let jump = continuous_position(&binding, ControlMode::Absolute, "test:off", cc(0), 0.0, 0.8);
        assert_eq!(jump, Some(0.0));
        let up = continuous_position(&binding, ControlMode::RelativeTwosComplement, "test:enc", cc(2), 0.0, 0.5)
            .unwrap();
        assert!((up - (0.5 + 2.0 / 128.0)).abs() < 1e-12);
        let still = continuous_position(&binding, ControlMode::RelativeBinaryOffset, "test:enc", cc(64), 0.5, 0.5);
        assert_eq!(still, None);
    }

    #[test]
    fn maps_cc_values_to_useful_ranges() {
        assert_eq!(map_cc_to_range(0, 1, 16), 1);
        assert_eq!(map_cc_to_range(127, 1, 16), 16);
        assert_eq!(map_cc_to_range(64, 1, 16), 9);
    }

    // Same cases as timeline/songNavigation.test.ts: the MIDI pedal and the
    // on-screen buttons must pick the same song.
    #[test]
    fn previous_song_goes_back_one_and_wraps_to_the_last() {
        let starts = [0.0, 100.0, 250.0];
        assert_eq!(previous_region_index(&starts, 150.0), Some(0));
        assert_eq!(previous_region_index(&starts, 300.0), Some(1));
        assert_eq!(previous_region_index(&starts, 100.0), Some(0));
        assert_eq!(previous_region_index(&starts, 0.0), Some(2));
        assert_eq!(previous_region_index(&starts, 42.0), Some(2));
        assert_eq!(previous_region_index(&[], 10.0), None);
    }

    #[test]
    fn next_song_goes_forward_one_and_wraps_to_the_first() {
        let starts = [0.0, 100.0, 250.0];
        assert_eq!(next_region_index(&starts, 0.0), Some(1));
        assert_eq!(next_region_index(&starts, 150.0), Some(2));
        assert_eq!(next_region_index(&starts, 260.0), Some(0));
        assert_eq!(next_region_index(&[], 10.0), None);
    }
}
