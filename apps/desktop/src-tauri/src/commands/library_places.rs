//! Library of disk folders ("places", like Ableton's browser): list one folder
//! of the user's disk so the library can browse it and drag audio out of it.
//!
//! Lists exactly one level — never walks the tree. The UI expands a folder by
//! asking for it, so opening a place with thousands of files nested below costs
//! one directory read, not a disk scan. Only names and kinds: nothing is opened
//! or decoded here (that happens on import, as with any other audio).
//!
//! `(async)` like every library command: these read the disk, and a plain
//! command would run on the main thread (see commands/library.rs).

use std::cmp::Ordering;
use std::path::Path;

use serde::Serialize;

/// Audio the importer accepts. Keep in step with SUPPORTED_AUDIO_EXTENSIONS in
/// features/transport/library/dragDrop.ts.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"];
const PACKAGE_EXTENSION: &str = "ltpkg";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LibraryDirEntryKind {
    Folder,
    Audio,
    Video,
    Package,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDirEntry {
    pub name: String,
    pub path: String,
    pub kind: LibraryDirEntryKind,
}

fn entry_kind(path: &Path, is_dir: bool) -> Option<LibraryDirEntryKind> {
    if is_dir {
        return Some(LibraryDirEntryKind::Folder);
    }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        Some(LibraryDirEntryKind::Audio)
    } else if libretracks_core::VIDEO_FILE_EXTENSIONS.contains(&extension.as_str()) {
        Some(LibraryDirEntryKind::Video)
    } else if extension == PACKAGE_EXTENSION {
        Some(LibraryDirEntryKind::Package)
    } else {
        None
    }
}

/// Folders first, then files; each group by name, case-insensitively and with
/// numbers in order ("2 Bass" before "10 Keys"), the way a file browser does.
fn compare_entries(left: &LibraryDirEntry, right: &LibraryDirEntry) -> Ordering {
    let left_folder = left.kind == LibraryDirEntryKind::Folder;
    let right_folder = right.kind == LibraryDirEntryKind::Folder;
    right_folder
        .cmp(&left_folder)
        .then_with(|| natural_cmp(&left.name, &right.name))
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let mut left_number = String::new();
                while let Some(c) = left_chars.peek().copied().filter(char::is_ascii_digit) {
                    left_number.push(c);
                    left_chars.next();
                }
                let mut right_number = String::new();
                while let Some(c) = right_chars.peek().copied().filter(char::is_ascii_digit) {
                    right_number.push(c);
                    right_chars.next();
                }
                let left_trimmed = left_number.trim_start_matches('0');
                let right_trimmed = right_number.trim_start_matches('0');
                let ordering = left_trimmed
                    .len()
                    .cmp(&right_trimmed.len())
                    .then_with(|| left_trimmed.cmp(right_trimmed));
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (Some(l), Some(r)) => {
                let ordering = l.to_lowercase().cmp(r.to_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

/// One level of `dir`: subfolders and the files the app can use. Hidden
/// entries (dot-files, and on Windows the hidden attribute) are left out.
pub fn list_dir_entries(dir: &Path) -> Result<Vec<LibraryDirEntry>, String> {
    let read = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || is_hidden(&entry) {
            continue;
        }
        // file_type() does not follow symlinks; metadata() does, so a linked
        // folder still browses like a folder.
        let Ok(metadata) = std::fs::metadata(entry.path()) else {
            continue;
        };
        let path = entry.path();
        let Some(kind) = entry_kind(&path, metadata.is_dir()) else {
            continue;
        };
        entries.push(LibraryDirEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            kind,
        });
    }
    entries.sort_by(compare_entries);
    Ok(entries)
}

#[cfg(windows)]
fn is_hidden(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    entry
        .metadata()
        .map(|metadata| metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden(_entry: &std::fs::DirEntry) -> bool {
    false
}

#[tauri::command(async)]
pub fn list_library_dir(path: String) -> Result<Vec<LibraryDirEntry>, String> {
    list_dir_entries(Path::new(&path))
}

/// Ask the user for a folder to add to the library. `None` = cancelled.
///
/// iOS: the same picker sessions use. It keeps a security-scoped bookmark of
/// the folder and reopens access to it at every launch (IosFolderPickerPlugin
/// `restoreBookmarks`), so the folder can be listed with `std::fs` and its
/// audio imported by reference after a restart. Android has no folder picker
/// here yet (plan next-release, step 12): it keeps the classic library.
#[tauri::command]
pub async fn pick_library_place(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        libretracks_ios_folder_picker::pick_folder(app).await
    }

    #[cfg(target_os = "android")]
    {
        let _ = app;
        Ok(None)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let picked = crate::platform::file_dialog::FileDialog::new()
            .set_title("Añadir carpeta a la biblioteca")
            .pick_folder();
        Ok(picked.map(|path| path.to_string_lossy().into_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_folders_first_then_usable_files_in_natural_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("Stems")).unwrap();
        fs::create_dir(dir.path().join("2 Live")).unwrap();
        for name in [
            "10 Keys.wav",
            "2 Bass.WAV",
            "Click.mp3",
            "notes.txt",
            ".hidden.wav",
            "Song.ltpkg",
            "Clip.mp4",
        ] {
            fs::write(dir.path().join(name), b"").unwrap();
        }

        let entries = list_dir_entries(dir.path()).expect("list");
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            ["2 Live", "Stems", "2 Bass.WAV", "10 Keys.wav", "Click.mp3", "Clip.mp4", "Song.ltpkg"]
        );
        let kinds: Vec<_> = entries.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds[0], LibraryDirEntryKind::Folder);
        assert_eq!(kinds[2], LibraryDirEntryKind::Audio);
        assert_eq!(kinds[5], LibraryDirEntryKind::Video);
        assert_eq!(kinds[6], LibraryDirEntryKind::Package);
    }

    #[test]
    fn lists_one_level_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("Song")).unwrap();
        fs::write(dir.path().join("Song").join("Drums.wav"), b"").unwrap();

        let entries = list_dir_entries(dir.path()).expect("list");
        assert_eq!(entries.len(), 1, "the nested file is not listed");
        assert_eq!(entries[0].kind, LibraryDirEntryKind::Folder);
    }

    #[test]
    fn a_missing_folder_is_an_error_not_a_panic() {
        assert!(list_dir_entries(Path::new("/definitely/not/here/lt")).is_err());
    }
}
