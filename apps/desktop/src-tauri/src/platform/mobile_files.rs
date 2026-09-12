//! Android file flows over the Storage Access Framework.
//!
//! Desktop uses synchronous native dialogs (`rfd`) and plain filesystem paths.
//! Android has neither: pickers are asynchronous system activities and what
//! they return are `content://` URIs, not paths. This module wraps the two
//! plugins that bridge that world — `tauri-plugin-dialog` (SAF pickers) and
//! `tauri-plugin-fs` (content-resolver file descriptors) — behind blocking
//! helpers shaped like the desktop dialogs, plus copy helpers to move bytes
//! between URIs and the private temp files our zip/import machinery needs.
//!
//! Blocking is safe here: Tauri commands never run on the Android UI thread,
//! and the SAF activity result arrives on the UI thread, which stays free.

#![cfg(target_os = "android")]

use std::path::PathBuf;
use std::sync::mpsc;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use super::document_name::{self, percent_decode};

/// SAF "open document" picker. Blocks until the user picks or cancels.
/// Extensions are advisory only — SAF filters by MIME, and custom extensions
/// like .ltpkg have none, so we accept everything and validate after.
pub fn pick_file(app: &AppHandle, title: &str) -> Option<FilePath> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    rx.recv().ok().flatten()
}

/// SAF "open documents" picker, multi-select. Blocks until the user picks or
/// cancels; an empty vec means cancelled.
///
/// Extensions are advisory only, as in [`pick_file`] — SAF filters by MIME, and
/// providers publish audio under types our list would not predict, so we accept
/// everything and let the importer validate.
pub fn pick_files(app: &AppHandle, title: &str) -> Vec<FilePath> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_files(move |files| {
            let _ = tx.send(files);
        });
    rx.recv().ok().flatten().unwrap_or_default()
}

/// SAF "create document" dialog (the system save-as UI: Downloads, Drive,
/// SD…). Blocks until the user picks a destination or cancels.
pub fn save_file(app: &AppHandle, title: &str, suggested_name: &str) -> Option<FilePath> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(suggested_name)
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    rx.recv().ok().flatten()
}

/// Open a picked `content://` document for reading, without copying it.
///
/// The plugin resolves the URI through the content resolver and hands back a
/// real `std::fs::File` wrapping the descriptor, so it is seekable — which is
/// all a zip reader needs. Prefer this over [`stage_picked_file_to_temp`] for
/// anything large: staging a 2 GiB `.ltset` wrote the whole archive to private
/// storage before extraction had even begun, doubling the I/O of an import that
/// was already the heaviest thing the app does on a phone.
///
/// The returned handle owns the descriptor and closes it on drop. Drop it as
/// soon as the read finishes: leaving it to the JVM finalizer is what produced
/// the `ParcelFileDescriptor.finalize() timed out` crash.
pub fn open_picked_file_for_read(
    app: &AppHandle,
    picked: &FilePath,
) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    app.fs()
        .open(picked.clone(), options)
        .map_err(|error| format!("No se pudo abrir el archivo seleccionado: {error}"))
}

/// A document the user picked for a library audio import, with the display name
/// resolved once at pick time.
///
/// The name has to be captured here: a SAF document id is opaque
/// (`msf:28`), so asking for it later — after the bytes have been copied
/// somewhere — yields a name no user would recognise.
pub struct PickedAudioDocument {
    picked: FilePath,
    file_name: String,
}

impl PickedAudioDocument {
    pub fn new(picked: FilePath) -> Self {
        let file_name = picked_file_name(&picked);
        let file_name = if file_name.trim().is_empty() {
            "audio".to_string()
        } else {
            file_name
        };
        Self { picked, file_name }
    }
}

/// Copy picked `content://` documents into `staging_root`, one folder each, and
/// return the payloads the staged-import core consumes.
///
/// Streams from the descriptor rather than reading whole files into memory, and
/// gives each document its own subfolder so two picks sharing a display name do
/// not overwrite each other before the importer has had a chance to rename
/// them apart.
///
/// A document that cannot be opened or copied is SKIPPED, not fatal: one
/// unreadable file should not lose the rest of a multitrack the user just
/// selected. The staged-import core reports anything missing from the payloads.
pub fn stage_picked_audio_documents(
    app: &AppHandle,
    staging_root: &std::path::Path,
    documents: &[PickedAudioDocument],
    mut on_progress: impl FnMut(usize, usize),
) -> Result<Vec<crate::state::AudioFilePathImportPayload>, String> {
    std::fs::create_dir_all(staging_root).map_err(|error| error.to_string())?;

    let total = documents.len();
    let mut payloads = Vec::with_capacity(total);
    for (index, document) in documents.iter().enumerate() {
        let staged_dir = staging_root.join(index.to_string());
        let copied = (|| -> Result<PathBuf, String> {
            std::fs::create_dir_all(&staged_dir).map_err(|error| error.to_string())?;
            let staged_path = staged_dir.join(&document.file_name);
            let mut source = open_picked_file_for_read(app, &document.picked)?;
            let mut destination =
                std::fs::File::create(&staged_path).map_err(|error| error.to_string())?;
            std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
            Ok(staged_path)
        })();

        match copied {
            Ok(staged_path) => payloads.push(crate::state::AudioFilePathImportPayload {
                file_name: document.file_name.clone(),
                source_path: staged_path.to_string_lossy().into_owned(),
            }),
            Err(error) => {
                crate::infra::error_log::write_error(&format!(
                    "could not stage picked audio \"{}\": {error}",
                    document.file_name
                ));
                let _ = std::fs::remove_dir_all(&staged_dir);
            }
        }
        on_progress(index + 1, total);
    }

    if payloads.is_empty() {
        return Err("No se pudo leer ninguno de los archivos seleccionados.".to_string());
    }
    Ok(payloads)
}

/// Copy a picked source (usually a `content://` URI) into a private staging
/// file so import code that expects a real `std::fs` path can work on it.
/// The caller owns the returned file and should delete it when done.
///
/// Prefer [`open_picked_file_for_read`] when the consumer can work from a
/// handle: this writes a second copy of the whole file.
pub fn stage_picked_file_to_temp(
    app: &AppHandle,
    picked: &FilePath,
    name_hint: &str,
) -> Result<PathBuf, String> {
    let staging_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("saf-staging");
    std::fs::create_dir_all(&staging_dir).map_err(|error| error.to_string())?;
    let dest_path = staging_dir.join(format!("{}-{}", unique_stamp(), name_hint));

    let mut options = OpenOptions::new();
    options.read(true);
    let mut source = app
        .fs()
        .open(picked.clone(), options)
        .map_err(|error| format!("No se pudo abrir el archivo seleccionado: {error}"))?;
    let mut dest = std::fs::File::create(&dest_path).map_err(|error| error.to_string())?;
    std::io::copy(&mut source, &mut dest).map_err(|error| error.to_string())?;
    Ok(dest_path)
}

/// Copy a finished private file (an export we just wrote) into the SAF
/// destination the user picked.
pub fn copy_path_to_picked_target(
    app: &AppHandle,
    source: &std::path::Path,
    target: &FilePath,
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).truncate(true);
    let mut dest = app
        .fs()
        .open(target.clone(), options)
        .map_err(|error| format!("No se pudo escribir en el destino: {error}"))?;
    let mut src = std::fs::File::open(source).map_err(|error| error.to_string())?;
    std::io::copy(&mut src, &mut dest).map_err(|error| error.to_string())?;
    Ok(())
}

/// Private scratch file for an export that will be copied to a SAF target.
pub fn export_temp_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("saf-exports");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!("{}-{}", unique_stamp(), file_name)))
}

/// Try to turn a SAF pick into a REAL filesystem path.
///
/// Needed for open-in-place flows (a session is a folder of files the engine
/// streams by path — a single content:// fd is useless there). Only the
/// external-storage provider encodes a usable location in its document id
/// ("primary:Music/Set/x.ltsession" → /storage/emulated/0/Music/Set/…);
/// provider-virtualized picks (the "Downloads"/"Recents" shortcuts, cloud
/// docs) do not map to paths. Reading the result still needs the storage
/// permission (legacy on Android 10, "all files" on 11+).
pub fn resolve_picked_file_to_path(picked: &FilePath) -> Option<PathBuf> {
    let url = match picked {
        FilePath::Path(path) => return Some(path.clone()),
        FilePath::Url(url) => url,
    };
    if url.host_str() != Some("com.android.externalstorage.documents") {
        return None;
    }
    let last_segment = url.path_segments()?.next_back()?.to_string();
    let doc_id = percent_decode(&last_segment);
    let (volume, relative) = doc_id.split_once(':')?;
    let root = if volume == "primary" {
        "/storage/emulated/0".to_string()
    } else {
        format!("/storage/{volume}")
    };
    let candidate = PathBuf::from(root).join(relative);
    candidate.is_file().then_some(candidate)
}

/// Turn a SAF "create document" pick into the REAL parent DIRECTORY the user
/// chose, so we can build a proper session folder there.
///
/// The plugin has no folder chooser on Android (`pick_folder` is desktop-only),
/// so "choose where to save a session" reuses the create-document dialog
/// (`ACTION_CREATE_DOCUMENT`), which returns a `document/` URI whose id is the
/// full destination path — `primary:Music/Sets/Mi Cancion.ltsession`. We map
/// that the same way as `resolve_picked_file_to_path` (`volume:relative` →
/// `/storage/<volume>/relative`) but return the file's PARENT and require it to
/// be an existing directory. Provider-virtualized picks (the Downloads/Recents
/// shortcuts, cloud roots) don't encode a real path → `None`, so the caller can
/// report a clear "pick a real device folder" message.
///
/// SAF also touches an empty placeholder file at the picked location; the
/// caller should delete it (we only ever wanted the folder).
pub fn resolve_picked_document_parent(picked: &FilePath) -> Option<PathBuf> {
    let url = match picked {
        // Desktop returns a real file path; its parent is the chosen folder.
        FilePath::Path(path) => return path.parent().map(std::path::Path::to_path_buf),
        FilePath::Url(url) => url,
    };
    if url.host_str() != Some("com.android.externalstorage.documents") {
        return None;
    }
    let last_segment = url.path_segments()?.next_back()?.to_string();
    let doc_id = percent_decode(&last_segment);
    let (volume, relative) = doc_id.split_once(':')?;
    let root = if volume == "primary" {
        "/storage/emulated/0".to_string()
    } else {
        format!("/storage/{volume}")
    };
    let file_path = PathBuf::from(root).join(relative);
    let parent = file_path.parent()?.to_path_buf();
    // Clean up the empty placeholder SAF created; ignore failure (it may live
    // under a provider that doesn't expose the real file, or perms may block
    // it — the folder is what we need and that we've validated).
    let _ = std::fs::remove_file(&file_path);
    parent.is_dir().then_some(parent)
}

fn unique_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

/// Display name of a picked file, for validation/messages ("song.ltpkg") and —
/// via the import flows — for the name of the session folder we create.
///
/// The document id is NOT a name: depending on the provider it is
/// `primary:Download/x.ltset` or `raw:/storage/emulated/0/Download/x.ltset`.
/// [`document_name::document_display_name`] keeps only its last path
/// component; handing the whole id downstream is what named imported sessions
/// `raw--storage-emulated-0-Download-x`.
pub fn picked_file_name(picked: &FilePath) -> String {
    match picked {
        FilePath::Path(path) => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .map(document_name::document_display_name)
            .unwrap_or_default(),
    }
}
