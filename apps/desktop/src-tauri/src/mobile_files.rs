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

/// Copy a picked source (usually a `content://` URI) into a private staging
/// file so import code that expects a real `std::fs` path can work on it.
/// The caller owns the returned file and should delete it when done.
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

fn unique_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

/// Display name of a picked file, for validation/messages ("song.ltpkg").
pub fn picked_file_name(picked: &FilePath) -> String {
    match picked {
        FilePath::Path(path) => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .map(|segment| {
                // SAF document ids come URL-encoded ("primary%3ADownload%2Fx.ltpkg").
                percent_decode(segment)
            })
            .unwrap_or_default(),
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
