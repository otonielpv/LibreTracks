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
    fader, feedback_message, FeedbackValue, MidiBinding, MidiTarget, MixControl, MixerTarget,
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
    /// The session's scenes in editor order and those engaged, as the UI
    /// last reported them (plan live-scenes, paso 05).
    scenes: SceneFeedback,
    /// Last message sent per binding key.
    sent: HashMap<String, [u8; 3]>,
}

fn state() -> &'static Mutex<FeedbackState> {
    static STATE: OnceLock<Mutex<FeedbackState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(FeedbackState::default()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneFeedback {
    pub scene_ids: Vec<String>,
    pub active_scene_ids: Vec<String>,
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
    let scenes = feedback.scenes.clone();
    let desired = control().with_mix(|mix| {
        // Switches light LEDs; volume and pan move motor faders and LED
        // rings (paso 09, Mackie Control). Sent on refreshes only, never per
        // fader message, so a motor does not fight the hand moving it.
        let switch_of = |track_id: &str, mix_control: MixControl| {
            let track = mix.tracks.get(track_id);
            Some(match mix_control {
                MixControl::Mute => FeedbackValue::Switch(track.is_some_and(|track| track.muted)),
                MixControl::Solo => FeedbackValue::Switch(track.is_some_and(|track| track.solo)),
                MixControl::Volume => FeedbackValue::Position(track.map_or(0.0, |track| {
                    fader::gain_to_position(track.volume, fader::TRACK_MAX_DB)
                })),
                MixControl::Pan => FeedbackValue::Position(
                    track.map_or(0.5, |track| fader::pan_to_position(track.pan)),
                ),
            })
        };
        desired_feedback(&mappings, &|target| match target {
            MidiTarget::Track { track_id, control } => switch_of(track_id, *control),
            MidiTarget::Strip { strip, control } => {
                match mix.bank.track(&mix.strip_order, *strip) {
                    Some(track_id) => switch_of(track_id, *control),
                    // An empty strip shows off, its fader down.
                    None => Some(match control {
                        MixControl::Mute | MixControl::Solo => FeedbackValue::Switch(false),
                        MixControl::Volume => FeedbackValue::Position(0.0),
                        MixControl::Pan => FeedbackValue::Position(0.5),
                    }),
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
            MidiTarget::Mixer(MixerTarget::SongMaster) => mix.song_master.as_ref().map(|master| {
                FeedbackValue::Position(fader::gain_to_position(master.gain, fader::TRACK_MAX_DB))
            }),
            MidiTarget::Scene { .. } | MidiTarget::SceneSlot(_) => target
                .scene_led(&scenes.scene_ids, &scenes.active_scene_ids)
                .map(FeedbackValue::Switch),
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

/// The UI reports the scenes whenever they or the engaged ones change (from
/// the screen, MIDI, a cue or a song change), so scene LEDs follow.
#[tauri::command]
pub fn midi_controller_scenes(app: AppHandle, scenes: SceneFeedback) {
    {
        let mut feedback = state().lock().unwrap_or_else(|e| e.into_inner());
        if feedback.scenes == scenes {
            return;
        }
        feedback.scenes = scenes;
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

    #[test]
    fn a_scene_led_follows_the_scene_however_it_was_engaged() {
        let mappings = vec![
            ("scene:down:toggle".to_string(), MidiBinding::new(0x90, 20)),
            ("scene_slot:2".to_string(), MidiBinding::new(0x90, 21)),
            ("scene:down:apply".to_string(), MidiBinding::new(0x90, 22)),
        ];
        let led = |scenes: &SceneFeedback| {
            desired_feedback(&mappings, &|target| {
                target
                    .scene_led(&scenes.scene_ids, &scenes.active_scene_ids)
                    .map(FeedbackValue::Switch)
            })
        };
        let mut scenes = SceneFeedback {
            scene_ids: vec!["down".into(), "piano".into()],
            active_scene_ids: vec![],
        };
        assert_eq!(
            led(&scenes),
            vec![
                ("scene:down:toggle".to_string(), [0x90, 20, 0]),
                ("scene_slot:2".to_string(), [0x90, 21, 0]),
            ]
        );
        // Engaged from the screen: the UI reports it, the LEDs light.
        scenes.active_scene_ids = vec!["down".into(), "piano".into()];
        assert_eq!(
            led(&scenes),
            vec![
                ("scene:down:toggle".to_string(), [0x90, 20, 127]),
                ("scene_slot:2".to_string(), [0x90, 21, 127]),
            ]
        );
    }

    #[test]
    fn a_mackie_fader_gets_its_track_position_as_14_bit_pitch_bend() {
        let mappings = vec![("strip:1:volume".to_string(), MidiBinding::new(0xE3, 0))];
        // Unity gain sits at 3/4 of the on-screen fader travel.
        let unity = fader::gain_to_position(1.0, fader::TRACK_MAX_DB);
        let desired = desired_feedback(&mappings, &|_| Some(FeedbackValue::Position(unity)));
        let word = (0.75f64 * 16383.0).round() as u16;
        assert_eq!(
            desired,
            vec![("strip:1:volume".to_string(), [0xE3, (word & 0x7F) as u8, (word >> 7) as u8])]
        );
    }
}
