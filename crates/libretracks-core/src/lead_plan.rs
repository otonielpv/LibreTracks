//! When items with a lead time fire, given what the transport is about to do.
//!
//! [`crate::lead_time`] answers "how long before this point is N beats".
//! This module answers "at which position of the CURRENT timeline does this
//! item start", which depends on what is pending: a live jump, a cue's jump or
//! a vamp loop can make an item's section start somewhere other than at its
//! own position. Rules (`docs/plans/lead-time/00-DISENO.md` §4):
//!
//! - **Linear**: an item starts at `F = lead before its anchor`.
//! - **Suppression**: while a discontinuity is pending at `E`, an item with a
//!   lead anchored at or after `E` does not start before the jump (it is the
//!   section the jump skips).
//! - **Pre-fire**: an item anchored at or after the landing `X` whose lead
//!   spills before `X` starts the spilled part before `E`.
//! - **Late**: when that point already passed (the jump was armed late, or is
//!   immediate), the item starts right away.
//! - **Landing**: after landing on `X`, pre-fired items carry on from where
//!   they are (not again), and items whose lead window contains `X` start
//!   right away (they are what should be showing now).
//!
//! Items WITHOUT a lead are never touched: they start on their anchor, exactly
//! as before this module existed.
//!
//! The planner holds a little state (what was pre-fired for which jump), but no
//! device, engine or clock: the desktop runtimes own it and call it, and the
//! decisions are covered by tests here, which run in CI.

use std::collections::HashMap;

use crate::lead_time::{has_lead, LeadGrid, LeadTime};

/// Positions closer than this are the same instant.
const POSITION_EPSILON: f64 = 1.0e-6;
/// A late item is placed just after the start of the next window, which is
/// half-open (`(start, end]`), so it fires on the next tick that advances.
const LATE_EPSILON: f64 = 1.0e-6;

/// One schedulable thing with a lead (a MIDI clip, an automation cue).
#[derive(Debug, Clone, Copy)]
pub struct LeadItem<'a> {
    pub id: &'a str,
    /// Where it is placed, in source seconds (the section marker it belongs
    /// to).
    pub anchor: f64,
    pub lead: Option<&'a LeadTime>,
}

/// A pending jump of the playhead: from `execute_at` to `landing`, both in
/// source seconds. A vamp is one too (from its end back to its start), re-armed
/// after every wrap.
#[derive(Debug, Clone, PartialEq)]
pub struct Discontinuity {
    pub execute_at: f64,
    pub landing: f64,
    /// The item whose own jump this is (a cue with a jump). It sits on or
    /// before the jump point by construction, so it is never held back by it,
    /// and it is not pre-fired by it either (a cue jumping onto itself does not
    /// re-fire before its own jump, as the armed-cue slot's `skip_cue_id`).
    pub owner: Option<String>,
}

impl Discontinuity {
    pub fn new(execute_at: f64, landing: f64) -> Self {
        Self {
            execute_at,
            landing,
            owner: None,
        }
    }

    fn same_as(&self, other: &Discontinuity) -> bool {
        (self.execute_at - other.execute_at).abs() < POSITION_EPSILON
            && (self.landing - other.landing).abs() < POSITION_EPSILON
            && self.owner == other.owner
    }

    fn owned_by(&self, id: &str) -> bool {
        self.owner.as_deref() == Some(id)
    }
}

#[derive(Debug, Clone)]
struct Armed {
    jump: Discontinuity,
    /// Window start when it was armed: suppressed items whose linear start
    /// falls after this never went out, so a cancel has to send them.
    armed_at: f64,
}

#[derive(Debug, Clone, Default)]
pub struct LeadPlanner {
    armed: Option<Armed>,
    /// Item id → where it starts before the pending jump (current timeline).
    prefire: HashMap<String, f64>,
    /// Item id → start that replaces the linear one on the current timeline:
    /// pre-fired items carried across a landing, and late items.
    overrides: HashMap<String, f64>,
    /// Where the last landing was, until playback moves on from it: the same
    /// landing reported twice (some paths re-land the cursor after a jump
    /// helper already did) must not fire the landing's items twice.
    last_landing: Option<f64>,
}

/// How far playback has to move past a landing before landing there again
/// counts as a new landing.
const RELANDING_SECONDS: f64 = 0.05;

impl LeadPlanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget everything (stop, song edit). The next landing or arm starts
    /// from scratch.
    pub fn reset(&mut self) {
        self.armed = None;
        self.prefire.clear();
        self.overrides.clear();
        self.last_landing = None;
    }

    /// Tell the planner what is pending now. Call it on every tick BEFORE
    /// collecting the window that starts at `window_start` (exclusive); it is
    /// a no-op while nothing changes.
    pub fn sync_pending<'a>(
        &mut self,
        grid: &LeadGrid,
        items: impl IntoIterator<Item = LeadItem<'a>> + Clone,
        pending: Option<Discontinuity>,
        window_start: f64,
    ) {
        if self
            .last_landing
            .is_some_and(|landing| (window_start - landing).abs() > RELANDING_SECONDS)
        {
            self.last_landing = None;
        }
        let unchanged = match (&self.armed, &pending) {
            (None, None) => true,
            (Some(armed), Some(jump)) => armed.jump.same_as(jump),
            _ => false,
        };
        if unchanged {
            return;
        }
        if let Some(previous) = self.armed.take() {
            self.cancel(grid, items.clone(), previous, window_start);
        }
        if let Some(jump) = pending {
            self.arm(grid, items, jump, window_start);
        }
    }

    fn cancel<'a>(
        &mut self,
        grid: &LeadGrid,
        items: impl IntoIterator<Item = LeadItem<'a>>,
        previous: Armed,
        window_start: f64,
    ) {
        self.prefire.clear();
        // What the jump suppressed comes back. Whatever should have started
        // between the arming and now starts right away; what is still ahead
        // starts on its own (its linear start is no longer suppressed).
        for item in items {
            if !has_lead(item.lead)
                || previous.jump.owned_by(item.id)
                || item.anchor < previous.jump.execute_at - POSITION_EPSILON
            {
                continue;
            }
            let start = grid.fire_seconds(item.anchor, item.lead);
            if start > previous.armed_at && start <= window_start {
                self.overrides
                    .insert(item.id.to_string(), window_start + LATE_EPSILON);
            }
        }
    }

    fn arm<'a>(
        &mut self,
        grid: &LeadGrid,
        items: impl IntoIterator<Item = LeadItem<'a>>,
        jump: Discontinuity,
        window_start: f64,
    ) {
        self.prefire.clear();
        for item in items {
            if jump.owned_by(item.id) {
                continue;
            }
            let Some(rest) = grid.remainder_before_landing(jump.landing, item.anchor, item.lead)
            else {
                continue;
            };
            let mut start = grid.fire_seconds(jump.execute_at, Some(&rest));
            if start <= window_start {
                start = window_start + LATE_EPSILON;
            }
            self.prefire.insert(item.id.to_string(), start);
        }
        self.armed = Some(Armed {
            jump,
            armed_at: window_start,
        });
    }

    /// The playhead landed on `landing` (a jump executed, a seek, playback
    /// started). `window_start` is where the next window starts (the runtime
    /// usually lands its cursor just before the landing point); `fired_until`
    /// is how far the runtime had fired on the old timeline before the jump
    /// (the end of its last window there), which tells a pre-fired item that
    /// already went out from one the jump overtook.
    pub fn on_landing<'a>(
        &mut self,
        grid: &LeadGrid,
        items: impl IntoIterator<Item = LeadItem<'a>>,
        landing: f64,
        window_start: f64,
        fired_until: f64,
    ) {
        if self.armed.is_none()
            && self
                .last_landing
                .is_some_and(|last| (last - landing).abs() < POSITION_EPSILON)
        {
            return;
        }
        self.last_landing = Some(landing);
        let late = window_start.max(landing - POSITION_EPSILON) + LATE_EPSILON;
        let mut carried = HashMap::new();
        if let Some(armed) = self.armed.take() {
            if (armed.jump.landing - landing).abs() < POSITION_EPSILON {
                for (id, start) in self.prefire.drain() {
                    // Same distance before the jump as before the landing:
                    // what was half a beat before E goes on half a beat
                    // before X. Clamped so an item that already went out is
                    // never ahead of the cursor (sent twice), and one the jump
                    // overtook starts now (never lost).
                    let mapped = landing - (armed.jump.execute_at - start);
                    let start = if start <= fired_until {
                        mapped.min(window_start)
                    } else {
                        mapped.max(late)
                    };
                    carried.insert(id, start);
                }
            }
        }
        self.prefire.clear();
        for item in items {
            if !has_lead(item.lead) || carried.contains_key(item.id) {
                continue;
            }
            let start = grid.fire_seconds(item.anchor, item.lead);
            if start < landing - POSITION_EPSILON && item.anchor >= landing - POSITION_EPSILON {
                carried.insert(item.id.to_string(), late);
            }
        }
        self.overrides = carried;
    }

    /// Every position of the current timeline where `item` starts (usually
    /// one; two when a backward jump or a vamp replays it; none when a pending
    /// jump suppresses it).
    pub fn starts(&self, grid: &LeadGrid, item: LeadItem<'_>) -> Vec<f64> {
        let mut starts = Vec::with_capacity(2);
        if let Some(start) = self.overrides.get(item.id) {
            starts.push(*start);
        } else if !self.suppressed(item) {
            starts.push(grid.fire_seconds(item.anchor, item.lead));
        }
        if let Some(start) = self.prefire.get(item.id) {
            if starts
                .iter()
                .all(|other| (other - start).abs() >= POSITION_EPSILON)
            {
                starts.push(*start);
            }
        }
        starts
    }

    fn suppressed(&self, item: LeadItem<'_>) -> bool {
        has_lead(item.lead)
            && self.armed.as_ref().is_some_and(|armed| {
                !armed.jump.owned_by(item.id)
                    && item.anchor >= armed.jump.execute_at - POSITION_EPSILON
            })
    }

    /// Whether anything about leads is in play; when false the runtime can use
    /// anchors directly.
    pub fn is_idle(&self) -> bool {
        self.armed.is_none()
            && self.prefire.is_empty()
            && self.overrides.is_empty()
            && self.last_landing.is_none()
    }
}

#[cfg(test)]
#[path = "lead_plan_tests.rs"]
mod tests;
