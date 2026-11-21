//! Slide pictures kept on disk (section editor). FreeShow renders each one
//! in a hidden window with two fixed 3 s waits, so a picture costs ~6 s:
//! once made, it is kept under `<base>/<program>/<presentation>/<version>/`,
//! where the version changes when the presentation is edited in the program
//! (FreeShow's modified time + layout), so an edit makes them again.

use std::fs;
use std::path::{Path, PathBuf};

use libretracks_core::LyricsSoftware;

/// Anything outside `[A-Za-z0-9_-]` becomes `_`: ids and versions become
/// safe folder names on every platform.
fn safe(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned
    }
}

fn program(software: LyricsSoftware) -> &'static str {
    match software {
        LyricsSoftware::ProPresenter => "propresenter",
        LyricsSoftware::FreeShow => "freeshow",
        LyricsSoftware::Holyrics => "holyrics",
        LyricsSoftware::Unknown => "unknown",
    }
}

/// The folder of one presentation (all its versions).
fn presentation_dir(base: &Path, software: LyricsSoftware, presentation_id: &str) -> PathBuf {
    base.join(program(software)).join(safe(presentation_id))
}

pub struct ThumbCache {
    dir: PathBuf,
}

impl ThumbCache {
    /// The cache of this version of a presentation. Older versions of the
    /// same presentation are deleted: they will never be shown again.
    pub fn open(base: &Path, software: LyricsSoftware, presentation_id: &str, version: &str) -> Self {
        let parent = presentation_dir(base, software, presentation_id);
        let current = safe(version);
        if let Ok(entries) = fs::read_dir(&parent) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy() != current {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Self {
            dir: parent.join(current),
        }
    }

    fn file(&self, index: u32) -> PathBuf {
        self.dir.join(format!("{index}.txt"))
    }

    /// The picture of a slide, if it was made before (a `data:` URL).
    pub fn get(&self, index: u32) -> Option<String> {
        fs::read_to_string(self.file(index))
            .ok()
            .filter(|url| url.starts_with("data:"))
    }

    /// Keep a picture. A failed write only means it is made again next time.
    pub fn put(&self, index: u32, url: &str) {
        if fs::create_dir_all(&self.dir).is_ok() {
            let _ = fs::write(self.file(index), url);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lt-thumbs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_kept_picture_comes_back_until_the_presentation_changes() {
        let base = temp();
        let cache = ThumbCache::open(&base, LyricsSoftware::FreeShow, "pcosong_1", "100-layout");
        assert_eq!(cache.get(3), None);
        cache.put(3, "data:image/png;base64,AAAA");
        let again = ThumbCache::open(&base, LyricsSoftware::FreeShow, "pcosong_1", "100-layout");
        assert_eq!(again.get(3).as_deref(), Some("data:image/png;base64,AAAA"));
        // Edited in FreeShow: a new version, and the old pictures are gone.
        let edited = ThumbCache::open(&base, LyricsSoftware::FreeShow, "pcosong_1", "200-layout");
        assert_eq!(edited.get(3), None);
        assert!(!presentation_dir(&base, LyricsSoftware::FreeShow, "pcosong_1")
            .join("100-layout")
            .exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn odd_ids_become_safe_folder_names() {
        assert_eq!(safe("../../etc/passwd"), "______etc_passwd");
        assert_eq!(safe(""), "_");
    }
}
