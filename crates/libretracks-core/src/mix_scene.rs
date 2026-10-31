//! Mix scenes (plan live-scenes, paso 01): a named mix state made of rules
//! that pick tracks by what they are (the active song, a folder, words in the
//! name) instead of by id, so one scene serves every song of a session.
//!
//! Everything here is pure: no engine, no ramps, no clock. The desktop crate
//! resolves a scene against the engine's song and plays the result.
//!
//! Scenes written before the plan (`trackOverrides`, absolute values per
//! track id) migrate on read into `Track` rules (D7) and behave the same.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};

use crate::model::{Song, TrackKind};
use crate::track_matching::fold_text;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixScene {
    pub id: String,
    pub name: String,
    /// Ramp when engaged or released by hand (seconds, 0 = instant).
    #[serde(default)]
    pub ramp_seconds: f64,
    #[serde(default)]
    pub rules: Vec<SceneRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneRule {
    pub select: TrackSelector,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub except: Vec<TrackSelector>,
    #[serde(default)]
    pub change: TrackChange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TrackSelector {
    /// One track by id, whatever its kind (the pre-plan scenes).
    Track { track_id: String },
    /// Every audio track of the song under the playhead.
    ActiveSong,
    /// The audio tracks under the active song's folders with this name.
    Folder { name: String },
    /// The active song's audio tracks whose name contains any of the words,
    /// ignoring case and accents.
    NameContains { words: Vec<String> },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<VolumeChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<PanChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum VolumeChange {
    /// Linear gain, 0..1.
    Absolute(f64),
    /// Decibels over the current gain (D6).
    RelativeDb(f64),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum PanChange {
    /// -1..1.
    Absolute(f64),
    /// Added to the current pan.
    Relative(f64),
}

impl TrackChange {
    pub fn is_empty(&self) -> bool {
        self.volume.is_none() && self.pan.is_none() && self.muted.is_none() && self.solo.is_none()
    }

    /// `other` on top of `self`, field by field: the later rule wins.
    fn overlay(&mut self, other: &TrackChange) {
        if other.volume.is_some() {
            self.volume = other.volume;
        }
        if other.pan.is_some() {
            self.pan = other.pan;
        }
        if other.muted.is_some() {
            self.muted = other.muted;
        }
        if other.solo.is_some() {
            self.solo = other.solo;
        }
    }
}

impl MixScene {
    /// Whether a rule follows the active song (so the scene moves when the
    /// song changes, paso 06) rather than pointing at fixed track ids.
    pub fn follows_song(&self) -> bool {
        self.rules
            .iter()
            .any(|rule| !matches!(rule.select, TrackSelector::Track { .. }))
    }
}

// --- Migration (D7) -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTrackOverride {
    track_id: String,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    pan: Option<f64>,
    #[serde(default)]
    muted: Option<bool>,
    #[serde(default)]
    solo: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMixScene {
    id: String,
    name: String,
    #[serde(default)]
    ramp_seconds: f64,
    #[serde(default)]
    rules: Option<Vec<SceneRule>>,
    #[serde(default)]
    track_overrides: Vec<LegacyTrackOverride>,
}

impl<'de> Deserialize<'de> for MixScene {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawMixScene::deserialize(deserializer)?;
        let rules = match raw.rules {
            Some(rules) => rules,
            None => raw
                .track_overrides
                .into_iter()
                .map(|legacy| SceneRule {
                    select: TrackSelector::Track {
                        track_id: legacy.track_id,
                    },
                    except: Vec::new(),
                    change: TrackChange {
                        volume: legacy.volume.map(VolumeChange::Absolute),
                        pan: legacy.pan.map(PanChange::Absolute),
                        muted: legacy.muted,
                        solo: legacy.solo,
                    },
                })
                .collect(),
        };
        Ok(MixScene {
            id: raw.id,
            name: raw.name,
            ramp_seconds: if raw.ramp_seconds.is_finite() {
                raw.ramp_seconds.max(0.0)
            } else {
                0.0
            },
            rules,
        })
    }
}

// --- Active song ----------------------------------------------------------

/// The tracks of the song under `position_seconds` (the song's source time,
/// the space regions and clips live in): those with an audio or MIDI clip
/// starting inside its region, plus the folders that hold them. Mirrors
/// `activeSongTrackIds` in `midiBankStore.ts`. `None` between songs or in a
/// song without clips.
pub fn active_song_track_ids(song: &Song, position_seconds: f64) -> Option<HashSet<String>> {
    let region = song.regions.iter().find(|region| {
        position_seconds >= region.start_seconds && position_seconds < region.end_seconds
    })?;
    let inside = |start: f64| start >= region.start_seconds && start < region.end_seconds;
    let mut ids: HashSet<String> = song
        .clips
        .iter()
        .filter(|clip| inside(clip.timeline_start_seconds))
        .map(|clip| clip.track_id.clone())
        .chain(
            song.midi_clips
                .iter()
                .filter(|clip| inside(clip.timeline_start_seconds))
                .map(|clip| clip.track_id.clone()),
        )
        .collect();
    if ids.is_empty() {
        return None;
    }
    let parents: HashMap<&str, Option<&str>> = song
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.parent_track_id.as_deref()))
        .collect();
    for id in ids.clone() {
        let mut parent = parents.get(id.as_str()).copied().flatten();
        while let Some(parent_id) = parent {
            if !ids.insert(parent_id.to_string()) {
                break;
            }
            parent = parents.get(parent_id).copied().flatten();
        }
    }
    Some(ids)
}

// --- Resolving ------------------------------------------------------------

/// What a scene does to one track.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedChange {
    pub track_id: String,
    pub change: TrackChange,
}

/// The tracks a selector picks. D5: only `Track` picks a folder, a video or
/// a MIDI track; the others pick audio tracks of the active song.
fn selector_picks(
    selector: &TrackSelector,
    song: &Song,
    active_song: Option<&HashSet<String>>,
) -> HashSet<String> {
    let audio_in_song = || {
        song.tracks.iter().filter(move |track| {
            track.kind == TrackKind::Audio
                && active_song.is_some_and(|ids| ids.contains(&track.id))
        })
    };
    match selector {
        TrackSelector::Track { track_id } => song
            .tracks
            .iter()
            .filter(|track| &track.id == track_id)
            .map(|track| track.id.clone())
            .collect(),
        TrackSelector::ActiveSong => audio_in_song().map(|track| track.id.clone()).collect(),
        TrackSelector::Folder { name } => {
            let wanted = fold_text(name.trim());
            if wanted.is_empty() {
                return HashSet::new();
            }
            let folders: HashSet<&str> = song
                .tracks
                .iter()
                .filter(|track| track.kind == TrackKind::Folder && fold_text(&track.name) == wanted)
                .map(|track| track.id.as_str())
                .collect();
            let parents: HashMap<&str, Option<&str>> = song
                .tracks
                .iter()
                .map(|track| (track.id.as_str(), track.parent_track_id.as_deref()))
                .collect();
            let under_folder = |track_id: &str| {
                let mut seen = HashSet::new();
                let mut parent = parents.get(track_id).copied().flatten();
                while let Some(parent_id) = parent {
                    if folders.contains(parent_id) {
                        return true;
                    }
                    if !seen.insert(parent_id) {
                        return false;
                    }
                    parent = parents.get(parent_id).copied().flatten();
                }
                false
            };
            audio_in_song()
                .filter(|track| under_folder(&track.id))
                .map(|track| track.id.clone())
                .collect()
        }
        TrackSelector::NameContains { words } => {
            let words: Vec<String> = words
                .iter()
                .map(|word| fold_text(word.trim()))
                .filter(|word| !word.is_empty())
                .collect();
            if words.is_empty() {
                return HashSet::new();
            }
            audio_in_song()
                .filter(|track| {
                    let name = fold_text(&track.name);
                    words.iter().any(|word| name.contains(word.as_str()))
                })
                .map(|track| track.id.clone())
                .collect()
        }
    }
}

/// For each track the scene touches, the final change: rules in order, the
/// last one that sets a field wins. Ordered as the song's tracks.
pub fn resolve_scene(
    scene: &MixScene,
    song: &Song,
    active_song: Option<&HashSet<String>>,
) -> Vec<ResolvedChange> {
    let mut changes: HashMap<String, TrackChange> = HashMap::new();
    for rule in &scene.rules {
        if rule.change.is_empty() {
            continue;
        }
        let mut picked = selector_picks(&rule.select, song, active_song);
        for except in &rule.except {
            for track_id in selector_picks(except, song, active_song) {
                picked.remove(&track_id);
            }
        }
        for track_id in picked {
            changes.entry(track_id).or_default().overlay(&rule.change);
        }
    }
    song.tracks
        .iter()
        .filter_map(|track| {
            changes.remove(&track.id).map(|change| ResolvedChange {
                track_id: track.id.clone(),
                change,
            })
        })
        .collect()
}

// --- Arithmetic (D6) ------------------------------------------------------

/// A track's mix values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackMix {
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

pub fn apply_change(current: TrackMix, change: &TrackChange) -> TrackMix {
    let volume = match change.volume {
        Some(VolumeChange::Absolute(volume)) => volume,
        Some(VolumeChange::RelativeDb(db)) => current.volume * 10f64.powf(db / 20.0),
        None => current.volume,
    };
    let pan = match change.pan {
        Some(PanChange::Absolute(pan)) => pan,
        Some(PanChange::Relative(delta)) => current.pan + delta,
        None => current.pan,
    };
    TrackMix {
        volume: if volume.is_finite() { volume.clamp(0.0, 1.0) } else { current.volume },
        pan: if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { current.pan },
        muted: change.muted.unwrap_or(current.muted),
        solo: change.solo.unwrap_or(current.solo),
    }
}

// --- Latches (D2, D3, D13) ------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
struct Latch {
    scene_id: String,
    changes: Vec<ResolvedChange>,
}

/// The scenes engaged by hand and the mix they hold.
///
/// Each track a latch touches keeps its value from before any scene (its
/// base). The sounding value is the base with every engaged scene's change
/// applied in the order they were engaged, so the last engaged wins on an
/// absolute value and relative changes stack. Releasing a scene recomputes
/// its tracks from the base and the scenes still engaged (D13).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SceneLatches {
    latches: Vec<Latch>,
    base: HashMap<String, TrackMix>,
}

impl SceneLatches {
    pub fn is_engaged(&self, scene_id: &str) -> bool {
        self.latches.iter().any(|latch| latch.scene_id == scene_id)
    }

    pub fn is_empty(&self) -> bool {
        self.latches.is_empty()
    }

    /// Engaged scene ids, in the order they were engaged.
    pub fn engaged_ids(&self) -> Vec<String> {
        self.latches.iter().map(|latch| latch.scene_id.clone()).collect()
    }

    /// Engage `scene_id` with `resolved`, or re-engage it on top if it was
    /// already. Returns the value every affected track must go to; tracks
    /// that were in the scene and are not any more go back.
    pub fn engage(
        &mut self,
        scene_id: &str,
        resolved: Vec<ResolvedChange>,
        current: impl Fn(&str) -> Option<TrackMix>,
    ) -> Vec<(String, TrackMix)> {
        let previous = self
            .latches
            .iter()
            .position(|latch| latch.scene_id == scene_id)
            .map(|index| self.latches.remove(index));
        self.latches.push(Latch {
            scene_id: scene_id.to_string(),
            changes: Vec::new(),
        });
        self.set_changes(self.latches.len() - 1, previous, resolved, current)
    }

    /// Replace what an engaged scene does without moving it in the stack
    /// (the scene was edited, or the active song changed). No-op when not
    /// engaged.
    pub fn update(
        &mut self,
        scene_id: &str,
        resolved: Vec<ResolvedChange>,
        current: impl Fn(&str) -> Option<TrackMix>,
    ) -> Vec<(String, TrackMix)> {
        let Some(index) = self.latches.iter().position(|latch| latch.scene_id == scene_id) else {
            return Vec::new();
        };
        let previous = Latch {
            scene_id: scene_id.to_string(),
            changes: std::mem::take(&mut self.latches[index].changes),
        };
        self.set_changes(index, Some(previous), resolved, current)
    }

    fn set_changes(
        &mut self,
        index: usize,
        previous: Option<Latch>,
        resolved: Vec<ResolvedChange>,
        current: impl Fn(&str) -> Option<TrackMix>,
    ) -> Vec<(String, TrackMix)> {
        let mut affected: Vec<String> = previous
            .map(|latch| latch.changes.into_iter().map(|change| change.track_id).collect())
            .unwrap_or_default();
        let mut kept = Vec::with_capacity(resolved.len());
        for change in resolved {
            if !self.base.contains_key(&change.track_id) {
                let Some(mix) = current(&change.track_id) else {
                    continue;
                };
                self.base.insert(change.track_id.clone(), mix);
            }
            if !affected.contains(&change.track_id) {
                affected.push(change.track_id.clone());
            }
            kept.push(change);
        }
        self.latches[index].changes = kept;
        self.settle(affected)
    }

    /// Release `scene_id`. Returns where its tracks go: their base, or what
    /// the scenes still engaged make of it. Empty when it was not engaged.
    pub fn release(&mut self, scene_id: &str) -> Vec<(String, TrackMix)> {
        let Some(index) = self.latches.iter().position(|latch| latch.scene_id == scene_id) else {
            return Vec::new();
        };
        let latch = self.latches.remove(index);
        self.settle(latch.changes.into_iter().map(|change| change.track_id).collect())
    }

    /// The user moved this track while scenes held it (D3): it leaves every
    /// scene, so releasing them leaves it where the user put it.
    pub fn touched_by_user(&mut self, track_id: &str) {
        if self.base.remove(track_id).is_none() {
            return;
        }
        for latch in &mut self.latches {
            latch.changes.retain(|change| change.track_id != track_id);
        }
    }

    /// Forget the tracks `exists` says are gone (deleted from the session),
    /// so releasing a scene later restores the others without error.
    pub fn forget_missing_tracks(&mut self, exists: impl Fn(&str) -> bool) {
        self.base.retain(|track_id, _| exists(track_id));
        for latch in &mut self.latches {
            latch.changes.retain(|change| exists(&change.track_id));
        }
    }

    /// The track's value before any scene, which is what a save must write
    /// (D9). `None` when no scene holds it.
    pub fn values_for_save(&self, track_id: &str) -> Option<TrackMix> {
        self.base.get(track_id).copied()
    }

    /// Release everything without computing anything (session closed).
    pub fn clear(&mut self) {
        self.latches.clear();
        self.base.clear();
    }

    /// The sounding value of each track, dropping the base of tracks no
    /// latch holds any more.
    fn settle(&mut self, track_ids: Vec<String>) -> Vec<(String, TrackMix)> {
        let mut out = Vec::with_capacity(track_ids.len());
        for track_id in track_ids {
            let Some(base) = self.base.get(&track_id).copied() else {
                continue;
            };
            let mut held = false;
            let mut mix = base;
            for latch in &self.latches {
                if let Some(change) = latch.changes.iter().find(|c| c.track_id == track_id) {
                    held = true;
                    mix = apply_change(mix, &change.change);
                }
            }
            if !held {
                self.base.remove(&track_id);
            }
            out.push((track_id, mix));
        }
        out
    }
}
