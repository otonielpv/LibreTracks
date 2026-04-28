use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use libretracks_audio::{JumpTrigger, PlaybackState, TransitionType, VampMode};
use midir::{Ignore, MidiInput, MidiInputPort};
use tauri::{AppHandle, Manager};

use crate::{
    audio_runtime::AudioCommand, commands::events::emit_transport_lifecycle_event,
    state::DesktopState,
};

const MIDI_LOOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MIDI_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MidiTransportAction {
    Play,
    Stop,
    ToggleVamp,
    NextSong,
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
    let (action_sender, action_receiver) = mpsc::channel();
    let (startup_sender, startup_receiver) = mpsc::channel();

    let listener_stop_flag = should_stop.clone();
    let listener_port_name = port_name.clone();
    let listener_thread = thread::Builder::new()
        .name("libretracks-midi-input".into())
        .spawn(move || {
            run_midi_listener_loop(
                &listener_port_name,
                action_sender,
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
            run_midi_dispatch_loop(app, action_receiver, dispatcher_stop_flag);
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
    action_sender: Sender<MidiTransportAction>,
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
            if let Some(action) = map_midi_message(message) {
                let _ = action_sender.send(action);
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
    action_receiver: mpsc::Receiver<MidiTransportAction>,
    should_stop: Arc<AtomicBool>,
) {
    while !should_stop.load(Ordering::Acquire) {
        match action_receiver.recv_timeout(MIDI_LOOP_POLL_INTERVAL) {
            Ok(action) => {
                if let Err(error) = dispatch_midi_action(&app, action) {
                    eprintln!("[libretracks-midi] failed to dispatch MIDI action: {error}");
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn dispatch_midi_action(app: &AppHandle, action: MidiTransportAction) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| "desktop session lock poisoned".to_string())?;

    let snapshot = match action {
        MidiTransportAction::Play => {
            if session.engine.playback_state() == PlaybackState::Playing {
                return Ok(());
            }
            let snapshot = session
                .play(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "play", &snapshot);
            snapshot
        }
        MidiTransportAction::Stop => {
            if session.engine.playback_state() == PlaybackState::Empty {
                return Ok(());
            }
            let snapshot = session
                .stop(&state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "stop", &snapshot);
            snapshot
        }
        MidiTransportAction::ToggleVamp => {
            let snapshot = session
                .toggle_vamp(VampMode::Section, &state.audio)
                .map_err(|error| error.to_string())?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
        MidiTransportAction::NextSong => {
            let snapshot = jump_to_next_region(&mut session, &state.audio)?;
            emit_transport_lifecycle_event(app, "sync", &snapshot);
            snapshot
        }
    };

    let _ = snapshot;
    Ok(())
}

fn jump_to_next_region(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio_runtime::AudioController,
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

    session
        .schedule_region_jump(
            &next_region.id,
            JumpTrigger::Immediate,
            TransitionType::Instant,
            audio,
        )
        .map_err(|error| error.to_string())
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

fn map_midi_message(message: &[u8]) -> Option<MidiTransportAction> {
    let status = *message.first()?;
    let event_kind = status & 0xF0;

    match event_kind {
        0x90 => {
            let note = *message.get(1)?;
            let velocity = *message.get(2).unwrap_or(&0);
            (velocity > 0).then(|| map_note_number(note)).flatten()
        }
        0xB0 => {
            let controller = *message.get(1)?;
            let value = *message.get(2).unwrap_or(&0);
            (value > 0).then(|| map_note_number(controller)).flatten()
        }
        _ => None,
    }
}

fn map_note_number(note: u8) -> Option<MidiTransportAction> {
    match note {
        60 => Some(MidiTransportAction::Play),
        61 => Some(MidiTransportAction::Stop),
        62 => Some(MidiTransportAction::ToggleVamp),
        63 => Some(MidiTransportAction::NextSong),
        _ => None,
    }
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
    use super::{map_midi_message, MidiTransportAction};

    #[test]
    fn maps_note_on_messages_to_transport_actions() {
        assert_eq!(
            map_midi_message(&[0x90, 60, 127]),
            Some(MidiTransportAction::Play)
        );
        assert_eq!(
            map_midi_message(&[0x90, 61, 127]),
            Some(MidiTransportAction::Stop)
        );
        assert_eq!(
            map_midi_message(&[0x90, 62, 127]),
            Some(MidiTransportAction::ToggleVamp)
        );
        assert_eq!(
            map_midi_message(&[0x90, 63, 127]),
            Some(MidiTransportAction::NextSong)
        );
    }

    #[test]
    fn ignores_note_on_with_zero_velocity_and_unknown_messages() {
        assert_eq!(map_midi_message(&[0x90, 60, 0]), None);
        assert_eq!(map_midi_message(&[0x80, 60, 127]), None);
        assert_eq!(map_midi_message(&[0x90, 72, 127]), None);
    }

    #[test]
    fn maps_control_change_messages_to_transport_actions() {
        assert_eq!(
            map_midi_message(&[0xB0, 60, 1]),
            Some(MidiTransportAction::Play)
        );
        assert_eq!(
            map_midi_message(&[0xB0, 63, 127]),
            Some(MidiTransportAction::NextSong)
        );
    }
}
