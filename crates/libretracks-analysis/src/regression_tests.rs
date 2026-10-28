use serde::Deserialize;

use crate::{
    analyze_click_with_guide, propose_tempo_markers, CountWord, ExistingTiming, GuideAnalysis,
    GuideAnnouncement, GuideGroup, ProposedSignatureMarker, ProposedTempoMarker, SongSpan,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    name: String,
    bpm: f64,
    click_start_seconds: f64,
    beat_count: usize,
    duration_seconds: f64,
    announcements: Vec<Announcement>,
    expected_tempo_markers: Vec<ProposedTempoMarker>,
    expected_signature_markers: Vec<ProposedSignatureMarker>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Announcement {
    start_seconds: f64,
    end_seconds: f64,
    labels: Vec<String>,
    #[serde(default)]
    count_words: Vec<(u8, f64)>,
}

fn guide(fixture: &Fixture) -> GuideAnalysis {
    GuideAnalysis {
        announcements: fixture
            .announcements
            .iter()
            .enumerate()
            .map(|(group, a)| GuideAnnouncement {
                start_seconds: a.start_seconds,
                end_seconds: a.end_seconds,
                group,
                count_words: a
                    .count_words
                    .iter()
                    .map(|&(number, start_seconds)| CountWord {
                        number,
                        start_seconds,
                    })
                    .collect(),
            })
            .collect(),
        groups: fixture
            .announcements
            .iter()
            .map(|a| GuideGroup {
                labels: a.labels.clone(),
                transcript: None,
                match_cost: None,
                counted_in: false,
                occurrences: 1,
                first_start_seconds: a.start_seconds,
                first_end_seconds: a.end_seconds,
            })
            .collect(),
    }
}

fn check_song(json: &str) {
    const RATE: u32 = 16_000;
    let fixture: Fixture = serde_json::from_str(json).expect("valid song regression fixture");
    let guide = guide(&fixture);
    // Equal quarter clicks, optionally with quieter eighths: neither has a
    // bar accent. Preserve the full duration, not just the opening count.
    for subdivisions in [1, 2] {
        let mut audio = vec![0.0; (fixture.duration_seconds * f64::from(RATE)) as usize];
        for pulse in 0..fixture.beat_count * subdivisions {
            let seconds = fixture.click_start_seconds
                + pulse as f64 * 60.0 / (fixture.bpm * subdivisions as f64);
            let start = (seconds * f64::from(RATE)).round() as usize;
            let amplitude = if pulse % subdivisions == 0 { 0.8 } else { 0.6 };
            for i in 0..(0.03 * f64::from(RATE)) as usize {
                if let Some(sample) = audio.get_mut(start + i) {
                    let t = i as f64 / f64::from(RATE);
                    *sample += (amplitude
                        * (-t / 0.006).exp()
                        * (std::f64::consts::TAU * 1100.0 * t).sin())
                        as f32;
                }
            }
        }
        let analysis =
            analyze_click_with_guide(&audio, RATE, 4, false, &guide).expect("an unaccented click");
        assert_eq!(analysis.segments.len(), 1, "{}", fixture.name);
        assert_eq!(analysis.segments[0].bpm, fixture.bpm, "{}", fixture.name);
        assert!(
            (analysis.segments[0].start_seconds - fixture.click_start_seconds).abs() < 0.003,
            "{}: {:?}",
            fixture.name,
            analysis.segments
        );
        assert!(!analysis.downbeat_known);
        // The same contract feeds the TypeScript placement tests. In
        // particular, no invented pickup may add a second 4/4 marker.
        for offset in [0.0, 100.0] {
            let proposal = propose_tempo_markers(
                &analysis,
                SongSpan {
                    start_seconds: offset,
                    end_seconds: offset + fixture.duration_seconds,
                },
                &ExistingTiming {
                    bpm: 130.0,
                    time_signature: "4/4".into(),
                    tempo_markers: vec![(offset + 0.42, 130.0)],
                    signature_markers: vec![(offset + 0.42, "4/4".into())],
                },
            );
            let mut expected_tempo = fixture.expected_tempo_markers.clone();
            let mut expected_signature = fixture.expected_signature_markers.clone();
            for marker in &mut expected_tempo {
                marker.start_seconds += offset;
            }
            for marker in &mut expected_signature {
                marker.start_seconds += offset;
            }
            assert_eq!(proposal.tempo_markers, expected_tempo, "{}", fixture.name);
            assert_eq!(
                proposal.signature_markers, expected_signature,
                "{}",
                fixture.name
            );
        }
    }
}

#[test]
fn rey_de_reyes_keeps_its_counted_bar_without_an_extra_four_four() {
    check_song(include_str!("../tests/fixtures/rey-de-reyes.json"));
}

#[test]
fn musica_del_cielo_keeps_its_section_start_phase_without_a_pickup() {
    check_song(include_str!("../tests/fixtures/musica-del-cielo.json"));
}
