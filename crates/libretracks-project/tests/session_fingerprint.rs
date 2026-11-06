//! Redundancy step 03: the session fingerprint survives saving, reloading,
//! migrating v7 to v8 and moving the session folder to another machine.

use std::path::Path;

use libretracks_core::session_fingerprint::{
    compare, file_key, fingerprint, AudioFileInfo, FingerprintInput, SessionFingerprint,
    TimingSettings,
};
use libretracks_core::Song;
use libretracks_project::{load_song, load_song_from_file, save_song};

fn demo_fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/resources/demo/song.ltsession")
}

/// Sizes as the desktop adapter reads them: `fs::metadata` of each clip's
/// file resolved against the session folder.
fn print_in(song: &Song, song_dir: &Path) -> SessionFingerprint {
    fingerprint(
        &FingerprintInput {
            song,
            automation_cues: &[],
            timing: &TimingSettings::default(),
        },
        |path| {
            let resolved = if Path::new(path).is_absolute() {
                Path::new(path).to_path_buf()
            } else {
                song_dir.join(path)
            };
            std::fs::metadata(resolved)
                .ok()
                .map(|meta| AudioFileInfo {
                    size_bytes: meta.len(),
                })
        },
    )
}

fn write_fake_audio(song: &Song, song_dir: &Path) {
    for clip in &song.clips {
        let name = file_key(&clip.file_path);
        let target = song_dir.join("audio").join(name);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // Size depends on the name only: the same in every folder.
        std::fs::write(&target, vec![0u8; 100 + clip.file_path.len()]).unwrap();
    }
}

fn relative_audio(mut song: Song) -> Song {
    for clip in &mut song.clips {
        clip.file_path = format!("audio/{}", file_key(&clip.file_path));
    }
    song
}

#[test]
fn saving_and_reloading_gives_the_same_fingerprint() {
    let song = relative_audio(load_song_from_file(demo_fixture()).expect("demo"));
    let dir = tempfile::tempdir().unwrap();
    write_fake_audio(&song, dir.path());
    let before = print_in(&song, dir.path());
    save_song(dir.path(), &song).unwrap();
    let reloaded = load_song(dir.path()).unwrap();
    assert_eq!(print_in(&reloaded, dir.path()), before);
}

#[test]
fn a_v7_document_and_its_v8_version_give_the_same_fingerprint() {
    let v7_text = std::fs::read_to_string(demo_fixture()).unwrap();
    let mut v8: serde_json::Value = serde_json::from_str(&v7_text).unwrap();
    assert_eq!(v8["version"], 7);
    v8["version"] = 8.into();
    v8["videoClips"] = serde_json::json!([]);
    let dir7 = tempfile::tempdir().unwrap();
    let dir8 = tempfile::tempdir().unwrap();
    std::fs::write(dir7.path().join("song.ltsession"), &v7_text).unwrap();
    std::fs::write(
        dir8.path().join("song.ltsession"),
        serde_json::to_string_pretty(&v8).unwrap(),
    )
    .unwrap();
    let song7 = load_song_from_file(dir7.path().join("song.ltsession")).expect("v7");
    let song8 = load_song_from_file(dir8.path().join("song.ltsession")).expect("v8");
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(print_in(&song7, empty.path()), print_in(&song8, empty.path()));
}

#[test]
fn the_same_session_in_two_folders_gives_the_same_fingerprint() {
    let song = relative_audio(load_song_from_file(demo_fixture()).expect("demo"));
    let machine_a = tempfile::tempdir().unwrap();
    let machine_b = tempfile::tempdir().unwrap();
    let dir_a = machine_a.path().join("Shows").join("Domingo");
    let dir_b = machine_b.path().join("Users").join("otro").join("Sesiones").join("Domingo");
    for dir in [&dir_a, &dir_b] {
        std::fs::create_dir_all(dir).unwrap();
        write_fake_audio(&song, dir);
        save_song(dir, &song).unwrap();
    }
    let a = print_in(&load_song(&dir_a).unwrap(), &dir_a);
    let b = print_in(&load_song(&dir_b).unwrap(), &dir_b);
    assert!(compare(&a, &b).is_empty(), "{:?}", compare(&a, &b));
    assert_eq!(a, b);
}
