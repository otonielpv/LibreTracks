//! 120 bpm, 4/4 (a beat is 0.5 s, a bar 2 s). One song 0..64 s:
//! Intro 0, Verso 1 4 (8 bars), Coro 20, Verso 2 28, Coro~1 36, Puente 44,
//! Coro~2 52, Final 60. Default lead: one beat.

use std::collections::HashMap;

use super::*;
use crate::lead_plan::{Discontinuity, LeadPlanner};
use crate::lead_time::{LeadGrid, LeadTime};
use crate::model::{
    LyricsStep, Marker, MarkerKind, RegionLyrics, Song, SongMaster, SongRegion, StepMode,
    TempoMarker,
};

const ONE_BEAT: LeadTime = LeadTime::Beats { count: 1.0 };
const TICK: f64 = 0.01;

fn marker(id: &str, kind: MarkerKind, variant: Option<u8>, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind,
        variant,
        color: None,
        category_override: None,
    }
}

fn region(id: &str, start: f64, end: f64, lyrics: Option<RegionLyrics>) -> SongRegion {
    SongRegion {
        drum_loop: None,
        lyrics,
        key_changes: Vec::new(),
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
        chart: None,
        cover_image: None,
        voice_guide_count_style: None,
        structure: None,
    }
}

fn song() -> Song {
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 120.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![region("r1", 0.0, 64.0, Some(RegionLyrics::default()))],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![
            marker("intro", MarkerKind::Intro, None, 0.0),
            marker("v1", MarkerKind::Verse, Some(1), 4.0),
            marker("c", MarkerKind::Chorus, None, 20.0),
            marker("v2", MarkerKind::Verse, Some(2), 28.0),
            marker("c~1", MarkerKind::Chorus, None, 36.0),
            marker("p", MarkerKind::Bridge, None, 44.0),
            marker("c~2", MarkerKind::Chorus, None, 52.0),
            marker("end", MarkerKind::Ending, None, 60.0),
        ],
    }
}

/// What the desktop runtime does each tick, without the network.
struct Runner {
    song: Song,
    grid: LeadGrid,
    items: Vec<LyricsItem>,
    planner: LeadPlanner,
    state: LyricsScheduleState,
    position: f64,
    log: Vec<(f64, LyricsEvent)>,
}

impl Runner {
    fn new(song: Song) -> Self {
        Self::with_counts(song, None)
    }

    fn with_counts(song: Song, counts: Option<HashMap<String, u32>>) -> Self {
        let grid = LeadGrid::new(&song);
        let items = lyrics_items(&song, &grid, &ONE_BEAT, counts.as_ref());
        Self {
            song,
            grid,
            items,
            planner: LeadPlanner::new(),
            state: LyricsScheduleState::default(),
            position: -TICK,
            log: Vec::new(),
        }
    }

    fn run_to(&mut self, until: f64, pending: Option<Discontinuity>) {
        while self.position < until - 1e-9 {
            let now = (self.position + TICK).min(until);
            self.planner.sync_pending(
                &self.grid,
                self.items.iter().map(LyricsItem::lead_item),
                pending.clone(),
                self.position,
            );
            for event in collect_lyrics_events(
                &self.items,
                &self.grid,
                &self.planner,
                self.position,
                now,
                &mut self.state,
            ) {
                self.log.push((now, event));
            }
            self.position = now;
        }
    }

    /// A jump executed: the playhead lands on `landing`.
    fn land(&mut self, landing: f64) {
        let fired_until = self.position;
        let window_start = landing - 1e-6;
        self.planner.on_landing(
            &self.grid,
            self.items.iter().map(LyricsItem::lead_item),
            landing,
            window_start,
            fired_until,
        );
        self.position = window_start;
    }

    fn sections(&self) -> Vec<(String, u32)> {
        self.log
            .iter()
            .filter_map(|(_, event)| match event {
                LyricsEvent::Section {
                    marker_id,
                    occurrence,
                    ..
                } => Some((marker_id.clone(), *occurrence)),
                _ => None,
            })
            .collect()
    }

    fn time_of(&self, wanted: &LyricsEvent) -> f64 {
        self.log
            .iter()
            .find(|(_, event)| event == wanted)
            .unwrap_or_else(|| panic!("{wanted:?} not sent: {:?}", self.log))
            .0
    }
}

fn section(marker: &str, occurrence: u32) -> LyricsEvent {
    LyricsEvent::Section {
        region_id: "r1".into(),
        marker_id: marker.into(),
        occurrence,
    }
}

fn names(list: &[(&str, u32)]) -> Vec<(String, u32)> {
    list.iter().map(|(id, k)| (id.to_string(), *k)).collect()
}

fn assert_near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() <= TICK + 1e-6, "expected {expected}, got {actual}");
}

#[test]
fn linear_playback_fires_each_section_one_beat_early_once() {
    let mut runner = Runner::new(song());
    runner.run_to(70.0, None);
    assert_eq!(
        runner.log.first().map(|(_, event)| event.clone()),
        Some(LyricsEvent::EnterSong {
            region_id: "r1".into()
        })
    );
    assert_eq!(
        runner.sections(),
        names(&[
            ("intro", 0),
            ("v1", 0),
            ("c", 0),
            ("v2", 0),
            ("c~1", 1),
            ("p", 0),
            ("c~2", 2),
            ("end", 0),
        ])
    );
    assert_near(runner.time_of(&section("v1", 0)), 3.5);
    assert_near(runner.time_of(&section("c", 0)), 19.5);
    assert_near(runner.time_of(&section("c~2", 2)), 51.5);
    let exit = LyricsEvent::ExitSong {
        region_id: "r1".into(),
    };
    assert_near(runner.time_of(&exit), 64.0);
    assert_eq!(runner.log.last().map(|(_, event)| event), Some(&exit));
}

#[test]
fn cue_markers_send_nothing() {
    let mut song = song();
    song.section_markers
        .push(marker("build", MarkerKind::Build, None, 10.0));
    let mut runner = Runner::new(song);
    runner.run_to(70.0, None);
    assert!(!runner.items.iter().any(|item| item.id.starts_with("build")));
    assert_eq!(runner.sections().len(), 8);
}

#[test]
fn song_lead_in_bars_seconds_and_across_a_tempo_change() {
    for lead in [LeadTime::Bars { count: 1.0 }, LeadTime::Seconds { seconds: 0.25 }] {
        let mut song = song();
        song.regions[0].lyrics.as_mut().unwrap().lead = Some(lead);
        let mut runner = Runner::new(song);
        runner.run_to(70.0, None);
        for (marker, anchor) in [("v1", 4.0), ("c", 20.0), ("p", 44.0)] {
            let expected = runner.grid.fire_seconds(anchor, Some(&lead));
            let occurrence = 0;
            assert_near(runner.time_of(&section(marker, occurrence)), expected);
        }
    }
    // 60 bpm from 24 s: the beat before Verso 2 (28 s) is a 60 bpm beat.
    let mut song = song();
    song.tempo_markers.push(TempoMarker {
        id: "t".into(),
        start_seconds: 24.0,
        bpm: 60.0,
        ramp: false,
    });
    let mut runner = Runner::new(song);
    runner.run_to(70.0, None);
    assert_near(runner.time_of(&section("v2", 0)), 27.0);
}

#[test]
fn a_live_jump_prefires_the_destination_and_skips_the_section_it_jumps_over() {
    let mut runner = Runner::new(song());
    runner.run_to(10.0, None);
    let jump = Some(Discontinuity::new(20.0, 44.0));
    runner.run_to(20.0, jump);
    runner.land(44.0);
    runner.run_to(70.0, None);
    assert_eq!(
        runner.sections(),
        names(&[("intro", 0), ("v1", 0), ("p", 0), ("c~2", 2), ("end", 0)])
    );
    assert_near(runner.time_of(&section("p", 0)), 19.5);
}

#[test]
fn cancelling_a_jump_after_the_chorus_fire_point_sends_the_chorus_right_away() {
    let mut runner = Runner::new(song());
    runner.run_to(10.0, None);
    runner.run_to(19.7, Some(Discontinuity::new(20.0, 44.0)));
    assert!(!runner.sections().contains(&("c".to_string(), 0)));
    runner.run_to(30.0, None);
    let chorus = runner.time_of(&section("c", 0));
    assert!(chorus > 19.7 && chorus <= 19.7 + 2.0 * TICK, "{chorus}");
}

#[test]
fn a_vamp_does_not_resend_the_chorus_each_lap_and_the_next_section_keeps_its_lead() {
    let mut runner = Runner::new(song());
    let vamp = Some(Discontinuity::new(28.0, 20.0));
    runner.run_to(15.0, None);
    runner.run_to(28.0, vamp.clone());
    runner.land(20.0);
    runner.run_to(28.0, vamp.clone());
    runner.land(20.0);
    // Leave the vamp in the middle of the third lap.
    runner.run_to(22.0, vamp);
    runner.run_to(30.0, None);
    let sections = runner.sections();
    assert_eq!(sections.iter().filter(|(id, _)| id == "c").count(), 1, "{sections:?}");
    assert_eq!(sections.iter().filter(|(id, _)| id == "v2").count(), 1, "{sections:?}");
    assert_near(runner.time_of(&section("v2", 0)), 27.5);
}

#[test]
fn a_vamp_over_a_section_with_slides_goes_back_to_its_first_slide() {
    let counts = HashMap::from([("c".to_string(), 2)]);
    let mut runner = Runner::with_counts(song(), Some(counts));
    let vamp = Some(Discontinuity::new(28.0, 20.0));
    runner.run_to(15.0, None);
    runner.run_to(28.0, vamp);
    let sections = runner.sections();
    // Chorus, its slide 2 at bar 3 of 4, then the chorus again before the lap.
    assert_eq!(sections.iter().filter(|(id, _)| id == "c").count(), 2, "{sections:?}");
}

#[test]
fn automatic_slide_changes_fall_on_whole_bars_or_beats() {
    let song = song();
    let grid = LeadGrid::new(&song);
    // Verso 1: 8 bars, 2 slides → bar 5 (4 + 4 bars = 12 s).
    assert_eq!(auto_step_positions(&grid, 4.0, 20.0, 2), vec![12.0]);
    // Final: 2 bars, 3 slides → beats (8 beats: 2 and 5).
    assert_eq!(auto_step_positions(&grid, 60.0, 64.0, 3), vec![61.0, 62.5]);
    assert!(auto_step_positions(&grid, 4.0, 20.0, 1).is_empty());

    let counts = HashMap::from([("v1".to_string(), 2)]);
    let mut runner = Runner::with_counts(song, Some(counts));
    runner.run_to(70.0, None);
    let step = LyricsEvent::Step {
        region_id: "r1".into(),
        marker_id: "v1".into(),
        k: 1,
    };
    assert_near(runner.time_of(&step), 11.5);
}

#[test]
fn recorded_slide_changes_are_beats_and_follow_the_tempo() {
    let mut song = song();
    {
        let lyrics = song.regions[0].lyrics.as_mut().unwrap();
        lyrics.step_mode = StepMode::Manual;
        lyrics.steps = vec![LyricsStep {
            marker_id: "v1".into(),
            offset_beats: 8.0,
        }];
    }
    let at_120 = lyrics_items(&song, &LeadGrid::new(&song), &ONE_BEAT, None);
    let anchor = |items: &[LyricsItem]| items.iter().find(|item| item.id == "v1#1").unwrap().anchor;
    assert_eq!(anchor(&at_120), 8.0);
    song.bpm = 60.0;
    let at_60 = lyrics_items(&song, &LeadGrid::new(&song), &ONE_BEAT, None);
    assert_eq!(anchor(&at_60), 12.0);
}

#[test]
fn landing_shows_the_section_under_the_cursor_and_its_passed_slides() {
    let mut song = song();
    song.regions.push(region("r2", 70.0, 100.0, Some(RegionLyrics::default())));
    let grid = LeadGrid::new(&song);
    let counts = HashMap::from([("v1".to_string(), 2)]);
    let items = lyrics_items(&song, &grid, &ONE_BEAT, Some(&counts));
    assert_eq!(
        land_lyrics(&song, &items, 13.0),
        Some(LyricsEvent::Land {
            region_id: "r1".into(),
            marker_id: Some("v1".into()),
            occurrence: 0,
            k_passed: 1,
        })
    );
    assert_eq!(
        land_lyrics(&song, &items, 1.0),
        Some(LyricsEvent::Land {
            region_id: "r1".into(),
            marker_id: Some("intro".into()),
            occurrence: 0,
            k_passed: 0,
        })
    );
    assert_eq!(land_lyrics(&song, &items, 66.0), None);
    // A song without sections: the song, no marker.
    assert_eq!(
        land_lyrics(&song, &items, 80.0),
        Some(LyricsEvent::Land {
            region_id: "r2".into(),
            marker_id: None,
            occurrence: 0,
            k_passed: 0,
        })
    );
}

#[test]
fn back_to_back_songs_enter_the_next_without_leaving_the_first() {
    let mut song = song();
    song.regions.push(region("r2", 64.0, 96.0, Some(RegionLyrics::default())));
    song.section_markers
        .push(marker("r2v", MarkerKind::Verse, None, 64.0));
    let mut runner = Runner::new(song);
    runner.run_to(66.0, None);
    assert!(runner.log.iter().any(|(_, event)| *event
        == LyricsEvent::EnterSong {
            region_id: "r2".into()
        }));
    assert!(!runner.log.iter().any(|(_, event)| matches!(event, LyricsEvent::ExitSong { region_id } if region_id == "r1")));
}

#[test]
fn songs_without_lyrics_send_nothing() {
    let mut disabled = song();
    disabled.regions[0].lyrics.as_mut().unwrap().enabled = false;
    let mut none = song();
    none.regions[0].lyrics = None;
    for song in [disabled, none] {
        let mut runner = Runner::new(song);
        runner.run_to(70.0, None);
        assert!(runner.items.is_empty());
        assert!(runner.log.is_empty());
    }
}

#[test]
fn ten_millisecond_windows_and_one_window_give_the_same_events() {
    let counts = HashMap::from([("v1".to_string(), 2), ("c".to_string(), 2)]);
    let mut ticked = Runner::with_counts(song(), Some(counts.clone()));
    ticked.run_to(70.0, None);
    let whole = Runner::with_counts(song(), Some(counts));
    let mut state = LyricsScheduleState::default();
    let events =
        collect_lyrics_events(&whole.items, &whole.grid, &whole.planner, -TICK, 70.0, &mut state);
    let ticked_events: Vec<LyricsEvent> = ticked.log.into_iter().map(|(_, event)| event).collect();
    assert_eq!(ticked_events, events);
    let _ = whole.song;
}
