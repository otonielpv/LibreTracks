use crate::{chart_link_marker_id, ChartLink, SongChart};

fn link(marker_id: &str, section: u32, line_beats: Vec<f64>) -> ChartLink {
    ChartLink {
        marker_id: marker_id.into(),
        section,
        line_beats,
        repeat: None,
    }
}

fn chart(links: Vec<ChartLink>) -> SongChart {
    SongChart {
        text: "{section: Coro}\n[C]Gracia".into(),
        links,
        source: None,
        follow: None,
    }
}

#[test]
fn a_repeated_section_uses_the_link_of_its_original_marker() {
    let chart = chart(vec![link("chorus", 2, vec![])]);
    assert_eq!(chart.link_for("chorus~3").map(|link| link.section), Some(2));
    assert!(chart.link_for("verse").is_none());
}

#[test]
fn normalizing_drops_unknown_markers_and_keeps_the_last_link_per_marker() {
    let mut chart = chart(vec![
        link("verse", 0, vec![]),
        link("ghost", 1, vec![]),
        link("verse~2", 3, vec![]),
    ]);
    chart.normalize(|id| id == "verse");
    assert_eq!(chart.links, vec![link("verse", 3, vec![])]);
}

#[test]
fn normalizing_cleans_line_beats() {
    let mut chart = chart(vec![link("verse", 0, vec![8.0, f64::NAN, -2.0, 4.0])]);
    chart.normalize(|_| true);
    assert_eq!(chart.links[0].line_beats, vec![0.0, 4.0, 8.0]);
}

#[test]
fn marker_id_without_suffix_is_left_alone() {
    assert_eq!(chart_link_marker_id("marker_123"), "marker_123");
    assert_eq!(chart_link_marker_id("marker_123~4"), "marker_123");
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
fn a_chart_survives_a_save_and_load_and_omits_empty_beats() {
    let chart = chart(vec![link("verse", 0, vec![]), link("chorus", 1, vec![0.0, 8.0])]);
    let json = serde_json::to_string(&chart).expect("serializes");
    assert!(json.contains("\"markerId\"") && json.contains("\"lineBeats\""));
    assert_eq!(json.matches("lineBeats").count(), 1, "{json}");
    let back: SongChart = serde_json::from_str(&json).expect("parses");
    assert_eq!(back, chart);
}

#[test]
fn a_link_keeps_how_many_times_its_section_plays_and_drops_nonsense() {
    let mut chart = chart(vec![link("verse", 0, vec![]), link("chorus", 1, vec![])]);
    chart.links[0].repeat = Some(2);
    chart.links[1].repeat = Some(1);
    chart.normalize(|_| true);
    assert_eq!(chart.links[0].repeat, Some(2));
    assert_eq!(chart.links[1].repeat, None, "once is the default, not stored");
    let json = serde_json::to_value(&chart).unwrap();
    assert_eq!(json["links"][0]["repeat"], 2);
    assert!(json["links"][1].get("repeat").is_none());
    let back: SongChart = serde_json::from_value(json).unwrap();
    assert_eq!(back, chart);
}

#[test]
fn chart_follow_round_trips_and_unknown_values_read_as_absent() {
    use crate::{ChartFollow, FollowFocus};
    for focus in [FollowFocus::Lines(1), FollowFocus::Lines(2), FollowFocus::Lines(3), FollowFocus::Section, FollowFocus::Off] {
        let mut with = chart(vec![]);
        with.follow = Some(ChartFollow { focus });
        let json = serde_json::to_string(&with).unwrap();
        let back: SongChart = serde_json::from_str(&json).unwrap();
        assert_eq!(back, with, "{json}");
    }
    let without = serde_json::to_string(&chart(vec![])).unwrap();
    assert!(!without.contains("follow"), "{without}");
    let back: SongChart = serde_json::from_str(&without).unwrap();
    assert_eq!(back.follow, None);

    for unknown in [r#"{"focus":7}"#, r#"{"focus":"page"}"#, r#""section""#, "42"] {
        let json = format!(r#"{{"text":"[C]Gracia","links":[{{"markerId":"m1","section":0}}],"follow":{unknown}}}"#);
        let back: SongChart = serde_json::from_str(&json).unwrap_or_else(|error| panic!("{json}: {error}"));
        assert_eq!(back.follow, None, "{unknown}");
        assert_eq!(back.text, "[C]Gracia");
        assert_eq!(back.links.len(), 1);
    }
    let section: SongChart = serde_json::from_str(r#"{"text":"x","follow":{"focus":"section"}}"#).unwrap();
    assert_eq!(section.follow, Some(ChartFollow { focus: FollowFocus::Section }));
    assert_eq!(
        serde_json::to_value(&section).unwrap()["follow"],
        serde_json::json!({ "focus": "section" })
    );
}
