use serde_json::{json, Value};

use crate::model::Track;
use crate::track_eq::{EqBand, EqBandKind, TrackEq};

/// JSON compartido con `packages/shared/src/trackEq.test.ts`: un renombre en
/// cualquiera de los dos lados lo rompe.
fn reference() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/shared/src/fixtures/trackEqReference.json"
    ))
    .unwrap()
}

fn track_json_without_eq() -> Value {
    json!({
        "id": "t1",
        "name": "Bajo",
        "kind": "audio",
        "parentTrackId": null,
        "volume": 1.0,
        "pan": 0.0,
        "muted": false,
        "solo": false,
        "transposeEnabled": true,
        "audioTo": "master",
        "monoDownmix": false,
        "autoCreated": false,
        "midiChannel": 1,
        "midiEnabled": true,
        "collapsed": false
    })
}

#[test]
fn a_track_saved_without_eq_loads_none_and_writes_back_without_the_key() {
    let original = serde_json::to_string(&track_json_without_eq()).unwrap();
    let track: Track = serde_json::from_str(&original).unwrap();
    assert_eq!(track.eq, None);
    let written = serde_json::to_value(&track).unwrap();
    assert!(written.get("eq").is_none(), "una pista sin EQ no debe escribir la clave");
    assert_eq!(written, track_json_without_eq(), "el fragmento de la pista cambió");
    assert_eq!(serde_json::to_string(&written).unwrap(), original);
}

#[test]
fn six_bands_with_every_kind_round_trip_through_serde() {
    let reference = reference()["trackEq"].clone();
    let eq: TrackEq = serde_json::from_value(reference.clone()).unwrap();
    assert_eq!(eq.bands.len(), 6);
    let kinds: Vec<EqBandKind> = eq.bands.iter().map(|band| band.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EqBandKind::LowCut,
            EqBandKind::LowShelf,
            EqBandKind::Peak,
            EqBandKind::Notch,
            EqBandKind::HighShelf,
            EqBandKind::HighCut,
        ]
    );
    assert_eq!(serde_json::to_value(&eq).unwrap(), reference);

    let mut track: Track = serde_json::from_value(track_json_without_eq()).unwrap();
    track.eq = Some(eq.clone());
    let back: Track = serde_json::from_value(serde_json::to_value(&track).unwrap()).unwrap();
    assert_eq!(back.eq, Some(eq));
}

#[test]
fn sanitized_clamps_every_range_and_keeps_a_valid_eq_identical() {
    let valid = TrackEq::default();
    assert_eq!(valid.sanitized(), valid);
    let reference: TrackEq = serde_json::from_value(reference()["trackEq"].clone()).unwrap();
    assert_eq!(reference.sanitized(), reference);

    let mut wild = TrackEq::default();
    wild.bands[0].frequency_hz = 5.0;
    wild.bands[1].frequency_hz = 96_000.0;
    wild.bands[1].gain_db = 40.0;
    wild.bands[2].gain_db = -40.0;
    wild.bands[2].q = 0.0;
    wild.bands[3].q = 100.0;
    wild.bands[3].frequency_hz = f64::NAN;
    wild.bands[4].gain_db = f64::INFINITY;
    wild.bands[4].q = f64::NEG_INFINITY;
    wild.bands[5].slope = 48;
    wild.bands[0].slope = 3;
    wild.bands.push(EqBand::default());
    wild.bands.push(EqBand::default());

    let clean = wild.sanitized();
    assert_eq!(clean.bands.len(), 6);
    assert_eq!(clean.bands[0].frequency_hz, 20.0);
    assert_eq!(clean.bands[0].slope, 12);
    assert_eq!(clean.bands[1].frequency_hz, 20_000.0);
    assert_eq!(clean.bands[1].gain_db, 18.0);
    assert_eq!(clean.bands[2].gain_db, -18.0);
    assert_eq!(clean.bands[2].q, 0.1);
    assert_eq!(clean.bands[3].q, 18.0);
    assert_eq!(clean.bands[3].frequency_hz, 1000.0);
    assert_eq!(clean.bands[4].gain_db, 0.0);
    assert_eq!(clean.bands[4].q, 0.71);
    assert_eq!(clean.bands[5].slope, 24);
}

#[test]
fn default_bands_follow_the_design() {
    let eq = TrackEq::default();
    assert!(eq.enabled);
    let summary: Vec<(bool, EqBandKind, f64)> =
        eq.bands.iter().map(|b| (b.enabled, b.kind, b.frequency_hz)).collect();
    assert_eq!(
        summary,
        vec![
            (false, EqBandKind::LowCut, 40.0),
            (true, EqBandKind::LowShelf, 100.0),
            (true, EqBandKind::Peak, 400.0),
            (true, EqBandKind::Peak, 2500.0),
            (true, EqBandKind::HighShelf, 8000.0),
            (false, EqBandKind::HighCut, 18000.0),
        ]
    );
    assert!(eq.bands.iter().all(|b| b.gain_db == 0.0 && b.q == 0.71));
    // Recién creado no hace nada: el botón no se ilumina.
    assert!(!eq.is_active());
}

#[test]
fn missing_band_fields_take_their_defaults() {
    let eq: TrackEq = serde_json::from_value(json!({ "bands": [{ "kind": "highCut" }] })).unwrap();
    assert!(eq.enabled);
    assert_eq!(eq.bands[0].kind, EqBandKind::HighCut);
    assert_eq!(eq.bands[0].frequency_hz, 1000.0);
    assert_eq!(eq.bands[0].slope, 12);
}
