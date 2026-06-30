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
    AudioFileImportPayload, AudioFilePathImportPayload, CreateAudioTrackWithClipRequest,
    CreateClipRequest, CreateClipWithAutoTrackRequest, DesktopSession, DesktopState,
    ProjectLoadProgressEvent,
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
        // The file-menu import inserts at the current playhead. Read it under a
        // brief lock, then do the heavy decompression unlocked.
        let insert_at = {
            let session = state
                .session
                .lock()
                .map_err(|_| DesktopError::StatePoisoned.to_string())?;
            session.current_position()
        };
        import_package_off_lock(worker_app, state, package_file, insert_at)
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
        import_package_off_lock(worker_app, state, package_file, insert_at_seconds)
    });

    Ok(true)
}

/// Shared import body: decompress the `.ltpkg` WITHOUT the session lock (the
/// slow part — a multitrack package can hold tens of MB of audio), emitting
/// per-entry progress so the UI stays responsive, then take the lock only for
/// the fast merge/persist. Previously the whole import (decompression included)
/// ran under the session lock, freezing every other frontend command — the user
/// saw the window go "not responding" for the duration of a large import.
fn import_package_off_lock(
    app: &AppHandle,
    state: &DesktopState,
    package_file: std::path::PathBuf,
    insert_at_seconds: f64,
) -> Result<TransportSnapshot, String> {
    use libretracks_project::extract_song_package;

    // Resolve the destination dir under a brief lock; release it before the
    // expensive extraction.
    let song_dir = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .package_import_song_dir()
            .map_err(|error| error.to_string())?
    };

    crate::state::emit_project_load_message(app, 5, "Leyendo paquete...".into());
    // Decompress off-lock, mapping per-entry progress onto the 7..40% band so
    // the bar moves for large packages (the merge/decode phases own 40..100%).
    let extracted = extract_song_package(&song_dir, &package_file, |done, total| {
        let percent = if total == 0 {
            7
        } else {
            7 + ((done as u64 * 33) / total as u64) as u8
        };
        crate::state::emit_project_load_message(app, percent, "Descomprimiendo paquete...".into());
    })
    .map_err(|error| error.to_string())?;

    // Fast, session-bound half: merge + persist under the lock.
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .import_song_from_extracted(app, &state.audio, extracted, insert_at_seconds)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pick_and_import_external_project_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<SongPackageImportResponse>, String> {
    eprintln!("[libretracks-import] command wizard import start");
    let target_pick = FileDialog::new()
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_title("Elige donde guardar el proyecto importado")
        .set_file_name("Proyecto importado.ltsession")
        .save_file();

    let Some(target_pick) = target_pick else {
        eprintln!("[libretracks-import] command wizard import cancelled at save target picker");
        return Ok(None);
    };
    eprintln!(
        "[libretracks-import] wizard target selected={} ",
        target_pick.to_string_lossy()
    );

    let picked_file = FileDialog::new()
        .add_filter("Proyecto Reaper/Ableton", &["rpp", "als"])
        .add_filter("Proyecto Reaper", &["rpp"])
        .add_filter("Proyecto Ableton Live", &["als"])
        .set_title("Selecciona un proyecto externo (.rpp o .als)")
        .pick_file();

    let Some(project_file) = picked_file else {
        eprintln!("[libretracks-import] command wizard import cancelled at external project picker");
        return Ok(None);
    };
    eprintln!(
        "[libretracks-import] wizard source selected={} ",
        project_file.to_string_lossy()
    );

    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .ensure_song_loaded_for_external_import(&app, &state.audio)
        .map_err(|error| error.to_string())?;
    let insert_at_seconds = session.transport_position_seconds();
    session
        .import_external_project(
            project_file.to_string_lossy().as_ref(),
            insert_at_seconds,
            &state.audio,
        )
        .map_err(|error| error.to_string())?;
    eprintln!("[libretracks-import] wizard waiting for post-import audio preparation");
    session
        .finalize_project_audio_preparation(&app, &state.audio)
        .map_err(|error| error.to_string())?;
    eprintln!("[libretracks-import] wizard post-import audio preparation completed");
    eprintln!("[libretracks-import] wizard import_external_project finished; saving-as target");
    let snapshot = session
        .save_project_as_to_path(target_pick)
        .map_err(|error| error.to_string())?;
    eprintln!(
        "[libretracks-import] wizard save_project_as_to_path finished revision={}",
        snapshot.project_revision
    );
    let library_assets = session
        .get_library_assets()
        .map_err(|error| error.to_string())?;
    eprintln!(
        "[libretracks-import] command wizard import done assets={}",
        library_assets.len()
    );

    Ok(Some(SongPackageImportResponse {
        snapshot,
        library_assets,
    }))
}

#[tauri::command]
pub fn pick_and_import_external_project_into_session_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<SongPackageImportResponse>, String> {
    eprintln!("[libretracks-import] command session import start");
    let picked_file = FileDialog::new()
        .add_filter("Proyecto Reaper/Ableton", &["rpp", "als"])
        .add_filter("Proyecto Reaper", &["rpp"])
        .add_filter("Proyecto Ableton Live", &["als"])
        .set_title("Selecciona un proyecto externo (.rpp o .als)")
        .pick_file();

    let Some(project_file) = picked_file else {
        eprintln!("[libretracks-import] command session import cancelled at external project picker");
        return Ok(None);
    };
    eprintln!(
        "[libretracks-import] session source selected={} ",
        project_file.to_string_lossy()
    );

    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    let insert_at_seconds = session.transport_position_seconds();
    let response = session
        .import_external_project(
            project_file.to_string_lossy().as_ref(),
            insert_at_seconds,
            &state.audio,
        )
        .map_err(|error| error.to_string())?;
    eprintln!("[libretracks-import] session waiting for post-import audio preparation");
    session
        .finalize_project_audio_preparation(&app, &state.audio)
        .map_err(|error| error.to_string())?;
    eprintln!("[libretracks-import] session post-import audio preparation completed");
    eprintln!(
        "[libretracks-import] command session import done revision={} assets={}",
        response.snapshot.project_revision,
        response.library_assets.len()
    );

    Ok(Some(response))
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

/// Drop one or more library assets onto the timeline. The state layer creates
/// one persistent audio track per asset (named `track_name`) plus a clip, all
/// in a single song update — so a batch drop onto an already-populated song
/// costs one rebuild instead of one per asset.
#[tauri::command]
pub fn create_audio_tracks_with_clips(
    app: AppHandle,
    requests: Vec<CreateAudioTrackWithClipRequest>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_audio_tracks_with_clips(&requests, &state.audio)
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
/// Open the native "import audio" dialog and return the picked file paths
/// WITHOUT importing them. The frontend uses this to create per-file pending
/// placeholders ("analyzing…") before kicking off the shared import pipeline via
/// `import_audio_files_from_paths`, so the library dialog gets the same live
/// feedback as drag-and-drop. Returns an empty vec if the user cancels.
#[tauri::command]
pub fn pick_library_files() -> Vec<String> {
    FileDialog::new()
        .add_filter("Audio", &["wav", "mp3", "flac", "m4a", "aac", "ogg"])
        .set_title("Importar audio a la libreria")
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

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
    let file_count = files.len();
    thread::spawn(move || {
        let state = worker_app.state::<DesktopState>();
        // Mirror the drag-import flow: hold the session lock only BRIEFLY to
        // clone (song_dir, current_song), then do the heavy copy+probe OUTSIDE
        // the lock. Holding the lock across the whole import froze the UI.
        let result = (|| -> Result<Vec<LibraryAssetSummary>, String> {
            let (song_dir, current_song) = {
                let session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned.to_string())?;
                let song_dir = session
                    .song_dir
                    .clone()
                    .ok_or_else(|| DesktopError::NoSongLoaded.to_string())?;
                (song_dir, session.engine.song().cloned())
            };

            crate::state::emit_library_import_progress(
                &worker_app,
                10,
                format!("Preparando {file_count} archivo(s) para importar..."),
            );

            // Funnel into the SAME path-based core the drag flow uses
            // (register original paths + probe metadata, no lock).
            let payloads: Vec<AudioFilePathImportPayload> = files
                .iter()
                .map(|path| AudioFilePathImportPayload {
                    file_name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("audio")
                        .to_string(),
                    source_path: path.to_string_lossy().to_string(),
                })
                .collect();

            crate::state::import_audio_files_from_paths_to_library(
                &song_dir,
                current_song.as_ref(),
                &payloads,
            )
            .map_err(|error| error.to_string())?;

            crate::state::emit_library_import_progress(
                &worker_app,
                100,
                "Importacion completada.".into(),
            );

            // Emit the FULL list (the frontend currently replaces its asset list
            // wholesale from this event).
            crate::state::list_library_assets(&song_dir, current_song.as_ref())
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

    let song_dir_for_prepare = song_dir.clone();
    let assets = tauri::async_runtime::spawn_blocking(move || {
        crate::state::import_audio_files_from_bytes_to_library(
            &song_dir,
            current_song.as_ref(),
            &files,
        )
    })
    .await
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_bytes", error))?
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_bytes", error))?;

    // Start decoding the imported library files now (see the paths variant).
    prepare_library_assets(&state, &song_dir_for_prepare, &assets);
    Ok(assets)
}

/// Kick off background decode→cache (+ same-pass waveform peaks) for freshly
/// imported library assets, so they're ready before they hit the timeline.
fn prepare_library_assets(
    state: &DesktopState,
    song_dir: &std::path::Path,
    assets: &[crate::models::view::LibraryAssetSummary],
) {
    let resolved: Vec<String> = assets
        .iter()
        .map(|a| {
            crate::state::resolve_audio_file_path(song_dir, &a.file_path)
                .to_string_lossy()
                .to_string()
        })
        .collect();
    let _ = state.audio.prepare_sources(&resolved);
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

    let song_dir_for_prepare = song_dir.clone();
    let assets = tauri::async_runtime::spawn_blocking(move || {
        crate::state::import_audio_files_from_paths_to_library(
            &song_dir,
            current_song.as_ref(),
            &files,
        )
    })
    .await
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_paths", error))?
    .map_err(|error| crate::error_log::log_command_err("import_audio_files_from_paths", error))?;

    // Ableton-style: start decoding the imported files to cache + waveform peaks
    // NOW, while they sit in the library — so by the time they're dragged to the
    // timeline the audio + waveform are already prepared (no re-decode, no wait).
    prepare_library_assets(&state, &song_dir_for_prepare, &assets);

    Ok(assets)
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

/// Export the ENTIRE session as a single portable `.ltset` archive (every
/// region, the library, automation, waveforms, and — in full mode — the audio
/// used by clips). The "create at home, play live elsewhere" flow.
///
/// Runs on a worker thread and streams progress to the UI via the
/// `session:export-progress` event (a large full export of a big set can take a
/// while), ending with a terminal `done` event (with `error` on failure).
/// Returns `false` if the user cancels the save dialog.
#[tauri::command]
pub fn export_session_package(
    app: AppHandle,
    include_audio: bool,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    let (song_dir, song, sidecars) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .prepare_session_package_export()
            .map_err(|error| error.to_string())?
    };

    let output_path = FileDialog::new()
        .add_filter("LibreTracks Set", &["ltset"])
        .set_title("Exportar sesion")
        .set_file_name(&format!("{}.ltset", crate::state::slugify(&song.title)))
        .save_file();

    let Some(path) = output_path else {
        return Ok(false);
    };

    let cache_root = crate::state::decoding_cache_root();
    let worker_app = app.clone();
    thread::spawn(move || {
        crate::state::emit_session_export_progress(
            &worker_app,
            2,
            "Preparando exportacion...".into(),
            false,
            None,
        );
        let result = libretracks_project::export_session_as_package(
            &cache_root,
            &song_dir,
            &song,
            &sidecars,
            &path,
            include_audio,
            |done, total| {
                if total > 0 {
                    // Per-source work is the bulk of the export (audio + waveform
                    // in a full package, waveform only in a light one); map it to
                    // a 5–98% band, leaving room for the final zip flush. Both
                    // modes report here — a light export of a big set can still
                    // take a while resolving/bundling every waveform.
                    let percent = 5 + ((done as f64 / total as f64) * 93.0) as u8;
                    let message = if include_audio {
                        format!("Empaquetando audio... {done}/{total}")
                    } else {
                        format!("Empaquetando sesion... {done}/{total}")
                    };
                    crate::state::emit_session_export_progress(
                        &worker_app,
                        percent.min(98),
                        message,
                        false,
                        None,
                    );
                }
            },
        );

        match result {
            Ok(_) => crate::state::emit_session_export_progress(
                &worker_app,
                100,
                "Sesion exportada.".into(),
                true,
                None,
            ),
            Err(error) => {
                let message = error.to_string();
                crate::error_log::write_error(&format!("session export failed: {message}"));
                crate::state::emit_session_export_progress(
                    &worker_app,
                    100,
                    "La exportacion fallo.".into(),
                    true,
                    Some(message),
                );
            }
        }
    });

    Ok(true)
}

/// Pick a `.ltset`, choose where to save the new project folder, then inflate
/// and open it as a fresh session — no session needs to be open first, so this
/// is wired to the empty-state landing screen as well as the menu. Replaces
/// whatever is currently loaded (it does NOT merge).
#[tauri::command]
pub fn start_import_session_package_from_dialog(app: AppHandle) -> Result<bool, String> {
    let package_file = FileDialog::new()
        .add_filter("LibreTracks Set", &["ltset"])
        .set_title("Importar sesion (.ltset)")
        .pick_file();

    let Some(package_file) = package_file else {
        return Ok(false);
    };

    // Default the new project folder to <app_data>/songs/<set-name>, but let the
    // user place it anywhere. The picked file name (sans extension) becomes the
    // project folder name, matching Create/Save-As.
    let default_directory = crate::state::create_song_default_directory(&app);
    let default_name = package_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("sesion-importada")
        .to_string();
    let target_pick = FileDialog::new()
        .set_title("Guardar sesion importada como")
        .set_directory(&default_directory)
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_file_name(&crate::state::default_project_file_name(&default_name))
        .save_file();

    let Some(target_pick) = target_pick else {
        return Ok(false);
    };

    let target_song_dir = match session_dir_from_pick(&target_pick) {
        Ok(dir) => dir,
        Err(error) => return Err(error),
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
                    .import_session_package_as_new(
                        &worker_app,
                        &state.audio,
                        &package_file,
                        &target_song_dir,
                    )
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
                crate::error_log::write_error(&format!("session import failed: {error}"));
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

/// Turn the save dialog's `<name>.ltsession` pick into the project FOLDER we
/// inflate into (`<parent>/<name>/`), matching Create and Save-As, which place
/// the session file inside a same-named folder.
fn session_dir_from_pick(target_pick: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let parent_dir = target_pick
        .parent()
        .ok_or_else(|| "no se pudo determinar la carpeta destino".to_string())?;
    let project_name = target_pick
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "el nombre del proyecto no es valido".to_string())?;
    Ok(parent_dir.join(project_name))
}

#[tauri::command]
pub fn import_external_project(
    project_path: String,
    insert_at_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<SongPackageImportResponse, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .import_external_project(&project_path, insert_at_seconds, &state.audio)
        .map_err(|error| error.to_string())
}
