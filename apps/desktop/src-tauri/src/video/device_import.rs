//! Adding a video from the phone itself (plan `video-mobile`, paso 08 §3):
//! the file is **copied** into the session's `video/` folder, like audio on a
//! phone (a picked document's permission does not outlive the app, and a
//! session must travel whole). The copy streams: a 1 GB video never sits in
//! memory or crosses the base64 bridge (README regla 6).
//!
//! The pure parts (the name in `video/`, the copy) are compiled everywhere and
//! tested; the picker and the worker that uses them are in
//! `commands/video.rs`.

// Used by the phone builds; compiled everywhere so the desktop tests cover it.
#![cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]

use std::io::{Read, Write};
use std::path::Path;

/// A name for `wanted` inside `dir` that no file there uses yet:
/// `clip.mp4`, then `clip (2).mp4`, `clip (3).mp4`… Path separators and
/// characters a file system refuses are replaced, so a provider's display
/// name ("Vídeo: ensayo/2") cannot escape the folder.
pub fn unique_video_name(dir: &Path, wanted: &str) -> String {
    let cleaned: String = wanted
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    let cleaned = if cleaned.is_empty() {
        "video.mp4".to_string()
    } else {
        cleaned
    };
    if !dir.join(&cleaned).exists() {
        return cleaned;
    }
    let (stem, extension) = match cleaned.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (cleaned.clone(), String::new()),
    };
    (2..)
        .map(|index| format!("{stem} ({index}){extension}"))
        .find(|candidate| !dir.join(candidate).exists())
        .unwrap_or(cleaned)
}

/// The name a picked video gets in the session: the provider's display name
/// ("ensayo.mp4") when it has one, else what the URI ends in. The photo
/// picker's URIs end in a bare number (`…/media/32`), which would be a file
/// with no name and no extension: then "video-32.mp4".
pub fn picked_video_name(display_name: Option<&str>, uri_tail: &str) -> String {
    let display_name = display_name.map(str::trim).filter(|name| !name.is_empty());
    let base = display_name.unwrap_or(uri_tail.trim());
    let has_extension = base.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty() && !extension.is_empty() && extension.len() <= 5
    });
    match (has_extension, base.is_empty()) {
        // The photo picker hides the real name on purpose and answers
        // "<id>.mp4" even through DISPLAY_NAME (seen on Android 16).
        (true, _)
            if base
                .split('.')
                .next()
                .is_some_and(|stem| stem.chars().all(|c| c.is_ascii_digit())) =>
        {
            format!("video-{base}")
        }
        (true, _) => base.to_string(),
        (false, true) => "video.mp4".to_string(),
        (false, false) if base.chars().all(|c| c.is_ascii_digit()) => format!("video-{base}.mp4"),
        (false, false) => format!("{base}.mp4"),
    }
}

/// Copy `source` into `song_dir/video/<unique name>` and return the path the
/// session stores (`video/<name>`, relative). Streams in 1 MiB chunks; a
/// half-written file is removed on error.
pub fn copy_into_session(
    source: &mut dyn Read,
    song_dir: &Path,
    file_name: &str,
) -> std::io::Result<String> {
    let dir = song_dir.join("video");
    std::fs::create_dir_all(&dir)?;
    let name = unique_video_name(&dir, file_name);
    let destination = dir.join(&name);
    let result = (|| {
        let mut out =
            std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(&destination)?);
        std::io::copy(source, &mut out)?;
        out.flush()?;
        out.into_inner()
            .map_err(|error| error.into_error())?
            .sync_all()
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    Ok(format!("video/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Found on the Android emulator: the photo picker's URI ends in "32".
    #[test]
    fn a_picked_video_keeps_its_real_name() {
        assert_eq!(picked_video_name(Some("ensayo.mp4"), "32"), "ensayo.mp4");
        assert_eq!(picked_video_name(None, "32"), "video-32.mp4");
        assert_eq!(picked_video_name(Some("  "), "Letras.MOV"), "Letras.MOV");
        assert_eq!(picked_video_name(Some("Mi vídeo"), "7"), "Mi vídeo.mp4");
        assert_eq!(picked_video_name(None, ""), "video.mp4");
        assert_eq!(picked_video_name(Some("32.mp4"), "32"), "video-32.mp4");
    }

    #[test]
    fn a_taken_name_gets_a_number_and_odd_characters_are_replaced() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(unique_video_name(dir.path(), "ensayo.mp4"), "ensayo.mp4");
        std::fs::write(dir.path().join("ensayo.mp4"), b"x").unwrap();
        assert_eq!(
            unique_video_name(dir.path(), "ensayo.mp4"),
            "ensayo (2).mp4"
        );
        std::fs::write(dir.path().join("ensayo (2).mp4"), b"x").unwrap();
        assert_eq!(
            unique_video_name(dir.path(), "ensayo.mp4"),
            "ensayo (3).mp4"
        );
        assert_eq!(unique_video_name(dir.path(), "../a/b:c.mov"), "_a_b_c.mov");
        assert_eq!(unique_video_name(dir.path(), "   "), "video.mp4");
    }

    #[test]
    fn a_picked_video_is_copied_whole_into_the_session_with_a_relative_path() {
        let session = tempfile::tempdir().expect("session");
        let bytes: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let relative =
            copy_into_session(&mut bytes.as_slice(), session.path(), "Mi vídeo.MOV").expect("copy");
        assert_eq!(relative, "video/Mi vídeo.MOV");
        assert_eq!(
            std::fs::read(session.path().join(&relative)).unwrap(),
            bytes
        );
        let again =
            copy_into_session(&mut bytes.as_slice(), session.path(), "Mi vídeo.MOV").unwrap();
        assert_eq!(again, "video/Mi vídeo (2).MOV");
    }

    #[test]
    fn a_copy_that_fails_leaves_nothing_behind() {
        struct Broken(usize);
        impl Read for Broken {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.0 == 0 {
                    return Err(std::io::Error::other("provider went away"));
                }
                self.0 -= 1;
                buffer[0] = 1;
                Ok(1)
            }
        }
        let session = tempfile::tempdir().expect("session");
        assert!(copy_into_session(&mut Broken(10), session.path(), "v.mp4").is_err());
        assert!(!session.path().join("video").join("v.mp4").exists());
    }
}
