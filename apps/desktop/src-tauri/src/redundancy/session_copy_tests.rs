//! Redundancy step 18: copying the main's session to the backup.

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use libretracks_link::{connect_as_backup, start_host, GuestConfig, GuestEvent, GuestState, HostConfig};

use super::*;
use crate::infra::settings::AppSettings;
use crate::state::FingerprintSource;

/// A main session folder: two audios inside, one imported by reference from
/// another folder (absolute path), a song using all three.
struct MainSession {
    _root: tempfile::TempDir,
    _elsewhere: tempfile::TempDir,
    dir: PathBuf,
    song: Song,
}

fn main_session() -> MainSession {
    let root = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let dir = root.path().join("Domingo");
    fs::create_dir_all(dir.join("audio")).unwrap();
    fs::create_dir_all(dir.join("cache").join("waveforms")).unwrap();
    fs::write(dir.join("audio").join("Drums.wav"), vec![1u8; 3 * 1024 * 1024 + 17]).unwrap();
    fs::write(dir.join("audio").join("Bass.wav"), vec![2u8; 5000]).unwrap();
    fs::write(dir.join("cache").join("waveforms").join("x.ltpeaks"), b"cache").unwrap();
    let external = elsewhere.path().join("Click.wav");
    fs::write(&external, vec![3u8; 70_000]).unwrap();
    let song: Song = serde_json::from_value(serde_json::json!({
        "id": "s", "title": "Domingo", "durationSeconds": 100.0,
        "regions": [{ "id": "r1", "name": "Uno", "startSeconds": 0.0, "endSeconds": 100.0 }],
        "tracks": [
            { "id": "t1", "name": "Drums", "kind": "audio", "parentTrackId": null, "volume": 1.0, "pan": 0.0, "muted": false, "solo": false },
            { "id": "t2", "name": "Bass", "kind": "audio", "parentTrackId": null, "volume": 1.0, "pan": 0.0, "muted": false, "solo": false },
            { "id": "t3", "name": "Click", "kind": "audio", "parentTrackId": null, "volume": 1.0, "pan": 0.0, "muted": false, "solo": false }
        ],
        "clips": [
            { "id": "c1", "trackId": "t1", "filePath": "audio/Drums.wav", "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 50.0, "gain": 1.0 },
            { "id": "c2", "trackId": "t2", "filePath": "audio/Bass.wav", "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 50.0, "gain": 1.0 },
            { "id": "c3", "trackId": "t3", "filePath": external.to_string_lossy(), "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 50.0, "gain": 1.0 }
        ],
        "sectionMarkers": []
    }))
    .unwrap();
    libretracks_project::save_song(&dir, &song).unwrap();
    MainSession {
        _root: root,
        _elsewhere: elsewhere,
        dir,
        song,
    }
}

fn fingerprint_of(song: Song, dir: &Path) -> libretracks_core::session_fingerprint::SessionFingerprint {
    crate::redundancy::fingerprint::compute(
        &FingerprintSource {
            song,
            song_dir: Some(dir.to_path_buf()),
            automation_cues: Vec::new(),
        },
        &AppSettings::default(),
    )
}

#[test]
fn the_manifest_rewrites_external_audio_and_skips_caches() {
    let main = main_session();
    let served = build_manifest("Domingo", &main.song, &main.dir, libretracks_project::SONG_FILE_NAME).unwrap();
    let paths: Vec<_> = served.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, vec!["audio/Bass.wav", "audio/Click.wav", "audio/Drums.wav"]);
    assert!(served.song_document.contains("\"audio/Click.wav\""));
    assert!(!served.song_document.contains(&*main._elsewhere.path().to_string_lossy().replace('\\', "\\\\")));
    assert!(read_chunk(&served, "../secret.txt", 0, 10).is_err(), "only manifest paths");
}

#[test]
fn files_already_there_or_anywhere_local_do_not_travel() {
    let target = tempfile::tempdir().unwrap();
    fs::create_dir_all(target.path().join("audio")).unwrap();
    fs::write(target.path().join("audio").join("Bass.wav"), vec![0u8; 5000]).unwrap();
    let local = tempfile::tempdir().unwrap();
    fs::write(local.path().join("DRUMS.WAV"), vec![0u8; 100]).unwrap();
    let candidates = local_candidates(Some(local.path()), None);
    let files = vec![
        SessionFile { path: "audio/Bass.wav".into(), size: 5000 },
        SessionFile { path: "audio/Drums.wav".into(), size: 100 },
        SessionFile { path: "audio/Click.wav".into(), size: 7 },
        SessionFile { path: "audio/Guide.wav".into(), size: 5000 },
    ];
    let plan = plan_copy(&files, target.path(), &candidates);
    assert_eq!(plan.keep.len(), 1, "same path and size");
    assert_eq!(plan.reuse.len(), 1, "same name (any case) and size elsewhere");
    let fetched: Vec<_> = plan.fetch.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(fetched, vec!["audio/Click.wav", "audio/Guide.wav"]);
    assert_eq!(plan.fetch_bytes(), 5007);
}

#[test]
fn a_session_copies_over_loopback_and_ends_with_the_same_fingerprint() {
    let main = main_session();
    // The backup already has one of the three files in its own session.
    let backup_session = tempfile::tempdir().unwrap();
    fs::write(backup_session.path().join("Bass.wav"), vec![2u8; 5000]).unwrap();
    let copies = tempfile::tempdir().unwrap();

    let (song_file, fetched_bytes) = tauri::async_runtime::block_on(async {
        let mut host = start_host(HostConfig {
            bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
            preferred_port: 0,
            port_attempts: 1,
            accept_guests: false,
            accept_backup: true,
            backup_pin: Some("4321".into()),
            ..HostConfig::new("PC A")
        })
        .await
        .unwrap();
        let port = host.handle.port();
        let handle = host.handle.clone();
        let (dir, song) = (main.dir.clone(), main.song.clone());
        // The main's side, with the same functions the app uses.
        tokio::spawn(async move {
            let mut served = None;
            while let Some(message) = host.backup_messages.recv().await {
                match message {
                    RedundancyMessage::SessionRequest { request_id } => {
                        let manifest =
                            build_manifest("Domingo", &song, &dir, libretracks_project::SONG_FILE_NAME).unwrap();
                        handle.send_to_backup(&RedundancyMessage::SessionManifest {
                            request_id,
                            name: manifest.name.clone(),
                            song_document: manifest.song_document.clone(),
                            files: manifest.files.clone(),
                        });
                        served = Some(manifest);
                    }
                    RedundancyMessage::FileChunkRequest { request_id, path, offset, length } => {
                        if let Some(served) = &served {
                            handle.send_to_backup(&chunk_message(served, request_id, &path, offset, length));
                        }
                    }
                    _ => {}
                }
            }
        });

        let mut backup = connect_as_backup(GuestConfig {
            pin: Some("4321".into()),
            ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), "pc-b")
        })
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while backup.handle.state() != GuestState::Connected {
                let _ = backup.events.recv().await;
            }
        })
        .await
        .unwrap();
        assert!(backup.handle.send_redundancy(RedundancyMessage::SessionRequest { request_id: 7 }));
        let candidates = local_candidates(Some(backup_session.path()), None);
        let mut job: Option<CopyJob> = None;
        let mut requests = 0;
        let song_file = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let Some(GuestEvent::Redundancy(message)) = backup.events.recv().await else {
                    continue;
                };
                let step = match message {
                    RedundancyMessage::SessionManifest { request_id, name, song_document, files } => {
                        let (started, step) = CopyJob::start(
                            request_id,
                            &files,
                            song_document,
                            target_dir(copies.path(), &name),
                            &candidates,
                        )
                        .unwrap();
                        job = Some(started);
                        step
                    }
                    RedundancyMessage::FileChunk { path, offset, data, error, .. } => job
                        .as_mut()
                        .unwrap()
                        .on_chunk(&path, offset, &data, error.as_deref()),
                    _ => continue,
                };
                match step {
                    CopyStep::Request(request) => {
                        requests += 1;
                        assert!(backup.handle.send_redundancy(request));
                    }
                    CopyStep::Done(song_file) => return song_file,
                    CopyStep::Failed(error) => panic!("copy failed: {error}"),
                }
            }
        })
        .await
        .expect("copy finished");
        let progress = job.unwrap().progress;
        assert_eq!(progress.done_bytes, progress.total_bytes);
        assert!(requests >= 5, "chunked: {requests} requests for ~3 MiB");
        (song_file, progress.total_bytes)
    });

    // Two files travelled (Drums + Click); Bass was copied locally, and the
    // progress counts it too (it was stuck at 0 % while copying locally).
    assert_eq!(fetched_bytes, (3 * 1024 * 1024 + 17) + 70_000 + 5000);
    let target = song_file.parent().unwrap().to_path_buf();
    assert!(target.join("audio").join("Bass.wav").exists());
    assert!(!target.join("cache").exists(), "caches are regenerated, not copied");
    let copied = libretracks_project::load_song(&target).unwrap();
    assert_eq!(
        fingerprint_of(copied, &target),
        fingerprint_of(main.song.clone(), &main.dir),
        "same session on both"
    );
}

#[test]
fn an_interrupted_copy_never_leaves_a_session_to_open() {
    let main = main_session();
    let served = build_manifest("Domingo", &main.song, &main.dir, libretracks_project::SONG_FILE_NAME).unwrap();
    let copies = tempfile::tempdir().unwrap();
    let target = target_dir(copies.path(), "Domingo");
    let (mut job, step) =
        CopyJob::start(1, &served.files, served.song_document.clone(), target.clone(), &HashMap::new()).unwrap();
    // Feed chunks until the copy is in the middle of a file.
    let mut step = step;
    let path = loop {
        let CopyStep::Request(RedundancyMessage::FileChunkRequest { path, offset, length, .. }) = step else {
            panic!("expected a request, got {step:?}");
        };
        if offset > 0 {
            break path;
        }
        let RedundancyMessage::FileChunk { data, .. } = chunk_message(&served, 1, &path, offset, length) else {
            unreachable!()
        };
        step = job.on_chunk(&path, offset, &data, None);
    };
    // The network goes here: the job is dropped.
    drop(job);
    assert!(!target.join(libretracks_project::SONG_FILE_NAME).exists(), "no session document");
    assert!(!target.join(&path).exists(), "no half file under its real name");
    assert!(target.join(format!("{path}.part")).exists());
}
