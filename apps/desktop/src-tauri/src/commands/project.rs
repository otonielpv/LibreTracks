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
use crate::file_dialog::FileDialog;

/// Where an export should be written, chosen by the platform's "save as".
///
/// Desktop picks a real filesystem path and the export writes straight to it.
/// Android's SAF returns a `content://` URI which `std::fs` can't open, so the
/// export writes to a private temp file and `finish()` copies it into the URI
/// through the content resolver (then deletes the temp).
enum ExportTarget {
    Path(std::path::PathBuf),
    #[cfg(target_os = "android")]
    Saf {
        temp: std::path::PathBuf,
        target: tauri_plugin_fs::FilePath,
    },
}

impl ExportTarget {
    /// The path the export routine should write to.
    fn write_path(&self) -> &std::path::Path {
        match self {
            ExportTarget::Path(path) => path,
            #[cfg(target_os = "android")]
            ExportTarget::Saf { temp, .. } => temp,
        }
    }

    /// Deliver the finished file to its real destination (no-op on desktop).
    fn finish(&self, app: &AppHandle) -> Result<(), String> {
        let _ = app;
        match self {
            ExportTarget::Path(_) => Ok(()),
            #[cfg(target_os = "android")]
            ExportTarget::Saf { temp, target } => {
                let result = crate::mobile_files::copy_path_to_picked_target(app, temp, target);
                let _ = std::fs::remove_file(temp);
                result
            }
        }
    }
}

/// Platform "save as" dialog for exports. Returns None if the user cancels.
fn pick_export_target(
    app: &AppHandle,
    title: &str,
    filter_name: &str,
    extensions: &[&str],
    suggested_name: &str,
) -> Result<Option<ExportTarget>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(FileDialog::new()
            .add_filter(filter_name, extensions)
            .set_title(title)
            .set_file_name(suggested_name)
            .save_file()
            .map(ExportTarget::Path))
    }
    #[cfg(target_os = "android")]
    {
        let _ = (filter_name, extensions);
        let Some(target) = crate::mobile_files::save_file(app, title, suggested_name) else {
            return Ok(None);
        };
        let temp = crate::mobile_files::export_temp_path(app, suggested_name)?;
        Ok(Some(ExportTarget::Saf { temp, target }))
    }
}

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
    #[cfg(target_os = "android")]
    {
        // SAF picker → content:// URI; stage it to a private temp file on the
        // worker (a big .ltpkg copy shouldn't block the command) and feed the
        // same import path as desktop.
        let Some(picked) = crate::mobile_files::pick_file(&app, "Selecciona un paquete .ltpkg")
        else {
            return Ok(false);
        };
        // No extension check: SAF document URIs from providers like Downloads
        // end in an opaque id ("msf:28"), not the display name. The package
        // reader validates the zip structure and reports a clear error.
        let picked_name = sanitize_saf_name_hint(
            &crate::mobile_files::picked_file_name(&picked),
            "paquete.ltpkg",
        );
        spawn_project_work(&app, move |worker_app, state| {
            let staged =
                crate::mobile_files::stage_picked_file_to_temp(worker_app, &picked, &picked_name)?;
            let insert_at = {
                let session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned.to_string())?;
                session.current_position()
            };
            let result = import_package_off_lock(worker_app, state, staged.clone(), insert_at);
            let _ = std::fs::remove_file(&staged);
            result
        });
        return Ok(true);
    }

    #[cfg(not(target_os = "android"))]
    {
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

/// Path-based external-project import for the timeline OS-drag (sibling of
/// [`start_import_song_package_from_path`]). The frontend resolves the `.rpp`/
/// `.als` path and the drop position; we run the same progress-emitting worker
/// flow so the import shows real progress instead of a frozen overlay. The
/// dropped project lands at `insert_at_seconds` (the drop X) UNLESS that would
/// overlap an existing song, in which case it appends after the setlist (a
/// whole project becomes song region(s), and the engine rejects overlap).
#[tauri::command]
pub fn start_import_external_project_from_path(
    app: AppHandle,
    project_path: String,
    insert_at_seconds: f64,
) -> Result<bool, String> {
    spawn_project_work(&app, move |worker_app, state| {
        import_external_project_off_lock(worker_app, state, &project_path, insert_at_seconds)
    });

    Ok(true)
}

fn import_external_project_off_lock(
    app: &AppHandle,
    state: &DesktopState,
    project_path: &str,
    insert_at_seconds: f64,
) -> Result<TransportSnapshot, String> {
    crate::state::emit_project_load_message(app, 5, "Leyendo proyecto externo...".into());

    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    // Make sure there is a song to append into (the timeline drop can happen on
    // an empty session too — same bootstrap the wizard import uses).
    session
        .ensure_song_loaded_for_external_import(app, &state.audio)
        .map_err(|error| error.to_string())?;

    // The drop X is the DESIRED position; import_external_project resolves it
    // against existing songs (falling back to the setlist end if it would
    // overlap), since a whole project becomes song region(s) that may not
    // overlap.
    let response = session
        .import_external_project_at(project_path, insert_at_seconds, true, &state.audio)
        .map_err(|error| error.to_string())?;
    session
        .finalize_project_audio_preparation(app, &state.audio)
        .map_err(|error| error.to_string())?;

    Ok(response.snapshot)
}

#[tauri::command]
pub fn pick_and_import_external_project_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<SongPackageImportResponse>, String> {
    eprintln!("[libretracks-import] command wizard import start");
    // Mirror the .ltset import flow: pick the source FIRST, then choose where to
    // save. Choosing the file before the destination reads more naturally and
    // lets us default the new session name to the imported project's name.
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

    // Default the new project to <app_data>/songs/<source-name>, matching the
    // .ltset import and Create/Save-As. The user can still place it anywhere.
    let default_directory = crate::state::create_song_default_directory(&app);
    let default_name = project_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Proyecto importado")
        .to_string();
    let target_pick = FileDialog::new()
        .add_filter("LibreTracks Session", &["ltsession"])
        .set_title("Elige donde guardar el proyecto importado")
        .set_directory(&default_directory)
        .set_file_name(&crate::state::default_project_file_name(&default_name))
        .save_file();

    let Some(target_pick) = target_pick else {
        eprintln!("[libretracks-import] command wizard import cancelled at save target picker");
        return Ok(None);
    };
    eprintln!(
        "[libretracks-import] wizard target selected={} ",
        target_pick.to_string_lossy()
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
    // Append the imported project AFTER the current setlist. Its region (a whole
    // song) must not overlap the existing ones, so we insert at the end of the
    // last region rather than at the playhead (which is usually 0 and overlapped
    // the first song → "regions out of order or overlap").
    let insert_at_seconds = session.setlist_end_seconds();
    eprintln!(
        "[libretracks-import] session import appending at setlist end={insert_at_seconds:.3}s"
    );
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

/// Sanitize a user-typed session name into a safe folder/file stem: path
/// separators and characters Windows rejects become spaces, and leading or
/// trailing dots/spaces are trimmed so the result is a valid directory name
/// on every platform.
fn sanitize_session_name(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned
        .trim()
        .trim_matches('.')
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return Err("El nombre del proyecto está vacío".to_string());
    }
    Ok(cleaned)
}

/// Create a session by name directly in the default songs folder, without a
/// native save dialog. This is the Android landing flow (`rfd` has no Android
/// backend), but it works on any platform. Same worker + progress events as
/// `start_create_song`.
#[tauri::command]
pub fn start_create_song_named(app: AppHandle, name: String) -> Result<bool, String> {
    start_create_song_named_at(app, name, None)
}

/// Create a session by name inside a caller-chosen parent folder — the Android
/// "choose where to save" flow, mirroring the desktop save dialog. When
/// `parent_dir` is `None` this behaves exactly like the default-folder create;
/// when `Some`, the session folder is placed under that directory (collisions
/// get a `-2`, `-3`… suffix so we never clobber an existing session). Same
/// worker + progress events as `start_create_song`.
#[tauri::command]
pub fn start_create_song_named_at(
    app: AppHandle,
    name: String,
    parent_dir: Option<String>,
) -> Result<bool, String> {
    let name = sanitize_session_name(&name)?;
    let target_pick = named_session_target(&app, &name, parent_dir)?;

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

/// Resolve the pseudo save-file path consumed by `create_song_at_path_with`
/// for the Android name + parent-folder flow. Shared by empty sessions and
/// sessions seeded from a template so both handle collisions identically.
fn named_session_target(
    app: &AppHandle,
    name: &str,
    parent_dir: Option<String>,
) -> Result<std::path::PathBuf, String> {
    match parent_dir {
        Some(parent) => {
            let parent = std::path::PathBuf::from(parent);
            if !parent.is_dir() {
                return Err(format!(
                    "La carpeta destino no existe: {}",
                    parent.display()
                ));
            }
            // On Android the "choose folder" flow reuses the SAF save dialog,
            // so the picked parent is the folder the user placed `<name>.ltsession`
            // INTO. When the user navigated into (or created) a folder that already
            // matches the session name, nesting another `<name>/` under it would
            // produce `…/Test/Test/`. If the chosen folder is already named `<name>`
            // and holds no session of its own, inflate the session directly there
            // instead of nesting.
            let parent_is_named_like_session = parent
                .file_name()
                .and_then(|value| value.to_str())
                .map(|dir_name| dir_name.eq_ignore_ascii_case(&name))
                .unwrap_or(false);
            let song_dir = if parent_is_named_like_session && !dir_holds_session(&parent) {
                parent.clone()
            } else {
                // A chosen folder may already hold a same-named session; pick a
                // fresh `<name>`, `<name>-2`… folder instead of failing so the
                // user isn't forced to rename.
                unique_session_dir(&parent, &name)
            };
            let dir_name = song_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&name);
            Ok(song_dir.join(crate::state::default_project_file_name(dir_name)))
        }
        None => {
            let default_directory = crate::state::create_song_default_directory(&app);
            if default_directory.join(&name).exists() {
                return Err(format!("Ya existe un proyecto llamado \"{name}\""));
            }
            let _ = std::fs::create_dir_all(&default_directory);
            Ok(default_directory.join(crate::state::default_project_file_name(&name)))
        }
    }
}

/// Let the user choose where a new session should be saved and return the
/// picked PARENT directory as a real filesystem path — the frontend then calls
/// `start_create_song_named_at` with it, so the session lands in
/// `<chosen>/<name>/`. Returns `None` when the user cancels.
///
/// Android has no folder chooser in the dialog plugin, so this reuses the SAF
/// create-document dialog (the system "save as" UI): we suggest
/// `<name>.ltsession` and derive the chosen folder from where the user places
/// it. Errors when the pick is a provider-virtualized location that doesn't map
/// to a real path (Drive, the Downloads shortcut…), since the engine streams
/// audio by path and can't use those.
#[tauri::command]
pub fn pick_session_folder(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let name = sanitize_session_name(&name)?;

    #[cfg(target_os = "android")]
    {
        let suggested = crate::state::default_project_file_name(&name);
        let Some(picked) =
            crate::mobile_files::save_file(&app, "Elige donde guardar la sesion", &suggested)
        else {
            return Ok(None);
        };
        match crate::mobile_files::resolve_picked_document_parent(&picked) {
            Some(path) => Ok(Some(path.to_string_lossy().into_owned())),
            None => Err(
                "No se puede crear la sesión en esa ubicación. Navega al almacenamiento \
                 del dispositivo (por ejemplo Música o Documentos) en vez de a un acceso \
                 directo como 'Descargas' o una unidad en la nube, que no tienen una ruta \
                 real. Si es la primera vez, concede a LibreTracks el permiso de acceso a \
                 archivos."
                    .to_string(),
            ),
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = &name;
        let picked = FileDialog::new()
            .set_title("Elige donde guardar la sesion")
            .pick_folder();
        Ok(picked.map(|path| path.to_string_lossy().into_owned()))
    }
}

/// List the sessions living in the default songs folder (most recently
/// modified first) so the Android landing screen can offer them without a
/// native "open file" dialog.
#[tauri::command]
pub fn list_default_sessions(app: AppHandle) -> Result<Vec<crate::state::SessionSummary>, String> {
    Ok(crate::state::list_default_sessions(&app))
}

/// List the reusable `.lttemplate` files in the default templates folder so the
/// landing screen can offer them when creating a new session.
#[tauri::command]
pub fn list_session_templates(app: AppHandle) -> Result<Vec<crate::state::TemplateSummary>, String> {
    Ok(crate::state::list_default_templates(&app))
}

/// Save the currently loaded session as a portable `.lttemplate` file. Opens a
/// save dialog seeded to the default templates folder; the user may pick any
/// location so templates can be carried between machines.
#[tauri::command]
pub fn start_save_session_as_template(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
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

    #[cfg(target_os = "android")]
    {
        let template_name = sanitize_session_name(&song_title)?;
        let file_name = format!("{template_name}.lttemplate");
        let Some(target) = crate::mobile_files::save_file(
            &app,
            "Guardar como plantilla",
            &file_name,
        ) else {
            return Ok(false);
        };
        let temporary = crate::mobile_files::export_temp_path(&app, &file_name)?;
        {
            let session = state
                .session
                .lock()
                .map_err(|_| DesktopError::StatePoisoned.to_string())?;
            session
                .save_current_as_template(temporary.clone())
                .map_err(|error| {
                    crate::error_log::log_command_err("start_save_session_as_template", error)
                })?;
        }
        let export_result = crate::mobile_files::copy_path_to_picked_target(
            &app,
            &temporary,
            &target,
        );
        if export_result.is_ok() {
            let catalog_dir = crate::state::templates_default_directory(&app);
            std::fs::create_dir_all(&catalog_dir).map_err(|error| error.to_string())?;
            std::fs::copy(&temporary, catalog_dir.join(&file_name))
                .map_err(|error| error.to_string())?;
        }
        let _ = std::fs::remove_file(&temporary);
        export_result?;
        return Ok(true);
    }

    #[cfg(not(target_os = "android"))]
    {
        let default_directory = crate::state::templates_default_directory(&app);
        // Ensure the suggested folder exists so the dialog can open there.
        let _ = std::fs::create_dir_all(&default_directory);
        let target_pick = FileDialog::new()
            .add_filter("LibreTracks Template", &["lttemplate"])
            .set_title("Guardar como plantilla")
            .set_directory(&default_directory)
            .set_file_name(&format!("{song_title}.lttemplate"))
            .save_file();

        let Some(target_pick) = target_pick else {
            return Ok(false);
        };

        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .save_current_as_template(target_pick)
            .map(|_| true)
            .map_err(|error| {
                crate::error_log::log_command_err("start_save_session_as_template", error)
            })
    }
}

/// Create a named session from a known template without a desktop save dialog.
#[tauri::command]
pub fn start_create_song_from_template_named_at(
    app: AppHandle,
    template_path: String,
    name: String,
    parent_dir: Option<String>,
) -> Result<bool, String> {
    let name = sanitize_session_name(&name)?;
    let target_pick = named_session_target(&app, &name, parent_dir)?;
    let template_path = std::path::PathBuf::from(template_path);

    spawn_project_work(&app, move |_worker_app, state| {
        let mut session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        session
            .create_song_from_template_path(template_path, target_pick, &state.audio)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

/// Create a new session from a template file already known by path (a template
/// listed on the landing screen). Opens a save dialog for the new project
/// location, then builds it off the template on a worker thread.
#[tauri::command]
pub fn start_create_song_from_template_path(
    app: AppHandle,
    template_path: String,
) -> Result<bool, String> {
    let template_path = std::path::PathBuf::from(template_path);
    let default_directory = crate::state::create_song_default_directory(&app);
    let target_pick = FileDialog::new()
        .set_title("Crear proyecto desde plantilla")
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
            .create_song_from_template_path(template_path, target_pick, &state.audio)
            .map_err(|error| error.to_string())
    });

    Ok(true)
}

/// Create a new session from a template chosen via an open dialog (e.g. a
/// `.lttemplate` brought from another machine). Prompts first for the template
/// file, then for the new project location.
#[tauri::command]
pub fn start_create_song_from_template_file(app: AppHandle) -> Result<bool, String> {
    let default_directory = crate::state::templates_default_directory(&app);
    let template_pick = FileDialog::new()
        .set_title("Elegir plantilla")
        .set_directory(&default_directory)
        .add_filter("LibreTracks Template", &["lttemplate"])
        .pick_file();

    let Some(template_path) = template_pick else {
        return Ok(false);
    };

    let target_directory = crate::state::create_song_default_directory(&app);
    let target_pick = FileDialog::new()
        .set_title("Crear proyecto desde plantilla")
        .set_directory(&target_directory)
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
            .create_song_from_template_path(template_path, target_pick, &state.audio)
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
    // Android: the system picker (which remembers the app's last folder on
    // its own) returns a content:// URI; opening IN PLACE needs the real
    // path — a session is a folder the engine streams by path — so resolve
    // it and fall out with a clear message when the location can't map to
    // one (cloud providers, the virtual Downloads shortcut).
    #[cfg(target_os = "android")]
    let song_file = {
        let Some(picked) =
            crate::mobile_files::pick_file(&app, "Selecciona session.ltsession")
        else {
            return Ok(false);
        };
        let Some(path) = crate::mobile_files::resolve_picked_file_to_path(&picked) else {
            return Err(
                "No se puede abrir una sesión desde esa ubicación. Navega al \
                 almacenamiento del dispositivo (no a accesos directos como \
                 'Descargas' o unidades en la nube), o usa Importar sesión \
                 (.ltset). Si es la primera vez, concede a LibreTracks el \
                 permiso de acceso a archivos."
                    .into(),
            );
        };
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| !ext.eq_ignore_ascii_case("ltsession"))
            .unwrap_or(true)
        {
            return Err("Selecciona un archivo .ltsession".into());
        }
        path
    };

    #[cfg(not(target_os = "android"))]
    let song_file = {
        let song_file = FileDialog::new()
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Selecciona session.ltsession")
            .pick_file();

        let Some(song_file) = song_file else {
            return Ok(false);
        };
        song_file
    };

    spawn_open_project_worker(&app, song_file);
    Ok(true)
}

/// Open a session whose `.ltsession` path is already known — the Android
/// landing screen picks from `list_default_sessions` instead of a native
/// file dialog. Same worker + progress events as the dialog flow.
#[tauri::command]
pub fn start_open_project_from_path(app: AppHandle, song_file: String) -> Result<bool, String> {
    let song_file = std::path::PathBuf::from(song_file);
    if !song_file.is_file() {
        return Err(format!(
            "No se encontró el archivo de sesión: {}",
            song_file.display()
        ));
    }

    spawn_open_project_worker(&app, song_file);
    Ok(true)
}

fn spawn_open_project_worker(app: &AppHandle, song_file: std::path::PathBuf) {
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

/// Android: consume files staged by `stage_imported_audio_chunk` — they are
/// MOVED into the session's audio/ folder and registered by relative path
/// (bytes-import semantics), because the staged temp files are ephemeral and
/// registering their absolute path (the desktop paths-import behaviour)
/// produced phantom "missing file" warnings once the staging area was
/// cleaned by the next import batch.
#[tauri::command]
pub async fn import_staged_audio_files(
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
        crate::state::import_staged_audio_files_to_library(
            &song_dir,
            current_song.as_ref(),
            &files,
        )
    })
    .await
    .map_err(|error| crate::error_log::log_command_err("import_staged_audio_files", error))?
    .map_err(|error| crate::error_log::log_command_err("import_staged_audio_files", error))?;

    prepare_library_assets(&state, &song_dir_for_prepare, &assets);

    Ok(assets)
}

/// Android import staging. The WebView file chooser hands us `File` objects
/// (no filesystem path — Android files live behind content:// URIs), and the
/// old path read the WHOLE file into a `Uint8Array` before invoking: on
/// low-RAM phones the WebView renderer process OOM-crashed importing normal-
/// sized WAVs (seen on an Oppo A5: "Render process crash" in
/// libwebviewchromium). Instead the frontend streams the file in small
/// base64 slices; each call appends to a temp file under the app cache, and
/// the last call returns the staged path, which then goes through the normal
/// paths-based import pipeline.
///
/// Base64-in-JSON rather than a raw invoke body because Android's WebView
/// cannot expose POST bodies to the intercepted custom scheme — Tauri routes
/// IPC through the string bridge there, so `tauri::ipc::Request` never sees
/// `InvokeBody::Raw` on Android (verified: the raw variant failed with
/// "expected a raw byte body" while desktop worked).
#[tauri::command]
pub fn stage_imported_audio_chunk(
    app: AppHandle,
    file_id: String,
    file_name: String,
    chunk_base64: String,
    is_last: bool,
    batch_reset: bool,
) -> Result<Option<String>, String> {
    let file_id: String = file_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    if file_id.is_empty() {
        return Err("stage_imported_audio_chunk: empty file id".to_string());
    }
    // Each file stages under its own uuid folder KEEPING the original file
    // name: the library asset and the copy in the session's audio/ take
    // their names from the source path's basename, so staging as
    // "<uuid>.wav" surfaced uuid-named assets in the UI.
    let file_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(128)
        .collect();
    let file_name = file_name.trim().trim_matches('.').to_string();
    if file_name.is_empty() {
        return Err("stage_imported_audio_chunk: empty file name".to_string());
    }

    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk_base64.as_bytes())
        .map_err(|error| format!("stage_imported_audio_chunk: bad base64: {error}"))?;

    let staging_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("import-staging");
    if batch_reset {
        let _ = std::fs::remove_dir_all(&staging_root);
    }
    let staging_dir = staging_root.join(&file_id);
    std::fs::create_dir_all(&staging_dir).map_err(|error| error.to_string())?;

    let staged_path = staging_dir.join(file_name);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&staged_path)
        .map_err(|error| error.to_string())?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|error| error.to_string())?;

    Ok(is_last.then(|| staged_path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_region_as_package(
    app: AppHandle,
    region_id: String,
    include_audio: bool,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
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

    let Some(target) = pick_export_target(
        &app,
        "Exportar Cancion",
        "LibreTracks Package",
        &["ltpkg"],
        &format!("{}.ltpkg", crate::state::slugify(&region_name)),
    )?
    else {
        return Ok(false);
    };

    let cache_root = crate::state::decoding_cache_root();
    let write_path = target.write_path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        libretracks_project::export_region_as_package(
            &cache_root,
            &song_dir,
            &song,
            &region_id,
            &write_path,
            include_audio,
        )
        .map_err(|error| error.to_string())?;
        target.finish(&app)
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(true)
}

#[tauri::command]
pub fn export_region_rendered_audio(
    app: AppHandle,
    region_id: String,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
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

    let Some(target) = pick_export_target(
        &app,
        "Exportar Audio Renderizado",
        "Wave Audio",
        &["wav"],
        &format!("{}.wav", crate::state::slugify(&region_name)),
    )?
    else {
        return Ok(false);
    };

    state
        .audio
        .export_region_rendered_audio(song_dir, song, &region_id, target.write_path())
        .map_err(|error| error.to_string())?;
    target.finish(&app)?;

    Ok(true)
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

    let Some(target) = pick_export_target(
        &app,
        "Exportar sesion",
        "LibreTracks Set",
        &["ltset"],
        &format!("{}.ltset", crate::state::slugify(&song.title)),
    )?
    else {
        return Ok(false);
    };
    let path = target.write_path().to_path_buf();

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

        // Android: the export landed in a private temp; hand it to the SAF
        // destination the user picked (desktop finish() is a no-op).
        let result = result
            .map_err(|error| error.to_string())
            .and_then(|_| target.finish(&worker_app));

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
    #[cfg(target_os = "android")]
    let (package_source, target_song_dir) = {
        // SAF picker for the .ltset.
        let Some(picked) = crate::mobile_files::pick_file(&app, "Importar sesion (.ltset)")
        else {
            return Ok(false);
        };
        // No extension check: SAF document URIs from providers like Downloads
        // end in an opaque id ("msf:28"), not the display name. The package
        // reader validates the zip structure and reports a clear error.
        let picked_name = sanitize_saf_name_hint(
            &crate::mobile_files::picked_file_name(&picked),
            "sesion-importada.ltset",
        );
        let default_name = picked_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .filter(|name| !name.is_empty())
            .unwrap_or("sesion-importada")
            .to_string();
        // Let the user choose where the new session folder lands (mirroring the
        // desktop "save as" step). The dialog plugin has no folder chooser on
        // Android, so we reuse the SAF create-document dialog and derive the
        // parent folder from the placement. Cancelling cancels the import — no
        // silent fallback to the private songs dir.
        let suggested = crate::state::default_project_file_name(&default_name);
        let Some(folder_pick) = crate::mobile_files::save_file(
            &app,
            "Elige donde guardar la sesion importada",
            &suggested,
        ) else {
            return Ok(false);
        };
        let Some(parent_dir) =
            crate::mobile_files::resolve_picked_document_parent(&folder_pick)
        else {
            return Err(
                "Esa ubicacion no se puede usar como carpeta de sesion. Elige una carpeta \
                 del almacenamiento del dispositivo (no un acceso directo como Descargas o \
                 una nube)."
                    .to_string(),
            );
        };
        let target_song_dir = unique_session_dir(&parent_dir, &default_name);
        ((picked, picked_name), target_song_dir)
    };

    #[cfg(not(target_os = "android"))]
    let (package_source, target_song_dir) = {
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
        (package_file, target_song_dir)
    };

    let worker_app = app.clone();
    thread::spawn(move || {
        let state = worker_app.state::<DesktopState>();
        let result = (|| -> Result<TransportSnapshot, String> {
            // Android: materialize the content:// pick into a private temp
            // file the zip reader can open; desktop already has a real path.
            #[cfg(target_os = "android")]
            let (package_file, staged_cleanup) = {
                let (picked, picked_name) = &package_source;
                let staged = crate::mobile_files::stage_picked_file_to_temp(
                    &worker_app,
                    picked,
                    picked_name,
                )?;
                (staged.clone(), Some(staged))
            };
            #[cfg(not(target_os = "android"))]
            let (package_file, staged_cleanup): (std::path::PathBuf, Option<std::path::PathBuf>) =
                (package_source, None);

            let import_result = {
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
                    .map_err(|error| error.to_string())
            };
            if let Some(staged) = staged_cleanup {
                let _ = std::fs::remove_file(staged);
            }
            import_result?;
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

/// SAF display names may be opaque provider ids ("msf:28") or carry path
/// separators; keep them safe for temp-file names and readable as folder
/// names, falling back when there's nothing usable.
#[cfg(target_os = "android")]
fn sanitize_saf_name_hint(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .collect();
    let cleaned = cleaned.trim_matches(['-', ' ', '.']).to_string();
    // Opaque ids like "msf-28" (no extension, short) make terrible names.
    if cleaned.is_empty() || !cleaned.contains('.') {
        return fallback.to_string();
    }
    cleaned
}

/// First non-existing `<songs>/<name>`, `<songs>/<name>-2`, … folder. Android
/// has no "save as" dialog to resolve collisions, so imports and the
/// choose-folder create pick a fresh folder automatically instead of
/// clobbering an existing session.
/// Whether a directory already contains a session (a `*.ltsession` file at its
/// top level). Used to decide if we can safely inflate a new session directly
/// into a user-picked folder rather than nesting a subfolder inside it.
fn dir_holds_session(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ltsession"))
            .unwrap_or(false)
    })
}

fn unique_session_dir(songs_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let base = songs_dir.join(name);
    if !base.exists() {
        return base;
    }
    for suffix in 2..1000 {
        let candidate = songs_dir.join(format!("{name}-{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    songs_dir.join(format!(
        "{name}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0)
    ))
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
