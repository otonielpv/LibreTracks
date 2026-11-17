use super::*;
use crate::drum_loops::{KitRef, LoopRow, OneShotBank, PatternSignature, Sound};

fn roots() -> SampleRoots {
    SampleRoots {
        builtin: PathBuf::from("/app/kit"),
        packs: PathBuf::from("/data/loops/packs"),
        user: PathBuf::from("/data/loops/user"),
    }
}

fn sample(source: SampleSource, file: &str) -> SampleRef {
    SampleRef {
        source,
        file: file.into(),
    }
}

#[test]
fn resolves_each_source_to_its_folder() {
    let r = roots();
    assert_eq!(
        resolve_sample_path(&sample(SampleSource::Builtin, "kick.wav"), &r),
        Some(PathBuf::from("/app/kit/kick.wav"))
    );
    assert_eq!(
        resolve_sample_path(&sample(SampleSource::User, "mío ñ.wav"), &r),
        Some(PathBuf::from("/data/loops/user/mío ñ.wav"))
    );
    assert_eq!(
        resolve_sample_path(&sample(SampleSource::Pack { pack_id: "latin".into() }, "shaker/a.wav"), &r),
        Some(PathBuf::from("/data/loops/packs/latin/shaker/a.wav"))
    );
}

#[test]
fn rejects_paths_that_escape_their_folder() {
    let r = roots();
    assert_eq!(resolve_sample_path(&sample(SampleSource::User, "../secret.wav"), &r), None);
    assert_eq!(resolve_sample_path(&sample(SampleSource::User, "/etc/passwd"), &r), None);
    assert_eq!(resolve_sample_path(&sample(SampleSource::User, ""), &r), None);
    assert_eq!(
        resolve_sample_path(&sample(SampleSource::Pack { pack_id: "../x".into() }, "a.wav"), &r),
        None
    );
    assert_eq!(
        resolve_sample_path(&sample(SampleSource::Pack { pack_id: "".into() }, "a.wav"), &r),
        None
    );
}

#[test]
fn slots_are_stable_when_one_sound_changes() {
    let mut table = SlotTable::default();
    let a = PathBuf::from("a.wav");
    let b = PathBuf::from("b.wav");
    let c = PathBuf::from("c.wav");
    let first = table.assign(vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(first.added.len(), 3);
    let (sa, sb, sc) = (table.slot_of(&a), table.slot_of(&b), table.slot_of(&c));
    assert_eq!((sa, sb, sc), (Some(0), Some(1), Some(2)));

    // Se cambia la muestra de b: a y c no se mueven, la nueva toma el hueco.
    let d = PathBuf::from("d.wav");
    let change = table.assign(vec![a.clone(), d.clone(), c.clone()]);
    assert_eq!(change.added, vec![d.clone()]);
    assert_eq!(change.removed, vec![b.clone()]);
    assert_eq!(table.slot_of(&a), sa);
    assert_eq!(table.slot_of(&c), sc);
    assert_eq!(table.slot_of(&d), Some(1));
    assert_eq!(table.slot_of(&b), None);

    // Sin cambios: nada que recargar. Repetidos cuentan una vez.
    let same = table.assign(vec![c.clone(), a.clone(), d.clone(), a.clone()]);
    assert!(!same.changed());
    assert_eq!(table.len(), 3);
    assert_eq!(
        table.entries(),
        vec![(0, a), (1, d), (2, c)]
    );
}

fn kit() -> DrumKit {
    DrumKit {
        id: "k".into(),
        name: "K".into(),
        sounds: vec![
            Sound {
                id: "hat".into(),
                name: "Hat".into(),
                color: String::new(),
                sample: sample(SampleSource::Builtin, "hat.wav"),
                gain_db: -6.0,
                choke_group: Some(2),
            },
            Sound {
                id: "shaker".into(),
                name: "Shaker".into(),
                color: String::new(),
                sample: sample(SampleSource::Builtin, "missing.wav"),
                gain_db: 0.0,
                choke_group: None,
            },
        ],
    }
}

#[test]
fn resolves_a_pattern_for_the_engine() {
    let k = kit();
    let pattern = LoopPattern {
        id: "p".into(),
        name: "P".into(),
        kit: KitRef::Library { kit_id: "k".into() },
        bpm: 95.0,
        signature: PatternSignature { numerator: 3, denominator: 4 },
        steps_per_beat: 4,
        bars: 1,
        swing: 0.2,
        rows: vec![
            LoopRow { sound_id: "hat".into(), gain_db: 0.0, variations: vec![vec![2; 12]] },
            LoopRow { sound_id: "shaker".into(), gain_db: 6.0, variations: vec![vec![1; 12]] },
            LoopRow { sound_id: "ghost".into(), gain_db: 0.0, variations: vec![] },
        ],
    };
    let resolved = resolve_pattern(&pattern, &k, |s| (s.file == "hat.wav").then_some(7));
    assert_eq!(resolved.beats_per_bar, 3);
    assert_eq!(resolved.free_bpm, 95.0);
    assert!((resolved.swing - 0.2).abs() < 1e-6);
    assert_eq!(resolved.rows.len(), 2, "la fila sin sonido en el kit se quita");
    assert_eq!(resolved.rows[0].slot, 7);
    assert!((resolved.rows[0].gain - db_to_gain(-6.0)).abs() < 1e-6);
    assert_eq!(resolved.rows[0].choke_group, 2);
    assert_eq!(resolved.rows[0].variations.len(), 4);
    assert_eq!(resolved.rows[0].variations[0].len(), 12);
    assert_eq!(resolved.rows[1].slot, -1, "muestra sin slot: fila muda, índices intactos");
    assert!((resolved.rows[1].gain - db_to_gain(6.0)).abs() < 1e-6);
}

#[test]
fn initial_rows_fill_missing_with_enabled_a() {
    let saved = vec![LoopRowLiveState { enabled: false, variation: 2 }];
    let rows = initial_rows(3, &saved);
    assert_eq!(rows[0], saved[0]);
    assert_eq!(rows[1], LoopRowLiveState { enabled: true, variation: 0 });
    assert_eq!(rows.len(), 3);
}

#[test]
fn resolves_a_one_shot_bank_with_empty_pads() {
    let pad = OneShotPad {
        id: "boom".into(),
        name: "Boom".into(),
        color: String::new(),
        sample: sample(SampleSource::User, "boom.wav"),
        gain_db: 0.0,
        mode: OneShotMode::Gate,
        quantize: TriggerQuantize::Bar,
        choke_group: Some(1),
    };
    let bank = OneShotBank { id: "a".into(), name: "A".into(), pads: vec![None, Some(pad)] };
    let resolved = resolve_one_shot_bank(&bank, |_| Some(4));
    assert_eq!(resolved.len(), 12);
    assert!(resolved[0].is_none());
    let p = resolved[1].as_ref().unwrap();
    assert_eq!((p.slot, p.mode, p.quantize, p.choke_group), (4, "gate", "bar", 1));
    assert!((p.gain - 1.0).abs() < 1e-6);
}
