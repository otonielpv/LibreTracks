#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio_runtime;
mod commands;
mod error;
mod models;
mod remote;
mod settings;
mod state;

use tauri::Manager;

use settings::{load_app_settings, AppSettingsStore};
use state::DesktopState;

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .setup(|app| {
            let initial_settings = load_app_settings(&app.handle()).unwrap_or_else(|error| {
                eprintln!("[libretracks-settings] failed to load settings: {error}");
                settings::AppSettings::default()
            });

            app.manage(AppSettingsStore::new(initial_settings.clone()));

            let state = app.state::<DesktopState>();
            state.audio.attach_app_handle(app.handle().clone());
            state
                .audio
                .apply_settings(initial_settings)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            remote::initialize_remote(app)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::healthcheck,
            commands::system::get_remote_server_info,
            commands::transport::get_transport_snapshot,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::update_audio_settings,
            commands::project::get_song_view,
            commands::library::get_library_assets,
            commands::library::get_library_folders,
            commands::library::get_waveform_summaries,
            commands::library::get_library_waveform_summaries,
            audio_runtime::get_audio_output_devices,
            commands::system::get_audio_debug_snapshot,
            commands::system::get_desktop_performance_snapshot,
            commands::system::report_ui_render_metric,
            commands::project::create_song,
            commands::project::import_library_assets_from_dialog,
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
            commands::transport::schedule_marker_jump,
            commands::transport::cancel_marker_jump,
            commands::timeline::move_clip,
            commands::timeline::move_clip_live,
            commands::timeline::delete_clip,
            commands::timeline::update_clip_window,
            commands::timeline::duplicate_clip,
            commands::timeline::split_clip,
            commands::timeline::undo_action,
            commands::timeline::redo_action,
            commands::timeline::create_section_marker,
            commands::timeline::update_section_marker,
            commands::timeline::delete_section_marker,
            commands::timeline::create_song_region,
            commands::timeline::update_song_region,
            commands::timeline::delete_song_region,
            commands::timeline::assign_section_marker_digit,
            commands::timeline::update_song_tempo,
            commands::timeline::upsert_song_tempo_marker,
            commands::timeline::delete_song_tempo_marker,
            commands::timeline::create_track,
            commands::project::create_clip,
            commands::project::create_clips_batch,
            commands::timeline::move_track,
            commands::timeline::update_track_mix_live,
            commands::timeline::update_track,
            commands::timeline::delete_track
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
