//! What redundancy reads from and hears from the session
//! (docs/plans/redundancy).
//!
//! - The single door for transport (step 04): the public transport methods
//!   live HERE, wrap the `apply_*` ones in `state/mod.rs` and emit exactly one
//!   [`TransportIntent`] after a successful change. Whatever calls the session
//!   (UI, MIDI, remote, network guests, the backup's follower) goes through
//!   them, so nothing can change the transport without the backup hearing.
//! - Cheap clones for the fingerprint (step 03), taken under the session lock;
//!   the hashing happens after it is released.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;

use libretracks_audio::{JumpTrigger, TransitionType, VampMode};
use libretracks_core::automation::AutomationCue;
use libretracks_core::Song;
use libretracks_link::redundancy::TransportIntent;
use tokio::sync::broadcast;

use super::{DesktopError, DesktopSession};
use crate::audio::engine::AudioController;
use crate::models::view::TransportSnapshot;

/// Where a transport change came from. The publisher never forwards
/// `Follower` changes (they came FROM the main: sending them back would loop
/// when the roles are swapped, step 07).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IntentOrigin {
    #[default]
    Local,
    Link,
    Midi,
    Remote,
    Follower,
}

impl IntentOrigin {
    fn to_u8(self) -> u8 {
        match self {
            IntentOrigin::Local => 0,
            IntentOrigin::Link => 1,
            IntentOrigin::Midi => 2,
            IntentOrigin::Remote => 3,
            IntentOrigin::Follower => 4,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => IntentOrigin::Link,
            2 => IntentOrigin::Midi,
            3 => IntentOrigin::Remote,
            4 => IntentOrigin::Follower,
            _ => IntentOrigin::Local,
        }
    }
}

/// Tags every transport change as `origin` until dropped, then restores the
/// previous origin. Holds no borrow of the session, so the caller keeps using
/// it normally (early returns included).
#[must_use]
pub struct OriginScope {
    cell: Arc<AtomicU8>,
    previous: u8,
}

impl Drop for OriginScope {
    fn drop(&mut self) {
        self.cell.store(self.previous, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OriginatedIntent {
    pub intent: TransportIntent,
    pub origin: IntentOrigin,
    pub at: Instant,
}

/// Bounded: a subscriber that falls this far behind loses the oldest (the
/// periodic state catches it up).
pub const INTENT_CHANNEL_CAPACITY: usize = 64;

pub struct IntentBus {
    tx: broadcast::Sender<OriginatedIntent>,
    origin: Arc<AtomicU8>,
    /// Nesting of public transport calls (a fade's second press calls
    /// `stop`): only the outermost one emits.
    depth: u32,
}

impl Default for IntentBus {
    fn default() -> Self {
        Self {
            tx: broadcast::channel(INTENT_CHANNEL_CAPACITY).0,
            origin: Arc::new(AtomicU8::new(IntentOrigin::Local.to_u8())),
            depth: 0,
        }
    }
}

impl IntentBus {
    /// Never blocks, never fails the change: no subscriber or a full channel
    /// just drops it.
    fn emit(&self, intent: TransportIntent) {
        let _ = self.tx.send(OriginatedIntent {
            intent,
            origin: IntentOrigin::from_u8(self.origin.load(Ordering::Relaxed)),
            at: Instant::now(),
        });
    }
}

/// The same strings `commands::transport::parse_jump_trigger` reads.
pub fn jump_trigger_parts(trigger: &JumpTrigger) -> (&'static str, Option<u32>) {
    match trigger {
        JumpTrigger::Immediate => ("immediate", None),
        JumpTrigger::NextMarker => ("next_marker", None),
        JumpTrigger::NextSection => ("next_section", None),
        JumpTrigger::NextCue => ("next_cue", None),
        JumpTrigger::RegionEnd => ("region_end", None),
        JumpTrigger::AfterBars(bars) => ("after_bars", Some(*bars)),
    }
}

/// The same strings `commands::transport::parse_transition_type` reads.
pub fn transition_parts(transition: &TransitionType) -> (&'static str, Option<f64>) {
    match transition {
        TransitionType::Instant => ("instant", None),
        TransitionType::FadeOut { duration_seconds } => ("fade_out", Some(*duration_seconds)),
    }
}

/// The same strings `commands::transport::parse_vamp_mode` reads.
pub fn vamp_mode_parts(mode: &VampMode) -> (&'static str, Option<u32>) {
    match mode {
        VampMode::Section => ("section", None),
        VampMode::SectionMarker => ("section_marker", None),
        VampMode::Cue => ("cue", None),
        VampMode::Bars(bars) => ("bars", Some(*bars)),
    }
}

/// Every public transport method of the session and the intent it emits.
/// Exhaustive on purpose (no `_`): a new intent kind does not compile until
/// it names its method, and `transport_command_coverage` checks the other
/// direction (every transport Tauri command maps to one of these).
pub fn method_for(intent: &TransportIntent) -> &'static str {
    match intent {
        TransportIntent::Play { .. } => "play",
        TransportIntent::Pause { .. } => "pause",
        TransportIntent::Stop => "stop",
        TransportIntent::FadeOutStop { .. } => "fade_out_and_stop",
        TransportIntent::Seek { .. } => "seek",
        TransportIntent::ScheduleMarkerJump { .. } => "schedule_marker_jump",
        TransportIntent::ScheduleRegionJump { .. } => "schedule_region_jump",
        TransportIntent::CancelJump => "cancel_marker_jump",
        TransportIntent::ToggleVamp { .. } => "toggle_vamp",
        // Not a session method: the publisher derives it from the state.
        TransportIntent::SongChanged { .. } => "",
    }
}

impl DesktopSession {
    /// Follow the transport changes (redundancy publisher).
    pub fn subscribe_intents(&self) -> broadcast::Receiver<OriginatedIntent> {
        self.intents.tx.subscribe()
    }

    /// Tag every transport change as `origin` while the returned scope lives.
    pub fn intent_origin_scope(&self, origin: IntentOrigin) -> OriginScope {
        let cell = self.intents.origin.clone();
        let previous = cell.swap(origin.to_u8(), Ordering::Relaxed);
        OriginScope { cell, previous }
    }

    fn published(
        &mut self,
        run: impl FnOnce(&mut Self) -> Result<TransportSnapshot, DesktopError>,
        intent: impl FnOnce(&Self, &TransportSnapshot) -> Option<TransportIntent>,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.intents.depth += 1;
        let result = run(self);
        self.intents.depth -= 1;
        if let Ok(snapshot) = &result {
            if self.intents.depth == 0 {
                if let Some(intent) = intent(self, snapshot) {
                    self.intents.emit(intent);
                }
            }
        }
        result
    }

    pub fn play(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.published(
            |session| session.apply_play(audio),
            |_, snapshot| {
                Some(TransportIntent::Play {
                    from_seconds: snapshot.position_seconds,
                })
            },
        )
    }

    pub fn pause(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.published(
            |session| session.apply_pause(audio),
            |_, snapshot| {
                Some(TransportIntent::Pause {
                    at_seconds: snapshot.position_seconds,
                })
            },
        )
    }

    pub fn stop(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.published(
            |session| session.apply_stop(audio),
            |_, _| Some(TransportIntent::Stop),
        )
    }

    /// A second press while fading stops at once: that goes out as `Stop`,
    /// so a backup that missed the first press does not start a fade.
    pub fn fade_out_and_stop(
        &mut self,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let was_fading = self.fade_stop.is_some();
        self.published(
            |session| session.apply_fade_out_and_stop(duration_seconds, audio),
            move |session, _| {
                if was_fading {
                    Some(TransportIntent::Stop)
                } else if session.fade_stop.is_some() {
                    Some(TransportIntent::FadeOutStop {
                        duration_ms: (super::fade_stop::sanitize_fade_stop_seconds(
                            duration_seconds,
                        ) * 1000.0)
                            .round() as u32,
                    })
                } else {
                    // Not playing: nothing changed.
                    None
                }
            },
        )
    }

    /// `position_seconds` in view time, as the UI passes it; the backup calls
    /// this same method with the same value.
    pub fn seek(
        &mut self,
        position_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.published(
            |session| session.apply_seek(position_seconds, audio),
            |_, _| {
                Some(TransportIntent::Seek {
                    to_seconds: position_seconds,
                })
            },
        )
    }

    /// The intent carries the marker, trigger and transition (not just the
    /// target), so the backup takes the SAME jump path, prepared jumps
    /// included.
    pub fn schedule_marker_jump(
        &mut self,
        target_marker_id: &str,
        trigger: JumpTrigger,
        transition: TransitionType,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let (trigger_name, bars) = jump_trigger_parts(&trigger);
        let (transition_name, duration_seconds) = transition_parts(&transition);
        let marker_id = target_marker_id.to_string();
        self.published(
            |session| session.apply_schedule_marker_jump(target_marker_id, trigger, transition, audio),
            move |_, _| {
                Some(TransportIntent::ScheduleMarkerJump {
                    marker_id,
                    trigger: trigger_name.into(),
                    bars,
                    transition: Some(transition_name.into()),
                    duration_seconds,
                })
            },
        )
    }

    pub fn schedule_region_jump(
        &mut self,
        target_region_id: &str,
        trigger: JumpTrigger,
        transition: TransitionType,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let (trigger_name, bars) = jump_trigger_parts(&trigger);
        let (transition_name, duration_seconds) = transition_parts(&transition);
        let region_id = target_region_id.to_string();
        self.published(
            |session| session.apply_schedule_region_jump(target_region_id, trigger, transition, audio),
            move |_, _| {
                Some(TransportIntent::ScheduleRegionJump {
                    region_id,
                    trigger: trigger_name.into(),
                    bars,
                    transition: Some(transition_name.into()),
                    duration_seconds,
                })
            },
        )
    }

    pub fn cancel_marker_jump(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.published(
            |session| session.apply_cancel_marker_jump(audio),
            |_, _| Some(TransportIntent::CancelJump),
        )
    }

    /// Goes out as the RESULTING vamp (on or off), never as a toggle.
    pub fn toggle_vamp(
        &mut self,
        mode: VampMode,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let (mode_name, bars) = vamp_mode_parts(&mode);
        self.published(
            |session| session.apply_toggle_vamp(mode, audio),
            move |_, snapshot| {
                Some(TransportIntent::ToggleVamp {
                    enabled: snapshot.active_vamp.is_some(),
                    mode: Some(mode_name.into()),
                    bars,
                })
            },
        )
    }
}

/// What the session fingerprint is computed from, cloned so the caller can
/// drop the lock before hashing.
pub struct FingerprintSource {
    pub song: Song,
    pub song_dir: Option<PathBuf>,
    pub automation_cues: Vec<AutomationCue>,
}

impl DesktopSession {
    pub fn fingerprint_source(&self) -> Option<FingerprintSource> {
        Some(FingerprintSource {
            song: self.engine.song()?.clone(),
            song_dir: self.song_dir.clone(),
            automation_cues: self.automation.cues.clone(),
        })
    }
}

#[cfg(test)]
#[path = "redundancy_tests.rs"]
mod tests;
