//! Plan lyrics-sync, paso 03: el vínculo de letra en el modelo y los ajustes
//! globales.

use crate::lead_time::LeadTime;
use crate::lyrics_config::{default_port, LyricsConfig};
use crate::model::{
    LyricsLink, LyricsSoftware, LyricsStep, OverrideTarget, RegionLyrics, SectionOverride,
    SongRegion, StepMode,
};

const LEGACY_REGION: &str = r#"{"id":"r1","name":"Way Maker","startSeconds":0.0,"endSeconds":240.0,"transposeSemitones":0,"warpEnabled":false,"warpSourceBpm":null,"master":{"gain":1.0}}"#;

#[test]
fn a_region_saved_before_the_plan_saves_back_the_same() {
    let region: SongRegion = serde_json::from_str(LEGACY_REGION).expect("legacy region");
    assert!(region.lyrics.is_none());
    let once = serde_json::to_string(&region).unwrap();
    assert!(!once.contains("lyrics"), "{once}");
    let again: SongRegion = serde_json::from_str(&once).unwrap();
    assert_eq!(serde_json::to_string(&again).unwrap(), once);
}

fn full_lyrics() -> RegionLyrics {
    let link = |software, id: Option<&str>| LyricsLink {
        software,
        presentation_id: id.map(str::to_string),
        presentation_name: "Way Maker".into(),
        overrides: vec![
            SectionOverride {
                marker_id: "c".into(),
                target: OverrideTarget::Group {
                    label: "Chorus 1".into(),
                },
            },
            SectionOverride {
                marker_id: "c~2".into(),
                target: OverrideTarget::Clear,
            },
            SectionOverride {
                marker_id: "inst".into(),
                target: OverrideTarget::Skip,
            },
        ],
    };
    RegionLyrics {
        enabled: false,
        links: vec![
            link(LyricsSoftware::ProPresenter, Some("UUID-1")),
            link(LyricsSoftware::FreeShow, Some("show1")),
            link(LyricsSoftware::Holyrics, None),
        ],
        steps: vec![LyricsStep {
            marker_id: "v1".into(),
            offset_beats: 16.0,
        }],
        step_mode: StepMode::Manual,
        lead: Some(LeadTime::Beats { count: 2.0 }),
    }
}

#[test]
fn region_lyrics_round_trip_without_loss() {
    let lyrics = full_lyrics();
    let json = serde_json::to_string(&lyrics).unwrap();
    assert!(json.contains(r#""type":"group""#), "{json}");
    assert!(json.contains(r#""software":"proPresenter""#), "{json}");
    let back: RegionLyrics = serde_json::from_str(&json).unwrap();
    assert_eq!(back, lyrics);
}

#[test]
fn an_unknown_program_reads_as_unknown_and_keeps_the_rest() {
    let json = r#"{"enabled":true,"links":[
        {"software":"openLp","presentationName":"Oceans"},
        {"software":"holyrics","presentationName":"Oceans","presentationId":"42"}
    ],"stepMode":"auto"}"#;
    let lyrics: RegionLyrics = serde_json::from_str(json).expect("tolerant");
    assert_eq!(lyrics.links[0].software, LyricsSoftware::Unknown);
    assert_eq!(lyrics.links[0].presentation_name, "Oceans");
    assert_eq!(
        lyrics.link_for(LyricsSoftware::Holyrics).unwrap().presentation_id.as_deref(),
        Some("42")
    );
}

#[test]
fn an_explicit_repeat_override_wins_over_the_base_one() {
    let lyrics = full_lyrics();
    let link = lyrics.link_for(LyricsSoftware::FreeShow).unwrap();
    assert_eq!(link.override_for("c~2"), Some(&OverrideTarget::Clear));
    assert_eq!(
        link.override_for("c~1"),
        Some(&OverrideTarget::Group {
            label: "Chorus 1".into()
        })
    );
    assert_eq!(link.override_for("v1"), None);
    assert_eq!(lyrics.steps_for("v1~3"), vec![16.0]);
}

#[test]
fn enabled_defaults_to_true_when_missing() {
    let lyrics: RegionLyrics = serde_json::from_str(r#"{"links":[]}"#).unwrap();
    assert!(lyrics.enabled);
    assert_eq!(lyrics.step_mode, StepMode::Auto);
}

#[test]
fn lyrics_config_reads_tolerantly() {
    assert_eq!(LyricsConfig::parse(""), LyricsConfig::default());
    assert_eq!(LyricsConfig::parse("{not json"), LyricsConfig::default());
    assert_eq!(LyricsConfig::parse("[1,2]"), LyricsConfig::default());

    let config = LyricsConfig::parse(
        r#"{"enabled":true,"software":"holyrics","host":"192.168.1.20","port":"nope","futureField":1,"clearOnStop":true}"#,
    );
    assert!(config.enabled);
    assert_eq!(config.software, Some(LyricsSoftware::Holyrics));
    assert_eq!(config.host, "192.168.1.20");
    assert_eq!(config.port, None, "a broken field keeps its default");
    assert!(config.clear_on_stop);
    assert!(config.clear_on_song_end);
    assert_eq!(config.effective_port(), Some(8091));
}

#[test]
fn lyrics_config_defaults() {
    let config = LyricsConfig::default();
    assert!(!config.enabled);
    assert_eq!(config.software, None);
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.lead, LeadTime::Beats { count: 1.0 });
    assert!(config.clear_on_song_end && !config.clear_on_stop && !config.paused);
    assert_eq!(default_port(LyricsSoftware::FreeShow), Some(5506));
    assert_eq!(default_port(LyricsSoftware::ProPresenter), None);
}
