use super::*;
use crate::model::{Song, SongRegion, TempoMarker, TimeSignatureMarker};

fn song(bpm: f64, signature: &str) -> Song {
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm,
        time_signature: signature.into(),
        duration_seconds: 600.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    }
}

fn tempo(at: f64, bpm: f64, ramp: bool) -> TempoMarker {
    TempoMarker {
        id: format!("t{at}"),
        start_seconds: at,
        bpm,
        ramp,
    }
}

fn signature(at: f64, value: &str) -> TimeSignatureMarker {
    TimeSignatureMarker {
        id: format!("ts{at}"),
        start_seconds: at,
        signature: value.into(),
    }
}

fn warped_region(start: f64, end: f64, source_bpm: f64) -> SongRegion {
    serde_json::from_value(serde_json::json!({
        "id": "r",
        "name": "R",
        "startSeconds": start,
        "endSeconds": end,
        "transposeSemitones": 0,
        "warpEnabled": true,
        "warpSourceBpm": source_bpm,
    }))
    .expect("region")
}

fn beats(count: f64) -> LeadTime {
    LeadTime::Beats { count }
}

fn bars(count: f64) -> LeadTime {
    LeadTime::Bars { count }
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1.0e-6,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn no_lead_fires_on_the_anchor() {
    let song = song(120.0, "4/4");
    close(lead_fire_seconds(&song, 10.0, None), 10.0);
    close(lead_fire_seconds(&song, 10.0, Some(&beats(0.0))), 10.0);
    // Garbage amounts count as no lead rather than firing at a random time.
    close(lead_fire_seconds(&song, 10.0, Some(&beats(-2.0))), 10.0);
    close(lead_fire_seconds(&song, 10.0, Some(&beats(f64::NAN))), 10.0);
}

#[test]
fn beats_bars_and_seconds_at_a_constant_tempo() {
    let song = song(120.0, "4/4");
    close(lead_fire_seconds(&song, 10.0, Some(&beats(1.0))), 9.5);
    close(lead_fire_seconds(&song, 10.0, Some(&beats(0.5))), 9.75);
    close(lead_fire_seconds(&song, 10.0, Some(&bars(1.0))), 8.0);
    close(lead_fire_seconds(&song, 10.0, Some(&bars(2.0))), 6.0);
    close(
        lead_fire_seconds(&song, 10.0, Some(&LeadTime::Seconds { seconds: 1.25 })),
        8.75,
    );
}

#[test]
fn a_beat_is_the_denominator_note_like_the_metronome() {
    // 6/8 at 120 (quarter = 0.5 s): a beat is an eighth (0.25 s), a bar six.
    let song = song(120.0, "6/8");
    close(lead_fire_seconds(&song, 10.0, Some(&beats(1.0))), 9.75);
    close(lead_fire_seconds(&song, 10.0, Some(&bars(1.0))), 8.5);
}

#[test]
fn never_fires_before_the_start_of_the_timeline() {
    let song = song(120.0, "4/4");
    close(lead_fire_seconds(&song, 1.0, Some(&bars(4.0))), 0.0);
    close(
        lead_fire_seconds(&song, 1.0, Some(&LeadTime::Seconds { seconds: 5.0 })),
        0.0,
    );
}

#[test]
fn the_lead_is_measured_in_the_tempo_that_plays_before_the_anchor() {
    // 60 bpm up to 20 s, 120 bpm after. An item at the change measures its
    // beat at 60 (1 s), not at the 120 that starts on it.
    let mut song = song(60.0, "4/4");
    song.tempo_markers = vec![tempo(20.0, 120.0, false)];
    close(lead_fire_seconds(&song, 20.0, Some(&beats(1.0))), 19.0);
    // Half a second into the fast part: 1 beat = 0.5 s there, then 0 left.
    close(lead_fire_seconds(&song, 20.5, Some(&beats(1.0))), 20.0);
    // Two beats from 20.5: one at 120 (to 20.0), one at 60 (to 19.0).
    close(lead_fire_seconds(&song, 20.5, Some(&beats(2.0))), 19.0);
}

#[test]
fn bars_across_a_signature_change_use_each_sides_bars() {
    // 3/4 until 12 s, 4/4 after, 120 bpm. One bar before 12 is a 3/4 bar
    // (1.5 s); one bar and a half from 13 crosses: 2 s of 4/4 then half a bar of
    // 3/4 (0.75 s).
    let mut song = song(120.0, "3/4");
    song.time_signature_markers = vec![signature(12.0, "4/4")];
    close(lead_fire_seconds(&song, 12.0, Some(&bars(1.0))), 10.5);
    close(lead_fire_seconds(&song, 14.0, Some(&bars(1.5))), 11.25);
}

#[test]
fn a_ramp_is_walked_along_its_curve() {
    // Ramp 60 → 120 bpm over 0..10 s, then 120. Ten seconds of ramp hold
    // (60+120)/2 * 10/60 = 15 quarters.
    let mut song = song(60.0, "4/4");
    song.tempo_markers = vec![tempo(0.0, 60.0, true), tempo(10.0, 120.0, false)];
    close(lead_fire_seconds(&song, 10.0, Some(&beats(15.0))), 0.0);
    // The last beat of the ramp is shorter than a beat at 60.
    let fire = lead_fire_seconds(&song, 10.0, Some(&beats(1.0)));
    assert!(fire > 9.0 && fire < 9.6, "fire at {fire}");
    close(musical_span(&song, fire, 10.0, LeadUnit::Beats), 1.0);
}

#[test]
fn inside_a_warped_region_the_source_tempo_rules() {
    // Map says 120, but the region's source is at 100 bpm: one source beat is
    // 0.6 source seconds, which is what the metronome clicks on.
    let mut song = song(120.0, "4/4");
    song.regions = vec![warped_region(0.0, 60.0, 100.0)];
    close(lead_fire_seconds(&song, 30.0, Some(&beats(1.0))), 29.4);
}

#[test]
fn musical_span_counts_units_between_two_points() {
    let mut song = song(60.0, "4/4");
    song.tempo_markers = vec![tempo(20.0, 120.0, false)];
    close(musical_span(&song, 18.0, 21.0, LeadUnit::Beats), 4.0);
    close(musical_span(&song, 18.0, 21.0, LeadUnit::Seconds), 3.0);
    close(musical_span(&song, 21.0, 18.0, LeadUnit::Beats), 0.0);
}

#[test]
fn remainder_before_landing_is_what_the_target_does_not_cover() {
    let song = song(120.0, "4/4");
    // Anchored on the landing: the whole lead spills before the jump.
    assert_eq!(
        lead_remainder_before_landing(&song, 40.0, 40.0, Some(&beats(2.0))),
        Some(beats(2.0))
    );
    // Anchored one beat after the landing with a two-beat lead: one spills.
    let rest = lead_remainder_before_landing(&song, 40.0, 40.5, Some(&beats(2.0))).unwrap();
    close(rest.amount(), 1.0);
    // The lead fits after the landing: nothing to fire before the jump.
    assert_eq!(
        lead_remainder_before_landing(&song, 40.0, 42.0, Some(&beats(2.0))),
        None
    );
    // Items before the landing are not played by the jump at all.
    assert_eq!(
        lead_remainder_before_landing(&song, 40.0, 39.0, Some(&beats(2.0))),
        None
    );
}

#[test]
fn lead_round_trips_as_camel_case_tagged_json() {
    let value = serde_json::to_value(beats(1.5)).unwrap();
    assert_eq!(value, serde_json::json!({"unit": "beats", "count": 1.5}));
    let seconds: LeadTime =
        serde_json::from_value(serde_json::json!({"unit": "seconds", "seconds": 0.8})).unwrap();
    assert_eq!(seconds, LeadTime::Seconds { seconds: 0.8 });
}

#[test]
fn items_without_lead_serialize_exactly_as_before() {
    let clip: crate::model::MidiClip = serde_json::from_value(serde_json::json!({
        "id": "c", "trackId": "t", "timelineStartSeconds": 4.0
    }))
    .unwrap();
    assert_eq!(clip.lead, None);
    assert!(serde_json::to_value(&clip).unwrap().get("lead").is_none());

    let cue: crate::automation::AutomationCue = serde_json::from_value(serde_json::json!({
        "id": "q", "name": "Q", "atSeconds": 4.0, "actions": []
    }))
    .unwrap();
    assert_eq!(cue.lead, None);
    assert!(serde_json::to_value(&cue).unwrap().get("lead").is_none());

    let with_lead = crate::model::MidiClip {
        lead: Some(bars(1.0)),
        ..clip
    };
    let value = serde_json::to_value(&with_lead).unwrap();
    assert_eq!(
        value["lead"],
        serde_json::json!({"unit": "bars", "count": 1.0})
    );
    let back: crate::model::MidiClip = serde_json::from_value(value).unwrap();
    assert_eq!(back, with_lead);
}
