use super::*;
use libretracks_core::drum_loops::{
    LoopRow, LoopRowLiveState, OneShotBank, OneShotPad, OneShotSet, PatternSignature, SampleSource, Sound,
};

fn sound(id: &str, file: &str) -> Sound {
    Sound {
        id: id.into(),
        name: id.into(),
        color: String::new(),
        sample: SampleRef { source: SampleSource::User, file: file.into() },
        gain_db: 0.0,
        choke_group: None,
    }
}

fn kit(id: &str, sounds: Vec<Sound>) -> DrumKit {
    DrumKit { id: id.into(), name: id.into(), sounds }
}

fn pattern(id: &str, kit: KitRef, sound_ids: &[&str]) -> LoopPattern {
    LoopPattern {
        id: id.into(),
        name: id.into(),
        kit,
        bpm: 100.0,
        signature: PatternSignature::default(),
        steps_per_beat: 4,
        bars: 1,
        swing: 0.0,
        rows: sound_ids
            .iter()
            .map(|s| LoopRow { sound_id: (*s).into(), gain_db: 0.0, variations: vec![vec![2; 16]] })
            .collect(),
    }
}

fn runtime() -> (RhythmRuntime, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = RhythmRuntime::default();
    rt.configure(dir.path().join("loops"), dir.path().join("builtin"));
    (rt, dir)
}

fn library() -> RhythmLibraryData {
    let basic = kit("basic", vec![sound("hat", "hat.wav"), sound("shaker", "shaker.wav")]);
    RhythmLibraryData {
        kits: vec![basic],
        patterns: vec![pattern("pop", KitRef::Library { kit_id: "basic".into() }, &["hat", "shaker"])],
        one_shots: OneShotSet {
            banks: vec![OneShotBank {
                id: "a".into(),
                name: "A".into(),
                pads: vec![Some(OneShotPad {
                    id: "boom".into(),
                    name: "Boom".into(),
                    color: String::new(),
                    sample: SampleRef { source: SampleSource::User, file: "boom.wav".into() },
                    gain_db: 0.0,
                    mode: Default::default(),
                    quantize: Default::default(),
                    choke_group: None,
                })],
            }],
        },
    }
}

fn load_paths(plan: &RhythmSyncPlan) -> Vec<(i32, String)> {
    plan.load
        .as_ref()
        .map(|l| l.samples.iter().map(|s| (s.slot, s.path.clone())).collect())
        .unwrap_or_default()
}

#[test]
fn plan_loads_samples_once_and_keeps_slots_stable() {
    let (mut rt, _dir) = runtime();
    let mut data = library();
    let first = rt.plan_with(&data, "pop", 0);
    let paths = load_paths(&first);
    assert_eq!(paths.len(), 3, "hat, shaker y el pad");
    assert!(first.commands.iter().any(|c| matches!(c, EngineCommand::SetLoopPattern { .. })));
    assert!(first.commands.iter().any(|c| matches!(c, EngineCommand::SetOneShotBank { .. })));

    // Nada cambia: no se recarga ninguna muestra.
    assert!(rt.plan_with(&data, "pop", 0).load.is_none());

    // Cambia la muestra del shaker: hat y boom conservan su slot.
    data.kits[0].sounds[1].sample.file = "shaker2.wav".into();
    let changed = rt.plan_with(&data, "pop", 0);
    let after = load_paths(&changed);
    let slot = |list: &[(i32, String)], name: &str| list.iter().find(|(_, p)| p.ends_with(name)).map(|(s, _)| *s);
    assert_eq!(slot(&after, "hat.wav"), slot(&paths, "hat.wav"));
    assert_eq!(slot(&after, "boom.wav"), slot(&paths, "boom.wav"));
    assert_eq!(slot(&after, "shaker2.wav"), slot(&paths, "shaker.wav"), "toma el hueco libre");
    assert!(slot(&after, "shaker.wav").is_none());
}

#[test]
fn the_engine_pattern_points_at_the_assigned_slots() {
    let (mut rt, _dir) = runtime();
    let data = library();
    let plan = rt.plan_with(&data, "pop", 0);
    let paths = load_paths(&plan);
    let EngineCommand::SetLoopPattern { pattern } = &plan.commands[0] else {
        panic!("primero el patrón activo");
    };
    let hat = paths.iter().find(|(_, p)| p.ends_with("hat.wav")).unwrap().0;
    assert_eq!(pattern.rows[0].slot, hat);
    assert_eq!(pattern.rows.len(), 2);
    assert_eq!(pattern.free_bpm, 100.0);
}

#[test]
fn a_session_with_two_song_loops_sends_both_regions() {
    let (mut rt, _dir) = runtime();
    let data = library();
    let embedded = kit("own", vec![sound("tamb", "tamb.wav")]);
    let mut song = crate::rhythm::tests::song_with_regions();
    song.regions[0].drum_loop = Some(RegionLoop {
        pattern: pattern("a", KitRef::Library { kit_id: "basic".into() }, &["hat"]),
        autostart: true,
        initial_rows: vec![],
    });
    song.regions[1].drum_loop = Some(RegionLoop {
        pattern: pattern("b", KitRef::Embedded { kit: embedded }, &["tamb"]),
        autostart: false,
        initial_rows: vec![LoopRowLiveState { enabled: false, variation: 1 }],
    });
    rt.set_song(&song);
    let plan = rt.plan_with(&data, "", 0);
    let regions = plan
        .commands
        .iter()
        .find_map(|c| match c {
            EngineCommand::SetRegionLoops { regions } => Some(regions.clone()),
            _ => None,
        })
        .expect("SetRegionLoops");
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].region_id, "r1");
    assert!(regions[0].autostart);
    assert_eq!(regions[0].initial_rows.len(), 1);
    assert!(regions[0].initial_rows[0].enabled, "sin estado guardado: encendida en A");
    assert_eq!(regions[1].region_id, "r2");
    assert_eq!(regions[1].initial_rows[0], LoopEngineRowState { enabled: false, variation: 1 });
    assert!(load_paths(&plan).iter().any(|(_, p)| p.ends_with("tamb.wav")));

    // Reordenar las canciones: el mismo plan con las regiones en el nuevo orden.
    song.regions.swap(0, 1);
    rt.set_song(&song);
    let reordered = rt.plan_with(&data, "", 0);
    let ids: Vec<String> = reordered
        .commands
        .iter()
        .find_map(|c| match c {
            EngineCommand::SetRegionLoops { regions } => Some(regions.iter().map(|r| r.region_id.clone()).collect()),
            _ => None,
        })
        .unwrap();
    assert_eq!(ids, vec!["r2".to_string(), "r1".to_string()]);
}

#[test]
fn embedding_copies_the_library_kit_into_the_song() {
    let data = library();
    let embedded = embed_kit(&data.patterns[0], &data.kits).unwrap();
    match &embedded.kit {
        KitRef::Embedded { kit } => assert_eq!(kit.sounds.len(), 2),
        _ => panic!("debe quedar incrustado"),
    }
    let missing = pattern("x", KitRef::Library { kit_id: "nope".into() }, &[]);
    assert!(embed_kit(&missing, &data.kits).is_none());
}

pub(super) fn song_with_regions() -> Song {
    let mut song: Song = serde_json::from_value(serde_json::json!({
        "id": "s", "title": "S", "bpm": 120.0, "timeSignature": "4/4", "durationSeconds": 20.0,
        "tempoMarkers": [], "timeSignatureMarkers": [], "tracks": [], "clips": [], "sectionMarkers": [],
        "regions": [
            { "id": "r1", "name": "Uno", "startSeconds": 0.0, "endSeconds": 10.0 },
            { "id": "r2", "name": "Dos", "startSeconds": 10.0, "endSeconds": 20.0 }
        ]
    }))
    .expect("song json");
    song.regions.iter_mut().for_each(|r| r.drum_loop = None);
    song
}
