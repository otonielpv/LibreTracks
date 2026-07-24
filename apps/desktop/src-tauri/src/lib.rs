//! LibreTracks application library.
//!
//! Desktop builds run this through src/main.rs; Android/iOS load it as a
//! shared library through `mobile_entry_point`. On Android the remote-control
//! server and MIDI input are excluded (see the `remote` / `midi` module
//! splits); the C++ audio engine runs for real through the Oboe/AAudio backend.

mod audio;
mod commands;
mod external_project;
mod infra;
mod models;
mod platform;
mod state;

#[cfg(not(target_os = "android"))]
mod midi;
#[cfg(target_os = "android")]
#[path = "midi/android.rs"]
mod midi;

#[cfg(not(target_os = "android"))]
mod remote;
#[cfg(target_os = "android")]
#[path = "remote/android.rs"]
mod remote;

use tauri::Manager;

use infra::settings::{load_app_settings, AppSettingsStore};
use state::DesktopState;

use commands::engine_v2::EngineV2State;

/// Resolve the directory where the C++ engine's `lt_audio_debug.log` should
/// live in a packaged build: `%LOCALAPPDATA%\LibreTracks` on Windows (where the
/// other diagnostic logs already go), falling back to Tauri's local/roaming app
/// data dir. Mirrors `commands::system::append_debug_log`'s resolution so all
/// logs land in the same folder.
fn resolve_engine_log_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Some(std::path::PathBuf::from(local).join("LibreTracks"));
        }
    }
    app.path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the error-log panic hook before anything else so panics during
    // plugin init / setup are captured too. Until infra::error_log::init runs (in
    // setup, once app_data_dir resolves) this is a no-op beyond the default
    // hook's stderr output.
    infra::error_log::install_panic_hook();

    // Mitigate the WebKitGTK white-screen bug on Linux (blank window on NVIDIA /
    // immutable distros like Bazzite) before the webview is created. No-op on
    // other platforms. See platform::linux_webkit for the rationale and the
    // user opt-out.
    platform::linux_webkit::apply_webkit_workarounds();

    // Keep the env flag visible for diagnostics; desktop audio now routes
    // through the C++ engine v2 path by default.
    let _engine_v2_requested = std::env::var("LIBRETRACKS_AUDIO_ENGINE")
        .map(|v| v == "cpp-v2")
        .unwrap_or(false);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState::default());

    let builder = builder.manage(EngineV2State::new());

    builder
        .setup(|app| {
            // Resolve the error-log directory now that app_data_dir is
            // available; degrade gracefully (no logging) if it can't resolve
            // rather than aborting startup.
            if let Ok(app_data_dir) = app.handle().path().app_data_dir() {
                infra::error_log::init(app_data_dir);
            }

            // Point the C++ engine's debug/diagnostic log at a KNOWN, writable
            // path before the engine is first used. Without this, a packaged
            // release falls back to "lt_audio_debug.log" relative to the process
            // CWD (unpredictable, often Program Files / not writable), so the
            // [LT_STARVATION] and other diagnostics couldn't be found in release.
            // Only set it when unset, so the dev scripts' override still wins.
            if std::env::var_os("LIBRETRACKS_AUDIO_DEBUG_LOG").is_none() {
                if let Some(log_dir) = resolve_engine_log_dir(&app.handle()) {
                    let _ = std::fs::create_dir_all(&log_dir);
                    std::env::set_var(
                        "LIBRETRACKS_AUDIO_DEBUG_LOG",
                        log_dir.join("lt_audio_debug.log"),
                    );
                }
            }

            // Android field diagnostics: there's no shell environment to set
            // LIBRETRACKS_AUDIO_DIAG on a phone, and we're actively tuning
            // playback on low-end devices. ~2 log lines/second while playing.
            // TODO: gate behind a Settings toggle once Android playback is
            // considered stable.
            #[cfg(target_os = "android")]
            if std::env::var_os("LIBRETRACKS_AUDIO_DIAG").is_none() {
                std::env::set_var("LIBRETRACKS_AUDIO_DIAG", "1");
            }

            let initial_settings = load_app_settings(&app.handle()).unwrap_or_else(|error| {
                eprintln!("[libretracks-settings] failed to load settings: {error}");
                infra::settings::AppSettings::default()
            });

            app.manage(AppSettingsStore::new(initial_settings.clone()));

            // Apply the decoding-cache preferences to the process env BEFORE the
            // audio engine is first used, so the configured folder / size cap
            // take effect for the very first decode.
            infra::settings::apply_decoding_cache_env(&app.handle(), &initial_settings);

            let state = app.state::<DesktopState>();
            state.audio.attach_app_handle(app.handle().clone());
            let initial_device = initial_settings.selected_output_device_id.clone();
            let apply_result = state.audio.apply_settings(initial_settings);
            // Desktop: a failure to apply the initial audio settings is fatal.
            // Android: the engine is a no-op stub for now, so tolerate errors
            // and let the app boot without audio instead of aborting startup.
            #[cfg(not(target_os = "android"))]
            apply_result.map_err(|error| std::io::Error::other(error.to_string()))?;
            #[cfg(target_os = "android")]
            if let Err(error) = apply_result {
                eprintln!("[libretracks-audio] android: initial audio settings not applied: {error}");
            }
            // If apply_settings nulled out the saved output device (because
            // the device couldn't be opened — see apply_settings_with_stream_rebuild
            // in audio/engine.rs), persist the cleaned-up settings to disk so
            // the next launch doesn't hit the same failure and we don't keep
            // showing a stale device name to the user.
            if let Ok(after) = state.audio.current_settings() {
                if initial_device.is_some() && after.selected_output_device_id.is_none() {
                    if let Err(e) = infra::settings::save_app_settings(&app.handle(), &after) {
                        if audio::engine::audio_debug_logging_enabled() {
                            eprintln!(
                                "[libretracks-settings] could not persist cleaned-up \
                                 audio settings after fallback to default device: {e}"
                            );
                        }
                    }
                    // Also update the in-memory AppSettingsStore so commands
                    // that read it (e.g. get_settings) reflect the fallback.
                    let store = app.state::<AppSettingsStore>();
                    let _ = store.set(after);
                }
            }
            state
                .midi
                .restart(
                    app.handle().clone(),
                    state.audio.command_sender(),
                    state
                        .audio
                        .current_settings()
                        .ok()
                        .and_then(|settings| settings.selected_midi_device),
                )
                .unwrap_or_else(|error| {
                    if audio::engine::audio_debug_logging_enabled() {
                        eprintln!("[libretracks-midi] startup warning: {error}");
                    }
                });
            remote::initialize_remote(app)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::healthcheck,
            commands::system::is_debug_build,
            commands::system::get_remote_server_info,
            commands::system::get_midi_inputs,
            commands::transport::get_transport_snapshot,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::update_audio_settings,
            commands::settings::set_metronome_enabled_realtime,
            commands::settings::set_metronome_volume_realtime,
            commands::settings::set_metronome_sound_realtime,
            commands::settings::set_voice_guide_config_realtime,
            commands::pads::get_pads_catalog,
            commands::pads::download_pad,
            commands::pads::delete_pad,
            commands::pads::set_pad_config_realtime,
            commands::pads::load_pad_key,
            commands::pads::create_user_pad,
            commands::pads::rename_user_pad,
            commands::pads::assign_pad_key,
            commands::pads::clear_pad_key,
            commands::settings::get_decoding_cache_info,
            commands::settings::set_decoding_cache_dir,
            commands::settings::set_decoding_cache_max_gb,
            commands::settings::purge_decoding_cache,
            commands::project::get_song_view,
            commands::project::get_project_load_progress_snapshot,
            commands::library::get_library_assets,
            commands::library::get_library_folders,
            commands::library::get_waveform_summaries,
            commands::library::get_library_waveform_summaries,
            audio::engine::get_audio_output_devices,
            commands::system::get_audio_debug_snapshot,
            commands::system::get_audio_output_meter,
            commands::system::get_audio_output_capture,
            commands::system::get_desktop_performance_snapshot,
            commands::system::get_system_resource_snapshot,
            commands::system::get_ownership_diagnostics,
            commands::system::append_debug_log,
            commands::system::read_error_log,
            commands::system::append_frontend_error,
            commands::system::reveal_error_log,
            commands::system::fetch_latest_release,
            commands::system::report_ui_render_metric,
            commands::project::start_create_song,
            commands::project::start_create_song_named,
            commands::project::start_create_song_named_at,
            commands::project::pick_session_folder,
            commands::project::start_open_project_from_path,
            commands::project::list_default_sessions,
            commands::project::list_session_templates,
            commands::project::start_save_session_as_template,
            commands::project::save_session_as_template_at,
            commands::project::start_create_song_from_template_path,
            commands::project::start_create_song_from_template_named_at,
            commands::project::start_create_song_from_template_file,
            commands::project::start_import_library_assets_from_dialog,
            commands::project::pick_library_files,
            commands::project::import_audio_files_from_bytes,
            commands::project::import_audio_files_from_paths,
            commands::project::stage_imported_audio_chunk,
            commands::project::import_staged_audio_files,
            commands::project::export_region_as_package,
            commands::project::export_region_rendered_audio,
            commands::project::import_song_package,
            commands::project::export_session_package,
            commands::project::start_import_session_package_from_dialog,
            commands::project::import_external_project,
            commands::project::resolve_missing_file,
            commands::library::delete_library_asset,
            commands::library::move_library_asset,
            commands::library::create_library_folder,
            commands::library::rename_library_folder,
            commands::library::delete_library_folder,
            commands::project::save_project,
            commands::project::start_save_project_as,
            commands::project::open_project_from_dialog,
            commands::project::start_open_project_from_dialog,
            commands::project::start_pick_and_import_song_from_dialog,
            commands::project::start_import_song_package_from_path,
            commands::project::start_import_external_project_from_path,
            commands::project::pick_and_import_external_project_from_dialog,
            commands::project::pick_and_import_external_project_into_session_from_dialog,
            commands::transport::play_transport,
            commands::transport::pause_transport,
            commands::transport::stop_transport,
            commands::transport::seek_transport,
            commands::transport::prewarm_timeline_seek,
            commands::transport::schedule_marker_jump,
            commands::transport::schedule_region_jump,
            commands::transport::cancel_marker_jump,
            commands::transport::toggle_vamp,
            commands::timeline::move_clip,
            commands::timeline::move_clip_live,
            commands::timeline::move_clips_batch,
            commands::timeline::move_clips_live_batch,
            commands::timeline::delete_clip,
            commands::timeline::delete_clips,
            commands::timeline::update_clip_window,
            commands::timeline::update_clip_color,
            commands::timeline::duplicate_clip,
            commands::timeline::duplicate_clips,
            commands::timeline::split_clip,
            commands::timeline::split_clips,
            commands::timeline::undo_action,
            commands::timeline::redo_action,
            commands::timeline::create_section_marker,
            commands::timeline::update_section_marker,
            commands::timeline::delete_section_marker,
            commands::timeline::create_song_region,
            commands::timeline::create_empty_song,
            commands::timeline::update_song_region,
            commands::timeline::move_song_region,
            commands::timeline::update_song_region_transpose,
            commands::timeline::update_song_region_warp,
            commands::timeline::update_live_region_master_gain,
            commands::timeline::update_song_region_master_gain,
            commands::timeline::delete_song_region,
            commands::timeline::split_song_region,
            commands::timeline::upsert_automation_cue,
            commands::timeline::delete_automation_cue,
            commands::timeline::add_automation_track,
            commands::timeline::remove_automation_track,
            commands::timeline::set_automation_track_position,
            commands::timeline::upsert_mix_scene,
            commands::timeline::delete_mix_scene,
            commands::timeline::assign_section_marker_digit,
            commands::timeline::set_section_marker_kind,
            commands::timeline::set_section_marker_color,
            commands::timeline::update_song_tempo,
            commands::timeline::update_song_region_key,
            commands::timeline::upsert_song_tempo_marker,
            commands::timeline::delete_song_tempo_marker,
            commands::timeline::update_song_time_signature,
            commands::timeline::upsert_song_time_signature_marker,
            commands::timeline::delete_song_time_signature_marker,
            commands::timeline::create_track,
            commands::project::create_clip,
            commands::project::create_clips_batch,
            commands::project::create_clips_with_auto_tracks,
            commands::project::create_audio_tracks_with_clips,
            commands::timeline::move_clip_to_track,
            commands::timeline::move_track,
            commands::timeline::update_track_mix_realtime,
            commands::timeline::commit_track_mix_change,
            commands::timeline::update_track,
            commands::timeline::update_track_color,
            commands::timeline::update_track_transpose_enabled,
            commands::timeline::delete_track,
            commands::timeline::delete_tracks,
            // ── Engine v2 commands (only available with `audio-engine-v2` feature) ──
            commands::engine_v2::engine_v2_initialize,
            commands::engine_v2::engine_v2_shutdown,
            commands::engine_v2::engine_v2_get_version,
            commands::engine_v2::engine_v2_get_snapshot,
            commands::engine_v2::engine_v2_send_command,
            commands::engine_v2::engine_v2_poll_events,
            commands::engine_v2::engine_v2_list_devices,
            commands::engine_v2::engine_v2_get_diagnostics,
            commands::engine_v2::engine_v2_load_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
