//! Mirror mode, host side: a guest runs the full LibreTracks UI and its
//! desktop commands arrive here as `LinkCommand::Invoke` (plan
//! network-sessions, «app completa en espejo», 2026-10-10).
//!
//! What may run and with which role is decided by the table in
//! scripts/link-commands.json; `proxy_dispatch.rs` is generated from it and
//! calls the real Tauri command functions, so a guest's edit is exactly the
//! host's own edit (same undo, same persistence, same events).
//!
//! The app events the host's UI listens to are relayed to the guests the
//! same way (`EVENTS_TO_RELAY`), so their UI follows along.

use std::fmt::Display;

use libretracks_link::{
    server::{CommandFailure, CommandReply},
    CommandRejection, Grants, HostHandle, Role,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventId, Listener, Manager};

use super::proxy_dispatch::{access, dispatch, ProxyAccess, EVENTS_TO_RELAY};
use crate::infra::settings::{AppSettings, AppSettingsStore};

/// Deserialize one command argument; the type comes from the command's own
/// parameter. A missing key reads as null, so `Option` parameters work.
pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("argument {key}: {error}"))
}

pub fn into_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

pub fn into_value_result<T: Serialize, E: Display>(result: Result<T, E>) -> Result<Value, String> {
    match result {
        Ok(value) => into_value(value),
        Err(error) => Err(error.to_string()),
    }
}

pub fn role_allows(role: Role, access: ProxyAccess) -> bool {
    match access {
        ProxyAccess::View => true,
        ProxyAccess::Control | ProxyAccess::Custom => role >= Role::Controller,
        ProxyAccess::Edit => role >= Role::Editor,
    }
}

fn failed(message: String) -> CommandFailure {
    CommandFailure {
        reason: CommandRejection::Failed,
        message: Some(message),
    }
}

/// Run a guest's `invoke` on the host.
pub async fn handle_invoke(
    app: &AppHandle,
    grants: Grants,
    command: &str,
    args: Value,
) -> CommandReply {
    // Bench (plan song-patches/01): the host's own timings, for any guest.
    if command == "get_link_perf" {
        return Ok(serde_json::json!({
            "feed": crate::session_feed::feed_perf(),
            "invokes": super::host::invoke_perf(),
        }));
    }
    let Some(access) = access(command) else {
        return Err(CommandRejection::NotAvailable.into());
    };
    if !role_allows(grants.role, access) {
        return Err(CommandRejection::Forbidden.into());
    }
    if access == ProxyAccess::Custom {
        return match command {
            "save_settings" => save_live_settings(app, grants.role, args).map_err(failed),
            _ => Err(CommandRejection::NotAvailable.into()),
        };
    }
    if let Some(feature) = RealtimeSettings::for_command(command) {
        let current = app
            .state::<AppSettingsStore>()
            .current()
            .map_err(|error| failed(error.to_string()))?;
        let merged = feature.merge(&current, &args).map_err(failed)?;
        let result = dispatch(app, command, serde_json::json!({ "settings": merged }))
            .await
            .map_err(failed)?;
        // These realtime handlers persist settings but do not emit this event.
        if merged != current {
            app.emit("settings:updated", &merged)
                .map_err(|error| failed(error.to_string()))?;
        }
        return Ok(result);
    }
    dispatch(app, command, args).await.map_err(failed)
}

#[derive(Clone, Copy)]
enum RealtimeSettings {
    Metronome,
    VoiceGuide,
    Pad,
}

impl RealtimeSettings {
    fn for_command(command: &str) -> Option<Self> {
        match command {
            "set_metronome_sound_realtime" => Some(Self::Metronome),
            "set_voice_guide_config_realtime" => Some(Self::VoiceGuide),
            "set_pad_config_realtime" | "load_pad_key" => Some(Self::Pad),
            _ => None,
        }
    }

    fn merge(self, current: &AppSettings, args: &Value) -> Result<AppSettings, String> {
        let guest = settings_argument(current, args)?;
        let mut next = current.clone();
        macro_rules! copy_fields {
            ($($field:ident),+ $(,)?) => {{
                $(next.$field = guest.$field.clone();)+
            }};
        }
        // Feature routing is hardware configuration: always keep the host's.
        match self {
            Self::Metronome => copy_fields!(
                metronome_enabled,
                metronome_volume,
                metronome_accent_enabled,
                metronome_accent_preset,
                metronome_beat_preset,
                metronome_accent_pitch,
                metronome_beat_pitch,
                metronome_subdivision,
                metronome_subdivision_preset,
                metronome_subdivision_pitch,
                metronome_subdivision_gain,
            ),
            Self::VoiceGuide => copy_fields!(
                voice_guide_enabled,
                voice_guide_volume,
                voice_guide_lead_bars,
                voice_guide_count_in_enabled,
                voice_guide_count_style,
                voice_guide_language,
            ),
            Self::Pad => copy_fields!(
                pad_enabled,
                pad_id,
                pad_key,
                pad_volume,
                pad_fade_in_seconds,
                pad_fade_out_seconds,
                pad_follow_song_key,
                pad_stop_with_transport,
            ),
        }
        Ok(next)
    }
}

fn settings_argument(current: &AppSettings, args: &Value) -> Result<AppSettings, String> {
    let fields = args
        .as_object()
        .and_then(|args| args.get("settings"))
        .and_then(Value::as_object)
        .ok_or("argument settings: expected a settings object")?;
    // A guest may send only changed fields. Missing fields are not defaults.
    let mut settings = into_value(current)?;
    settings.as_object_mut().unwrap().extend(fields.clone());
    serde_json::from_value(settings).map_err(|error| format!("argument settings: {error}"))
}

/// The fields of the app settings a guest may change on the host: what the
/// live view and the transport bar change while playing. Everything else in
/// the guest's copy (audio device, MIDI, folders, …) is ignored, so a guest
/// can never reconfigure the host's machine.
pub fn merge_live_settings(
    current: &AppSettings,
    from_guest: &AppSettings,
    role: Role,
) -> AppSettings {
    let mut next = current.clone();
    if role < Role::Controller {
        return next;
    }
    next.global_jump_mode = from_guest.global_jump_mode.clone();
    next.global_jump_bars = from_guest.global_jump_bars;
    next.song_jump_trigger = from_guest.song_jump_trigger.clone();
    next.song_jump_bars = from_guest.song_jump_bars;
    next.song_transition_mode = from_guest.song_transition_mode.clone();
    next.vamp_mode = from_guest.vamp_mode.clone();
    next.vamp_bars = from_guest.vamp_bars;
    next.pause_at_song_end = from_guest.pause_at_song_end;
    next.vamp_between_songs = from_guest.vamp_between_songs;
    next.fade_out_stop_seconds = from_guest.fade_out_stop_seconds;
    if role >= Role::Editor {
        next.metronome_enabled = from_guest.metronome_enabled;
        next.metronome_volume = from_guest.metronome_volume;
        next.track_meter_mode = from_guest.track_meter_mode;
    }
    next
}

fn save_live_settings(app: &AppHandle, role: Role, args: Value) -> Result<Value, String> {
    let current = app
        .state::<AppSettingsStore>()
        .current()
        .map_err(|error| error.to_string())?;
    let from_guest = settings_argument(&current, &args)?;
    let merged = merge_live_settings(&current, &from_guest, role);
    // This helper diffs engine settings and applies mixer-only changes without
    // rebuilding the stream; save_settings alone would leave the engine stale.
    let merged = crate::commands::settings::update_audio_settings(
        app.clone(),
        merged,
        app.state::<AppSettingsStore>(),
        app.state::<crate::state::DesktopState>(),
    )?;
    let saved = crate::commands::settings::save_settings(
        app.clone(),
        merged,
        app.state::<AppSettingsStore>(),
    )?;
    into_value(saved)
}

/// Start relaying the host's session events to `handle`'s guests. Returns
/// the listener ids so hosting can stop relaying.
pub fn relay_events(app: &AppHandle, handle: &HostHandle) -> Vec<EventId> {
    EVENTS_TO_RELAY
        .iter()
        .map(|name| {
            let handle = handle.clone();
            let event_name = (*name).to_string();
            app.listen_any(*name, move |event| {
                let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
                handle.publish_event(&event_name, &payload);
            })
        })
        .collect()
}

pub fn stop_relaying(app: &AppHandle, ids: Vec<EventId>) {
    for id in ids {
        app.unlisten(id);
    }
}

#[cfg(test)]
mod tests {
    use super::super::proxy_dispatch::PROXIED_COMMANDS;
    use super::*;

    #[test]
    fn roles_get_what_the_table_says() {
        assert!(role_allows(Role::Viewer, ProxyAccess::View));
        assert!(!role_allows(Role::Viewer, ProxyAccess::Control));
        assert!(role_allows(Role::Controller, ProxyAccess::Control));
        assert!(!role_allows(Role::Controller, ProxyAccess::Edit));
        assert!(role_allows(Role::Editor, ProxyAccess::Edit));
        assert!(!role_allows(Role::Viewer, ProxyAccess::Custom));
        assert!(role_allows(Role::Controller, ProxyAccess::Custom));
        assert!(role_allows(Role::Editor, ProxyAccess::Custom));
    }

    #[test]
    fn the_table_classifies_the_obvious_cases() {
        assert_eq!(access("get_song_view"), Some(ProxyAccess::View));
        assert_eq!(access("play_transport"), Some(ProxyAccess::Control));
        assert_eq!(access("move_clip"), Some(ProxyAccess::Edit));
        assert_eq!(access("save_settings"), Some(ProxyAccess::Custom));
        // Local to the guest, or needing the host's files: never run here.
        assert_eq!(access("get_audio_output_devices"), None);
        assert_eq!(access("import_audio_files_from_paths"), None);
        assert_eq!(access("save_project"), None);
        assert_eq!(access("whatever"), None);
    }

    #[test]
    fn every_dispatched_command_has_a_role() {
        for command in PROXIED_COMMANDS {
            assert!(access(command).is_some(), "{command}");
        }
    }

    #[test]
    fn a_guest_never_changes_the_hosts_devices() {
        let current = AppSettings::default();
        let mut from_guest = AppSettings::default();
        from_guest.global_jump_mode = "next_marker".into();
        from_guest.vamp_bars = 8;
        from_guest.metronome_enabled = !current.metronome_enabled;
        from_guest.selected_output_device = Some("Altavoces del invitado".into());
        let merged = merge_live_settings(&current, &from_guest, Role::Controller);
        assert_eq!(merged.global_jump_mode, "next_marker");
        assert_eq!(merged.vamp_bars, 8);
        assert_eq!(
            merged.selected_output_device,
            current.selected_output_device
        );
        // The metronome is mix: editor only.
        assert_eq!(merged.metronome_enabled, current.metronome_enabled);
        let as_editor = merge_live_settings(&current, &from_guest, Role::Editor);
        assert_eq!(as_editor.metronome_enabled, from_guest.metronome_enabled);
    }

    fn host_settings() -> AppSettings {
        let mut host = AppSettings::default();
        host.selected_output_device = Some("Host interface".into());
        host.selected_midi_device = Some("Host pedal".into());
        host.selected_midi_output_device = Some("Host lights".into());
        host.enabled_output_channels = vec![0, 1, 2, 3];
        host.metronome_output = "3".into();
        host.voice_guide_output = "4".into();
        host.pad_output = "1/2".into();
        host.library_places = vec!["host-library".into()];
        host.locale = Some("es".into());
        host.global_jump_bars = 7;
        host.metronome_volume = 0.37;
        host.voice_guide_volume = 0.42;
        host.pad_volume = 0.53;
        host
    }

    fn assert_feature_scope(command: &str, changes: Value) {
        let host = host_settings();
        // A stale full guest snapshot has different routing, devices, folders,
        // playback options and other features, not just the edited feature.
        let mut guest = serde_json::to_value(AppSettings::default()).unwrap();
        guest
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        let mut expected = serde_json::to_value(&host).unwrap();
        expected
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        let merged = RealtimeSettings::for_command(command)
            .unwrap()
            .merge(&host, &serde_json::json!({ "settings": guest }))
            .unwrap();
        assert_eq!(serde_json::to_value(merged).unwrap(), expected);
        assert_eq!(access(command), Some(ProxyAccess::Edit));
        for role in [Role::Viewer, Role::Controller, Role::Editor] {
            assert_eq!(
                role_allows(role, access(command).unwrap()),
                role >= Role::Editor
            );
        }
    }

    #[test]
    fn metronome_settings_only_apply_the_metronome_feature() {
        assert_feature_scope(
            "set_metronome_sound_realtime",
            serde_json::json!({
                "metronomeEnabled": true,
                "metronomeVolume": 0.8,
                "metronomeAccentEnabled": false,
                "metronomeAccentPreset": 2,
                "metronomeBeatPreset": 3,
                "metronomeAccentPitch": 1.25,
                "metronomeBeatPitch": 0.75,
                "metronomeSubdivision": 2,
                "metronomeSubdivisionPreset": 4,
                "metronomeSubdivisionPitch": 1.5,
                "metronomeSubdivisionGain": 0.5
            }),
        );
    }

    #[test]
    fn voice_guide_settings_only_apply_the_voice_guide_feature() {
        assert_feature_scope(
            "set_voice_guide_config_realtime",
            serde_json::json!({
                "voiceGuideEnabled": true,
                "voiceGuideVolume": 0.8,
                "voiceGuideLeadBars": 3,
                "voiceGuideCountInEnabled": false,
                "voiceGuideCountStyle": "halfTime",
                "voiceGuideLanguage": "en"
            }),
        );
    }

    #[test]
    fn pad_settings_only_apply_the_pad_feature() {
        for command in ["set_pad_config_realtime", "load_pad_key"] {
            assert_feature_scope(
                command,
                serde_json::json!({
                    "padEnabled": true,
                    "padId": "ambient",
                    "padKey": 5,
                    "padVolume": 0.8,
                    "padFadeInSeconds": 2.5,
                    "padFadeOutSeconds": 4.5,
                    "padFollowSongKey": true,
                    "padStopWithTransport": true
                }),
            );
        }
    }

    #[test]
    fn partial_settings_preserve_omitted_feature_and_playback_fields() {
        let host = host_settings();
        let args = serde_json::json!({ "settings": { "padKey": 8 } });
        let mut expected = host.clone();
        expected.pad_key = 8;
        assert_eq!(RealtimeSettings::Pad.merge(&host, &args).unwrap(), expected);
        let args = serde_json::json!({ "settings": { "pauseAtSongEnd": !host.pause_at_song_end } });
        let guest = settings_argument(&host, &args).unwrap();
        let mut expected = host.clone();
        expected.pause_at_song_end = !host.pause_at_song_end;
        assert_eq!(
            merge_live_settings(&host, &guest, Role::Controller),
            expected
        );
        assert_eq!(merge_live_settings(&host, &guest, Role::Viewer), host);
    }

    #[test]
    fn malformed_settings_arguments_are_rejected() {
        for feature in [
            RealtimeSettings::Metronome,
            RealtimeSettings::VoiceGuide,
            RealtimeSettings::Pad,
        ] {
            for args in [
                Value::Null,
                serde_json::json!([]),
                serde_json::json!({}),
                serde_json::json!({ "settings": null }),
                serde_json::json!({ "settings": [] }),
                serde_json::json!({ "settings": "invalid" }),
                serde_json::json!({ "settings": { "padKey": "invalid" } }),
            ] {
                assert!(feature.merge(&host_settings(), &args).is_err(), "{args}");
            }
        }
    }

    #[test]
    fn live_settings_respect_roles_and_preserve_unrelated_host_settings() {
        let host = host_settings();
        let mut guest = AppSettings::default();
        guest.global_jump_mode = "next_marker".into();
        guest.global_jump_bars = 3;
        guest.song_jump_trigger = "bar".into();
        guest.song_jump_bars = 4;
        guest.song_transition_mode = "crossfade".into();
        guest.vamp_mode = "bars".into();
        guest.vamp_bars = 8;
        guest.pause_at_song_end = !host.pause_at_song_end;
        guest.vamp_between_songs = !host.vamp_between_songs;
        guest.fade_out_stop_seconds = 9.0;
        guest.metronome_enabled = !host.metronome_enabled;
        guest.metronome_volume = 0.9;
        guest.track_meter_mode = lt_audio_engine_v2::TrackMeterMode::PreFader;
        assert_eq!(merge_live_settings(&host, &guest, Role::Viewer), host);
        let mut expected = host.clone();
        expected.global_jump_mode = guest.global_jump_mode.clone();
        expected.global_jump_bars = guest.global_jump_bars;
        expected.song_jump_trigger = guest.song_jump_trigger.clone();
        expected.song_jump_bars = guest.song_jump_bars;
        expected.song_transition_mode = guest.song_transition_mode.clone();
        expected.vamp_mode = guest.vamp_mode.clone();
        expected.vamp_bars = guest.vamp_bars;
        expected.pause_at_song_end = guest.pause_at_song_end;
        expected.vamp_between_songs = guest.vamp_between_songs;
        expected.fade_out_stop_seconds = guest.fade_out_stop_seconds;
        assert_eq!(
            merge_live_settings(&host, &guest, Role::Controller),
            expected
        );
        expected.metronome_enabled = guest.metronome_enabled;
        expected.metronome_volume = guest.metronome_volume;
        expected.track_meter_mode = guest.track_meter_mode;
        assert_eq!(merge_live_settings(&host, &guest, Role::Editor), expected);
    }

    #[test]
    fn live_engine_playback_changes_never_reopen_the_device() {
        let host = host_settings();
        for field in ["pauseAtSongEnd", "vampBetweenSongs", "fadeOutStopSeconds"] {
            let mut guest = host.clone();
            match field {
                "pauseAtSongEnd" => guest.pause_at_song_end = !host.pause_at_song_end,
                "vampBetweenSongs" => guest.vamp_between_songs = !host.vamp_between_songs,
                _ => guest.fade_out_stop_seconds = host.fade_out_stop_seconds + 1.0,
            }
            let merged = merge_live_settings(&host, &guest, Role::Controller);
            let plan = crate::state::plan_audio_settings_change(&host, &merged);
            assert!(!plan.rebuild_stream, "{field}");
            // Fade duration is read from the engine's settings snapshot, which
            // update_audio_settings replaces even when no mixer command is due.
            assert_eq!(plan.apply, field != "fadeOutStopSeconds", "{field}");
            assert_ne!(merged, host);
        }
        let mut guest = host.clone();
        guest.track_meter_mode = lt_audio_engine_v2::TrackMeterMode::PreFader;
        let merged = merge_live_settings(&host, &guest, Role::Editor);
        let plan = crate::state::plan_audio_settings_change(&host, &merged);
        assert!(plan.apply);
        assert!(!plan.rebuild_stream);
        assert_eq!(merge_live_settings(&host, &guest, Role::Controller), host);
    }

    #[test]
    fn missing_arguments_read_as_null() {
        let args = serde_json::json!({ "clipId": "c1" });
        let id: String = arg(&args, "clipId").unwrap();
        assert_eq!(id, "c1");
        let none: Option<f64> = arg(&args, "absent").unwrap();
        assert_eq!(none, None);
        assert!(arg::<f64>(&args, "absent").is_err());
    }
}
