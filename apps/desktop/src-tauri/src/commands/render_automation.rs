//! "Render audio" with the song's automation applied.
//!
//! Playback runs the cues live: Rust polls the playhead, fires mix actions,
//! advances ramps and lets the engine execute the jumps. An offline render
//! has no playhead to poll, so this module plays the song's cues ahead of
//! time and flattens them into what the offline renderer can apply:
//!
//! - the timeline **segments** the jumps play, in order (a jump back to the
//!   chorus renders the chorus twice);
//! - per-track **envelopes** of gain/pan (piecewise linear: ramps) and
//!   mute/solo (steps), on the OUTPUT timeline so they keep running across a
//!   jump;
//! - a master envelope for the jump fades (tracks only, as in playback);
//! - the click, voice guide and pad changes, also on the output timeline.
//!
//! Only cues inside the song (region) count. Rules that differ from playback,
//! because a render has no musician to end a loop:
//! - a jump back with no run limit plays once (live it would loop until the
//!   user acts);
//! - a jump whose target is outside the song is ignored (the render is that
//!   song only);
//! - mute/solo are honoured only on tracks the automation touches; the rest
//!   keep the render's rule of ignoring tonight's mute/solo;
//! - the pad starts off and the click/guide start on (the user asked for them
//!   in the dialog); cues switch them from there.

use std::collections::HashMap;

use libretracks_core::mix_scene::{active_song_track_ids, resolve_scene, SceneLatches, TrackMix};
use libretracks_core::{warp_timeline_seconds_at, Song, SongRegion};
use lt_audio_engine_v2::{
    RenderAutomation, RenderKey, RenderMetronomeChange, RenderPadChange, RenderSegment,
    RenderTrackAutomation, RenderVoiceGuideChange,
};

use crate::audio::automation::{
    AutomationAction, AutomationDocument, AutomationJumpTarget, AutomationTransitionMode, SceneMode,
};
use crate::infra::settings::AppSettings;

/// Fade applied around an instant jump so the cut does not click (the live
/// engine declicks its jumps too).
const JUMP_DECLICK_SECONDS: f64 = 0.005;
/// Default fade of a FadeOut transition with no duration (same as playback).
const DEFAULT_JUMP_FADE_SECONDS: f64 = 0.35;
/// Safety nets: a render never follows more jumps than this, nor grows past
/// this many seconds of output.
const MAX_JUMPS: usize = 256;
const MAX_OUTPUT_SECONDS: f64 = 2.0 * 60.0 * 60.0;
const EPSILON: f64 = 0.001;

/// What the render needs besides the song.
pub(crate) struct AutomationPlanInputs<'a> {
    /// The source song (cues and regions are in source seconds).
    pub song: &'a Song,
    pub automation: &'a AutomationDocument,
    pub region_id: &'a str,
    pub settings: &'a AppSettings,
    pub pads_dir: String,
}

/// Flatten the region's automation. `None` when the region has no cue that
/// would change anything (the render then runs as before).
pub(crate) fn plan_render_automation(inputs: &AutomationPlanInputs<'_>) -> Option<RenderAutomation> {
    let song = inputs.song;
    let region = song.regions.iter().find(|region| region.id == inputs.region_id)?;
    if !inputs.automation.track_enabled {
        return None;
    }
    let mut cues: Vec<_> = inputs
        .automation
        .cues
        .iter()
        .filter(|cue| {
            cue.enabled
                && !cue.actions.is_empty()
                && cue.at_seconds >= region.start_seconds - EPSILON
                && cue.at_seconds < region.end_seconds
        })
        .collect();
    if cues.is_empty() {
        return None;
    }
    cues.sort_by(|left, right| left.at_seconds.total_cmp(&right.at_seconds));

    let mut sim = Simulation::new(song, region, inputs);
    let mut position = region.start_seconds;
    let mut skip_cue: Option<String> = None;
    let mut jumps = 0usize;

    'segments: loop {
        let mut pending: Vec<(f64, AutomationAction)> = Vec::new();
        for cue in &cues {
            let on_landing = cue.at_seconds <= position + EPSILON;
            if cue.at_seconds < position - EPSILON {
                continue;
            }
            if on_landing && skip_cue.as_deref() == Some(cue.id.as_str()) {
                continue;
            }
            let jump = cue.jump_action().and_then(|action| match action {
                AutomationAction::Jump { target, transition, mix_scene_id } => {
                    let target_seconds = target_source_seconds(song, target)?;
                    let inside = target_seconds >= region.start_seconds - EPSILON
                        && target_seconds < region.end_seconds;
                    inside.then_some((target_seconds, transition.clone(), mix_scene_id.clone()))
                }
                _ => None,
            });
            let runs = sim.runs.get(cue.id.as_str()).copied().unwrap_or(0);
            let limit = cue.max_runs.unwrap_or(match &jump {
                // A loop with no limit plays once in a render.
                Some((target_seconds, _, _)) if *target_seconds <= cue.at_seconds => 1,
                _ => u32::MAX,
            });
            if runs >= limit {
                continue;
            }
            *sim.runs.entry(cue.id.as_str()).or_insert(0) += 1;
            pending.extend(
                cue.timed_pre_jump_actions()
                    .into_iter()
                    .map(|(offset, action)| (cue.at_seconds + offset, action)),
            );

            let Some((target_seconds, transition, mix_scene_id)) = jump else {
                continue;
            };
            let jump_at = (cue.at_seconds + cue.pre_jump_wait_seconds()).max(position);
            if jump_at >= region.end_seconds || jumps >= MAX_JUMPS {
                continue;
            }
            jumps += 1;
            sim.fire_pending(&mut pending, position, jump_at);
            let fade = match transition.mode {
                AutomationTransitionMode::FadeOut => transition
                    .duration_seconds
                    .unwrap_or(DEFAULT_JUMP_FADE_SECONDS)
                    .max(0.0),
                _ => 0.0,
            };
            sim.close_segment(position, jump_at, fade.max(JUMP_DECLICK_SECONDS));
            if sim.output_seconds >= MAX_OUTPUT_SECONDS {
                break 'segments;
            }
            position = target_seconds;
            sim.segment_start = position;
            if let Some(scene_id) = mix_scene_id {
                sim.apply_scene(&scene_id, SceneMode::Apply, 0.0, position);
            }
            skip_cue = Some(cue.id.clone());
            continue 'segments;
        }
        sim.fire_pending(&mut pending, position, region.end_seconds);
        sim.close_segment(position, region.end_seconds, 0.0);
        break;
    }

    Some(sim.finish())
}

fn target_source_seconds(song: &Song, target: &AutomationJumpTarget) -> Option<f64> {
    match target {
        AutomationJumpTarget::Marker { marker_id } => song
            .section_markers
            .iter()
            .find(|marker| marker.id == *marker_id)
            .map(|marker| marker.start_seconds),
        AutomationJumpTarget::Region { region_id } => song
            .regions
            .iter()
            .find(|region| region.id == *region_id)
            .map(|region| region.start_seconds),
        AutomationJumpTarget::Frame { seconds } if seconds.is_finite() && *seconds >= 0.0 => {
            Some(*seconds)
        }
        AutomationJumpTarget::Frame { .. } => None,
    }
}

#[derive(Default)]
struct TrackKeys {
    gain: Vec<RenderKey>,
    pan: Vec<RenderKey>,
    mute: Vec<RenderKey>,
    solo: Vec<RenderKey>,
}

struct Simulation<'a> {
    /// The song with the mix as the automation leaves it (scenes read it).
    song: Song,
    settings: AppSettings,
    pads_dir: String,
    runs: HashMap<&'a str, u32>,
    latches: SceneLatches,
    scenes: &'a AutomationDocument,
    /// Source second where the current segment starts.
    segment_start: f64,
    /// Output seconds rendered by the segments already closed.
    output_seconds: f64,
    segments: Vec<RenderSegment>,
    keys: HashMap<String, TrackKeys>,
    /// The order tracks first got keys in, so the output is deterministic.
    key_order: Vec<String>,
    solo_touched: bool,
    master: Vec<RenderKey>,
    metronome: Vec<RenderMetronomeChange>,
    voice_guide: Vec<RenderVoiceGuideChange>,
    pad: Vec<RenderPadChange>,
}

impl<'a> Simulation<'a> {
    fn new(song: &Song, region: &SongRegion, inputs: &AutomationPlanInputs<'a>) -> Self {
        Self {
            song: song.clone(),
            settings: inputs.settings.clone(),
            pads_dir: inputs.pads_dir.clone(),
            runs: HashMap::new(),
            latches: SceneLatches::default(),
            scenes: inputs.automation,
            segment_start: region.start_seconds,
            output_seconds: 0.0,
            segments: Vec::new(),
            keys: HashMap::new(),
            key_order: Vec::new(),
            solo_touched: false,
            master: Vec::new(),
            metronome: Vec::new(),
            voice_guide: Vec::new(),
            pad: Vec::new(),
        }
    }

    fn view(&self, source_seconds: f64) -> f64 {
        warp_timeline_seconds_at(&self.song, source_seconds)
    }

    /// Output second at which source second `at` of the current segment plays.
    fn output_at(&self, at: f64) -> f64 {
        self.output_seconds + (self.view(at) - self.view(self.segment_start)).max(0.0)
    }

    /// Fire, in time order, the actions due in `[from, until)`; drop the rest
    /// (a jump cuts the jobs it interrupts, as the one-armed-cue runtime does).
    fn fire_pending(&mut self, pending: &mut Vec<(f64, AutomationAction)>, from: f64, until: f64) {
        pending.sort_by(|left, right| left.0.total_cmp(&right.0));
        for (at, action) in pending.drain(..) {
            if at >= until {
                continue;
            }
            self.apply(&action, at.max(from));
        }
    }

    fn close_segment(&mut self, from: f64, until: f64, fade_seconds: f64) {
        let start = self.view(from);
        let end = self.view(until);
        if end <= start {
            return;
        }
        let length = end - start;
        self.segments.push(RenderSegment { start_seconds: start, end_seconds: end });
        let segment_out_start = self.output_seconds;
        self.output_seconds += length;
        if fade_seconds > 0.0 {
            // Fade the tracks out into the cut and back in after it.
            let cut = self.output_seconds;
            let fade_start = (cut - fade_seconds).max(segment_out_start);
            set_linear(&mut self.master, 1.0, fade_start, 0.0, cut - fade_start);
            set_linear(&mut self.master, 1.0, cut, 1.0, fade_seconds);
        }
    }

    fn track_keys(&mut self, track_id: &str) -> &mut TrackKeys {
        if !self.keys.contains_key(track_id) {
            self.key_order.push(track_id.to_string());
        }
        self.keys.entry(track_id.to_string()).or_default()
    }

    fn mix_of(&self, track_id: &str) -> Option<TrackMix> {
        self.song.tracks.iter().find(|track| track.id == track_id).map(|track| TrackMix {
            volume: track.volume,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
        })
    }

    /// Move a track to `target` from output second `at`, ramping volume/pan
    /// over `ramp` seconds. Keys are only written for fields that change or
    /// were named, so an untouched track keeps the render's defaults.
    fn set_mix(&mut self, track_id: &str, target: TrackMix, ramp: f64, at: f64, fields: MixFields) {
        let Some(current) = self.mix_of(track_id) else {
            return;
        };
        // The values the track starts the render with: what the model says.
        let initial = self.initial_mix(track_id).unwrap_or(current);
        let keys = self.track_keys(track_id);
        if fields.volume {
            set_linear(&mut keys.gain, initial.volume as f32, at, target.volume as f32, ramp);
        }
        if fields.pan {
            set_linear(&mut keys.pan, initial.pan as f32, at, target.pan as f32, ramp);
        }
        if fields.muted {
            set_step(&mut keys.mute, initial.muted, at, target.muted);
        }
        if fields.solo {
            set_step(&mut keys.solo, initial.solo, at, target.solo);
            self.solo_touched = true;
        }
        if let Some(track) = self.song.tracks.iter_mut().find(|track| track.id == track_id) {
            if fields.volume {
                track.volume = target.volume;
            }
            if fields.pan {
                track.pan = target.pan;
            }
            if fields.muted {
                track.muted = target.muted;
            }
            if fields.solo {
                track.solo = target.solo;
            }
        }
    }

    /// A track's mix before any cue moved it: the first key of each field, or
    /// the model when there is none yet.
    fn initial_mix(&self, track_id: &str) -> Option<TrackMix> {
        let current = self.mix_of(track_id)?;
        let Some(keys) = self.keys.get(track_id) else {
            return Some(current);
        };
        Some(TrackMix {
            volume: keys.gain.first().map_or(current.volume, |key| key.value as f64),
            pan: keys.pan.first().map_or(current.pan, |key| key.value as f64),
            muted: keys.mute.first().map_or(current.muted, |key| key.value > 0.5),
            solo: keys.solo.first().map_or(current.solo, |key| key.value > 0.5),
        })
    }

    fn apply(&mut self, action: &AutomationAction, at_source: f64) {
        let at = self.output_at(at_source);
        match action {
            AutomationAction::SetTrackMute { track_id, muted } => {
                if let Some(mut mix) = self.mix_of(track_id) {
                    mix.muted = *muted;
                    self.set_mix(track_id, mix, 0.0, at, MixFields::MUTED);
                }
            }
            AutomationAction::SetTrackSolo { track_id, solo } => {
                if let Some(mut mix) = self.mix_of(track_id) {
                    mix.solo = *solo;
                    self.set_mix(track_id, mix, 0.0, at, MixFields::SOLO);
                }
            }
            AutomationAction::SetTrackMix { track_id, volume, pan, ramp_seconds } => {
                if let Some(mut mix) = self.mix_of(track_id) {
                    if let Some(volume) = volume {
                        mix.volume = *volume;
                    }
                    if let Some(pan) = pan {
                        mix.pan = *pan;
                    }
                    let fields = MixFields {
                        volume: volume.is_some(),
                        pan: pan.is_some(),
                        muted: false,
                        solo: false,
                    };
                    self.set_mix(track_id, mix, ramp_seconds.unwrap_or(0.0).max(0.0), at, fields);
                }
            }
            AutomationAction::ApplyScene { scene_id, ramp_seconds, mode } => {
                self.apply_scene(scene_id, *mode, ramp_seconds.unwrap_or(0.0).max(0.0), at_source);
            }
            AutomationAction::SetPad {
                enabled,
                pad_id,
                pad_key,
                volume,
                output: _,
                fade_in_seconds,
                fade_out_seconds,
            } => {
                self.pad.push(RenderPadChange {
                    seconds: at,
                    enabled: *enabled,
                    pad_id: pad_id.clone(),
                    key: (*pad_key).clamp(0, 11),
                    volume: volume.clamp(0.0, 10.0) as f32,
                    fade_in_seconds: fade_in_seconds.unwrap_or(0.0).clamp(0.0, 30.0) as f32,
                    fade_out_seconds: fade_out_seconds.unwrap_or(0.0).clamp(0.0, 30.0) as f32,
                });
            }
            AutomationAction::SetMetronome {
                enabled,
                accent_enabled,
                accent_preset,
                beat_preset,
                subdivision,
                subdivision_preset,
                output: _,
            } => {
                let settings = &mut self.settings;
                if let Some(value) = accent_enabled {
                    settings.metronome_accent_enabled = *value;
                }
                if let Some(value) = accent_preset {
                    settings.metronome_accent_preset = *value;
                }
                if let Some(value) = beat_preset {
                    settings.metronome_beat_preset = *value;
                }
                if let Some(value) = subdivision {
                    settings.metronome_subdivision = *value;
                }
                if let Some(value) = subdivision_preset {
                    settings.metronome_subdivision_preset = *value;
                }
                let enabled = enabled.unwrap_or_else(|| {
                    self.metronome.last().map_or(true, |change| change.enabled)
                });
                self.metronome.push(RenderMetronomeChange {
                    seconds: at,
                    enabled,
                    config: crate::audio::engine::metronome_render_config(&self.settings),
                });
            }
            AutomationAction::SetVoiceGuide {
                enabled,
                language,
                output: _,
                lead_bars,
                count_in_enabled,
                count_style,
            } => {
                let settings = &mut self.settings;
                if let Some(value) = language {
                    settings.voice_guide_language = value.clone();
                }
                if let Some(value) = lead_bars {
                    settings.voice_guide_lead_bars = *value;
                }
                if let Some(value) = count_in_enabled {
                    settings.voice_guide_count_in_enabled = *value;
                }
                if let Some(value) = count_style {
                    settings.voice_guide_count_style = *value;
                }
                let enabled = enabled.unwrap_or_else(|| {
                    self.voice_guide.last().map_or(true, |change| change.enabled)
                });
                self.voice_guide.push(RenderVoiceGuideChange {
                    seconds: at,
                    enabled,
                    lead_bars: self.settings.voice_guide_lead_bars,
                    count_in_enabled: self.settings.voice_guide_count_in_enabled,
                    count_style: self.settings.voice_guide_count_style.as_engine_value(),
                    lang: self.settings.voice_guide_language.clone(),
                });
            }
            AutomationAction::Jump { .. } | AutomationAction::Wait { .. } => {}
        }
    }

    /// Same engage/release rules as `trigger_mix_scene_runtime`, resolved
    /// against the song under `at_source`.
    fn apply_scene(&mut self, scene_id: &str, mode: SceneMode, ramp: f64, at_source: f64) {
        let Some(scene) = self.scenes.mix_scenes.iter().find(|scene| scene.id == scene_id).cloned()
        else {
            return;
        };
        let engaged = self.latches.is_engaged(scene_id);
        let engage = match mode {
            SceneMode::Apply => true,
            SceneMode::Restore => false,
            SceneMode::Toggle => !engaged,
        };
        if !engage && !engaged {
            return;
        }
        let targets = if engage {
            let active_song = active_song_track_ids(&self.song, at_source);
            let resolved = resolve_scene(&scene, &self.song, active_song.as_ref());
            let song = &self.song;
            let current = |track_id: &str| {
                song.tracks.iter().find(|track| track.id == track_id).map(|track| TrackMix {
                    volume: track.volume,
                    pan: track.pan,
                    muted: track.muted,
                    solo: track.solo,
                })
            };
            self.latches.engage(scene_id, resolved, current)
        } else {
            self.latches.release(scene_id)
        };
        let at = self.output_at(at_source);
        for (track_id, target) in targets {
            let Some(current) = self.mix_of(&track_id) else {
                continue;
            };
            let fields = MixFields {
                volume: current.volume != target.volume,
                pan: current.pan != target.pan,
                muted: current.muted != target.muted,
                solo: current.solo != target.solo,
            };
            self.set_mix(&track_id, target, ramp, at, fields);
        }
    }

    fn finish(mut self) -> RenderAutomation {
        if self.solo_touched {
            // Solo is global: once a cue solos something, every track's solo
            // state matters, starting from what the model says.
            let ids: Vec<(String, bool)> = self
                .song
                .tracks
                .iter()
                .map(|track| (track.id.clone(), track.solo))
                .collect();
            for (track_id, _) in ids {
                let initial = self.initial_mix(&track_id).map_or(false, |mix| mix.solo);
                let keys = self.track_keys(&track_id);
                if keys.solo.is_empty() {
                    keys.solo.push(RenderKey { seconds: 0.0, value: f32::from(u8::from(initial)) });
                }
            }
        }
        let tracks = self
            .key_order
            .iter()
            .filter_map(|track_id| {
                let keys = self.keys.remove(track_id)?;
                Some(RenderTrackAutomation {
                    track_id: track_id.clone(),
                    gain: keys.gain,
                    pan: keys.pan,
                    mute: keys.mute,
                    solo: keys.solo,
                })
            })
            .collect();
        RenderAutomation {
            segments: self.segments,
            tracks,
            master_gain: self.master,
            metronome: self.metronome,
            voice_guide: self.voice_guide,
            pad: self.pad,
            pads_dir: self.pads_dir,
        }
    }
}

#[derive(Clone, Copy)]
struct MixFields {
    volume: bool,
    pan: bool,
    muted: bool,
    solo: bool,
}

impl MixFields {
    const MUTED: Self = Self { volume: false, pan: false, muted: true, solo: false };
    const SOLO: Self = Self { volume: false, pan: false, muted: false, solo: true };
}

/// Value of a piecewise-linear envelope at `at` (the C++ side reads it the
/// same way: the last key at or before `at`, interpolated toward the next).
fn linear_value_at(keys: &[RenderKey], at: f64, fallback: f32) -> f32 {
    let Some(index) = keys.iter().rposition(|key| key.seconds <= at) else {
        return keys.first().map_or(fallback, |key| key.value);
    };
    let key = keys[index];
    match keys.get(index + 1) {
        Some(next) if next.seconds > key.seconds => {
            let t = ((at - key.seconds) / (next.seconds - key.seconds)).clamp(0.0, 1.0);
            key.value + (next.value - key.value) * t as f32
        }
        _ => key.value,
    }
}

/// Head toward `target` from output second `at` over `ramp` seconds, starting
/// from wherever the envelope is at that instant (a ramp cut by a newer
/// change starts the new one from its current value, as playback does).
fn set_linear(keys: &mut Vec<RenderKey>, initial: f32, at: f64, target: f32, ramp: f64) {
    if keys.is_empty() {
        keys.push(RenderKey { seconds: 0.0, value: initial });
    }
    let current = linear_value_at(keys, at, initial);
    keys.retain(|key| key.seconds <= at);
    keys.push(RenderKey { seconds: at, value: current });
    keys.push(RenderKey { seconds: at + ramp.max(0.0), value: target });
}

fn set_step(keys: &mut Vec<RenderKey>, initial: bool, at: f64, target: bool) {
    if keys.is_empty() {
        keys.push(RenderKey { seconds: 0.0, value: f32::from(u8::from(initial)) });
    }
    keys.retain(|key| key.seconds <= at);
    keys.push(RenderKey { seconds: at, value: f32::from(u8::from(target)) });
}

#[cfg(test)]
#[path = "render_automation_tests.rs"]
mod tests;
