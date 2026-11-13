use std::collections::HashMap;

use serde_json::json;

use super::*;
use crate::model::ChannelMode;

/// Two songs (regions), three tracks (one folder), clips with relative and
/// absolute paths, markers, a tempo change inside the second song.
fn session() -> Song {
    serde_json::from_value(json!({
        "id": "session",
        "title": "Domingo",
        "bpm": 120.0,
        "timeSignature": "4/4",
        "durationSeconds": 400.0,
        "regions": [
            { "id": "r1", "name": "Canción A", "startSeconds": 0.0, "endSeconds": 200.0 },
            { "id": "r2", "name": "Canción B", "startSeconds": 200.0, "endSeconds": 400.0,
              "warpEnabled": true, "warpSourceBpm": 98.0 }
        ],
        "tempoMarkers": [ { "id": "t1", "startSeconds": 200.0, "bpm": 98.0 } ],
        "timeSignatureMarkers": [],
        "tracks": [
            { "id": "folder", "name": "Banda", "kind": "folder", "parentTrackId": null,
              "volume": 1.0, "pan": 0.0, "muted": false, "solo": false },
            { "id": "drums", "name": "Batería", "kind": "audio", "parentTrackId": "folder",
              "volume": 0.8, "pan": 0.0, "muted": false, "solo": false, "color": "#ff0000" },
            { "id": "click", "name": "Click", "kind": "audio", "parentTrackId": null,
              "volume": 1.0, "pan": -1.0, "muted": false, "solo": false, "audioTo": "ext:2-3" }
        ],
        "clips": [
            { "id": "c1", "trackId": "drums", "filePath": "audio/Drums A.wav",
              "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 200.0,
              "gain": 1.0 },
            { "id": "c2", "trackId": "click", "filePath": "audio/Click A.wav",
              "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 200.0,
              "gain": 1.0 },
            { "id": "c3", "trackId": "drums", "filePath": "C:\\Users\\ana\\Stems\\Drums B.wav",
              "timelineStartSeconds": 200.0, "sourceStartSeconds": 0.0, "durationSeconds": 200.0,
              "gain": 1.0 }
        ],
        "sectionMarkers": [
            { "id": "m1", "name": "Intro", "startSeconds": 0.0, "digit": 1 },
            { "id": "m2", "name": "Coro", "startSeconds": 60.0, "digit": 2 },
            { "id": "m3", "name": "Intro", "startSeconds": 200.0, "digit": 1 }
        ]
    }))
    .expect("test session")
}

fn timing() -> TimingSettings {
    TimingSettings {
        global_jump_mode: "nextBar".into(),
        global_jump_bars: 4,
        song_jump_trigger: "regionEnd".into(),
        song_jump_bars: 4,
        song_transition_mode: "instant".into(),
        fade_out_stop_seconds: 2.0,
        vamp_mode: "section".into(),
        vamp_bars: 4,
        pause_at_song_end: false,
        vamp_between_songs: false,
        voice_guide_lead_bars: 1,
        voice_guide_count_in_enabled: false,
    }
}

fn sizes() -> HashMap<String, u64> {
    HashMap::from([
        ("drums a.wav".to_string(), 1_000),
        ("click a.wav".to_string(), 2_000),
        ("drums b.wav".to_string(), 3_000),
    ])
}

fn print(song: &Song, timing: &TimingSettings, sizes: &HashMap<String, u64>) -> SessionFingerprint {
    fingerprint(
        &FingerprintInput {
            song,
            automation_cues: &[],
            timing,
        },
        |path| {
            sizes
                .get(&file_key(path))
                .map(|&size_bytes| AudioFileInfo { size_bytes })
        },
    )
}

fn base() -> SessionFingerprint {
    print(&session(), &timing(), &sizes())
}

fn diffs_after(change: impl FnOnce(&mut Song, &mut TimingSettings, &mut HashMap<String, u64>)) -> Vec<FingerprintDiff> {
    let (mut song, mut timing, mut sizes) = (session(), timing(), sizes());
    change(&mut song, &mut timing, &mut sizes);
    compare(&base(), &print(&song, &timing, &sizes))
}

fn title(name: &str) -> String {
    name.to_string()
}

#[test]
fn same_session_twice_gives_the_same_fingerprint() {
    assert_eq!(base(), base());
    assert!(compare(&base(), &base()).is_empty());
    assert_eq!(base().songs.len(), 2);
    assert_eq!(base().songs[0].title, "Canción A");
}

#[test]
fn serde_round_trip_gives_the_same_fingerprint() {
    let text = serde_json::to_string_pretty(&session()).unwrap();
    let back: Song = serde_json::from_str(&text).unwrap();
    assert_eq!(print(&back, &timing(), &sizes()), base());
}

#[test]
fn another_folder_or_drive_gives_the_same_fingerprint() {
    let diffs = diffs_after(|song, _, _| {
        for clip in &mut song.clips {
            clip.file_path = format!("D:/Shows/Domingo/{}", clip.file_path.replace('\\', "/"));
        }
    });
    assert!(diffs.is_empty(), "{diffs:?}");
}

#[test]
fn file_names_that_differ_only_in_case_are_the_same_file() {
    let diffs = diffs_after(|song, _, _| {
        song.clips[0].file_path = "audio/DRUMS A.WAV".into();
    });
    assert!(diffs.is_empty(), "{diffs:?}");
}

#[test]
fn moving_a_marker_10_ms_is_only_a_timeline_difference() {
    let diffs = diffs_after(|song, _, _| song.section_markers[1].start_seconds += 0.010);
    assert_eq!(
        diffs,
        vec![FingerprintDiff::TimelineDiffers {
            title: title("Canción A")
        }]
    );
}

#[test]
fn a_different_file_of_the_same_name_is_only_an_audio_difference() {
    let diffs = diffs_after(|_, _, sizes| {
        sizes.insert("drums b.wav".into(), 3_001);
    });
    assert_eq!(
        diffs,
        vec![FingerprintDiff::AudioDiffers {
            title: title("Canción B")
        }]
    );
}

#[test]
fn reordering_the_setlist_is_only_a_setlist_difference() {
    // Both songs set their own tempo at their start, so swapping them moves
    // nothing but their place in the set.
    let with_own_tempo = |mut song: Song| {
        song.tempo_markers.push(TempoMarkerFixture::at(0.0, 120.0));
        song
    };
    let reference = print(&with_own_tempo(session()), &timing(), &sizes());
    let mut swapped = with_own_tempo(session());
    let shift = |seconds: f64| if seconds < 200.0 { seconds + 200.0 } else { seconds - 200.0 };
    for region in &mut swapped.regions {
        region.start_seconds = shift(region.start_seconds);
        region.end_seconds = region.start_seconds + 200.0;
    }
    for clip in &mut swapped.clips {
        clip.timeline_start_seconds = shift(clip.timeline_start_seconds);
    }
    for marker in &mut swapped.section_markers {
        marker.start_seconds = shift(marker.start_seconds);
    }
    for marker in &mut swapped.tempo_markers {
        marker.start_seconds = shift(marker.start_seconds);
    }
    let diffs = compare(&reference, &print(&swapped, &timing(), &sizes()));
    assert_eq!(diffs, vec![FingerprintDiff::SetlistOrder]);
}

#[test]
fn a_song_only_on_one_side_is_missing_or_extra() {
    let diffs = diffs_after(|song, _, _| {
        song.regions.retain(|region| region.id != "r2");
    });
    assert_eq!(
        diffs,
        vec![FingerprintDiff::SongMissing {
            title: title("Canción B")
        }]
    );
    let reverse = compare(
        &print(
            &{
                let mut song = session();
                song.regions.retain(|region| region.id != "r2");
                song
            },
            &timing(),
            &sizes(),
        ),
        &base(),
    );
    assert_eq!(
        reverse,
        vec![FingerprintDiff::SongExtra {
            title: title("Canción B")
        }]
    );
}

#[test]
fn changing_the_jump_mode_names_the_setting() {
    let diffs = diffs_after(|_, timing, _| timing.global_jump_mode = "immediate".into());
    assert_eq!(
        diffs,
        vec![FingerprintDiff::TimingSettingsDiffer {
            which: "globalJumpMode".into()
        }]
    );
    let diffs = diffs_after(|_, timing, _| timing.vamp_between_songs = true);
    assert_eq!(
        diffs,
        vec![FingerprintDiff::TimingSettingsDiffer {
            which: "vampBetweenSongs".into()
        }]
    );
}

#[test]
fn a_track_volume_is_only_a_mix_difference_and_does_not_block() {
    let diffs = diffs_after(|song, _, _| song.tracks[1].volume = 0.5);
    let expected = vec![
        FingerprintDiff::MixDiffers {
            title: title("Canción A"),
        },
        FingerprintDiff::MixDiffers {
            title: title("Canción B"),
        },
    ];
    assert_eq!(diffs, expected);
    assert!(diffs.iter().all(|diff| !diff.blocks_arming()));
    let master = diffs_after(|song, _, _| song.regions[0].master.gain = 0.7);
    assert_eq!(
        master,
        vec![FingerprintDiff::MixDiffers {
            title: title("Canción A")
        }]
    );
    assert!(FingerprintDiff::TimelineDiffers { title: title("x") }.blocks_arming());
}

#[test]
fn a_track_channel_mode_is_only_a_mix_difference() {
    for mode in [ChannelMode::Left, ChannelMode::Right, ChannelMode::Mono] {
        let diffs = diffs_after(|song, _, _| song.tracks[1].channel_mode = mode);
        assert!(!diffs.is_empty(), "{mode:?} debe cambiar la huella");
        assert!(
            diffs.iter().all(|diff| matches!(diff, FingerprintDiff::MixDiffers { .. })),
            "{mode:?}: {diffs:?}"
        );
    }
}

#[test]
fn view_only_changes_change_nothing() {
    let diffs = diffs_after(|song, _, _| {
        song.tracks[1].color = Some("#00ff00".into());
        song.tracks[1].name = "Drums".into();
        song.tracks[0].collapsed = true;
        song.tracks[1].height_offset = Some(40);
        song.regions[0].compact_column_width_rem = Some(12.0);
        song.regions[0].name = "Canción A".into();
    });
    assert!(diffs.is_empty(), "{diffs:?}");
}

#[test]
fn a_tempo_change_before_the_song_reaches_its_base_tempo() {
    // A tempo marker at the end of song A changes what rules at song B's
    // start only through B's base tempo; both songs see it once.
    let diffs = diffs_after(|song, _, _| {
        song.tempo_markers.push(TempoMarkerFixture::at(150.0, 140.0));
    });
    assert!(diffs.contains(&FingerprintDiff::TimelineDiffers {
        title: title("Canción A")
    }));
    assert!(!diffs.iter().any(|diff| matches!(diff, FingerprintDiff::AudioDiffers { .. })));
}

#[test]
fn a_hundred_and_fifty_tracks_fingerprint_quickly() {
    // Cost (C6): not an assertion on time, only a printed figure.
    let mut song = session();
    for index in 0..150 {
        let id = format!("t{index}");
        let mut track = song.tracks[1].clone();
        track.id = id.clone();
        track.parent_track_id = None;
        song.tracks.push(track);
        for region in 0..10 {
            let mut clip = song.clips[0].clone();
            clip.id = format!("c{index}-{region}");
            clip.track_id = id.clone();
            clip.timeline_start_seconds = f64::from(region) * 40.0;
            clip.file_path = format!("audio/stem {index} {region}.wav");
            song.clips.push(clip);
        }
    }
    let started = std::time::Instant::now();
    let fingerprint = print(&song, &timing(), &sizes());
    eprintln!(
        "[fingerprint] {} tracks, {} clips: {:?}",
        song.tracks.len(),
        song.clips.len(),
        started.elapsed()
    );
    assert_eq!(fingerprint.songs.len(), 2);
}

struct TempoMarkerFixture;
impl TempoMarkerFixture {
    fn at(start_seconds: f64, bpm: f64) -> crate::model::TempoMarker {
        crate::model::TempoMarker {
            id: format!("tm-{start_seconds}"),
            start_seconds,
            bpm,
            ramp: false,
        }
    }
}

#[test]
fn differences_are_explained_field_by_field() {
    let main: Song = serde_json::from_value(serde_json::json!({
        "id": "s", "title": "S", "durationSeconds": 100.0,
        "regions": [{ "id": "r1", "name": "Uno", "startSeconds": 0.0, "endSeconds": 100.0 }],
        "tracks": [{ "id": "t1", "name": "Drums", "kind": "audio", "parentTrackId": null, "volume": 1.0, "pan": 0.0, "muted": false, "solo": false }],
        "clips": [{ "id": "c1", "trackId": "t1", "filePath": "audio/Drums.wav", "timelineStartSeconds": 0.0, "sourceStartSeconds": 0.0, "durationSeconds": 50.0, "gain": 1.0 }],
        "sectionMarkers": []
    }))
    .unwrap();
    let mut other = main.clone();
    assert!(explain_song_differences(&main, &other, 10).is_empty());
    other.clips[0].duration_seconds = 49.5;
    other.tracks[0].volume = 0.5;
    let lines = explain_song_differences(&main, &other, 10);
    assert!(lines.iter().any(|line| line.contains("timeline.clips[c1].durationSeconds") && line.contains("50.000000")), "{lines:?}");
    assert!(lines.iter().any(|line| line.contains("mix.tracks[t1].volume")), "{lines:?}");
    assert!(lines.iter().all(|line| line.starts_with("«Uno» ")));
}
