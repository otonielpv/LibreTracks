//! Decisions of the video sync, pure and tested without a player or a clock.
//!
//! The audio engine is the master clock; the picture is corrected to follow
//! it, never the other way round. Everything here works in **view time**: the
//! engine plays the warped timeline at one second per second, so a clip's
//! media advances at `rate = source duration / view duration` (1.0 without
//! warp) and the player's base speed is that rate.
//!
//! [`step`] is called by the desktop runtime every tick with where the
//! transport is and what the player reports, and answers what to tell the
//! player. Control law (docs/plans/video-output/00-DISENO.md §4.6):
//!
//! | Situation | Action |
//! | --- | --- |
//! | new clip / other file | `Load` at the exact media time |
//! | stopped | `Pause` on the exact frame (pre-roll) |
//! | discontinuity (seek, jump, vamp) | `Seek` |
//! | error > `reseek_threshold` | `Seek` (safety net) |
//! | error > deadband | `speed = rate × (1 − k·e)`, within ±`max_speed_dev` |
//! | error ≤ deadband | `speed = rate` |
//!
//! The deadband is a quarter frame, not one frame: paso 01 measured that a
//! one-frame deadband lets the error sit at the edge (~27 ms at rate 1.05).

use crate::model::{Song, TrackKind, VideoFit};
use crate::warp::warp_timeline_seconds_at;

/// One clip as the sync sees it: view-time span, media mapping and look.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineVideoClip {
    pub clip_id: String,
    /// Position of the track in the arrangement: lower is higher up.
    pub track_order: usize,
    pub file_path: String,
    pub start: f64,
    pub end: f64,
    /// Media time at `start`.
    pub media_start: f64,
    /// Media seconds per view second.
    pub rate: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub fit: Option<VideoFit>,
}

/// The video clips that can be seen, in view time: hidden (muted) tracks are
/// already dropped and, if any video track is soloed, only soloed ones kept.
/// Immutable: the runtime rebuilds and swaps it on every edit.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VideoTimeline {
    pub clips: Vec<TimelineVideoClip>,
}

impl VideoTimeline {
    /// Build from a song. `resolve_path` turns a stored path into the file to
    /// open (relative paths from a package are relative to the session).
    pub fn from_song(song: &Song, resolve_path: impl Fn(&str) -> String) -> Self {
        let video_tracks: Vec<(usize, &crate::model::Track)> = song
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, track)| track.kind == TrackKind::Video)
            .collect();
        let any_solo = video_tracks.iter().any(|(_, track)| track.solo);
        let mut clips: Vec<TimelineVideoClip> = song
            .video_clips
            .iter()
            .filter_map(|clip| {
                let (order, track) = video_tracks
                    .iter()
                    .find(|(_, track)| track.id == clip.track_id)?;
                if track.muted || (any_solo && !track.solo) {
                    return None;
                }
                let start = warp_timeline_seconds_at(song, clip.timeline_start_seconds);
                let end = warp_timeline_seconds_at(song, clip.end_seconds());
                let view_duration = end - start;
                if view_duration <= 0.0 {
                    return None;
                }
                let rate = clip.duration_seconds / view_duration;
                Some(TimelineVideoClip {
                    clip_id: clip.id.clone(),
                    track_order: *order,
                    file_path: resolve_path(&clip.file_path),
                    start,
                    end,
                    media_start: clip.source_start_seconds,
                    rate,
                    // Fades are stored in source seconds; the picture fades
                    // over the same audible stretch.
                    fade_in: clip.fade_in_seconds.unwrap_or(0.0) / rate,
                    fade_out: clip.fade_out_seconds.unwrap_or(0.0) / rate,
                    fit: clip.fit,
                })
            })
            .collect();
        clips.sort_by(|left, right| {
            left.start
                .partial_cmp(&right.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Self { clips }
    }

    pub fn is_empty(&self) -> bool {
        self.clips.is_empty()
    }

    /// The next clip starting strictly after `position`, for preloading.
    pub fn next_clip_after(&self, position: f64) -> Option<&TimelineVideoClip> {
        self.clips
            .iter()
            .filter(|clip| clip.start > position)
            .min_by(|left, right| {
                left.start
                    .partial_cmp(&right.start)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(left.track_order.cmp(&right.track_order))
            })
    }
}

/// What should be on screen at a position.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveVideo {
    pub clip_id: String,
    pub file_path: String,
    pub media_time: f64,
    pub rate: f64,
    /// 0 (black) … 1 (full picture), from the clip's fades.
    pub fade_gain: f64,
    pub fit: Option<VideoFit>,
}

/// The clip of the highest visible video track whose span holds `position`
/// (start inclusive, end exclusive).
pub fn active_clip_at(timeline: &VideoTimeline, position: f64) -> Option<ActiveVideo> {
    let clip = timeline
        .clips
        .iter()
        .filter(|clip| position >= clip.start && position < clip.end)
        .min_by_key(|clip| clip.track_order)?;
    Some(active_for(clip, position))
}

fn active_for(clip: &TimelineVideoClip, position: f64) -> ActiveVideo {
    let into = (position - clip.start).max(0.0);
    let left = (clip.end - position).max(0.0);
    let mut gain: f64 = 1.0;
    if clip.fade_in > 0.0 {
        gain = gain.min(into / clip.fade_in);
    }
    if clip.fade_out > 0.0 {
        gain = gain.min(left / clip.fade_out);
    }
    ActiveVideo {
        clip_id: clip.clip_id.clone(),
        file_path: clip.file_path.clone(),
        media_time: clip.media_start + into * clip.rate,
        rate: clip.rate,
        fade_gain: gain.clamp(0.0, 1.0),
        fit: clip.fit,
    }
}

/// mpv `brightness` for a fade gain: linear, −100 is black. Linear in the
/// signal is close enough for fades of a second or two and costs nothing.
pub fn brightness_for_gain(gain: f64) -> f64 {
    -100.0 * (1.0 - gain.clamp(0.0, 1.0))
}

/// Tunables of the control law, with their defaults.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SyncParams {
    /// Proportional gain, per second of error.
    pub gain_k: f64,
    /// Largest speed change, as a fraction of the base rate.
    pub max_speed_dev: f64,
    /// Error beyond which the player is re-seeked instead of chased.
    pub reseek_threshold: f64,
    /// Error inside `deadband_frames` frames leaves the speed at the base rate.
    pub deadband_frames: f64,
    /// Exponential smoothing of the error (time-pos jitters by a frame).
    pub ema_alpha: f64,
    /// Seeks while running aim this far ahead, to land where the transport
    /// will be once the frame is decoded.
    pub seek_lead: f64,
    /// Speed changes smaller than this are not sent.
    pub min_speed_step: f64,
}

impl Default for SyncParams {
    fn default() -> Self {
        Self {
            gain_k: 0.5,
            max_speed_dev: 0.05,
            reseek_threshold: 0.25,
            deadband_frames: 0.25,
            ema_alpha: 0.1,
            seek_lead: 0.05,
            min_speed_step: 0.0005,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransportInput {
    /// Target position in view seconds (latency and offset already applied).
    pub position: f64,
    pub running: bool,
    /// Play, seek, jump, vamp or session change since the last tick.
    pub discontinuity: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerInput {
    pub file: Option<String>,
    /// Media time the player shows now (extrapolated by the caller).
    pub time_pos: Option<f64>,
    /// False between a load/seek and its first frame: its time is not to be
    /// trusted yet.
    pub settled: bool,
    pub frame_duration: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlayerAction {
    Load { path: String, at: f64, paused: bool },
    Seek { at: f64 },
    SetSpeed(f64),
    /// Pause on the exact frame of `at`.
    Pause { at: f64 },
    Resume,
    /// Nothing under the playhead: show the idle screen.
    Idle,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyncOutput {
    pub actions: Vec<PlayerAction>,
    pub brightness: f64,
    pub fit: Option<VideoFit>,
    /// Error the step acted on, for diagnostics (None when not measured).
    pub error: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncState {
    pub filtered_error: Option<f64>,
    pub clip_id: Option<String>,
    pub speed: f64,
    pub paused: bool,
    pub idle: bool,
    /// Seeks issued (forced corrections), for diagnostics.
    pub seeks: u64,
}

/// One tick of the sync.
pub fn step(
    state: &mut SyncState,
    params: &SyncParams,
    timeline: &VideoTimeline,
    transport: TransportInput,
    player: &PlayerInput,
) -> SyncOutput {
    let mut out = SyncOutput {
        actions: Vec::new(),
        brightness: 0.0,
        fit: None,
        error: None,
    };
    let Some(active) = active_clip_at(timeline, transport.position) else {
        if !state.idle {
            out.actions.push(PlayerAction::Idle);
            state.idle = true;
        }
        state.clip_id = None;
        state.filtered_error = None;
        state.paused = false;
        return out;
    };
    out.brightness = brightness_for_gain(active.fade_gain);
    out.fit = active.fit;
    let clip_changed = state.clip_id.as_deref() != Some(active.clip_id.as_str());
    let file_matches = player.file.as_deref() == Some(active.file_path.as_str());
    state.idle = false;

    // A different file (or nothing loaded): load it on the exact frame.
    if !file_matches {
        let lead = if transport.running { params.seek_lead * active.rate } else { 0.0 };
        out.actions.push(PlayerAction::Load {
            path: active.file_path.clone(),
            at: active.media_time + lead,
            paused: !transport.running,
        });
        if transport.running {
            out.actions.push(PlayerAction::SetSpeed(active.rate));
        }
        state.clip_id = Some(active.clip_id);
        state.filtered_error = None;
        state.speed = active.rate;
        state.paused = !transport.running;
        return out;
    }

    // Stopped: hold the exact frame so play starts on it.
    if !transport.running {
        let off_frame = player
            .time_pos
            .is_none_or(|time| (time - active.media_time).abs() > player.frame_duration / 2.0);
        if !state.paused || clip_changed || (player.settled && off_frame) {
            out.actions.push(PlayerAction::Pause {
                at: active.media_time,
            });
            state.paused = true;
        }
        state.clip_id = Some(active.clip_id);
        state.filtered_error = None;
        return out;
    }

    let mut resumed = false;
    if state.paused {
        out.actions.push(PlayerAction::Resume);
        state.paused = false;
        resumed = true;
    }

    // Same file, but a jump in the transport or into another clip of it that
    // is not continuous with what is playing: seek.
    let target = active.media_time;
    let discontinuous_clip = clip_changed
        && player
            .time_pos
            .is_none_or(|time| (time - target).abs() > params.reseek_threshold);
    if transport.discontinuity || discontinuous_clip {
        out.actions.push(PlayerAction::Seek {
            at: target + params.seek_lead * active.rate,
        });
        out.actions.push(PlayerAction::SetSpeed(active.rate));
        state.speed = active.rate;
        state.filtered_error = None;
        state.clip_id = Some(active.clip_id);
        state.seeks += 1;
        return out;
    }
    state.clip_id = Some(active.clip_id);

    if resumed {
        out.actions.push(PlayerAction::SetSpeed(active.rate));
        state.speed = active.rate;
    }
    let (Some(time_pos), true) = (player.time_pos, player.settled) else {
        return out;
    };

    // Error in view seconds (media error divided by the media rate).
    let error = (time_pos - target) / active.rate;
    out.error = Some(error);
    if error.abs() > params.reseek_threshold {
        out.actions.push(PlayerAction::Seek {
            at: target + params.seek_lead * active.rate,
        });
        out.actions.push(PlayerAction::SetSpeed(active.rate));
        state.speed = active.rate;
        state.filtered_error = None;
        state.seeks += 1;
        return out;
    }
    let filtered = match state.filtered_error {
        None => error,
        Some(previous) => previous + params.ema_alpha * (error - previous),
    };
    state.filtered_error = Some(filtered);

    let deadband = params.deadband_frames * player.frame_duration;
    let wanted = if filtered.abs() <= deadband {
        active.rate
    } else {
        let deviation = (-params.gain_k * filtered).clamp(-params.max_speed_dev, params.max_speed_dev);
        active.rate * (1.0 + deviation)
    };
    if (wanted - state.speed).abs() >= params.min_speed_step * active.rate
        || (wanted == active.rate && state.speed != active.rate)
    {
        out.actions.push(PlayerAction::SetSpeed(wanted));
        state.speed = wanted;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: f64 = 1.0 / 30.0;

    fn clip(id: &str, order: usize, start: f64, end: f64) -> TimelineVideoClip {
        TimelineVideoClip {
            clip_id: id.into(),
            track_order: order,
            file_path: format!("{id}.mp4"),
            start,
            end,
            media_start: 0.0,
            rate: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            fit: None,
        }
    }

    fn timeline(clips: Vec<TimelineVideoClip>) -> VideoTimeline {
        VideoTimeline { clips }
    }

    fn playing(position: f64) -> TransportInput {
        TransportInput {
            position,
            running: true,
            discontinuity: false,
        }
    }

    fn player(file: &str, time_pos: f64) -> PlayerInput {
        PlayerInput {
            file: Some(file.into()),
            time_pos: Some(time_pos),
            settled: true,
            frame_duration: FRAME,
        }
    }

    // ---- C1: active_clip_at -------------------------------------------------

    #[test]
    fn the_highest_track_wins_an_overlap() {
        let t = timeline(vec![clip("low", 3, 0.0, 10.0), clip("high", 1, 5.0, 8.0)]);
        assert_eq!(active_clip_at(&t, 4.0).unwrap().clip_id, "low");
        assert_eq!(active_clip_at(&t, 6.0).unwrap().clip_id, "high");
        assert_eq!(active_clip_at(&t, 8.0).unwrap().clip_id, "low");
    }

    #[test]
    fn start_is_inclusive_and_end_exclusive() {
        let t = timeline(vec![clip("a", 0, 2.0, 4.0)]);
        assert!(active_clip_at(&t, 1.999_999).is_none());
        assert_eq!(active_clip_at(&t, 2.0).unwrap().media_time, 0.0);
        assert!(active_clip_at(&t, 4.0).is_none());
    }

    #[test]
    fn a_trimmed_clip_maps_to_its_media_window() {
        let mut trimmed = clip("a", 0, 10.0, 20.0);
        trimmed.media_start = 30.0;
        let t = timeline(vec![trimmed]);
        assert!((active_clip_at(&t, 12.5).unwrap().media_time - 32.5).abs() < 1e-12);
    }

    #[test]
    fn fades_give_black_at_the_edges_and_full_inside() {
        let mut faded = clip("a", 0, 0.0, 10.0);
        faded.fade_in = 2.0;
        faded.fade_out = 4.0;
        let t = timeline(vec![faded]);
        assert_eq!(active_clip_at(&t, 0.0).unwrap().fade_gain, 0.0);
        assert!((active_clip_at(&t, 1.0).unwrap().fade_gain - 0.5).abs() < 1e-12);
        assert_eq!(active_clip_at(&t, 5.0).unwrap().fade_gain, 1.0);
        assert!((active_clip_at(&t, 9.0).unwrap().fade_gain - 0.25).abs() < 1e-12);
        // Last frame of the clip: almost black.
        assert!(active_clip_at(&t, 10.0 - FRAME).unwrap().fade_gain < 0.01);
        assert_eq!(brightness_for_gain(0.0), -100.0);
        assert_eq!(brightness_for_gain(1.0), 0.0);
    }

    fn song_with_tracks(solo_second: bool, mute_first: bool) -> Song {
        use crate::model::{SongMaster, SongRegion, Track, VideoClip};
        let track = |id: &str, muted: bool, solo: bool| Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Video,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted,
            solo,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        };
        let video = |id: &str, track_id: &str| VideoClip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: format!("{id}.mp4"),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 10.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            fit: None,
            color: None,
        };
        Song {
            id: "s".into(),
            title: "S".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "r".into(),
                name: "r".into(),
                start_seconds: 0.0,
                end_seconds: 20.0,
                transpose_semitones: 0,
                key: None,
                warp_enabled: false,
                warp_source_bpm: None,
                master: SongMaster::default(),
                compact_column_width_rem: None,
            }],
            tracks: vec![track("top", mute_first, false), track("bottom", false, solo_second)],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![video("a", "top"), video("b", "bottom")],
            section_markers: vec![],
        }
    }

    #[test]
    fn muted_tracks_are_hidden_and_solo_leaves_only_soloed_ones() {
        let plain = VideoTimeline::from_song(&song_with_tracks(false, false), str::to_string);
        assert_eq!(active_clip_at(&plain, 1.0).unwrap().clip_id, "a");
        let muted = VideoTimeline::from_song(&song_with_tracks(false, true), str::to_string);
        assert_eq!(active_clip_at(&muted, 1.0).unwrap().clip_id, "b");
        let solo = VideoTimeline::from_song(&song_with_tracks(true, false), str::to_string);
        assert_eq!(solo.clips.len(), 1);
        assert_eq!(active_clip_at(&solo, 1.0).unwrap().clip_id, "b");
    }

    #[test]
    fn warp_sets_the_media_rate() {
        let mut song = song_with_tracks(false, false);
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = Some(100.0);
        song.bpm = 120.0;
        let t = VideoTimeline::from_song(&song, str::to_string);
        let active = active_clip_at(&t, 1.0).unwrap();
        assert!((active.rate - 1.2).abs() < 1e-9, "rate {}", active.rate);
    }

    // ---- C2: step ------------------------------------------------------------

    fn one_clip() -> VideoTimeline {
        timeline(vec![clip("a", 0, 0.0, 600.0)])
    }

    #[test]
    fn a_perfect_player_runs_at_the_base_rate() {
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let out = step(&mut state, &SyncParams::default(), &one_clip(), playing(10.0), &player("a.mp4", 10.0));
        assert!(out.actions.is_empty(), "{:?}", out.actions);
        assert_eq!(state.speed, 1.0);
    }

    #[test]
    fn a_late_player_speeds_up_within_five_percent_and_converges() {
        let params = SyncParams::default();
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let mut transport = 10.0;
        let mut media = 10.0 - 0.040;
        let mut speeds = Vec::new();
        for _ in 0..2000 {
            let out = step(&mut state, &params, &one_clip(), playing(transport), &player("a.mp4", media));
            for action in out.actions {
                if let PlayerAction::SetSpeed(speed) = action {
                    speeds.push(speed);
                }
            }
            transport += 0.01;
            media += 0.01 * state.speed;
        }
        assert!(speeds.iter().any(|speed| *speed > 1.0));
        assert!(speeds.iter().all(|speed| *speed <= 1.05 + 1e-12));
        assert!((media - transport).abs() < FRAME / 4.0, "left {}", media - transport);
    }

    #[test]
    fn a_large_error_is_seeked() {
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let out = step(&mut state, &SyncParams::default(), &one_clip(), playing(10.0), &player("a.mp4", 9.6));
        assert!(matches!(out.actions[0], PlayerAction::Seek { at } if (at - 10.05).abs() < 1e-9));
    }

    #[test]
    fn an_explicit_discontinuity_seeks_even_with_a_small_error() {
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let transport = TransportInput {
            discontinuity: true,
            ..playing(10.0)
        };
        let out = step(&mut state, &SyncParams::default(), &one_clip(), transport, &player("a.mp4", 10.01));
        assert!(matches!(out.actions[0], PlayerAction::Seek { .. }));
    }

    #[test]
    fn a_clip_change_loads_the_new_file() {
        let t = timeline(vec![clip("a", 0, 0.0, 10.0), clip("b", 0, 10.0, 20.0)]);
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let out = step(&mut state, &SyncParams::default(), &t, playing(10.2), &player("a.mp4", 10.2));
        assert!(matches!(
            &out.actions[0],
            PlayerAction::Load { path, at, paused: false } if path == "b.mp4" && (at - 0.25).abs() < 1e-9
        ));
    }

    #[test]
    fn stopping_pauses_on_the_exact_frame() {
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let stopped = TransportInput {
            running: false,
            ..playing(42.123)
        };
        let out = step(&mut state, &SyncParams::default(), &one_clip(), stopped, &player("a.mp4", 42.5));
        assert_eq!(out.actions, vec![PlayerAction::Pause { at: 42.123 }]);
        // Holding: nothing more while it sits on that frame.
        let out = step(&mut state, &SyncParams::default(), &one_clip(), stopped, &player("a.mp4", 42.123));
        assert!(out.actions.is_empty());
        // Play: resume at the base rate.
        let out = step(&mut state, &SyncParams::default(), &one_clip(), playing(42.123), &player("a.mp4", 42.123));
        assert_eq!(out.actions, vec![PlayerAction::Resume, PlayerAction::SetSpeed(1.0)]);
    }

    #[test]
    fn warp_uses_the_clip_rate_as_base_speed() {
        let mut warped = clip("a", 0, 0.0, 100.0);
        warped.rate = 1.2;
        let t = timeline(vec![warped]);
        let mut state = SyncState::default();
        let out = step(&mut state, &SyncParams::default(), &t, playing(10.0), &PlayerInput {
            file: None,
            time_pos: None,
            settled: false,
            frame_duration: FRAME,
        });
        assert!(out.actions.contains(&PlayerAction::SetSpeed(1.2)));
        // Media time 12 at view 10: rate 1.2.
        assert!(matches!(out.actions[0], PlayerAction::Load { at, .. } if (at - (12.0 + 0.06)).abs() < 1e-9));
    }

    #[test]
    fn no_clip_under_the_playhead_shows_idle_once() {
        let t = timeline(vec![clip("a", 0, 10.0, 20.0)]);
        let mut state = SyncState::default();
        let out = step(&mut state, &SyncParams::default(), &t, playing(1.0), &player("a.mp4", 0.0));
        assert_eq!(out.actions, vec![PlayerAction::Idle]);
        let out = step(&mut state, &SyncParams::default(), &t, playing(1.1), &player("a.mp4", 0.0));
        assert!(out.actions.is_empty());
    }

    #[test]
    fn nothing_is_corrected_until_the_player_settles() {
        let mut state = SyncState {
            clip_id: Some("a".into()),
            speed: 1.0,
            ..Default::default()
        };
        let mut unsettled = player("a.mp4", 9.0);
        unsettled.settled = false;
        let out = step(&mut state, &SyncParams::default(), &one_clip(), playing(10.0), &unsettled);
        assert!(out.actions.is_empty());
    }

    // ---- C3/C4: 10-minute simulation with a model player --------------------

    /// Tiny deterministic generator (no rand dependency).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Returns |error| p95 in seconds over 10 minutes of 10 ms ticks against a
    /// player whose clock drifts 0.1 %, which applies speed changes 30 ms
    /// late and reports time-pos in whole frames with ±1 frame of jitter.
    fn simulate(params: SyncParams, rate: f64) -> f64 {
        let t = timeline(vec![{
            let mut c = clip("a", 0, 0.0, 700.0);
            c.rate = rate;
            c
        }]);
        let mut rng = Lcg(0x5eed_cafe);
        let mut state = SyncState::default();
        let mut true_media = 0.0_f64;
        let mut speed = 1.0;
        let mut pending: Vec<(f64, f64)> = Vec::new(); // (apply_at, speed)
        let mut file: Option<String> = None;
        let mut errors = Vec::new();
        let dt = 0.01;
        let drift = 1.001;
        let mut now = 0.0;
        while now < 600.0 {
            // Apply delayed speed changes.
            pending.retain(|(at, value)| {
                if *at <= now {
                    speed = *value;
                    false
                } else {
                    true
                }
            });
            let reported = (true_media / FRAME).floor() * FRAME + (rng.next() * 2.0 - 1.0) * FRAME;
            let input = PlayerInput {
                file: file.clone(),
                time_pos: file.as_ref().map(|_| reported),
                settled: true,
                frame_duration: FRAME,
            };
            let out = step(&mut state, &params, &t, playing(now), &input);
            for action in out.actions {
                match action {
                    PlayerAction::Load { path, at, .. } => {
                        file = Some(path);
                        true_media = at;
                    }
                    PlayerAction::Seek { at } => true_media = at,
                    PlayerAction::SetSpeed(value) => pending.push((now + 0.03, value)),
                    _ => {}
                }
            }
            if now > 1.0 {
                errors.push(((true_media / rate) - now).abs());
            }
            true_media += dt * speed * drift;
            now += dt;
        }
        errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
        errors[(errors.len() as f64 * 0.95) as usize]
    }

    #[test]
    fn ten_minutes_stay_within_a_frame() {
        let p95 = simulate(SyncParams::default(), 1.0);
        assert!(p95 < FRAME, "p95 {:.1} ms", p95 * 1000.0);
        let warped = simulate(SyncParams::default(), 1.05);
        eprintln!("sim p95: rate 1.0 {:.2} ms, rate 1.05 {:.2} ms", p95 * 1e3, warped * 1e3);
        assert!(warped < FRAME, "warped p95 {:.1} ms", warped * 1000.0);
    }

    /// C4: without the correction the same simulation leaves the frame.
    #[test]
    fn without_correction_the_simulation_drifts_out() {
        let params = SyncParams {
            gain_k: 0.0,
            ..Default::default()
        };
        let p95 = simulate(params, 1.0);
        eprintln!("sim p95 with k=0: {:.1} ms", p95 * 1e3);
        assert!(p95 >= FRAME, "p95 {:.1} ms should exceed a frame", p95 * 1000.0);
    }
}
