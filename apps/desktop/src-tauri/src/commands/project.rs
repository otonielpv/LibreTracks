use std::thread;

use tauri::{AppHandle, Manager, State};

use crate::commands::events::{
    emit_library_import_complete_event, emit_project_load_complete_event,
    emit_ready_library_waveforms, emit_transport_lifecycle_event,
    LibraryImportCompleteEventPayload, ProjectLoadCompleteEventPayload,
};
use crate::error::DesktopError;
use crate::models::{LibraryAssetSummary, SongPackageImportResponse, SongView, TransportSnapshot};
use crate::state::{
    AudioFileImportPayload, AudioFilePathImportPayload, CreateClipRequest,
    CreateClipWithAutoTrackRequest, DesktopSession, DesktopState, ProjectLoadProgressEvent,
};
use rfd::FileDialog;

#[tauri::command]
pub fn get_song_view(
    state: State<'_, DesktopState>,
    include_waveforms: Option<bool>,
) -> Result<Option<SongView>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .song_view_with_options(include_waveforms.unwrap_or(true))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_pick_and_import_song_from_dialog(app: AppHandle) -> Result<bool, String> {
    let package_file = FileDialog::new()
        .add_filter("LibreTracks Package", &["ltpkg"])
        .set_title("Selecciona un paquete .ltpkg")
        .pick_file();

    let Some(package_file) = package_file else {
        return Ok(false);
    };

    spawn_project_work(&app, move |worker_app, state| {
        let mut session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        // The file-menu import inserts at the current playhead, matching the old
        // behavior before insert_at_seconds was threaded through.
        let insert_at = session.current_position();
        session
            .import_song_from_path(worker_app, &state.audio, package_file, insert_at)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

/// Path-based sibling of [`start_pick_and_import_song_from_dialog`] for the
/// compact view, which resolves the `.ltpkg` path itself (its own picker or an
/// OS drag) and computes the insert offset. Runs the SAME progress-emitting
/// import flow on a worker thread so the compact import shows real progress
/// (percent + source readiness) instead of a frozen "Aplicando cambios"
/// overlay — the old `import_song_package` command emitted nothing.
#[tauri::command]
pub fn start_import_song_package_from_path(
    app: AppHandle,
    package_path: String,
    insert_at_seconds: f64,
) -> Result<bool, String> {
    let package_file = std::path::PathBuf::from(package_path);
    spawn_project_work(&app, move |worker_app, state| {
        let mut session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .import_song_from_path(worker_app, &state.audio, package_file, insert_at_seconds)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

/// Spawn the heavy half of a dialog-driven project operation on a worker
/// thread, emitting `project:load-complete` when it finishes. The native rfd
/// dialog must run on the calling (main) thread on macOS, but the lock + engine
/// work must NOT run there: running it on the main thread freezes the macOS run loop and
/// hangs the window on the "Applying changes" overlay. The frontend awaits the
/// completion event (see `openProject`/`createSong` in desktopApi.ts).
fn spawn_project_work<F>(app: &AppHandle, work: F)
where
    F: FnOnce(&AppHandle, &DesktopState) -> Result<TransportSnapshot, String> + Send + 'static,
{
    let worker_app = app.clone();
    thread::spawn(move || {
        let state = worker_app.state::<DesktopState>();
        let result = work(&worker_app, &state);

        match result {
            Ok(snapshot) => {
                emit_transport_lifecycle_event(&worker_app, "sync", &snapshot);
                emit_project_load_complete_event(
                    &worker_app,
                    ProjectLoadCompleteEventPayload {
                        snapshot: Some(snapshot),
                        error: None,
                    },
                );
            }
            Err(error) => {
                crate::error_log::write_error(&format!("project load/save failed: {error}"));
                emit_project_load_complete_event(
                    &worker_app,
                    ProjectLoadCompleteEventPayload {
                        snapshot: None,
                        error: Some(error),
                    },
                );
            }
        }
    });
}

#[tauri::command]
pub fn start_create_song(app: AppHandle) -> Result<bool, String> {
    // project_root() needs the AppHandle; build the default dir here so the
    // dialog still opens in <app_data>/songs as before.
    let default_directory = crate::state::create_song_default_directory(&app);
    let target_pick = FileDialog::new()
        .set_title("Crear proyecto")
        .set_directory(&default_directory)
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_file_name(&crate::state::default_project_file_name("Nueva Cancion"))
        .save_file();

    let Some(target_pick) = target_pick else {
        return Ok(false);
    };

    spawn_project_work(&app, move |_worker_app, state| {
        let mut session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .create_song_at_path(target_pick, &state.audio)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

#[tauri::command]
pub fn save_project(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .save_project()
        .map_err(|error| crate::error_log::log_command_err("save_project", error))
}

#[tauri::command]
pub fn resolve_missing_file(
    old_path: String,
    new_path: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .resolve_missing_file(&old_path, &new_path, &state.audio)
        .map_err(|error| crate::error_log::log_command_err("resolve_missing_file", error))
}

#[tauri::command]
pub fn start_save_project_as(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    // Read the current title under a short lock so we can seed the dialog's
    // default file name, then drop the lock before opening the (blocking)
    // dialog and spawning the heavy save onto a worker thread.
    let song_title = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .engine
            .song()
            .map(|song| song.title.clone())
            .ok_or_else(|| DesktopError::NoSongLoaded.to_string())?
    };

    let target_pick = FileDialog::new()
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_title("Guardar proyecto como")
        .set_file_name(&crate::state::default_project_file_name(&song_title))
        .save_file();

    let Some(target_pick) = target_pick else {
        return Ok(false);
    };

    spawn_project_work(&app, move |_worker_app, state| {
        let mut session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .save_project_as_to_path(target_pick)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

#[tauri::command]
pub fn open_project_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<TransportSnapshot>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .open_project_from_dialog(&app, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_project_load_progress_snapshot(
    state: State<'_, DesktopState>,
) -> Result<Option<ProjectLoadProgressEvent>, String> {
    state
        .project_load_progress
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| DesktopError::StatePoisoned.to_string())
}

#[tauri::command]
pub fn start_open_project_from_dialog(app: AppHandle) -> Result<bool, String> {
    let song_file = FileDialog::new()
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_title("Selecciona session.ltsession")
        .pick_file();

    let Some(song_file) = song_file else {
        return Ok(false);
    };

    let worker_app = app.clone();
    thread::spawn(move || {
        let state = worker_app.state::<DesktopState>();
        let result = (|| -> Result<TransportSnapshot, String> {
            {
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned.to_string())?;
                session
                    .begin_open_project_from_path(&worker_app, &state.audio, song_file)
                    .map_err(|error| error.to_string())?;
            }
            let snapshot = DesktopSession::wait_for_project_audio_preparation_unlocked(
                &worker_app,
                &state,
                &state.audio,
            )
            .map_err(|error| error.to_string())?;
            Ok(snapshot)
        })();

        match result {
            Ok(snapshot) => {
                emit_transport_lifecycle_event(&worker_app, "sync", &snapshot);
                emit_project_load_complete_event(
                    &worker_app,
                    ProjectLoadCompleteEventPayload {
                        snapshot: Some(snapshot),
                        error: None,
                    },
                );
            }
            Err(error) => {
                crate::error_log::write_error(&format!("project load/save failed: {error}"));
                emit_project_load_complete_event(
                    &worker_app,
                    ProjectLoadCompleteEventPayload {
                        snapshot: None,
                        error: Some(error),
                    },
                );
            }
        }
    });

    Ok(true)
}

#[tauri::command]
pub fn create_clip(
    app: AppHandle,
    track_id: String,
    file_path: String,
    timeline_start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_clip(&track_id, &file_path, timeline_start_seconds, &state.audio)
        .map_err(|error| error.to_string())?;

    if let Some(song_dir) = snapshot.song_dir.as_deref() {
        emit_ready_library_waveforms(&app, &state, &mut session, song_dir, &[file_path])?;
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn create_clips_batch(
    app: AppHandle,
    requests: Vec<CreateClipRequest>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_clips_batch(&requests, &state.audio)
        .map_err(|error| error.to_string())?;

    if let Some(song_dir) = snapshot.song_dir.as_deref() {
        let requested_paths = requests
            .iter()
            .map(|request| request.file_path.clone())
            .collect::<Vec<_>>();
        emit_ready_library_waveforms(&app, &state, &mut session, song_dir, &requested_paths)?;
    }

    Ok(snapshot)
}

/// Drop one or more audio files into a compact-view song column. The
/// state layer creates an auto track per file; the file stem becomes
/// the track name. Used by the compact view's drop handler.
#[tauri::command]
pub fn create_clips_with_auto_tracks(
    app: AppHandle,
    requests: Vec<CreateClipWithAutoTrackRequest>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_clips_with_auto_tracks(&requests, &state.audio)
        .map_err(|error| error.to_string())?;

    if let Some(song_dir) = snapshot.song_dir.as_deref() {
        let requested_paths = requests
            .iter()
            .map(|request| request.file_path.clone())
            .collect::<Vec<_>>();
        emit_ready_library_waveforms(&app, &state, &mut session, song_dir, &requested_paths)?;
    }

    Ok(snapshot)
}

/// Open the native "import audio" dialog on the main thread, then hand the
/// picked files to a worker thread for the heavy decode/persist work, reporting
/// the result via the `library:import-complete` event. Running the import on
/// the main thread froze the macOS run loop and hung the window (same failure
/// mode the project load/save commands fixed). Returns `false` if the user
/// cancels the dialog. No event fires in that case, so the frontend resolves
/// to null without waiting (see `importLibraryAssetsFromDialog` in desktopApi.ts).
#[tauri::command]
pub fn start_import_library_assets_from_dialog(app: AppHandle) -> Result<bool, String> {
    let files = FileDialog::new()
        .add_filter("Audio", &["wav", "mp3", "flac", "m4a", "aac", "ogg"])
        .set_title("Importar audio a la libreria")
        .pick_files();

    let Some(files) = files else {
        return Ok(false);
    };

    let worker_app = app.clone();
    thread::spawn(move || {
        let state = worker_app.state::<DesktopState>();
        let result = (|| -> Result<Vec<LibraryAssetSummary>, String> {
            let mut session = state
                .session
                .lock()
                .map_err(|_| DesktopError::StatePoisoned.to_string())?;
            session
                .import_picked_library_assets(&worker_app, &files)
                .map_err(|error| error.to_string())
        })();

        match result {
            Ok(assets) => {
                emit_library_import_complete_event(
                    &worker_app,
                    LibraryImportCompleteEventPayload {
                        assets: Some(assets),
                        error: None,
                    },
                );
            }
            Err(error) => {
                crate::error_log::write_error(&format!("library import failed: {error}"));
                emit_library_import_complete_event(
                    &worker_app,
                    LibraryImportCompleteEventPayload {
                        assets: None,
                        error: Some(error),
                    },
                );
            }
        }
    });

    Ok(true)
}

#[tauri::command]
pub async fn import_audio_files_from_bytes(
    files: Vec<AudioFileImportPayload>,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let (song_dir, current_song) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| DesktopError::NoSongLoaded.to_string())?;
        let current_song = session.engine.song().cloned();
        (song_dir, current_song)
    };

    tauri::async_runtime::spawn_blocking(move || {
        crate::state::import_audio_files_from_bytes_to_library(
            &song_dir,
            current_song.as_ref(),
            &files,
        )
    })
    .await
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_bytes", error))?
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_bytes", error))
}

#[tauri::command]
pub async fn import_audio_files_from_paths(
    files: Vec<AudioFilePathImportPayload>,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let (song_dir, current_song) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| DesktopError::NoSongLoaded.to_string())?;
        let current_song = session.engine.song().cloned();
        (song_dir, current_song)
    };

    tauri::async_runtime::spawn_blocking(move || {
        crate::state::import_audio_files_from_paths_to_library(
            &song_dir,
            current_song.as_ref(),
            &files,
        )
    })
    .await
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_paths", error))?
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_paths", error))
}

#[tauri::command]
pub async fn export_region_as_package(
    region_id: String,
    include_audio: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let (song_dir, song, region_name) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| "No song loaded".to_string())?;
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "No song loaded".to_string())?;
        let region_name = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .map(|region| region.name.clone())
            .ok_or_else(|| "Region not found".to_string())?;
        (song_dir, song, region_name)
    };

    let output_path = FileDialog::new()
        .add_filter("LibreTracks Package", &["ltpkg"])
        .set_title("Exportar Cancion")
        .set_file_name(&format!("{}.ltpkg", crate::state::slugify(&region_name)))
        .save_file();

    if let Some(path) = output_path {
        let cache_root = crate::state::decoding_cache_root();
        tauri::async_runtime::spawn_blocking(move || {
            libretracks_project::export_region_as_package(
                &cache_root,
                &song_dir,
                &song,
                &region_id,
                &path,
                include_audio,
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
    }

    Ok(())
}

#[tauri::command]
pub fn export_region_rendered_audio(
    region_id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let (song_dir, song, region_name) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| "No song loaded".to_string())?;
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "No song loaded".to_string())?;
        let region_name = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .map(|region| region.name.clone())
            .ok_or_else(|| "Region not found".to_string())?;
        (song_dir, song, region_name)
    };

    let output_path = FileDialog::new()
        .add_filter("Wave Audio", &["wav"])
        .set_title("Exportar Audio Renderizado")
        .set_file_name(&format!("{}.wav", crate::state::slugify(&region_name)))
        .save_file();

    if let Some(path) = output_path {
        state
            .audio
            .export_region_rendered_audio(song_dir, song, &region_id, &path)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn import_song_package(
    package_path: String,
    insert_at_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<SongPackageImportResponse, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .import_song_package(&package_path, insert_at_seconds, &state.audio)
        .map_err(|error| crate::error_log::log_command_err("import_song_package", error))
}
