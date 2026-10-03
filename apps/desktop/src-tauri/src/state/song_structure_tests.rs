//! Aplicar arreglos en la sesión (paso 04 del plan de arreglos).
//!
//! Fixture, 120 BPM 4/4 (un compás = 2 s):
//!
//! ```text
//! r1 [0, 8)    clip c1
//! r2 [8, 40)   A [8,16) · B [16,32) · C [32,40)   clips xa/xb/xc, cue k2 en 20
//! r3 [40, 48)  clip c3 en 41, marca m3 en 40, cue k3 en 42
//! ```

use std::fs;

use libretracks_core::{
    source_seconds_at_view, warp_timeline_seconds_at, Arrangement, ArrangementBlock, Clip, Marker,
    MarkerKind, Song, SongMaster, SongRegion, TempoMarker, Track, TrackKind,
};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use super::{placed_blocks, relocate_playhead, AppliedChange, PlacedBlock};
use crate::audio::automation::{AutomationAction, AutomationCue, AutomationDocument};
use crate::audio::engine::AudioController;
use crate::state::{next_downbeat_after_in_view_timeline, DesktopSession};

pub(crate) fn region(id: &str, start: f64, end: f64) -> SongRegion {
    SongRegion {
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
        structure: None,
    }
}

pub(crate) fn clip(id: &str, start: f64, duration: f64) -> Clip {
    Clip {
        id: id.into(),
        track_id: "a1".into(),
        file_path: "audio/test.wav".into(),
        timeline_start_seconds: start,
        source_start_seconds: 0.0,
        duration_seconds: duration,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }
}

pub(crate) fn marker(id: &str, start: f64, kind: MarkerKind) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind,
        variant: None,
        color: None,
        category_override: None,
    }
}

pub(crate) fn mute_cue(id: &str, at: f64) -> AutomationCue {
    AutomationCue {
        id: id.into(),
        name: id.into(),
        at_seconds: at,
        enabled: true,
        max_runs: None,
        actions: vec![AutomationAction::SetTrackMute {
            track_id: "a1".into(),
            muted: true,
        }],
    }
}

/// Fixture con las secciones de r2 de `a`, `b` y `c` segundos de fuente.
pub(crate) fn song_with_sections(a: f64, b: f64, c: f64) -> Song {
    let r2_end = 8.0 + a + b + c;
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: r2_end + 8.0,
        tempo_markers: vec![TempoMarker {
            id: "t2".into(),
            start_seconds: 8.0,
            bpm: 120.0,
        }],
        time_signature_markers: vec![],
        regions: vec![
            region("r1", 0.0, 8.0),
            region("r2", 8.0, r2_end),
            region("r3", r2_end, r2_end + 8.0),
        ],
        tracks: vec![Track {
            id: "a1".into(),
            name: "a1".into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }],
        clips: vec![
            clip("c1", 1.0, 1.0),
            clip("xa", 8.0, a),
            clip("xb", 8.0 + a, b),
            clip("xc", 8.0 + a + b, c),
            clip("c3", r2_end + 1.0, 1.0),
        ],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![
            marker("a", 8.0, MarkerKind::Intro),
            marker("b", 8.0 + a, MarkerKind::Verse),
            marker("c", 8.0 + a + b, MarkerKind::Chorus),
            marker("m3", r2_end, MarkerKind::Outro),
        ],
    }
}

pub(crate) fn base_song() -> Song {
    song_with_sections(8.0, 16.0, 8.0)
}

pub(crate) fn base_cues() -> Vec<AutomationCue> {
    vec![mute_cue("k2", 20.0), mute_cue("k3", 42.0)]
}

pub(crate) fn session_with(song: Song, cues: Vec<AutomationCue>) -> DesktopSession {
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "structure").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    crate::state::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 1);
    save_song(&song_dir, &song).expect("save song");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session.automation = AutomationDocument {
        cues,
        track_present: true,
        ..AutomationDocument::default()
    };
    session
}

pub(crate) fn arrangement(id: &str, sections: &[&str]) -> Arrangement {
    Arrangement {
        id: id.into(),
        name: id.into(),
        blocks: sections
            .iter()
            .enumerate()
            .map(|(index, section)| ArrangementBlock {
                id: format!("{id}-{index}"),
                section_marker_id: (*section).into(),
            })
            .collect(),
    }
}

pub(crate) fn song_of(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song")
}

pub(crate) fn span(song: &Song, id: &str) -> (f64, f64) {
    let region = song.regions.iter().find(|r| r.id == id).expect("region");
    (region.start_seconds, region.end_seconds)
}

pub(crate) fn clip_start(song: &Song, id: &str) -> f64 {
    song.clips
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("clip {id}"))
        .timeline_start_seconds
}

pub(crate) fn marker_start(song: &Song, id: &str) -> f64 {
    song.section_markers
        .iter()
        .find(|m| m.id == id)
        .unwrap_or_else(|| panic!("marca {id}"))
        .start_seconds
}

pub(crate) fn cue_positions(session: &DesktopSession) -> Vec<(String, f64)> {
    session
        .automation
        .cues
        .iter()
        .map(|cue| (cue.id.clone(), cue.at_seconds))
        .collect()
}

pub(crate) fn close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{what}: esperado {expected}, obtenido {actual}"
    );
}

/// Si `view` (segundos de vista) cae en un tiempo fuerte de la rejilla.
fn on_downbeat(song: &Song, view: f64) -> bool {
    let next = next_downbeat_after_in_view_timeline(song, view - 1e-3);
    (next - view).abs() < 1e-6
}

pub(crate) fn captured(song: Song, cues: Vec<AutomationCue>) -> (DesktopSession, AudioController) {
    let mut session = session_with(song, cues);
    let audio = AudioController::default();
    session
        .capture_song_structure("r2", &audio)
        .expect("capture");
    (session, audio)
}

/// C1: alargar la del medio 8 compases desplaza la tercera, que sigue
/// empezando en tiempo fuerte, con todo su contenido.
#[test]
fn lengthening_the_middle_song_pushes_the_next_one_with_everything_inside() {
    let (mut session, audio) = captured(base_song(), base_cues());

    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");

    let song = song_of(&session);
    assert_eq!(span(&song, "r2"), (8.0, 56.0));
    assert_eq!(span(&song, "r3"), (56.0, 64.0));
    assert!(on_downbeat(&song, warp_timeline_seconds_at(&song, 56.0)));
    close(clip_start(&song, "c3"), 57.0, "clip de r3");
    close(marker_start(&song, "m3"), 56.0, "marca de r3");
    // El verso repetido: xb otra vez, con id determinista.
    close(clip_start(&song, "xb~2"), 32.0, "copia del verso");
    close(clip_start(&song, "xc"), 48.0, "coro tras los dos versos");
    assert_eq!(
        cue_positions(&session),
        vec![
            ("k2".to_string(), 20.0),
            ("k2~2".to_string(), 36.0),
            ("k3".to_string(), 58.0)
        ]
    );
    let structure = song.regions[1].structure.as_ref().expect("structure");
    assert_eq!(structure.applied_arrangement_id.as_deref(), Some("largo"));
}

/// C2: lo mismo acortando.
#[test]
fn shortening_the_middle_song_pulls_the_next_one_back() {
    let (mut session, audio) = captured(base_song(), base_cues());

    session
        .save_song_arrangement("r2", arrangement("corto", &["a", "c"]), true, &audio)
        .expect("apply");

    let song = song_of(&session);
    assert_eq!(span(&song, "r2"), (8.0, 24.0));
    assert_eq!(span(&song, "r3"), (24.0, 32.0));
    close(clip_start(&song, "c3"), 25.0, "clip de r3");
    close(clip_start(&song, "xc"), 16.0, "coro tras la intro");
    assert!(song.clips.iter().all(|c| c.id != "xb"), "el verso se fue");
    // La cue del verso desaparece con él; la de r3 viaja.
    assert_eq!(cue_positions(&session), vec![("k3".to_string(), 26.0)]);
}

/// C3: aplicar → deshacer → rehacer; `Song` y cues como se espera en cada paso.
#[test]
fn apply_undo_redo_keep_song_and_cues_in_step() {
    let (mut session, audio) = captured(base_song(), base_cues());
    let before_song = song_of(&session);
    let before_cues = session.automation.clone();

    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    let applied_song = song_of(&session);
    let applied_cues = session.automation.clone();
    assert_ne!(applied_song, before_song);

    session.undo_action(&audio).expect("undo");
    assert_eq!(song_of(&session), before_song, "deshacer: Song");
    assert_eq!(session.automation, before_cues, "deshacer: cues");

    session.redo_action(&audio).expect("redo");
    assert_eq!(song_of(&session), applied_song, "rehacer: Song");
    assert_eq!(session.automation, applied_cues, "rehacer: cues");
}

/// C4: aplicar el orden original sobre una canción recién capturada deja el
/// `Song` byte a byte igual que antes de capturar (salvo `structure`).
#[test]
fn applying_the_original_order_leaves_the_song_byte_for_byte_unchanged() {
    // Valores elegidos para que restar el inicio y volver a sumarlo NO sea
    // exacto en coma flotante: (108.0 - 1.79) + 1.79 != 108.0. Si el original
    // se guardara restado, este test fallaría.
    let start = 1.7878835619088065;
    let far = 107.97256582217265;
    assert_ne!((far - start) + start, far, "el fixture debe ser inexacto");
    let mut song = song_with_sections(40.0, 40.0, 40.0);
    song.regions.remove(0);
    song.clips.remove(0);
    let shift = start - 8.0;
    for region in &mut song.regions {
        region.start_seconds += shift;
        region.end_seconds += shift;
    }
    for clip in &mut song.clips {
        clip.timeline_start_seconds += shift;
    }
    for marker in &mut song.section_markers {
        marker.start_seconds += shift;
    }
    song.tempo_markers[0].start_seconds = start;
    song.clips.push(clip("far", far, 1.0));
    let before = serde_json::to_string(&song).expect("json");
    let (mut session, audio) = captured(song, vec![mute_cue("k_far", far)]);
    let cues_before = session.automation.clone();

    session
        .save_song_arrangement("r2", arrangement("igual", &["a", "b", "c"]), true, &audio)
        .expect("apply");

    let mut after = song_of(&session);
    assert!(after.regions[0].structure.is_some());
    after.regions[0].structure = None;
    assert_eq!(serde_json::to_string(&after).expect("json"), before);
    assert_eq!(session.automation, cues_before);
}

/// C5: con warp en la canción arreglada y en la siguiente, las fronteras y las
/// marcas de sección quedan en tiempo fuerte en vista (y este es también el
/// test de warp que el paso 03 dejó para aquí).
#[test]
fn with_warp_the_boundaries_and_sections_stay_on_downbeats() {
    // Fuente a 100 BPM, timeline a 120: 4 compases de fuente = 9,6 s.
    let mut song = song_with_sections(9.6, 19.2, 9.6);
    for id in ["r2", "r3"] {
        let region = song.regions.iter_mut().find(|r| r.id == id).unwrap();
        region.warp_enabled = true;
        region.warp_source_bpm = Some(100.0);
    }
    let (mut session, audio) = captured(song, base_cues());

    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");

    let song = song_of(&session);
    let (r2_start, r2_end) = span(&song, "r2");
    let r3_start = span(&song, "r3").0;
    let view = |s: f64| warp_timeline_seconds_at(&song, s);
    close(view(r2_end), 8.0 + 48.0, "r2 dura 24 compases en vista");
    assert!(on_downbeat(&song, view(r3_start)), "r3 en tiempo fuerte");
    close(
        view(r3_start),
        next_downbeat_after_in_view_timeline(&song, view(r2_end)),
        "r3 justo tras r2",
    );
    for marker in song
        .section_markers
        .iter()
        .filter(|m| m.start_seconds >= r2_start && m.start_seconds < r2_end)
    {
        assert!(
            on_downbeat(&song, view(marker.start_seconds)),
            "{} en {} (vista {})",
            marker.id,
            marker.start_seconds,
            view(marker.start_seconds)
        );
    }
}

/// C6: transposición sin warp (varispeed) en la canción arreglada: las
/// fronteras siguen en tiempo fuerte en vista, como tras reordenar.
#[test]
fn with_varispeed_the_next_song_still_lands_on_a_downbeat() {
    let mut song = base_song();
    song.regions[1].transpose_semitones = 2;
    // Coloca r3 donde la habría puesto un reordenado: en el compás siguiente
    // al final (en vista) de r2.
    let r2_end = song.regions[1].end_seconds;
    let view_start =
        next_downbeat_after_in_view_timeline(&song, warp_timeline_seconds_at(&song, r2_end));
    let r3_start = source_seconds_at_view(&song, view_start);
    let shift = r3_start - song.regions[2].start_seconds;
    song.regions[2].start_seconds += shift;
    song.regions[2].end_seconds += shift;
    song.clips[4].timeline_start_seconds += shift;
    song.section_markers[3].start_seconds += shift;
    song.duration_seconds += shift;
    let (mut session, audio) = captured(song, vec![]);

    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");

    let song = song_of(&session);
    let r2_end = span(&song, "r2").1;
    let r3_start = span(&song, "r3").0;
    let view = |s: f64| warp_timeline_seconds_at(&song, s);
    assert!(on_downbeat(&song, view(r3_start)), "r3 en tiempo fuerte");
    close(
        view(r3_start),
        next_downbeat_after_in_view_timeline(&song, view(r2_end)),
        "r3 justo tras r2",
    );
}

// ── C7: reubicar el playhead ───────────────────────────────────────────────

fn blocks(layout: &[(&str, f64)]) -> Vec<PlacedBlock> {
    let mut cursor = 0.0;
    layout
        .iter()
        .map(|(id, length)| {
            let block = PlacedBlock {
                section_marker_id: (*id).into(),
                start: cursor,
                length: *length,
            };
            cursor += length;
            block
        })
        .collect()
}

fn relocation_case(new_layout: &[(&str, f64)]) -> (Song, Song, AppliedChange) {
    let before = base_song();
    let mut after = before.clone();
    let new_length: f64 = new_layout.iter().map(|(_, l)| l).sum();
    let delta = new_length - 32.0;
    after.regions[1].end_seconds = 8.0 + new_length;
    after.regions[2].start_seconds += delta;
    after.regions[2].end_seconds += delta;
    let change = AppliedChange {
        region_id: "r2".into(),
        old_blocks: blocks(&[("a", 8.0), ("b", 16.0), ("c", 8.0)]),
        new_blocks: blocks(new_layout),
    };
    (before, after, change)
}

#[test]
fn the_playhead_stays_in_the_same_spot_of_a_block_that_still_exists() {
    let (before, after, change) =
        relocation_case(&[("a", 8.0), ("b", 16.0), ("b", 16.0), ("c", 8.0)]);
    // 2 s dentro del coro (32 + 2): el coro pasa a empezar en 8 + 40.
    close(
        relocate_playhead(34.0, &before, &after, &change),
        50.0,
        "coro",
    );
    // Dentro del verso: se queda en el primer verso (desde su índice).
    close(
        relocate_playhead(20.0, &before, &after, &change),
        20.0,
        "verso",
    );
}

#[test]
fn the_playhead_goes_to_the_song_start_when_its_block_is_gone() {
    let (before, after, change) = relocation_case(&[("a", 8.0), ("c", 8.0)]);
    close(
        relocate_playhead(20.0, &before, &after, &change),
        8.0,
        "inicio de r2",
    );
}

#[test]
fn the_playhead_in_a_later_song_moves_with_it() {
    let (before, after, change) =
        relocation_case(&[("a", 8.0), ("b", 16.0), ("b", 16.0), ("c", 8.0)]);
    close(
        relocate_playhead(42.0, &before, &after, &change),
        58.0,
        "r3 empujada",
    );
}

#[test]
fn the_playhead_in_an_earlier_song_does_not_move() {
    let (before, after, change) = relocation_case(&[("c", 8.0)]);
    close(relocate_playhead(3.0, &before, &after, &change), 3.0, "r1");
}

#[test]
fn placed_blocks_accumulate_section_lengths() {
    let (session, _) = captured(base_song(), vec![]);
    let song = song_of(&session);
    let structure = song.regions[1].structure.as_ref().unwrap();
    let placed = placed_blocks(&structure.sections, &["c".into(), "a".into(), "c".into()]);
    let starts: Vec<f64> = placed.iter().map(|b| b.start).collect();
    assert_eq!(starts, vec![0.0, 8.0, 16.0]);
}

// ── Resto de órdenes ───────────────────────────────────────────────────────

#[test]
fn going_back_to_the_original_restores_the_layout() {
    let (mut session, audio) = captured(base_song(), base_cues());
    let original = song_of(&session);
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");

    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original");

    let song = song_of(&session);
    assert_eq!(span(&song, "r2"), (8.0, 40.0));
    assert_eq!(span(&song, "r3"), (40.0, 48.0));
    assert_eq!(song.clips, original.clips);
    assert_eq!(song.section_markers, original.section_markers);
    assert_eq!(
        cue_positions(&session),
        vec![("k2".to_string(), 20.0), ("k3".to_string(), 42.0)]
    );
    // El original y el arreglo se conservan para volver a aplicar.
    let structure = song.regions[1].structure.as_ref().unwrap();
    assert_eq!(structure.applied_arrangement_id, None);
    assert_eq!(structure.arrangements.len(), 1);
}

#[test]
fn each_command_is_a_single_undo_step() {
    let (mut session, audio) = captured(base_song(), base_cues());
    let undo_depth = session.undo_stack.len();
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    assert_eq!(session.undo_stack.len(), undo_depth + 1);
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original");
    assert_eq!(session.undo_stack.len(), undo_depth + 2);
}

#[test]
fn deleting_the_applied_arrangement_goes_back_to_the_original_first() {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");

    session
        .delete_song_arrangement("r2", "largo", &audio)
        .expect("delete");

    let song = song_of(&session);
    assert_eq!(span(&song, "r3"), (40.0, 48.0));
    let structure = song.regions[1].structure.as_ref().unwrap();
    assert!(structure.arrangements.is_empty());
    assert_eq!(structure.applied_arrangement_id, None);
}

#[test]
fn discarding_the_structure_goes_back_and_forgets_it() {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement("r2", arrangement("corto", &["a", "c"]), true, &audio)
        .expect("apply");

    session
        .discard_song_structure("r2", &audio)
        .expect("discard");

    let song = song_of(&session);
    assert_eq!(span(&song, "r2"), (8.0, 40.0));
    assert!(song.regions[1].structure.is_none());
    assert_eq!(
        cue_positions(&session),
        vec![("k2".to_string(), 20.0), ("k3".to_string(), 42.0)]
    );
}

#[test]
fn saving_without_apply_does_not_touch_the_timeline() {
    let (mut session, audio) = captured(base_song(), base_cues());
    let before = song_of(&session);
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            false,
            &audio,
        )
        .expect("save");
    let after = song_of(&session);
    assert_eq!(after.clips, before.clips);
    assert_eq!(span(&after, "r3"), (40.0, 48.0));
    assert_eq!(
        after.regions[1]
            .structure
            .as_ref()
            .unwrap()
            .arrangements
            .len(),
        1
    );
}

#[test]
fn capturing_is_refused_while_an_arrangement_is_applied() {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    assert!(session.capture_song_structure("r2", &audio).is_err());
}

#[test]
fn an_off_beat_section_marker_is_reported_with_the_nearest_downbeat() {
    let mut song = base_song();
    // El verso empieza 0,5 s tarde: a mitad del primer tiempo del compás.
    song.section_markers[1].start_seconds = 16.5;
    let mut session = session_with(song, vec![]);
    let audio = AudioController::default();
    let result = session
        .capture_song_structure("r2", &audio)
        .expect("capture");
    let off_beat: Vec<_> = result
        .warnings
        .iter()
        .filter(|w| w.kind == "offBeatSection")
        .collect();
    assert_eq!(off_beat.len(), 1, "{:?}", result.warnings);
    assert_eq!(off_beat[0].marker_id, "b");
    close(
        off_beat[0].suggested_start_seconds.unwrap(),
        16.0,
        "compás más cercano",
    );
}

#[test]
fn switching_between_arrangements_rebuilds_from_the_original() {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("largo");
    session
        .save_song_arrangement("r2", arrangement("corto", &["c", "a"]), true, &audio)
        .expect("corto");
    let song = song_of(&session);
    assert_eq!(span(&song, "r2"), (8.0, 24.0));
    close(clip_start(&song, "xc"), 8.0, "coro primero");
    close(clip_start(&song, "xa"), 16.0, "intro después");
    assert_eq!(span(&song, "r3"), (24.0, 32.0));
}

/// Paso 06 (C4), lado del motor: aplicar un arreglo con repeticiones no trae
/// ningún fichero nuevo. Los picos se cachean por fichero, así que los clips
/// recortados y repetidos reutilizan los que ya había: no hay análisis nuevo.
#[test]
fn an_arrangement_with_repeats_references_no_new_audio_file() {
    let (mut session, audio) = captured(base_song(), base_cues());
    let files = |song: &Song| {
        song.clips
            .iter()
            .map(|c| c.file_path.clone())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let before = files(&song_of(&session));
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    let after = song_of(&session);
    assert!(after.clips.len() > base_song().clips.len());
    assert_eq!(files(&after), before);
}
