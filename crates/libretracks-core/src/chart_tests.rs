use crate::{chart_anchor_marker_id, looks_like_pdf, SongChart};

fn chart() -> SongChart {
    SongChart {
        file_path: "charts/song.pdf".into(),
        anchors: Vec::new(),
    }
}

#[test]
fn a_repeated_section_resolves_to_the_anchor_of_its_original_marker() {
    let mut chart = chart();
    chart.set_anchor("chorus", 1, 0.4);

    let repeat = chart.anchor_for("chorus~2").expect("repeat finds the original");
    assert_eq!((repeat.page, repeat.y), (1, 0.4));
    assert!(chart.anchor_for("verse").is_none());
}

#[test]
fn setting_an_anchor_from_a_repeat_moves_the_original_one() {
    let mut chart = chart();
    chart.set_anchor("chorus", 0, 0.2);
    chart.set_anchor("chorus~3", 2, 0.9);

    assert_eq!(chart.anchors.len(), 1);
    assert_eq!(chart.anchors[0].marker_id, "chorus");
    assert_eq!((chart.anchors[0].page, chart.anchors[0].y), (2, 0.9));
}

#[test]
fn anchor_height_is_clamped_to_the_page() {
    let mut chart = chart();
    chart.set_anchor("a", 0, 1.7);
    chart.set_anchor("b", 0, -0.3);
    chart.set_anchor("c", 0, f64::NAN);

    let ys: Vec<f64> = chart.anchors.iter().map(|anchor| anchor.y).collect();
    assert_eq!(ys, vec![1.0, 0.0, 0.0]);
}

#[test]
fn removing_through_a_repeat_removes_the_original_anchor() {
    let mut chart = chart();
    chart.set_anchor("chorus", 0, 0.5);
    chart.remove_anchor("chorus~2");
    assert!(chart.anchors.is_empty());
}

#[test]
fn marker_id_without_suffix_is_left_alone() {
    assert_eq!(chart_anchor_marker_id("marker_123"), "marker_123");
    assert_eq!(chart_anchor_marker_id("marker_123~4"), "marker_123");
}

#[test]
fn pdf_header_is_found_in_the_first_kilobyte() {
    assert!(looks_like_pdf(b"%PDF-1.7\n..."));
    let mut prefixed = vec![b' '; 300];
    prefixed.extend_from_slice(b"%PDF-1.4");
    assert!(looks_like_pdf(&prefixed));

    assert!(!looks_like_pdf(b"RIFF....WAVE"));
    let mut too_late = vec![b' '; 2000];
    too_late.extend_from_slice(b"%PDF-1.4");
    assert!(!looks_like_pdf(&too_late));
}

#[test]
fn a_session_without_chart_round_trips_without_the_field() {
    let json = r#"{"id":"r","name":"Song","startSeconds":0,"endSeconds":10}"#;
    let region: crate::SongRegion = serde_json::from_str(json).expect("old region parses");
    assert!(region.chart.is_none());
    let saved = serde_json::to_string(&region).expect("serializes");
    assert!(!saved.contains("chart"), "absent chart must not be written: {saved}");
}

#[test]
fn a_chart_survives_a_save_and_load() {
    let mut chart = chart();
    chart.set_anchor("verse", 0, 0.25);
    let json = serde_json::to_string(&chart).expect("serializes");
    assert!(json.contains("\"filePath\"") && json.contains("\"markerId\""));
    let back: SongChart = serde_json::from_str(&json).expect("parses");
    assert_eq!(back, chart);
}
