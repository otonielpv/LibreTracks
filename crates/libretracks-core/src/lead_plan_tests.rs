//! Song used throughout: 120 bpm, 4/4 (a beat is 0.5 s, a bar 2 s).
//! Verse at 0, chorus at 16, verse 2 at 32, bridge at 48. Lyric items sit on
//! the section markers with a lead, like a ProPresenter command would.

use super::*;
use crate::lead_time::LeadTime;
use crate::model::{Song, TempoMarker};

fn song(bpm: f64) -> Song {
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm,
        time_signature: "4/4".into(),
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

const ONE_BEAT: LeadTime = LeadTime::Beats { count: 1.0 };
const TWO_BEATS: LeadTime = LeadTime::Beats { count: 2.0 };

struct Items {
    list: Vec<(String, f64, Option<LeadTime>)>,
}

impl Items {
    fn standard() -> Self {
        Self {
            list: vec![
                ("verse".into(), 0.0, Some(ONE_BEAT)),
                ("chorus".into(), 16.0, Some(ONE_BEAT)),
                ("verse2".into(), 32.0, Some(ONE_BEAT)),
                ("bridge".into(), 48.0, Some(ONE_BEAT)),
                // A plain clip without lead, in the middle of the chorus.
                ("plain".into(), 20.0, None),
            ],
        }
    }

    fn with(mut self, id: &str, anchor: f64, lead: Option<LeadTime>) -> Self {
        self.list.push((id.into(), anchor, lead));
        self
    }

    fn iter(&self) -> impl Iterator<Item = LeadItem<'_>> + Clone {
        self.list.iter().map(|(id, anchor, lead)| LeadItem {
            id,
            anchor: *anchor,
            lead: lead.as_ref(),
        })
    }

    fn get(&self, id: &str) -> LeadItem<'_> {
        self.iter().find(|item| item.id == id).expect("item")
    }
}

fn jump(execute_at: f64, landing: f64) -> Option<Discontinuity> {
    Some(Discontinuity::new(execute_at, landing))
}

fn assert_starts(actual: Vec<f64>, expected: &[f64]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "expected {expected:?}, got {actual:?}"
    );
    for (a, e) in actual.iter().zip(expected) {
        assert!((a - e).abs() < 1.0e-4, "expected {expected:?}, got {actual:?}");
    }
}

#[test]
fn linear_playback_starts_each_item_its_lead_before_the_anchor() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let planner = LeadPlanner::new();

    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
    assert_starts(planner.starts(&grid, items.get("verse2")), &[31.5]);
    // Nothing before 0 to lead into.
    assert_starts(planner.starts(&grid, items.get("verse")), &[0.0]);
    assert!(planner.is_idle());
}

#[test]
fn items_without_lead_are_never_touched() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard().with("on_jump", 16.0, None);
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    // A plain clip past the jump point is not suppressed: same as before leads.
    assert_starts(planner.starts(&grid, items.get("plain")), &[20.0]);
    assert_starts(planner.starts(&grid, items.get("on_jump")), &[16.0]);

    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 16.0);
    assert_starts(planner.starts(&grid, items.get("plain")), &[20.0]);
}

#[test]
fn a_live_jump_fires_the_target_section_and_not_the_skipped_one() {
    // The issue's case: in the verse, a jump at section end (16) to verse 2.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    // The chorus' lyric (which would go out at 15.5) is held back...
    assert!(planner.starts(&grid, items.get("chorus")).is_empty());
    // ...and verse 2's goes out one beat before the jump instead.
    assert_starts(planner.starts(&grid, items.get("verse2")), &[15.5]);
    // Further sections past the jump point are held back too.
    assert!(planner.starts(&grid, items.get("bridge")).is_empty());

    // After landing on 32, verse 2's lyric is not sent again: it carries on
    // from half a second before the landing, already behind the playhead.
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 16.0);
    assert_starts(planner.starts(&grid, items.get("verse2")), &[31.5]);
    // Linear rules again past the landing.
    assert_starts(planner.starts(&grid, items.get("bridge")), &[47.5]);
}

#[test]
fn the_lead_before_a_jump_is_measured_in_the_music_that_plays_before_it() {
    // 60 bpm up to 20 s, 120 after. The jump leaves at 16 (60 bpm): one beat
    // there is 1 s, though verse 2 itself is at 120.
    let mut song = song(60.0);
    song.tempo_markers = vec![TempoMarker {
        id: "t".into(),
        start_seconds: 20.0,
        bpm: 120.0,
        ramp: false,
    }];
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    assert_starts(planner.starts(&grid, items.get("verse2")), &[15.0]);
}

#[test]
fn a_jump_armed_after_the_lead_point_fires_the_target_right_away() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    // Armed at 15.8, past 15.5: verse 2's lyric starts on the next tick.
    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 15.8);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert_eq!(starts.len(), 1);
    assert!(starts[0] > 15.8 && starts[0] < 15.8001, "{starts:?}");
}

#[test]
fn an_immediate_jump_fires_the_target_at_once_and_not_again_on_landing() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(10.0, 32.0), 10.0);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert!(starts[0] > 10.0 && starts[0] < 10.001, "{starts:?}");

    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 10.01);
    let after = planner.starts(&grid, items.get("verse2"));
    assert!(after.iter().all(|start| *start <= 31.999), "{after:?}");
}

#[test]
fn landing_without_seeing_the_jump_armed_still_fires_the_target() {
    // A jump too quick for the runtime to observe while pending: the landing
    // rule catches it.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 16.0);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert_eq!(starts.len(), 1);
    assert!(starts[0] > 31.999 && starts[0] <= 32.0, "{starts:?}");
}

#[test]
fn seeking_inside_a_lead_window_fires_the_upcoming_item() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    // 31.7 is between verse 2's lead point (31.5) and its marker (32).
    planner.on_landing(&grid, items.iter(), 31.7, 31.699, 0.0);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert!(starts[0] > 31.699 && starts[0] <= 31.7001, "{starts:?}");
    // The chorus is long gone, nothing for it.
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
}

#[test]
fn cancelling_before_the_lead_point_restores_linear_playback() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    planner.sync_pending(&grid, items.iter(), None, 15.2);
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
    assert_starts(planner.starts(&grid, items.get("verse2")), &[31.5]);
}

#[test]
fn cancelling_after_the_lead_point_sends_the_held_back_item_at_once() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    // Cancelled at 15.7: the chorus is coming after all and its lyric was held
    // back at 15.5, so it goes out now.
    planner.sync_pending(&grid, items.iter(), None, 15.7);
    let starts = planner.starts(&grid, items.get("chorus"));
    assert!(starts[0] > 15.7 && starts[0] < 15.7001, "{starts:?}");
}

#[test]
fn cancelling_does_not_resend_what_went_out_before_the_jump_was_armed() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    // Armed at 15.8: the chorus lyric already went out at 15.5.
    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 15.8);
    planner.sync_pending(&grid, items.iter(), None, 15.9);
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
}

#[test]
fn changing_the_jump_target_moves_the_pre_fire() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    planner.sync_pending(&grid, items.iter(), jump(16.0, 48.0), 11.0);
    assert!(planner.starts(&grid, items.get("verse2")).is_empty());
    assert_starts(planner.starts(&grid, items.get("bridge")), &[15.5]);
}

#[test]
fn a_lead_longer_than_the_gap_after_the_landing_splits_across_the_jump() {
    // Two beats of lead on an item one beat after the landing: one beat is
    // covered after the landing, the other goes before the jump.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard().with("late_in_verse2", 32.5, Some(TWO_BEATS));
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    assert_starts(planner.starts(&grid, items.get("late_in_verse2")), &[15.5]);
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 16.0);
    assert_starts(planner.starts(&grid, items.get("late_in_verse2")), &[31.5]);
}

#[test]
fn a_vamp_refires_the_loop_start_before_every_wrap() {
    // Vamp on verse 2 (32..48): the lyric on 32 goes out one beat before each
    // wrap, besides its normal linear start the first time.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();
    let vamp = jump(48.0, 32.0);

    planner.sync_pending(&grid, items.iter(), vamp.clone(), 30.0);
    assert_starts(planner.starts(&grid, items.get("verse2")), &[31.5, 47.5]);
    // The bridge (on the vamp's end) is held back while looping.
    assert!(planner.starts(&grid, items.get("bridge")).is_empty());

    // Wrap: lands on 32, the runtime re-arms the same vamp for the next lap.
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 48.0);
    planner.sync_pending(&grid, items.iter(), vamp, 31.999);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert_starts(starts, &[31.5, 47.5]);
}

#[test]
fn a_backward_jump_plays_the_section_again_with_its_lead() {
    // From the bridge's end (64) back to the chorus (16): the chorus lyric
    // goes out one beat before 64.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(64.0, 16.0), 50.0);
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5, 63.5]);
}

#[test]
fn reset_forgets_pending_and_carried_state() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    planner.reset();
    assert!(planner.is_idle());
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
}

#[test]
fn a_pre_fire_the_jump_overtook_goes_out_on_landing() {
    // The runtime only got to 15.4 before the jump executed (a missed tick):
    // verse 2's pre-fire at 15.5 never went out, so it goes out on landing.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 10.0);
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 15.4);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert!(starts[0] > 31.999 && starts[0] <= 32.0, "{starts:?}");
}

#[test]
fn the_same_landing_reported_twice_fires_once() {
    // A vamp wrap path re-lands the cursor after the jump helper already did.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();
    let vamp = jump(48.0, 32.0);

    planner.sync_pending(&grid, items.iter(), vamp, 40.0);
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 48.0);
    planner.on_landing(&grid, items.iter(), 32.0, 31.999, 31.999);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert!(starts.iter().all(|start| *start <= 31.999), "{starts:?}");
}

#[test]
fn landing_on_the_same_point_again_later_is_a_new_landing() {
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();

    planner.on_landing(&grid, items.iter(), 31.7, 31.699, 0.0);
    // Playback moves on, then the user seeks to 31.7 again.
    planner.sync_pending(&grid, items.iter(), None, 35.0);
    planner.on_landing(&grid, items.iter(), 31.7, 31.699, 35.0);
    let starts = planner.starts(&grid, items.get("verse2"));
    assert!(starts[0] > 31.699 && starts[0] <= 31.7001, "{starts:?}");
}

#[test]
fn a_cue_is_never_held_back_or_pre_fired_by_its_own_jump() {
    // A cue on 16 with a lead whose own jump (no waits) executes at 16 and
    // goes back to 16: its actions still go out one beat early, once.
    let song = song(120.0);
    let grid = LeadGrid::new(&song);
    let items = Items::standard();
    let mut planner = LeadPlanner::new();
    let own_jump = Some(Discontinuity {
        execute_at: 16.0,
        landing: 16.0,
        owner: Some("chorus".into()),
    });

    planner.sync_pending(&grid, items.iter(), own_jump, 10.0);
    assert_starts(planner.starts(&grid, items.get("chorus")), &[15.5]);
    // Someone else's jump at the same point does hold it back.
    planner.sync_pending(&grid, items.iter(), jump(16.0, 32.0), 11.0);
    assert!(planner.starts(&grid, items.get("chorus")).is_empty());
}
