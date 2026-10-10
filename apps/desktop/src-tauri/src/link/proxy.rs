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
use tauri::{AppHandle, EventId, Listener, Manager};

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
    dispatch(app, command, args).await.map_err(failed)
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
    next.global_jump_mode = from_guest.global_jump_mode.clone();
    next.global_jump_bars = from_guest.global_jump_bars;
    next.song_jump_trigger = from_guest.song_jump_trigger.clone();
    next.song_jump_bars = from_guest.song_jump_bars;
    next.song_transition_mode = from_guest.song_transition_mode.clone();
    next.vamp_mode = from_guest.vamp_mode.clone();
    next.vamp_bars = from_guest.vamp_bars;
    if role >= Role::Editor {
        next.metronome_enabled = from_guest.metronome_enabled;
        next.metronome_volume = from_guest.metronome_volume;
    }
    next
}

fn save_live_settings(app: &AppHandle, role: Role, args: Value) -> Result<Value, String> {
    let from_guest: AppSettings = arg(&args, "settings")?;
    let current = app
        .state::<AppSettingsStore>()
        .current()
        .map_err(|error| error.to_string())?;
    let merged = merge_live_settings(&current, &from_guest, role);
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
