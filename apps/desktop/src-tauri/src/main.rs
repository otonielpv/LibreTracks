#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod audio_engine;
mod commands;
mod error;
mod midi;
mod models;
mod remote;
mod settings;
mod state;

use tauri::Manager;

use settings::{load_app_settings, AppSettingsStore};
use state::DesktopState;

use commands::engine_v2::EngineV2State;

fn main() {
    // Keep the env flag visible for diagnostics; desktop audio now routes
    // through the C++ engine v2 path by default.
    let _engine_v2_requested = std::env::var("LIBRETRACKS_AUDIO_ENGINE")
        .map(|v| v == "cpp-v2")
        .unwrap_or(false);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopState::default());

    let builder = builder.manage(EngineV2State::new());

    builder
        .setup(|app| {
            let initial_settings = load_app_settings(&app.handle()).unwrap_or_else(|error| {
                eprintln!("[libretracks-settings] failed to load settings: {error}");
                settings::AppSettings::default()
            });

            app.manage(AppSettingsStore::new(initial_settings.clone()));

            let state = app.state::<DesktopState>();
            state.audio.attach_app_handle(app.handle().clone());
            let initial_device = initial_settings.selected_output_device_id.clone();
            state
                .audio
                .apply_settings(initial_settings)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            // If apply_settings nulled out the saved output device (because
            // the device couldn't be opened — see apply_settings_with_stream_rebuild
            // in audio_engine.rs), persist the cleaned-up settings to disk so
            // the next launch doesn't hit the same failure and we don't keep
            // showing a stale device name to the user.
            if let Ok(after) = state.audio.current_settings() {
                if initial_device.is_some() && after.selected_output_device_id.is_none() {
                    if let Err(e) = settings::save_app_settings(&app.handle(), &after) {
                        if audio_engine::audio_debug_logging_enabled() {
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
                    if audio_engine::audio_debug_logging_enabled() {
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
            commands::project::get_song_view,
            commands::library::get_library_assets,
            commands::library::get_library_folders,
            commands::library::get_waveform_summaries,
            commands::library::get_library_waveform_summaries,
            audio_engine::get_audio_output_devices,
            commands::system::get_audio_debug_snapshot,
            commands::system::get_desktop_performance_snapshot,
            commands::system::get_ownership_diagnostics,
            commands::system::append_debug_log,
            commands::system::report_ui_render_metric,
            commands::project::create_song,
            commands::project::import_library_assets_from_dialog,
            commands::project::import_audio_files_from_bytes,
            commands::project::import_audio_files_from_paths,
            commands::project::export_region_as_package,
            commands::project::export_region_rendered_audio,
            commands::project::import_song_package,
            commands::project::resolve_missing_file,
            commands::library::delete_library_asset,
            commands::library::move_library_asset,
            commands::library::create_library_folder,
            commands::library::rename_library_folder,
            commands::library::delete_library_folder,
            commands::project::save_project,
            commands::project::save_project_as,
            commands::project::open_project_from_dialog,
            commands::project::pick_and_import_song_from_dialog,
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
            commands::timeline::update_clip_window,
            commands::timeline::duplicate_clip,
            commands::timeline::duplicate_clips,
            commands::timeline::split_clip,
            commands::timeline::undo_action,
            commands::timeline::redo_action,
            commands::timeline::create_section_marker,
            commands::timeline::update_section_marker,
            commands::timeline::delete_section_marker,
            commands::timeline::create_song_region,
            commands::timeline::update_song_region,
            commands::timeline::update_song_region_transpose,
            commands::timeline::update_song_region_warp,
            commands::timeline::delete_song_region,
            commands::timeline::assign_section_marker_digit,
            commands::timeline::update_song_tempo,
            commands::timeline::upsert_song_tempo_marker,
            commands::timeline::delete_song_tempo_marker,
            commands::timeline::update_song_time_signature,
            commands::timeline::upsert_song_time_signature_marker,
            commands::timeline::delete_song_time_signature_marker,
            commands::timeline::create_track,
            commands::project::create_clip,
            commands::project::create_clips_batch,
            commands::timeline::move_track,
            commands::timeline::update_track_mix_realtime,
            commands::timeline::commit_track_mix_change,
            commands::timeline::update_track,
            commands::timeline::update_track_transpose_enabled,
            commands::timeline::delete_track,
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
