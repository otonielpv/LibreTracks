use std::fs;

use libretracks_analysis::{ProposedSignatureMarker, ProposedTempoMarker};
use libretracks_core::{
    Marker, MarkerCategory, MarkerKind, Song, SongMaster, SongRegion, TempoMarker,
    TimeSignatureMarker,
};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use super::{
    apply_key_to_song, apply_sections_to_song, apply_tempo_analysis_to_song, AnalysedSection,
};
use crate::audio::engine::AudioController;
use crate::state::DesktopSession;

fn region(id: &str, start: f64, end: f64) -> SongRegion {
    SongRegion {
        key_changes: Vec::new(),
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        end_seconds: end,
        transpose_semitones: 0,
        key: None,
        warp_enabled: false,
        warp_source_bpm: None,
        master: SongMaster::default(),
        compact_column_width_rem: None,
        chart: None,
        cover_image: None,
        voice_guide_count_style: None,
        structure: None,
    }
}

fn tempo(id: &str, start: f64, bpm: f64) -> TempoMarker {
    TempoMarker {
        id: id.into(),
        start_seconds: start,
        bpm,
        ramp: false,
    }
}

fn proposed(start: f64, bpm: f64) -> ProposedTempoMarker {
    ProposedTempoMarker {
        start_seconds: start,
        bpm,
        ramp: false,
    }
}

fn proposed_signature(start: f64, signature: &str) -> ProposedSignatureMarker {
    ProposedSignatureMarker {
        start_seconds: start,
        signature: signature.into(),
    }
}

/// Three songs: [0, 60), [60, 120), [120, 180).
fn setlist() -> Song {
    Song {
        id: "setlist".into(),
        title: "Setlist".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 180.0,
        tempo_markers: vec![
            tempo("before", 30.0, 100.0),
            tempo("inside_a", 60.0, 128.0),
            tempo("inside_b", 90.0, 64.0),
            tempo("next", 120.0, 140.0),
        ],
        time_signature_markers: vec![TimeSignatureMarker {
            id: "inside_sig".into(),
            start_seconds: 80.0,
            signature: "3/4".into(),
        }],
        regions: vec![
            region("r1", 0.0, 60.0),
            region("r2", 60.0, 120.0),
            region("r3", 120.0, 180.0),
        ],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    }
}

fn tempo_map(song: &Song) -> Vec<(f64, f64)> {
    song.tempo_markers
        .iter()
        .map(|marker| (marker.start_seconds, marker.bpm))
        .collect()
}

#[test]
fn replaces_only_the_markers_inside_the_song() {
    let mut song = setlist();
    apply_tempo_analysis_to_song(
        &mut song,
        "r2",
        &[proposed(60.25, 92.0), proposed(100.0, 96.0)],
        &[proposed_signature(60.25, "6/8")],
    )
    .expect("apply");

    assert_eq!(
        tempo_map(&song),
        vec![(30.0, 100.0), (60.25, 92.0), (100.0, 96.0), (120.0, 140.0)]
    );
    let signatures: Vec<(f64, &str)> = song
        .time_signature_markers
        .iter()
        .map(|marker| (marker.start_seconds, marker.signature.as_str()))
        .collect();
    assert_eq!(signatures, vec![(60.25, "6/8")]);
    // Kept markers keep their ids.
    assert_eq!(song.tempo_markers[0].id, "before");
    assert_eq!(song.tempo_markers[3].id, "next");
    // New ones never collide.
    assert_ne!(song.tempo_markers[1].id, song.tempo_markers[2].id);
}

#[test]
fn a_marker_at_zero_sets_the_base_tempo_and_meter() {
    let mut song = setlist();
    apply_tempo_analysis_to_song(
        &mut song,
        "r1",
        &[proposed(0.0, 87.0)],
        &[proposed_signature(0.0, "12/8")],
    )
    .expect("apply");
    assert_eq!(song.bpm, 87.0);
    assert_eq!(song.time_signature, "12/8");
    // The marker at 30 s was inside r1: gone.
    assert_eq!(tempo_map(&song)[0], (60.0, 128.0));
}

#[test]
fn rejects_out_of_range_values() {
    let mut song = setlist();
    assert!(apply_tempo_analysis_to_song(&mut song, "r2", &[proposed(60.0, 400.0)], &[]).is_err());
    assert!(
        apply_tempo_analysis_to_song(&mut song, "r2", &[], &[proposed_signature(60.0, "x")])
            .is_err()
    );
    assert!(apply_tempo_analysis_to_song(&mut song, "nope", &[], &[]).is_err());
    assert_eq!(
        song.tempo_markers.len(),
        4,
        "a rejected apply changes nothing"
    );
}

#[test]
fn the_key_is_written_or_cleared_on_its_song_only() {
    let mut song = setlist();
    apply_key_to_song(&mut song, "r2", " C#m ").expect("apply");
    assert_eq!(song.regions[1].key.as_deref(), Some("C#m"));
    assert_eq!(song.regions[0].key, None);
    apply_key_to_song(&mut song, "r2", "").expect("clear");
    assert_eq!(song.regions[1].key, None);
    assert!(apply_key_to_song(&mut song, "nope", "D").is_err());
}

fn marker(id: &str, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
        category_override: None,
    }
}

fn section(start: f64, kind: MarkerKind, variant: Option<u8>, name: &str) -> AnalysedSection {
    AnalysedSection {
        start_seconds: start,
        kind,
        variant,
        name: name.into(),
        category_override: None,
    }
}

#[test]
fn guide_sections_replace_the_song_s_own_markers_only() {
    let mut song = setlist();
    song.section_markers = vec![
        marker("before", 10.0),
        marker("inside", 70.0),
        marker("after", 130.0),
    ];
    apply_sections_to_song(
        &mut song,
        "r2",
        &[
            section(64.0, MarkerKind::Intro, None, "Intro"),
            section(80.0, MarkerKind::Chorus, Some(2), "Coro 2"),
            // Outside the song: dropped.
            section(125.0, MarkerKind::Outro, None, "Outro"),
        ],
    )
    .expect("apply");
    let names: Vec<(&str, f64)> = song
        .section_markers
        .iter()
        .map(|m| (m.name.as_str(), m.start_seconds))
        .collect();
    assert_eq!(
        names,
        vec![
            ("before", 10.0),
            ("Intro", 64.0),
            ("Coro 2", 80.0),
            ("after", 130.0)
        ]
    );
    let chorus = &song.section_markers[2];
    assert_eq!((chorus.kind, chorus.variant), (MarkerKind::Chorus, Some(2)));
    assert_ne!(song.section_markers[1].id, song.section_markers[2].id);
}

#[test]
fn a_second_section_on_the_same_spot_goes_in_the_cue_lane() {
    let mut song = setlist();
    apply_sections_to_song(
        &mut song,
        "r2",
        &[
            section(64.0, MarkerKind::Verse, None, "Verso"),
            AnalysedSection {
                category_override: Some(MarkerCategory::Cue),
                ..section(64.0, MarkerKind::Acapella, None, "A Capella")
            },
        ],
    )
    .expect("apply");
    let lanes: Vec<(MarkerKind, MarkerCategory)> = song
        .section_markers
        .iter()
        .map(|m| (m.kind, m.category()))
        .collect();
    assert_eq!(
        lanes,
        vec![
            (MarkerKind::Verse, MarkerCategory::Section),
            (MarkerKind::Acapella, MarkerCategory::Cue),
        ]
    );
}

#[test]
fn two_guide_markers_on_one_spot_of_a_lane_keep_the_first() {
    // "markers are out of order: section_…_15 before section_…_16": two cues
    // on one beat made the engine reject the whole analysis.
    let mut song = setlist();
    apply_sections_to_song(
        &mut song,
        "r2",
        &[
            section(64.0, MarkerKind::Verse, None, "Verso"),
            AnalysedSection {
                category_override: Some(MarkerCategory::Cue),
                ..section(64.0, MarkerKind::Chorus, None, "Coro")
            },
            AnalysedSection {
                category_override: Some(MarkerCategory::Cue),
                ..section(64.0, MarkerKind::Bridge, None, "Puente")
            },
        ],
    )
    .expect("apply");
    let kinds: Vec<MarkerKind> = song.section_markers.iter().map(|m| m.kind).collect();
    assert_eq!(kinds, vec![MarkerKind::Verse, MarkerKind::Chorus]);
    libretracks_core::validate_song(&song).expect("the song stays valid");
}

#[test]
fn a_section_kind_can_be_created_in_the_cue_lane() {
    let song = setlist();
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "cue-lane-create").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    save_song(&song_dir, &song).expect("save");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load");
    let audio = AudioController::default();

    session
        .create_section_marker(
            70.0,
            Some(MarkerKind::Verse),
            None,
            Some("Verso".into()),
            &audio,
        )
        .expect("section");
    session
        .create_section_marker_in_lane(
            70.0,
            Some(MarkerKind::Acapella),
            None,
            Some("A Capella".into()),
            Some(MarkerCategory::Cue),
            &audio,
        )
        .expect("as cue");
    let created = session.engine.song().cloned().expect("song");
    let lanes: Vec<(MarkerKind, MarkerCategory)> = created
        .section_markers
        .iter()
        .map(|m| (m.kind, m.category()))
        .collect();
    assert_eq!(
        lanes,
        vec![
            (MarkerKind::Verse, MarkerCategory::Section),
            (MarkerKind::Acapella, MarkerCategory::Cue),
        ]
    );
    // Asking for the lane the kind already implies stores no override.
    session
        .create_section_marker_in_lane(
            80.0,
            Some(MarkerKind::DrumsIn),
            None,
            None,
            Some(MarkerCategory::Cue),
            &audio,
        )
        .expect("cue");
    let song = session.engine.song().cloned().expect("song");
    let drums = song
        .section_markers
        .iter()
        .find(|m| m.kind == MarkerKind::DrumsIn)
        .expect("drums in");
    assert_eq!(drums.category_override, None);
}

#[test]
fn applying_is_one_undo_step() {
    let song = setlist();
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "song-analysis-undo").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    save_song(&song_dir, &song).expect("save");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song.clone()).expect("load");
    let audio = AudioController::default();

    session
        .apply_song_analysis(
            "r2",
            Some((
                &[proposed(60.0, 92.0), proposed(100.0, 96.0)],
                &[proposed_signature(60.0, "6/8")],
            )),
            Some("Dm".into()),
            None,
            None,
            &audio,
        )
        .expect("apply");
    let applied = session.engine.song().cloned().expect("song");
    assert_eq!(
        tempo_map(&applied),
        vec![(30.0, 100.0), (60.0, 92.0), (100.0, 96.0), (120.0, 140.0)]
    );
    assert_eq!(applied.regions[1].key.as_deref(), Some("Dm"));

    // Tempo and key go back together.
    session.undo_action(&audio).expect("undo");
    let undone = session.engine.song().cloned().expect("song");
    assert_eq!(tempo_map(&undone), tempo_map(&song));
    assert_eq!(undone.time_signature_markers, song.time_signature_markers);
    assert_eq!(undone.regions[1].key, None);
}
