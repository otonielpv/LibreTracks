//! Controller feedback (plan midi-controllers, paso 06, D10).
//!
//! Without LEDs a button's light drifts from the app as soon as something
//! changes on screen. [`refresh`] works out what every bound control should
//! show (mute/solo of its track or strip, play, pause, vamp, click, guide,
//! pads) and sends only what changed since the last call, to the port chosen
//! in `midi_controller_output`. It runs on every change that can move an LED:
//! a UI sync, a control press, a bank change and the transport state the UI
//! reports. A new port or a cleared map resends everything.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use libretracks_core::midi_control::{
    feedback_message, FeedbackValue, MidiBinding, MidiTarget, MixControl,
};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::{control::control, message::OutboundMidiMessage};
use crate::{infra::settings::AppSettingsStore, state::DesktopState};

/// What the UI knows about the transport that Rust's MIDI side does not
/// track by itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportFeedback {
    pub playing: bool,
    pub paused: bool,
    pub vamp_active: bool,
}

#[derive(Default)]
struct FeedbackState {
    port: Option<String>,
    transport: TransportFeedback,
    /// Last message sent per binding key.
    sent: HashMap<String, [u8; 3]>,
}

fn state() -> &'static Mutex<FeedbackState> {
    static STATE: OnceLock<Mutex<FeedbackState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(FeedbackState::default()))
}

/// What each binding's control should show now. Pure over its inputs so the
/// desktop tests can drive it without an app.
pub(crate) fn desired_feedback(
    mappings: &[(String, MidiBinding)],
    switches: &dyn Fn(&MidiTarget) -> Option<FeedbackValue>,
) -> Vec<(String, [u8; 3])> {
    mappings
        .iter()
        .filter_map(|(key, binding)| {
            let target = MidiTarget::parse(key)?;
            let value = switches(&target)?;
            Some((key.clone(), feedback_message(binding, value)?))
        })
        .collect()
}

/// Send what changed. Cheap when nothing did: one pass over the bindings.
pub(crate) fn refresh(app: &AppHandle) {
    let store = app.state::<AppSettingsStore>();
    let Ok(((mappings, port, toggles), _)) = store.read(|settings| {
        (
            settings
                .midi_mappings
                .iter()
                .map(|(key, binding)| (key.clone(), binding.clone().migrated()))
                .collect::<Vec<_>>(),
            settings.midi_controller_output.clone(),
            (
                settings.metronome_enabled,
                settings.voice_guide_enabled,
                settings.pad_enabled,
            ),
        )
    }) else {
        return;
    };
    let Some(port) = port else {
        return;
    };

    let mut feedback = state().lock().unwrap_or_else(|e| e.into_inner());
    if feedback.port.as_deref() != Some(port.as_str()) {
        feedback.port = Some(port.clone());
        feedback.sent.clear();
    }
    let transport = feedback.transport;
    let desired = control().with_mix(|mix| {
        let switch_of = |track_id: &str, mix_control: MixControl| {
            let track = mix.tracks.get(track_id);
            let on = match mix_control {
                MixControl::Mute => track.is_some_and(|track| track.muted),
                MixControl::Solo => track.is_some_and(|track| track.solo),
                // Motor faders are paso 09 (Mackie Control).
                MixControl::Volume | MixControl::Pan => return None,
            };
            Some(FeedbackValue::Switch(on))
        };
        desired_feedback(&mappings, &|target| match target {
            MidiTarget::Track { track_id, control } => switch_of(track_id, *control),
            MidiTarget::Strip { strip, control } => {
                match mix.bank.track(&mix.strip_order, *strip) {
                    Some(track_id) => switch_of(track_id, *control),
                    // An empty strip shows off.
                    None => control.is_switch().then_some(FeedbackValue::Switch(false)),
                }
            }
            MidiTarget::Action(name) => {
                let on = match name.as_str() {
                    "play" => transport.playing,
                    "pause" => transport.paused,
                    "toggle_vamp" => transport.vamp_active,
                    "toggle_metronome" => toggles.0,
                    "toggle_voice_guide" => toggles.1,
                    "toggle_pads" => toggles.2,
                    _ => return None,
                };
                Some(FeedbackValue::Switch(on))
            }
            _ => None,
        })
    });

    let mut messages = Vec::new();
    for (key, bytes) in desired {
        if feedback.sent.get(&key) != Some(&bytes) {
            messages.push(OutboundMidiMessage {
                status: bytes[0],
                data1: bytes[1],
                data2: bytes[2],
                two_bytes: false,
            });
            feedback.sent.insert(key, bytes);
        }
    }
    drop(feedback);
    if !messages.is_empty() {
        app.state::<DesktopState>()
            .midi_output
            .send_to(Some(&port), &messages);
    }
}

/// The UI reports the transport state whenever it changes, and asks for a
/// refresh when the settings that light buttons change.
#[tauri::command]
pub fn midi_controller_transport(app: AppHandle, transport: TransportFeedback) {
    {
        let mut feedback = state().lock().unwrap_or_else(|e| e.into_inner());
        feedback.transport = transport;
    }
    refresh(&app);
}

/// Forget what was sent, so the next refresh lights every control again
/// (a controller that was just plugged in, or a "resend" button).
#[tauri::command]
pub fn midi_controller_resend_feedback(app: AppHandle) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .sent
        .clear();
    refresh(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bound_controls_that_can_show_the_value_get_a_message() {
        let mappings = vec![
            ("track:a:mute".to_string(), MidiBinding::new(0x90, 16)),
            ("track:a:volume".to_string(), MidiBinding::new(0xB0, 0)),
            ("action:play".to_string(), MidiBinding::new(0xB0, 41)),
            ("action:jump_song_2".to_string(), MidiBinding::new(0x90, 1)),
        ];
        let desired = desired_feedback(&mappings, &|target| match target {
            MidiTarget::Track { control: MixControl::Mute, .. } => {
                Some(FeedbackValue::Switch(true))
            }
            MidiTarget::Action(name) if name == "play" => Some(FeedbackValue::Switch(false)),
            _ => None,
        });
        assert_eq!(
            desired,
            vec![
                ("track:a:mute".to_string(), [0x90, 16, 127]),
                ("action:play".to_string(), [0xB0, 41, 0]),
            ]
        );
    }
}
