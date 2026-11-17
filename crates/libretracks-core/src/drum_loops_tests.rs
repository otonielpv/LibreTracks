use super::*;
use serde_json::{json, Value};

fn sample(file: &str) -> SampleRef {
    SampleRef {
        source: SampleSource::Builtin,
        file: file.into(),
    }
}

fn sound(id: &str) -> Sound {
    Sound {
        id: id.into(),
        name: id.into(),
        color: "#ff0000".into(),
        sample: sample(&format!("{id}.wav")),
        gain_db: 0.0,
        choke_group: None,
    }
}

fn kit(ids: &[&str]) -> DrumKit {
    DrumKit {
        id: "kit".into(),
        name: "Kit".into(),
        sounds: ids.iter().map(|id| sound(id)).collect(),
    }
}

fn row(sound_id: &str, steps: usize) -> LoopRow {
    LoopRow {
        sound_id: sound_id.into(),
        gain_db: 0.0,
        variations: vec![vec![0; steps]; MAX_VARIATIONS],
    }
}

fn pattern(ids: &[&str]) -> LoopPattern {
    LoopPattern {
        id: "p1".into(),
        name: "Pop".into(),
        kit: KitRef::Embedded { kit: kit(ids) },
        bpm: 92.0,
        signature: PatternSignature::default(),
        steps_per_beat: 4,
        bars: 1,
        swing: 0.0,
        rows: ids.iter().map(|id| row(id, 16)).collect(),
    }
}

/// Serializa, compara con el JSON de referencia y vuelve a deserializar.
fn round_trip<T>(value: &T, reference: Value)
where
    T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
{
    let serialized = serde_json::to_value(value).unwrap();
    assert_eq!(serialized, reference, "el JSON cambió de forma");
    let back: T = serde_json::from_value(reference).unwrap();
    assert_eq!(&back, value);
}

/// JSON de referencia compartido con el test de forma de TypeScript
/// (`packages/shared/src/drumLoops.test.ts`): un renombre en cualquiera de
/// los dos lados lo rompe.
fn reference() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/shared/src/fixtures/drumLoopsReference.json"
    ))
    .unwrap()
}

fn reference_region_loop_json() -> Value {
    reference()["regionLoop"].clone()
}

#[test]
fn every_shared_reference_entry_round_trips() {
    let r = reference();
    let lib: KitRef = serde_json::from_value(r["libraryKitRef"].clone()).unwrap();
    round_trip(&lib, r["libraryKitRef"].clone());
    let user: SampleRef = serde_json::from_value(r["userSample"].clone()).unwrap();
    assert_eq!(user.source, SampleSource::User);
    round_trip(&user, r["userSample"].clone());
    let builtin: SampleRef = serde_json::from_value(r["builtinSample"].clone()).unwrap();
    round_trip(&builtin, r["builtinSample"].clone());
    let live: LoopLiveState = serde_json::from_value(r["liveState"].clone()).unwrap();
    round_trip(&live, r["liveState"].clone());
    let set: OneShotSet = serde_json::from_value(r["oneShotSet"].clone()).unwrap();
    assert_eq!(set.banks[0].pads[0].as_ref().unwrap().choke_group, Some(2));
    round_trip(&set, r["oneShotSet"].clone());
    let error: PatternError = serde_json::from_value(r["patternError"].clone()).unwrap();
    round_trip(&error, r["patternError"].clone());
}

#[test]
fn sample_ref_round_trips_with_reference_json() {
    round_trip(&sample("kick.wav"), json!({ "source": { "kind": "builtin" }, "file": "kick.wav" }));
    round_trip(
        &SampleRef { source: SampleSource::User, file: "mine.wav".into() },
        json!({ "source": { "kind": "user" }, "file": "mine.wav" }),
    );
    round_trip(
        &SampleRef { source: SampleSource::Pack { pack_id: "fx".into() }, file: "riser.wav".into() },
        json!({ "source": { "kind": "pack", "packId": "fx" }, "file": "riser.wav" }),
    );
}

#[test]
fn sound_and_kit_round_trip_with_reference_json() {
    let mut s = sound("hat");
    s.choke_group = Some(2);
    s.gain_db = -6.0;
    round_trip(
        &s,
        json!({
            "id": "hat", "name": "hat", "color": "#ff0000",
            "sample": { "source": { "kind": "builtin" }, "file": "hat.wav" },
            "gainDb": -6.0, "chokeGroup": 2
        }),
    );
    round_trip(
        &DrumKit { id: "k".into(), name: "K".into(), sounds: vec![] },
        json!({ "id": "k", "name": "K", "sounds": [] }),
    );
}

#[test]
fn kit_ref_round_trips_with_reference_json() {
    round_trip(
        &KitRef::Library { kit_id: "basic".into() },
        json!({ "kind": "library", "kitId": "basic" }),
    );
    round_trip(
        &KitRef::Embedded { kit: DrumKit { id: "k".into(), name: "K".into(), sounds: vec![] } },
        json!({ "kind": "embedded", "kit": { "id": "k", "name": "K", "sounds": [] } }),
    );
}

#[test]
fn region_loop_round_trips_with_reference_json() {
    let reference = reference_region_loop_json();
    let value: RegionLoop = serde_json::from_value(reference.clone()).unwrap();
    assert_eq!(value.pattern.signature.numerator, 3);
    assert_eq!(value.pattern.rows[0].variations[0][8], STEP_ACCENT);
    assert_eq!(value.initial_rows[0].variation, 1);
    round_trip(&value, reference);
}

#[test]
fn live_state_round_trips_with_reference_json() {
    round_trip(
        &LoopLiveState {
            pattern_id: Some("p1".into()),
            playing: true,
            rows: vec![LoopRowLiveState { enabled: false, variation: 3 }],
        },
        json!({ "patternId": "p1", "playing": true, "rows": [{ "enabled": false, "variation": 3 }] }),
    );
    round_trip(&LoopLiveState::default(), json!({ "playing": false, "rows": [] }));
}

#[test]
fn one_shots_round_trip_with_reference_json() {
    let pad = OneShotPad {
        id: "boom".into(),
        name: "Boom".into(),
        color: "#00ff00".into(),
        sample: sample("boom.wav"),
        gain_db: 1.5,
        mode: OneShotMode::Gate,
        quantize: TriggerQuantize::Bar,
        choke_group: None,
    };
    round_trip(
        &pad,
        json!({
            "id": "boom", "name": "Boom", "color": "#00ff00",
            "sample": { "source": { "kind": "builtin" }, "file": "boom.wav" },
            "gainDb": 1.5, "mode": "gate", "quantize": "bar"
        }),
    );
    let set = OneShotSet {
        banks: vec![OneShotBank { id: "a".into(), name: "A".into(), pads: vec![Some(pad), None] }],
    };
    let value = serde_json::to_value(&set).unwrap();
    assert_eq!(value["banks"][0]["pads"][1], Value::Null);
    assert_eq!(value["banks"][0]["pads"][0]["mode"], "gate");
    let back: OneShotSet = serde_json::from_value(value).unwrap();
    assert_eq!(back, set);
    // Los enums sin variante explícita deserializan a su valor por defecto.
    let minimal: OneShotPad = serde_json::from_value(json!({
        "id": "x", "name": "X", "sample": { "source": { "kind": "user" }, "file": "x.wav" }
    }))
    .unwrap();
    assert_eq!(minimal.mode, OneShotMode::OneShot);
    assert_eq!(minimal.quantize, TriggerQuantize::Off);
    assert_eq!(serde_json::to_value(OneShotMode::OneShot).unwrap(), "oneShot");
}

#[test]
fn pattern_error_serializes_with_code_tag() {
    assert_eq!(
        serde_json::to_value(PatternError::UnknownSound { sound_id: "x".into() }).unwrap(),
        json!({ "code": "unknownSound", "soundId": "x" })
    );
    assert_eq!(serde_json::to_value(PatternError::EmptyName).unwrap(), json!({ "code": "emptyName" }));
}

// ---- normalized(): un test por límite ----

#[test]
fn normalized_truncates_kit_to_eight_sounds_and_rows() {
    let ids: Vec<String> = (0..10).map(|i| format!("s{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let normalized = pattern(&refs).normalized();
    assert_eq!(normalized.embedded_kit().unwrap().sounds.len(), MAX_KIT_SOUNDS);
    assert_eq!(normalized.rows.len(), MAX_KIT_SOUNDS);
}

#[test]
fn normalized_pads_and_truncates_variations_to_four() {
    let mut p = pattern(&["a", "b"]);
    p.rows[0].variations = vec![vec![1; 16]; 6];
    p.rows[1].variations = vec![vec![1; 16]];
    let normalized = p.normalized();
    assert_eq!(normalized.rows[0].variations.len(), MAX_VARIATIONS);
    assert_eq!(normalized.rows[1].variations.len(), MAX_VARIATIONS);
    assert_eq!(normalized.rows[1].variations[3], vec![0; 16]);
}

#[test]
fn normalized_fits_step_count_to_bars_and_signature() {
    let mut p = pattern(&["a"]);
    p.rows[0].variations[0] = vec![2; 20];
    p.rows[0].variations[1] = vec![2; 3];
    let normalized = p.normalized();
    assert_eq!(normalized.rows[0].variations[0].len(), 16);
    assert_eq!(normalized.rows[0].variations[1], [vec![2; 3], vec![0; 13]].concat());

    let mut waltz = pattern(&["a"]);
    waltz.signature = PatternSignature { numerator: 3, denominator: 4 };
    waltz.bars = 2;
    assert_eq!(waltz.normalized().rows[0].variations[0].len(), 24);
}

#[test]
fn normalized_caps_steps_at_sixty_four() {
    let mut p = pattern(&["a"]);
    p.signature = PatternSignature { numerator: 7, denominator: 4 };
    p.bars = 4; // 7 × 4 × 4 = 112 pasos: no cabe
    p.rows[0].variations[0] = vec![2; 200];
    let normalized = p.normalized();
    assert!(normalized.step_count() <= MAX_STEPS);
    assert_eq!(normalized.bars, 2); // 7 × 4 × 2 = 56
    assert_eq!(normalized.rows[0].variations[0].len(), 56);
}

#[test]
fn normalized_clamps_step_velocity() {
    let mut p = pattern(&["a"]);
    p.rows[0].variations[0][0] = 9;
    assert_eq!(p.normalized().rows[0].variations[0][0], MAX_STEP_VELOCITY);
}

#[test]
fn normalized_drops_rows_with_unknown_sound() {
    let mut p = pattern(&["a", "b"]);
    p.rows.push(row("ghost", 16));
    let normalized = p.normalized();
    assert_eq!(normalized.rows.len(), 2);
    assert!(normalized.rows.iter().all(|r| r.sound_id != "ghost"));
    // Con kit de biblioteca, sin el kit a mano no se quita nada.
    let mut library = p.clone();
    library.kit = KitRef::Library { kit_id: "basic".into() };
    assert_eq!(library.normalized().rows.len(), 3);
    assert_eq!(library.normalized_with_kit(Some(&kit(&["a"]))).rows.len(), 1);
}

#[test]
fn normalized_clamps_swing_and_bpm() {
    let mut p = pattern(&["a"]);
    p.swing = 2.0;
    p.bpm = 500.0;
    let normalized = p.normalized();
    assert_eq!(normalized.swing, MAX_SWING);
    assert_eq!(normalized.bpm, MAX_PATTERN_BPM);
    p.swing = -1.0;
    p.bpm = 5.0;
    let normalized = p.normalized();
    assert_eq!(normalized.swing, 0.0);
    assert_eq!(normalized.bpm, MIN_PATTERN_BPM);
    p.bpm = f64::NAN;
    assert_eq!(p.normalized().bpm, 120.0);
}

#[test]
fn normalized_fixes_invalid_bars_and_steps_per_beat() {
    let mut p = pattern(&["a"]);
    p.bars = 3;
    p.steps_per_beat = 7;
    let normalized = p.normalized();
    assert_eq!(normalized.bars, 2);
    assert_eq!(normalized.steps_per_beat, 4);
}

#[test]
fn one_shot_set_normalized_caps_banks_and_pads() {
    let bank = OneShotBank { id: "a".into(), name: "A".into(), pads: vec![None; 20] };
    let set = OneShotSet { banks: vec![bank.clone(); 6] }.normalized();
    assert_eq!(set.banks.len(), MAX_ONE_SHOT_BANKS);
    assert!(set.banks.iter().all(|b| b.pads.len() == PADS_PER_BANK));
    let short = OneShotBank { pads: vec![], ..bank }.normalized();
    assert_eq!(short.pads.len(), PADS_PER_BANK);
}

// ---- validate() ----

#[test]
fn validate_reports_typed_errors() {
    let mut p = pattern(&["a"]);
    assert!(p.validate(None).is_empty());
    p.name = "  ".into();
    p.rows.push(row("ghost", 16));
    let errors = p.validate(None);
    assert!(errors.contains(&PatternError::EmptyName));
    assert!(errors.contains(&PatternError::UnknownSound { sound_id: "ghost".into() }));

    let mut empty = pattern(&[]);
    empty.bars = 3;
    let errors = empty.validate(None);
    assert!(errors.contains(&PatternError::KitWithoutSounds));
    assert!(errors.contains(&PatternError::NoRows));
    assert!(errors.contains(&PatternError::InvalidBars));
}

// ---- Operaciones del editor ----

#[test]
fn toggle_step_switches_between_off_and_normal() {
    let mut p = pattern(&["a"]);
    assert!(p.toggle_step(0, 1, 5));
    assert_eq!(p.rows[0].variations[1][5], STEP_NORMAL);
    assert!(p.toggle_step(0, 1, 5));
    assert_eq!(p.rows[0].variations[1][5], 0);
    assert!(!p.toggle_step(0, 1, 99));
    assert!(!p.toggle_step(3, 0, 0));
}

#[test]
fn cycle_velocity_goes_normal_accent_soft() {
    let mut p = pattern(&["a"]);
    let mut seen = Vec::new();
    for _ in 0..4 {
        p.cycle_velocity(0, 0, 0);
        seen.push(p.rows[0].variations[0][0]);
    }
    assert_eq!(seen, vec![STEP_NORMAL, STEP_ACCENT, STEP_SOFT, STEP_NORMAL]);
}

#[test]
fn paint_steps_fills_a_range_and_clamps() {
    let mut p = pattern(&["a"]);
    assert!(p.paint_steps(0, 2, 4..8, 3));
    assert_eq!(&p.rows[0].variations[2][3..9], &[0, 3, 3, 3, 3, 0]);
    assert!(!p.paint_steps(0, 2, 4..8, 3), "repetir no cambia nada");
    assert!(p.paint_steps(0, 2, 14..40, 9));
    assert_eq!(&p.rows[0].variations[2][14..], &[3, 3]);
}

#[test]
fn copy_variation_copies_every_row() {
    let mut p = pattern(&["a", "b"]);
    p.toggle_step(0, 0, 0);
    p.toggle_step(1, 0, 4);
    assert!(p.copy_variation(0, 3));
    assert_eq!(p.rows[0].variations[3], p.rows[0].variations[0]);
    assert_eq!(p.rows[1].variations[3][4], STEP_NORMAL);
    assert!(!p.copy_variation(0, 0));
    assert!(!p.copy_variation(0, 4));
}

#[test]
fn clear_row_empties_all_variations() {
    let mut p = pattern(&["a", "b"]);
    p.paint_steps(0, 0, 0..16, 2);
    p.paint_steps(0, 3, 0..16, 2);
    p.paint_steps(1, 0, 0..16, 2);
    assert!(p.clear_row(0));
    assert!(p.rows[0].variations.iter().all(|v| v.iter().all(|&s| s == 0)));
    assert_eq!(p.rows[1].variations[0], vec![2; 16]);
}

#[test]
fn resize_bars_repeats_when_growing_and_truncates_when_shrinking() {
    let mut p = pattern(&["a"]);
    p.toggle_step(0, 0, 0);
    p.toggle_step(0, 0, 6);
    let one_bar = p.rows[0].variations[0].clone();
    p.resize_bars(4);
    assert_eq!(p.bars, 4);
    assert_eq!(p.rows[0].variations[0].len(), 64);
    for bar in 0..4 {
        assert_eq!(&p.rows[0].variations[0][bar * 16..(bar + 1) * 16], one_bar.as_slice());
    }
    // Lo nuevo del compás 3 se pierde al encoger a 2.
    p.toggle_step(0, 0, 40);
    p.resize_bars(2);
    assert_eq!(p.bars, 2);
    assert_eq!(p.rows[0].variations[0].len(), 32);
    assert_eq!(&p.rows[0].variations[0][16..32], one_bar.as_slice());
}

#[test]
fn set_steps_per_beat_converts_and_warns_when_inexact() {
    let mut p = pattern(&["a"]);
    // Pasos en el tiempo (0, 4, 8, 12) son exactos; el 2 (corchea) no.
    for step in [0, 4, 8, 12] {
        p.toggle_step(0, 0, step);
    }
    let exact = p.clone();
    let mut exact_copy = exact.clone();
    let report = exact_copy.set_steps_per_beat(3);
    assert!(report.is_exact());
    assert_eq!(exact_copy.steps_per_beat, 3);
    assert_eq!(exact_copy.rows[0].variations[0].len(), 12);
    let on: Vec<usize> = (0..12).filter(|&i| exact_copy.rows[0].variations[0][i] > 0).collect();
    assert_eq!(on, vec![0, 3, 6, 9]);

    p.toggle_step(0, 0, 2);
    let report = p.set_steps_per_beat(3);
    assert_eq!(report.moved_steps, 1);
    assert!(!report.is_exact());
    // 2/4 de tiempo = 1,5 pasos de tresillo: va al 2.
    assert!(p.rows[0].variations[0][2] > 0);

    // Mismo valor o inválido: no hace nada.
    let mut same = exact.clone();
    assert!(same.set_steps_per_beat(4).is_exact());
    assert_eq!(same, exact);
    assert!(same.set_steps_per_beat(5).is_exact());
    assert_eq!(same, exact);
}
