//! `capture_original` y `build_arrangement` (paso 03 del plan de arreglos).
//!
//! Fixture base, 120 BPM 4/4 (un compás = 2 s), región en [10, 58):
//!
//! ```text
//! relativo  0        8                24               40        48
//!           | Intro  | Verso          | Coro           | Final   |
//! a_cross            ·       [16 ────────── 32)                     fade-out 1 s
//! a_parts   [0─i─8)  [8───v───24)     [24───c───40)    [40─f─48)
//! a_full    [0 ─────────────────────────────────────────────── 48)
//! video     [0 ────────────── 24)
//! midi                   20: nota de 8 s (cruza a Coro) + PC a +6
//! marcas    intro    verso            coro    build(30)  final
//! cue                        20: salto a "coro"
//! ```

use super::*;
use crate::automation::AutomationTransition;
use crate::model::{MarkerKind, MidiEvent, SongMaster, SongRegion, Track, TrackKind};

const ORIGIN: f64 = 10.0;

fn marker(id: &str, rel: f64, kind: MarkerKind) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: ORIGIN + rel,
        digit: None,
        kind,
        variant: None,
        color: None,
        category_override: None,
    }
}

fn clip(id: &str, track: &str, file: &str, rel: f64, duration: f64) -> Clip {
    Clip {
        id: id.into(),
        track_id: track.into(),
        file_path: file.into(),
        timeline_start_seconds: ORIGIN + rel,
        source_start_seconds: rel,
        duration_seconds: duration,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }
}

fn track(id: &str, kind: TrackKind) -> Track {
    Track {
        id: id.into(),
        name: id.into(),
        kind,
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
    }
}

fn region(id: &str, start: f64, end: f64) -> SongRegion {
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

fn jump_to_marker(id: &str, rel: f64, target: &str) -> AutomationCue {
    AutomationCue {
        id: id.into(),
        name: id.into(),
        at_seconds: ORIGIN + rel,
        enabled: true,
        max_runs: None,
        actions: vec![AutomationAction::Jump {
            target: AutomationJumpTarget::Marker {
                marker_id: target.into(),
            },
            transition: AutomationTransition::default(),
            mix_scene_id: None,
        }],
    }
}

/// Canción con una región previa [0, 8) (a 100 BPM, para que el tempo base
/// de la región venga de fuera) y la región del fixture en [10, 58).
fn base_song() -> Song {
    let mut crossing = clip("a_cross", "a1", "cross.wav", 16.0, 16.0);
    crossing.fade_out_seconds = Some(1.0);
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm: 100.0,
        time_signature: "4/4".into(),
        duration_seconds: 58.0,
        tempo_markers: vec![TempoMarker {
            id: "t0".into(),
            start_seconds: ORIGIN,
            bpm: 120.0,
        }],
        time_signature_markers: vec![TimeSignatureMarker {
            id: "ts0".into(),
            start_seconds: ORIGIN,
            signature: "4/4".into(),
        }],
        regions: vec![region("prev", 0.0, 8.0), region("r", ORIGIN, ORIGIN + 48.0)],
        tracks: vec![
            track("a1", TrackKind::Audio),
            track("a2", TrackKind::Audio),
            track("a3", TrackKind::Audio),
            track("midi", TrackKind::Midi),
            track("video", TrackKind::Video),
        ],
        clips: vec![
            crossing,
            clip("a_intro", "a2", "parts.wav", 0.0, 8.0),
            clip("a_verso", "a2", "parts.wav", 8.0, 16.0),
            clip("a_coro", "a2", "parts.wav", 24.0, 16.0),
            clip("a_final", "a2", "parts.wav", 40.0, 8.0),
            clip("a_full", "a3", "full.wav", 0.0, 48.0),
            // De la canción anterior: no entra en la instantánea.
            Clip {
                timeline_start_seconds: 1.0,
                ..clip("other", "a1", "other.wav", 0.0, 2.0)
            },
        ],
        midi_clips: vec![MidiClip {
            id: "m1".into(),
            track_id: "midi".into(),
            timeline_start_seconds: ORIGIN + 20.0,
            name: "luces".into(),
            events: vec![
                MidiEvent {
                    id: "note".into(),
                    at_seconds: 0.0,
                    channel: None,
                    kind: MidiEventKind::Note {
                        note: 60,
                        velocity: 100,
                        duration_seconds: 8.0,
                    },
                },
                MidiEvent {
                    id: "pc".into(),
                    at_seconds: 6.0,
                    channel: None,
                    kind: MidiEventKind::ProgramChange { program: 5 },
                },
            ],
            color: None,
        }],
        video_clips: vec![VideoClip {
            id: "v1".into(),
            track_id: "video".into(),
            file_path: "video.mp4".into(),
            timeline_start_seconds: ORIGIN,
            source_start_seconds: 0.0,
            duration_seconds: 24.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            fit: None,
            color: None,
        }],
        section_markers: vec![
            marker("intro", 0.0, MarkerKind::Intro),
            marker("verso", 8.0, MarkerKind::Verse),
            marker("coro", 24.0, MarkerKind::Chorus),
            marker("build", 30.0, MarkerKind::Build),
            marker("final", 40.0, MarkerKind::Outro),
        ],
    }
}

fn base_cues() -> Vec<AutomationCue> {
    vec![
        jump_to_marker("k", 20.0, "coro"),
        // De la canción anterior (1 s absoluto): no entra.
        AutomationCue {
            at_seconds: 1.0,
            ..jump_to_marker("other", 0.0, "coro")
        },
    ]
}

struct Fixture {
    snapshot: OriginalSnapshot,
    sections: Vec<OriginalSection>,
    warnings: Vec<CaptureWarning>,
}

fn capture(song: &Song, cues: &[AutomationCue]) -> Fixture {
    let (snapshot, sections, warnings) = capture_original(song, cues, "r").expect("capture");
    Fixture {
        snapshot,
        sections,
        warnings,
    }
}

fn base() -> Fixture {
    capture(&base_song(), &base_cues())
}

fn blocks(names: &[&str]) -> Vec<ArrangementBlock> {
    names
        .iter()
        .enumerate()
        .map(|(index, name)| ArrangementBlock {
            id: format!("b{index}"),
            section_marker_id: (*name).into(),
        })
        .collect()
}

fn build(fixture: &Fixture, names: &[&str]) -> BuiltRegion {
    build_arrangement(&fixture.snapshot, &fixture.sections, &blocks(names)).expect("build")
}

fn rel(position: f64) -> f64 {
    position - ORIGIN
}

fn close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "{what}: esperado {expected}, obtenido {actual}"
    );
}

fn as_snapshot_lists(built: &BuiltRegion) -> OriginalSnapshot {
    OriginalSnapshot {
        clips: built.clips.clone(),
        midi_clips: built.midi_clips.clone(),
        video_clips: built.video_clips.clone(),
        tempo_markers: built.tempo_markers.clone(),
        time_signature_markers: built.time_signature_markers.clone(),
        section_markers: built.section_markers.clone(),
        automation_cues: built.automation_cues.clone(),
        ..OriginalSnapshot::default()
    }
}

fn lists_only(snapshot: &OriginalSnapshot) -> OriginalSnapshot {
    OriginalSnapshot {
        origin_seconds: 0.0,
        duration_seconds: 0.0,
        base_bpm: 0.0,
        base_time_signature: String::new(),
        ..snapshot.clone()
    }
}

// ── Captura ────────────────────────────────────────────────────────────────

#[test]
fn capture_keeps_only_what_belongs_to_the_region_in_timeline_coordinates() {
    let fixture = base();
    let snapshot = &fixture.snapshot;
    assert_eq!(snapshot.origin_seconds, ORIGIN);
    assert_eq!(snapshot.duration_seconds, 48.0);
    // El tempo y el compás de fuera: la base del proyecto (100), no la marca
    // de dentro (120).
    assert_eq!(snapshot.base_bpm, 100.0);
    assert_eq!(snapshot.base_time_signature, "4/4");
    assert_eq!(
        snapshot.clips.len(),
        6,
        "el clip de la canción anterior queda fuera"
    );
    assert!(snapshot.clips.iter().all(|c| c.id != "other"));
    assert_eq!(snapshot.automation_cues.len(), 1);
    assert_eq!(snapshot.automation_cues[0].id, "k");
    // Posiciones tal cual estaban en el timeline.
    assert_eq!(snapshot.clips[0].timeline_start_seconds, ORIGIN + 16.0);
}

#[test]
fn capture_finds_the_sections_and_cue_markers_do_not_cut() {
    let fixture = base();
    let found: Vec<(&str, f64, f64)> = fixture
        .sections
        .iter()
        .map(|s| (s.marker_id.as_str(), s.start_seconds, s.end_seconds))
        .collect();
    assert_eq!(
        found,
        vec![
            ("intro", 0.0, 8.0),
            ("verso", 8.0, 24.0),
            ("coro", 24.0, 40.0),
            ("final", 40.0, 48.0)
        ]
    );
}

#[test]
fn a_first_marker_after_the_start_opens_an_implicit_start_section() {
    let mut song = base_song();
    for marker in &mut song.section_markers {
        if marker.id == "intro" {
            marker.start_seconds = ORIGIN + 2.0;
        }
    }
    let fixture = capture(&song, &[]);
    assert_eq!(
        fixture.sections[0].marker_id,
        implicit_start_section_id("r")
    );
    close(fixture.sections[0].start_seconds, 0.0, "inicio implícito");
    close(fixture.sections[0].end_seconds, 2.0, "fin implícito");
    assert_eq!(fixture.sections[1].marker_id, "intro");

    // Se puede usar como bloque: "Inicio" sólo dura 2 s.
    let built = build(&fixture, &[&implicit_start_section_id("r"), "final"]);
    close(built.duration_seconds, 2.0 + 8.0, "Inicio + Final");
}

#[test]
fn a_marker_pinned_a_hair_before_the_start_still_opens_the_song() {
    let mut song = base_song();
    for marker in &mut song.section_markers {
        if marker.id == "intro" {
            marker.start_seconds = ORIGIN - 0.0005;
        }
    }
    let fixture = capture(&song, &[]);
    assert_eq!(fixture.sections[0].marker_id, "intro");
    assert_eq!(fixture.sections[0].start_seconds, 0.0);
}

#[test]
fn fewer_than_two_sections_cannot_be_captured() {
    let mut song = base_song();
    song.section_markers.retain(|m| m.id == "intro");
    assert_eq!(
        capture_original(&song, &[], "r").map(|_| ()),
        Err(StructureError::TooFewSections)
    );
    assert_eq!(
        capture_original(&song, &[], "nope").map(|_| ()),
        Err(StructureError::RegionNotFound("nope".into()))
    );
}

#[test]
fn non_finite_values_are_rejected_on_capture() {
    let mut song = base_song();
    song.clips[1].source_start_seconds = f64::NAN;
    assert!(matches!(
        capture_original(&song, &[], "r"),
        Err(StructureError::NonFinite(_))
    ));
}

// ── Tabla del plan ─────────────────────────────────────────────────────────

/// Identidad: el orden original devuelve la instantánea, ids incluidos y sin
/// fundidos nuevos.
#[test]
fn the_original_order_is_the_identity() {
    let fixture = base();
    let built = build(&fixture, &["intro", "verso", "coro", "final"]);
    assert_eq!(built.duration_seconds, 48.0);
    assert_eq!(as_snapshot_lists(&built), lists_only(&fixture.snapshot));
}

/// Repetir: `Intro Verso Verso Coro Final` alarga 8 compases y el clip que
/// cruzaba Verso→Coro se parte sólo en el corte nuevo.
#[test]
fn repeating_a_section_lengthens_the_song_and_cuts_only_at_the_new_seam() {
    let fixture = base();
    let built = build(&fixture, &["intro", "verso", "verso", "coro", "final"]);
    close(built.duration_seconds, 48.0 + 16.0, "duración");

    let pieces: Vec<&Clip> = built
        .clips
        .iter()
        .filter(|c| c.file_path == "cross.wav")
        .collect();
    assert_eq!(pieces.len(), 2);
    // Primera aparición: recortada en el corte nuevo (24), conserva el id.
    assert_eq!(pieces[0].id, "a_cross");
    close(rel(pieces[0].timeline_start_seconds), 16.0, "inicio 1");
    close(pieces[0].duration_seconds, 8.0, "recortado en 24");
    // Segunda: entera (el verso repetido sigue hasta el coro sin corte).
    assert_eq!(pieces[1].id, "a_cross~2");
    close(rel(pieces[1].timeline_start_seconds), 32.0, "inicio 2");
    close(pieces[1].duration_seconds, 16.0, "entero");
    close(pieces[1].source_start_seconds, 16.0, "mismo audio");
}

/// Quitar: `Intro Coro Final`, el clip Verso→Coro empieza recortado en el
/// Coro con su `source_start` correcto.
#[test]
fn removing_a_section_trims_the_clip_that_crossed_into_the_next_one() {
    let fixture = base();
    let built = build(&fixture, &["intro", "coro", "final"]);
    close(built.duration_seconds, 8.0 + 16.0 + 8.0, "duración");
    let crossing = built
        .clips
        .iter()
        .find(|c| c.file_path == "cross.wav")
        .expect("trozo del coro");
    close(
        rel(crossing.timeline_start_seconds),
        8.0,
        "empieza con el coro",
    );
    close(crossing.source_start_seconds, 16.0 + 8.0, "source_start");
    close(crossing.duration_seconds, 8.0, "lo que quedaba en el coro");
    assert_eq!(
        crossing.fade_in_seconds,
        Some(CUT_FADE_SECONDS),
        "fundido de corte"
    );
    assert_eq!(
        crossing.fade_out_seconds,
        Some(1.0),
        "su fundido de salida intacto"
    );
}

/// Reordenar: `Coro Intro`, el tempo de arranque es el que regía en el Coro
/// (120 por la marca del inicio), no el de fuera (100).
#[test]
fn reordering_starts_with_the_tempo_that_governed_the_first_block() {
    let fixture = base();
    let built = build(&fixture, &["coro", "intro"]);
    let at_start: Vec<&TempoMarker> = built
        .tempo_markers
        .iter()
        .filter(|m| rel(m.start_seconds).abs() < 1e-9)
        .collect();
    assert_eq!(at_start.len(), 1);
    assert_eq!(at_start[0].bpm, 120.0);
    // Es la primera aparición de t0, así que conserva el id.
    assert_eq!(at_start[0].id, "t0");
    // La copia de t0 al empezar la Intro es redundante (120 tras 120) y no
    // se emite.
    assert_eq!(built.tempo_markers.len(), 1, "{:?}", built.tempo_markers);
}

/// Fixture pequeño para tempo y compás: Verso [0, 16) a 120 y Coro [16, 28)
/// con su propia marca (otro BPM u otro compás).
fn two_section_song(tempo_marker_on_verse: bool) -> Song {
    let mut song = base_song();
    song.regions = vec![region("r", ORIGIN, ORIGIN + 28.0)];
    song.bpm = 120.0;
    song.tempo_markers = vec![TempoMarker {
        id: "t_coro".into(),
        start_seconds: ORIGIN + 16.0,
        bpm: 140.0,
    }];
    if tempo_marker_on_verse {
        song.tempo_markers.insert(
            0,
            TempoMarker {
                id: "t_verso".into(),
                start_seconds: ORIGIN,
                bpm: 120.0,
            },
        );
    }
    song.time_signature_markers = vec![];
    song.clips = vec![
        clip("v", "a1", "a.wav", 0.0, 16.0),
        clip("c", "a1", "a.wav", 16.0, 12.0),
    ];
    song.midi_clips = vec![];
    song.video_clips = vec![];
    song.section_markers = vec![
        marker("verso", 0.0, MarkerKind::Verse),
        marker("coro", 16.0, MarkerKind::Chorus),
    ];
    song
}

/// Tempo distinto por sección: `Coro Verso` reinserta el BPM del verso al
/// empezar el verso, venga de una marca del original o de la base.
#[test]
fn a_section_after_one_with_another_tempo_gets_its_own_tempo_back() {
    for with_marker in [true, false] {
        let fixture = capture(&two_section_song(with_marker), &[]);
        let built = build(&fixture, &["coro", "verso"]);
        let tempos: Vec<(f64, f64)> = built
            .tempo_markers
            .iter()
            .map(|m| (rel(m.start_seconds), m.bpm))
            .collect();
        assert_eq!(
            tempos,
            vec![(0.0, 140.0), (12.0, 120.0)],
            "marca en el verso: {with_marker}"
        );
        let verse_tempo = &built.tempo_markers[1];
        if with_marker {
            assert_eq!(verse_tempo.id, "t_verso");
        } else {
            assert_eq!(
                verse_tempo.id, "verso~tempo~1",
                "id determinista para la base"
            );
        }
    }
}

/// Compás distinto: lo mismo con 3/4 en el coro.
#[test]
fn a_section_after_one_with_another_meter_gets_its_own_meter_back() {
    let mut song = two_section_song(true);
    song.tempo_markers.clear();
    song.time_signature_markers = vec![TimeSignatureMarker {
        id: "ts_coro".into(),
        start_seconds: ORIGIN + 16.0,
        signature: "3/4".into(),
    }];
    let fixture = capture(&song, &[]);
    let built = build(&fixture, &["coro", "verso", "coro"]);
    let meters: Vec<(f64, &str)> = built
        .time_signature_markers
        .iter()
        .map(|m| (rel(m.start_seconds), m.signature.as_str()))
        .collect();
    assert_eq!(meters, vec![(0.0, "3/4"), (12.0, "4/4"), (28.0, "3/4")]);
    assert_eq!(built.time_signature_markers[2].id, "ts_coro~2");
}

/// Generador congruencial con semilla fija: posiciones "aleatorias"
/// reproducibles sin añadir `rand`.
struct Lcg(u64);

impl Lcg {
    fn next_unit(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

/// Qué `(fichero, segundo de fuente)` suena en una pista en una posición.
fn sounding(clips: &[Clip], track: &str, absolute: f64) -> Option<(String, f64)> {
    clips
        .iter()
        .filter(|c| c.track_id == track)
        .find(|c| {
            absolute >= c.timeline_start_seconds
                && absolute < c.timeline_start_seconds + c.duration_seconds
        })
        .map(|c| {
            (
                c.file_path.clone(),
                c.source_start_seconds + (absolute - c.timeline_start_seconds),
            )
        })
}

/// Conservación: en 200 posiciones al azar (semilla fija), cada pista suena
/// con el audio de la sección original que toca en ese bloque.
#[test]
fn every_block_sounds_like_its_original_section() {
    let fixture = base();
    let arrangements: [&[&str]; 4] = [
        &["intro", "verso", "verso", "coro", "final"],
        &["coro", "intro", "final", "verso"],
        &["intro", "coro", "coro", "coro", "final"],
        &["final", "verso", "intro"],
    ];
    let mut rng = Lcg(0x5EED);
    for names in arrangements {
        let built = build(&fixture, names);
        let section_of = |name: &str| {
            fixture
                .sections
                .iter()
                .find(|s| s.marker_id == name)
                .unwrap()
        };
        // Dónde empieza cada bloque en la canción arreglada.
        let mut starts = Vec::new();
        let mut cursor = 0.0;
        for name in names {
            let section = section_of(name);
            starts.push((cursor, section));
            cursor += section.end_seconds - section.start_seconds;
        }
        for _ in 0..200 {
            let position = rng.next_unit() * built.duration_seconds;
            let (block_start, section) = starts
                .iter()
                .rev()
                .find(|(start, _)| position >= *start)
                .unwrap();
            let offset = position - block_start;
            // Lejos de las costuras (los extremos exactos son de un lado o del
            // otro por convenio).
            let section_length = section.end_seconds - section.start_seconds;
            if offset < 1e-6 || section_length - offset < 1e-6 {
                continue;
            }
            let original_position = ORIGIN + section.start_seconds + offset;
            for track in ["a1", "a2", "a3"] {
                let expected = sounding(&fixture.snapshot.clips, track, original_position);
                let actual = sounding(&built.clips, track, ORIGIN + position);
                match (&expected, &actual) {
                    (None, None) => {}
                    (Some((file_e, src_e)), Some((file_a, src_a))) => {
                        assert_eq!(file_e, file_a, "{names:?} {track} @ {position}");
                        assert!(
                            (src_e - src_a).abs() < 1e-9,
                            "{names:?} {track} @ {position}: fuente {src_a}, esperada {src_e}"
                        );
                    }
                    _ => {
                        panic!("{names:?} {track} @ {position}: {actual:?} en vez de {expected:?}")
                    }
                }
            }
        }
    }
}

/// Sin solapes: ningún par de clips de la misma pista se pisa.
#[test]
fn no_two_clips_of_a_track_overlap() {
    let fixture = base();
    for names in [
        &["intro", "verso", "verso", "coro", "final"][..],
        &["coro", "verso", "coro", "verso"][..],
        &["final", "intro"][..],
    ] {
        let built = build(&fixture, names);
        for track in ["a1", "a2", "a3"] {
            let mut clips: Vec<&Clip> =
                built.clips.iter().filter(|c| c.track_id == track).collect();
            clips.sort_by(|l, r| {
                l.timeline_start_seconds
                    .total_cmp(&r.timeline_start_seconds)
            });
            for pair in clips.windows(2) {
                let end = pair[0].timeline_start_seconds + pair[0].duration_seconds;
                assert!(
                    end <= pair[1].timeline_start_seconds + 1e-9,
                    "{names:?} {track}: {} acaba en {end} y {} empieza en {}",
                    pair[0].id,
                    pair[1].id,
                    pair[1].timeline_start_seconds
                );
            }
        }
    }
}

#[test]
fn building_is_deterministic() {
    let fixture = base();
    let names = ["coro", "verso", "verso", "coro", "intro"];
    assert_eq!(build(&fixture, &names), build(&fixture, &names));
}

/// Marca cue: el Build aparece una vez por cada Coro del arreglo.
#[test]
fn a_cue_marker_travels_with_every_copy_of_its_section() {
    let fixture = base();
    let built = build(&fixture, &["intro", "coro", "verso", "coro", "coro"]);
    let builds: Vec<(&str, f64)> = built
        .section_markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Build)
        .map(|m| (m.id.as_str(), rel(m.start_seconds)))
        .collect();
    assert_eq!(
        builds,
        vec![
            ("build", 8.0 + 6.0),
            ("build~2", 40.0 + 6.0),
            ("build~3", 56.0 + 6.0)
        ]
    );
    // Las marcas duplicadas conservan tipo, nombre y variante.
    let coros: Vec<&Marker> = built
        .section_markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Chorus)
        .collect();
    assert_eq!(coros.len(), 3);
    assert!(coros.iter().all(|m| m.name == "coro"));
}

/// Salto: la copia del salto apunta a la copia del Coro de su tramo.
#[test]
fn a_copied_jump_targets_the_chorus_of_its_own_span() {
    let fixture = base();
    // Dos tramos [Verso Coro] y [Verso Coro].
    let built = build(&fixture, &["verso", "coro", "verso", "coro"]);
    let targets: Vec<(&str, &str)> = built
        .automation_cues
        .iter()
        .map(|cue| match cue.actions.last() {
            Some(AutomationAction::Jump {
                target: AutomationJumpTarget::Marker { marker_id },
                ..
            }) => (cue.id.as_str(), marker_id.as_str()),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(targets, vec![("k", "coro"), ("k~2", "coro~2")]);

    // Un tramo sin coro propio: el salto va a la primera aparición.
    let built = build(&fixture, &["coro", "verso"]);
    match built.automation_cues[0].actions.last() {
        Some(AutomationAction::Jump {
            target: AutomationJumpTarget::Marker { marker_id },
            ..
        }) => assert_eq!(marker_id, "coro"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_frame_jump_inside_the_song_lands_in_its_own_span() {
    let mut cues = base_cues();
    cues[0].actions = vec![AutomationAction::Jump {
        // A 2 s del inicio del coro.
        target: AutomationJumpTarget::Frame {
            seconds: ORIGIN + 26.0,
        },
        transition: AutomationTransition::default(),
        mix_scene_id: None,
    }];
    let fixture = capture(&base_song(), &cues);
    let built = build(&fixture, &["verso", "coro", "verso", "coro"]);
    let frames: Vec<f64> = built
        .automation_cues
        .iter()
        .map(|cue| match cue.actions.last() {
            Some(AutomationAction::Jump {
                target: AutomationJumpTarget::Frame { seconds },
                ..
            }) => rel(*seconds),
            other => panic!("{other:?}"),
        })
        .collect();
    // Primer tramo: coro en 16 → 18. Segundo: coro en 48 → 50.
    assert_eq!(frames, vec![18.0, 50.0]);
}

/// MIDI: la nota que cruzaba se acorta en el corte, el program change del
/// otro lado no viaja, y la captura avisa.
#[test]
fn a_midi_note_is_shortened_at_the_cut_and_capture_warns_about_it() {
    let fixture = base();
    assert_eq!(
        fixture.warnings,
        vec![CaptureWarning::MidiClipCrossesSection {
            clip_id: "m1".into(),
            marker_id: "coro".into(),
        }]
    );

    let built = build(&fixture, &["intro", "verso", "final"]);
    assert_eq!(built.midi_clips.len(), 1);
    let copy = &built.midi_clips[0];
    close(
        rel(copy.timeline_start_seconds),
        20.0,
        "el clip no se mueve",
    );
    assert_eq!(copy.events.len(), 1, "el program change era del coro");
    match copy.events[0].kind {
        MidiEventKind::Note {
            duration_seconds, ..
        } => close(duration_seconds, 4.0, "nota acortada en 24"),
        ref other => panic!("{other:?}"),
    }

    // Sólo el coro: la copia empieza en el primer evento que conserva (el
    // inicio del tramo, porque el clip empezaba antes) con el program change.
    let built = build(&fixture, &["coro"]);
    let copy = &built.midi_clips[0];
    close(rel(copy.timeline_start_seconds), 0.0, "inicio del tramo");
    assert_eq!(copy.events.len(), 1);
    assert_eq!(copy.events[0].id, "pc");
    close(copy.events[0].at_seconds, 2.0, "26 - 24");
}

#[test]
fn an_empty_arrangement_is_rejected() {
    let fixture = base();
    assert_eq!(
        build_arrangement(&fixture.snapshot, &fixture.sections, &[]),
        Err(StructureError::EmptyArrangement)
    );
}

#[test]
fn an_unknown_section_is_rejected() {
    let fixture = base();
    assert_eq!(
        build_arrangement(
            &fixture.snapshot,
            &fixture.sections,
            &blocks(&["intro", "puente"])
        ),
        Err(StructureError::UnknownSection("puente".into()))
    );
}

/// Fundido previo mayor: un clip con fade-out de 1 s recortado por ese lado
/// lo conserva y no recibe el de 5 ms.
#[test]
fn a_trimmed_edge_keeps_a_longer_fade_it_already_had() {
    let fixture = base();
    let built = build(&fixture, &["intro", "verso", "final"]);
    let crossing = built
        .clips
        .iter()
        .find(|c| c.file_path == "cross.wav")
        .expect("trozo del verso");
    close(crossing.duration_seconds, 8.0, "recortado en 24");
    assert_eq!(crossing.fade_out_seconds, Some(1.0));
    assert_eq!(crossing.fade_in_seconds, None, "su inicio no se recortó");
}

#[test]
fn a_fade_never_outlasts_the_trimmed_clip() {
    let mut song = base_song();
    // Fade-out de 12 s en el clip que cruza: tras recortarlo a 8 s no cabe.
    song.clips[0].fade_out_seconds = Some(12.0);
    let fixture = capture(&song, &[]);
    let built = build(&fixture, &["intro", "verso", "final"]);
    let crossing = built
        .clips
        .iter()
        .find(|c| c.file_path == "cross.wav")
        .unwrap();
    assert_eq!(crossing.fade_out_seconds, Some(8.0));
}

#[test]
fn video_clips_are_cut_like_audio() {
    let fixture = base();
    let built = build(&fixture, &["verso", "intro"]);
    let pieces: Vec<(f64, f64, f64)> = built
        .video_clips
        .iter()
        .map(|v| {
            (
                rel(v.timeline_start_seconds),
                v.source_start_seconds,
                v.duration_seconds,
            )
        })
        .collect();
    // Verso: fuente [8, 24) en 0; Intro: fuente [0, 8) en 16.
    assert_eq!(pieces, vec![(0.0, 8.0, 16.0), (16.0, 0.0, 8.0)]);
    assert_eq!(built.video_clips[1].id, "v1~2");
}

#[test]
fn translate_moves_everything_and_zero_moves_nothing() {
    let fixture = base();
    let built = build(&fixture, &["verso", "coro"]);
    let mut same = built.clone();
    same.translate(0.0);
    assert_eq!(same, built);
    let mut moved = built.clone();
    moved.translate(5.0);
    close(
        moved.clips[0].timeline_start_seconds,
        built.clips[0].timeline_start_seconds + 5.0,
        "clip",
    );
    close(
        moved.automation_cues[0].at_seconds,
        built.automation_cues[0].at_seconds + 5.0,
        "cue",
    );
}

/// C3: medida de rendimiento. No es una aserción de tiempo (nada de tests que
/// midan relojes): se ejecuta a mano en release y se apunta en la bitácora.
///
/// `cargo test -p libretracks-core --release -- --ignored --nocapture build_arrangement_perf`
#[test]
#[ignore]
fn build_arrangement_perf() {
    let mut song = base_song();
    song.clips.clear();
    song.tracks = (0..40)
        .map(|t| track(&format!("t{t}"), TrackKind::Audio))
        .collect();
    // 60 clips de 0,8 s por pista repartidos por los 48 s.
    for t in 0..40 {
        for c in 0..60 {
            song.clips.push(clip(
                &format!("c{t}_{c}"),
                &format!("t{t}"),
                "a.wav",
                c as f64 * 0.8,
                0.8,
            ));
        }
    }
    let fixture = capture(&song, &base_cues());
    let names = [
        "intro", "verso", "coro", "verso", "coro", "coro", "final", "intro", "verso", "coro",
        "coro", "final",
    ];
    let blocks = blocks(&names);
    let runs = 50;
    let started = std::time::Instant::now();
    let mut total_clips = 0;
    for _ in 0..runs {
        let built = build_arrangement(&fixture.snapshot, &fixture.sections, &blocks).unwrap();
        total_clips += built.clips.len();
    }
    let per_run = started.elapsed().as_secs_f64() * 1000.0 / runs as f64;
    println!(
        "build_arrangement: {per_run:.3} ms por arreglo (40 pistas × 60 clips, 12 bloques, {} clips de salida)",
        total_clips / runs
    );
}

// ── Ramas que la tabla del plan no cubre ───────────────────────────────────

#[test]
fn every_kind_of_non_finite_value_is_rejected() {
    type Break = Box<dyn Fn(&mut Song, &mut Vec<AutomationCue>)>;
    let cases: Vec<(&str, Break)> = vec![
        (
            "vídeo",
            Box::new(|s, _| s.video_clips[0].duration_seconds = f64::NAN),
        ),
        (
            "midi",
            Box::new(|s, _| s.midi_clips[0].events[0].at_seconds = f64::INFINITY),
        ),
        ("tempo", Box::new(|s, _| s.tempo_markers[0].bpm = f64::NAN)),
        ("base", Box::new(|s, _| s.bpm = f64::NAN)),
    ];
    for (what, break_it) in cases {
        let mut song = base_song();
        let mut cues = base_cues();
        break_it(&mut song, &mut cues);
        assert!(
            matches!(
                capture_original(&song, &cues, "r"),
                Err(StructureError::NonFinite(_))
            ),
            "{what}"
        );
    }

    let fixture = base();
    let mut snapshot = fixture.snapshot.clone();
    snapshot.origin_seconds = f64::NAN;
    assert!(matches!(
        build_arrangement(&snapshot, &fixture.sections, &blocks(&["intro"])),
        Err(StructureError::NonFinite(_))
    ));
    let mut sections = fixture.sections.clone();
    sections[1].end_seconds = f64::INFINITY;
    assert!(matches!(
        build_arrangement(&fixture.snapshot, &sections, &blocks(&["intro"])),
        Err(StructureError::NonFinite(_))
    ));
    // Una marca o una cue con NaN no pertenecen a ninguna canción y la
    // captura ya las deja fuera; si llegan en una instantánea, se rechazan.
    let mut snapshot = fixture.snapshot.clone();
    snapshot.section_markers[3].start_seconds = f64::NAN;
    assert!(matches!(
        build_arrangement(&snapshot, &fixture.sections, &blocks(&["intro"])),
        Err(StructureError::NonFinite(_))
    ));
    let mut snapshot = fixture.snapshot.clone();
    snapshot.automation_cues[0].at_seconds = f64::NAN;
    assert!(matches!(
        build_arrangement(&snapshot, &fixture.sections, &blocks(&["intro"])),
        Err(StructureError::NonFinite(_))
    ));
}

#[test]
fn two_section_markers_at_the_same_spot_open_a_single_section() {
    let mut song = base_song();
    song.section_markers
        .push(marker("verso_bis", 8.0, MarkerKind::Verse));
    let fixture = capture(&song, &[]);
    let ids: Vec<&str> = fixture
        .sections
        .iter()
        .map(|s| s.marker_id.as_str())
        .collect();
    assert_eq!(ids, vec!["intro", "verso", "coro", "final"]);
    // La segunda marca viaja dentro de la sección de la primera.
    let built = build(&fixture, &["verso", "verso"]);
    assert_eq!(
        built
            .section_markers
            .iter()
            .filter(|m| m.id.starts_with("verso_bis"))
            .count(),
        2
    );
}

#[test]
fn a_control_curve_is_shortened_at_the_cut_like_a_note() {
    let mut song = base_song();
    song.midi_clips[0].events[0].kind = MidiEventKind::ControlCurve {
        controller: 7,
        from_value: 0,
        to_value: 127,
        duration_seconds: 8.0,
    };
    let fixture = capture(&song, &[]);
    let built = build(&fixture, &["verso", "final"]);
    match built.midi_clips[0].events[0].kind {
        MidiEventKind::ControlCurve {
            duration_seconds, ..
        } => close(duration_seconds, 4.0, "curva acortada en 24"),
        ref other => panic!("{other:?}"),
    }
}

fn frame_jump(at_rel: f64, target_absolute: f64) -> AutomationCue {
    AutomationCue {
        actions: vec![AutomationAction::Jump {
            target: AutomationJumpTarget::Frame {
                seconds: target_absolute,
            },
            transition: AutomationTransition::default(),
            mix_scene_id: None,
        }],
        ..jump_to_marker("f", at_rel, "")
    }
}

fn first_frame(built: &BuiltRegion) -> f64 {
    match built.automation_cues[0].actions.last() {
        Some(AutomationAction::Jump {
            target: AutomationJumpTarget::Frame { seconds },
            ..
        }) => *seconds,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_frame_jump_outside_the_song_is_left_alone() {
    // Salta a 3 s absoluto: dentro de la canción anterior.
    let fixture = capture(&base_song(), &[frame_jump(20.0, 3.0)]);
    let built = build(&fixture, &["coro", "verso"]);
    close(first_frame(&built), 3.0, "destino fuera intacto");
}

#[test]
fn a_frame_jump_into_a_dropped_section_goes_to_the_song_start() {
    // Desde el verso salta a la intro (2 s), que el arreglo quita.
    let fixture = capture(&base_song(), &[frame_jump(20.0, ORIGIN + 2.0)]);
    let built = build(&fixture, &["verso", "coro"]);
    close(first_frame(&built), ORIGIN, "inicio de la canción");
}

#[test]
fn a_jump_to_a_marker_the_arrangement_drops_keeps_its_target_id() {
    let fixture = base();
    let built = build(&fixture, &["intro", "verso", "final"]);
    match built.automation_cues[0].actions.last() {
        Some(AutomationAction::Jump {
            target: AutomationJumpTarget::Marker { marker_id },
            ..
        }) => assert_eq!(marker_id, "coro", "sin copia: el id original, sin inventar"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_base_tempo_comes_from_a_marker_of_the_previous_song() {
    let mut song = base_song();
    song.tempo_markers.insert(
        0,
        TempoMarker {
            id: "t_prev".into(),
            start_seconds: 0.0,
            bpm: 90.0,
        },
    );
    song.time_signature_markers.insert(
        0,
        TimeSignatureMarker {
            id: "ts_prev".into(),
            start_seconds: 0.0,
            signature: "6/8".into(),
        },
    );
    let fixture = capture(&song, &[]);
    assert_eq!(fixture.snapshot.base_bpm, 90.0);
    assert_eq!(fixture.snapshot.base_time_signature, "6/8");
    assert!(fixture
        .snapshot
        .tempo_markers
        .iter()
        .all(|m| m.id != "t_prev"));
}

#[test]
fn bars_and_governing_values_read_the_snapshot_relative_to_its_origin() {
    let fixture = capture(&two_section_song(true), &[]);
    assert_eq!(governing_bpm_at(&fixture.snapshot, 0.0), 120.0);
    assert_eq!(governing_bpm_at(&fixture.snapshot, 16.0), 140.0);
    assert_eq!(governing_signature_at(&fixture.snapshot, 16.0), "4/4");
    // 12 s del coro a 140 BPM, 4/4: 7 compases.
    close(
        bars_for_view_duration(&fixture.snapshot, 16.0, 12.0),
        7.0,
        "compases",
    );
    assert_eq!(beats_per_bar("7/8"), 7.0);
    assert_eq!(beats_per_bar("raro"), 4.0);
    assert!(section_marker(&fixture.snapshot, "coro").is_some());
}
