use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use libretracks_audio::PlaybackState;
use midir::{Ignore, MidiInput, MidiInputPort};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    audio_runtime::AudioCommand, commands::events::emit_transport_lifecycle_event,
    commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode},
    settings::{save_app_settings, AppSettings, AppSettingsStore, MidiBinding},
    state::DesktopState,
};

const MIDI_LOOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MIDI_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

const MIDI_RAW_MESSAGE_EVENT: &str = "midi:raw_message";
const SETTINGS_UPDATED_EVENT: &str = "settings:updated";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MidiMessage {
    status: u8,
    data1: u8,
    data2: u8,
}

pub(crate) struct MidiListenerHandle {
    device_name: String,
    should_stop: Arc<AtomicBool>,
    listener_thread: JoinHandle<()>,
    dispatcher_thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct MidiManager {
    active_listener: Mutex<Option<MidiListenerHandle>>,
}

impl MidiManager {
    pub fn restart(
        &self,
        app: AppHandle,
        audio_sender: Sender<AudioCommand>,
        selected_device: Option<String>,
    ) -> Result<(), String> {
        let normalized_device = normalize_device_name(selected_device);
        let mut active_listener = self
            .active_listener
            .lock()
            .map_err(|_| "midi listener state lock poisoned".to_string())?;

        if active_listener
            .as_ref()
            .map(|listener| listener.device_name.as_str())
            == normalized_device.as_deref()
        {
            return Ok(());
        }

        if let Some(listener) = active_listener.take() {
            stop_listener(listener);
        }

        if let Some(device_name) = normalized_device {
            let listener = spawn_midi_listener(device_name, audio_sender, app)?;
            *active_listener = Some(listener);
        }

        Ok(())
    }
}

impl Drop for MidiManager {
    fn drop(&mut self) {
        if let Ok(mut active_listener) = self.active_listener.lock() {
            if let Some(listener) = active_listener.take() {
                stop_listener(listener);
            }
        }
    }
}

pub(crate) fn get_midi_input_names() -> Result<Vec<String>, String> {
    let midi_input =
        MidiInput::new("libretracks-midi-inputs").map_err(|error| error.to_string())?;
    let mut device_names = midi_input
        .ports()
        .iter()
        .filter_map(|port| midi_input.port_name(port).ok())
        .collect::<Vec<_>>();
    device_names.sort();
    device_names.dedup();
    Ok(device_names)
}

pub(crate) fn spawn_midi_listener(
    port_name: String,
    audio_sender: Sender<AudioCommand>,
    app: AppHandle,
) -> Result<MidiListenerHandle, String> {
    let should_stop = Arc::new(AtomicBool::new(false));
    let (message_sender, message_receiver) = mpsc::channel();
    let (startup_sender, startup_receiver) = mpsc::channel();

    let listener_stop_flag = should_stop.clone();
    let listener_port_name = port_name.clone();
    let listener_thread = thread::Builder::new()
        .name("libretracks-midi-input".into())
        .spawn(move || {
            run_midi_listener_loop(
                &listener_port_name,
                message_sender,
                startup_sender,
                listener_stop_flag,
                audio_sender,
            );
        })
        .map_err(|error| error.to_string())?;

    match startup_receiver.recv_timeout(MIDI_STARTUP_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err(error);
        }
        Err(RecvTimeoutError::Timeout) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err("timed out while starting MIDI listener".into());
        }
        Err(RecvTimeoutError::Disconnected) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err("MIDI listener exited before startup completed".into());
        }
    }

    let dispatcher_stop_flag = should_stop.clone();
    let dispatcher_thread = thread::Builder::new()
        .name("libretracks-midi-dispatch".into())
        .spawn(move || {
            run_midi_dispatch_loop(app, message_receiver, dispatcher_stop_flag);
        })
        .map_err(|error| error.to_string())?;

    Ok(MidiListenerHandle {
        device_name: port_name,
        should_stop,
        listener_thread,
        dispatcher_thread,
    })
}

fn run_midi_listener_loop(
    port_name: &str,
    message_sender: Sender<MidiMessage>,
    startup_sender: Sender<Result<(), String>>,
    should_stop: Arc<AtomicBool>,
    _audio_sender: Sender<AudioCommand>,
) {
    let midi_input = match MidiInput::new("libretracks-midi-listener") {
        Ok(midi_input) => midi_input,
        Err(error) => {
            let _ = startup_sender.send(Err(error.to_string()));
            return;
        }
    };

    let resolved_port = match resolve_port_by_name(&midi_input, port_name) {
        Ok(port) => port,
        Err(error) => {
            let _ = startup_sender.send(Err(error));
            return;
        }
    };

    let mut midi_input = midi_input;
    midi_input.ignore(Ignore::None);

    let connection = match midi_input.connect(
        &resolved_port,
        "libretracks-midi-callback",
        move |_timestamp, message, _state| {
            if let Some(message) = parse_midi_message(message) {
                let _ = message_sender.send(message);
            }
        },
        (),
    ) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = startup_sender.send(Err(error.to_string()));
            return;
        }
    };

    let _ = startup_sender.send(Ok(()));
    keep_connection_alive(connection, should_stop);
}

fn keep_connection_alive<T>(
    connection: midir::MidiInputConnection<T>,
    should_stop: Arc<AtomicBool>,
) {
    while !should_stop.load(Ordering::Acquire) {
        thread::sleep(MIDI_LOOP_POLL_INTERVAL);
    }
    drop(connection);
}

fn run_midi_dispatch_loop(
    app: AppHandle,
    message_receiver: mpsc::Receiver<MidiMessage>,
    should_stop: Arc<AtomicBool>,
) {
    while !should_stop.load(Ordering::Acquire) {
        match message_receiver.recv_timeout(MIDI_LOOP_POLL_INTERVAL) {
            Ok(message) => {
                if let Err(error) = dispatch_midi_message(&app, message) {
                    eprintln!("[libretracks-midi] failed to dispatch MIDI message: {error}");
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiRawMessagePayload {
    status: u8,
    data1: u8,
    data2: u8,
}

fn dispatch_midi_message(app: &AppHandle, message: MidiMessage) -> Result<(), String> {
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
    let settings = settings_store.current().map_err(|error| error.to_string())?;

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

    let state = app.state::<DesktopState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| "desktop session lock poisoned".to_string())?;

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
                .open_project_from_dialog(&state.audio)
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        "action:save_project" => {
            let snapshot = session
                .save_project()
                .map_err(|error| error.to_string())?;
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
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "immediate".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_global_jump_mode_after_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "after_bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_global_jump_mode_next_marker" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_mode = "next_marker".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_global_jump_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_bars = next_settings.global_jump_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_global_jump_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.global_jump_bars = next_settings.global_jump_bars.saturating_sub(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_immediate" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "immediate".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_after_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "after_bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_jump_trigger_region_end" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_trigger = "region_end".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_song_jump_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_bars = next_settings.song_jump_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_song_jump_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_jump_bars = next_settings.song_jump_bars.saturating_sub(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_transition_instant" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_transition_mode = "instant".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_song_transition_fade_out" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.song_transition_mode = "fade_out".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_vamp_mode_section" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.vamp_mode = "section".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:set_vamp_mode_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.vamp_mode = "bars".into();
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:increase_vamp_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.vamp_bars = next_settings.vamp_bars.saturating_add(1).max(1);
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:decrease_vamp_bars" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
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
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.metronome_enabled = !next_settings.metronome_enabled;
            apply_midi_settings_update(app, settings_store, next_settings)?;
            return Ok(());
        }
        "action:toggle_split_stereo" => {
            let mut next_settings = settings_store.current().map_err(|error| error.to_string())?;
            next_settings.split_stereo_enabled = !next_settings.split_stereo_enabled;
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
                .create_section_marker(position_seconds, &state.audio)
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

    let previous_settings = settings_store.current().map_err(|error| error.to_string())?;
    let mut next_settings = previous_settings.clone();
    let mut changed = false;

    match binding_key {
        "param:metronome_volume" => {
            let next_volume = f64::from(message.data2) / 127.0;
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
                0..=63 => "immediate",
                64..=95 => "after_bars",
                _ => "region_end",
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
            let next_mode = if message.data2 < 64 { "instant" } else { "fade_out" };
            if next_settings.song_transition_mode != next_mode {
                next_settings.song_transition_mode = next_mode.to_string();
                changed = true;
            }
        }
        "param:vamp_mode" => {
            let next_mode = if message.data2 < 64 { "section" } else { "bars" };
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
    let previous_settings = settings_store.current().map_err(|error| error.to_string())?;
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
    audio: &crate::audio_runtime::AudioController,
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

    let jump_trigger = parse_jump_trigger(&settings.song_jump_trigger, Some(settings.song_jump_bars))
        .map_err(|error| error.to_string())?;
    let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
        .map_err(|error| error.to_string())?;

    session
        .schedule_region_jump(
            &next_region.id,
            jump_trigger,
            transition,
            audio,
        )
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

fn parse_midi_message(message: &[u8]) -> Option<MidiMessage> {
    let status = *message.first()?;
    let data1 = *message.get(1)?;
    let data2 = *message.get(2).unwrap_or(&0);

    Some(MidiMessage {
        status,
        data1,
        data2,
    })
}

fn map_cc_to_range(value: u8, min: u32, max: u32) -> u32 {
    if min >= max {
        return min;
    }

    let span = max - min;
    let normalized = f64::from(value) / 127.0;
    min + (normalized * f64::from(span)).round() as u32
}

fn resolve_port_by_name(midi_input: &MidiInput, port_name: &str) -> Result<MidiInputPort, String> {
    midi_input
        .ports()
        .into_iter()
        .find(|port| {
            midi_input
                .port_name(port)
                .map(|name| name == port_name)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("MIDI input device not found: {port_name}"))
}

fn normalize_device_name(device_name: Option<String>) -> Option<String> {
    device_name.and_then(|name| {
        let trimmed = name.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn stop_listener(listener: MidiListenerHandle) {
    listener.should_stop.store(true, Ordering::Release);
    let _ = listener.listener_thread.join();
    let _ = listener.dispatcher_thread.join();
}

#[cfg(test)]
mod tests {
    use super::{map_cc_to_range, parse_midi_message, MidiMessage};

    #[test]
    fn parses_raw_midi_messages() {
        assert_eq!(
            parse_midi_message(&[0x90, 60, 127]),
            Some(MidiMessage {
                status: 0x90,
                data1: 60,
                data2: 127,
            })
        );
        assert_eq!(
            parse_midi_message(&[0xB0, 74]),
            Some(MidiMessage {
                status: 0xB0,
                data1: 74,
                data2: 0,
            })
        );
    }

    #[test]
    fn maps_cc_values_to_useful_ranges() {
        assert_eq!(map_cc_to_range(0, 1, 16), 1);
        assert_eq!(map_cc_to_range(127, 1, 16), 16);
        assert_eq!(map_cc_to_range(64, 1, 16), 9);
    }
}
