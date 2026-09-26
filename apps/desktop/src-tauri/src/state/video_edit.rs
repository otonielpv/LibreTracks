//! Editing of video clips: create, update, move, trim, split, duplicate and
//! delete.
//!
//! Sibling `impl DesktopSession` block, same shape as `state/midi_edit.rs`.
//! Every position the frontend sends is in view time (what the user sees,
//! warp applied) and is stored in source time, the space
//! [`VideoClip::timeline_start_seconds`] documents. None of this reaches the
//! audio engine: the commit is `MixerOnly`, which only replaces the Rust model.

use libretracks_core::{source_seconds_at_view, Song, TrackKind, VideoClip, VideoFit};
use serde::Deserialize;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::timestamp_suffix;
use super::DesktopSession;

/// Shortest clip a trim or split may leave behind. Below this the clip is too
/// thin to grab in the timeline and shows less than a frame.
pub(crate) const MIN_VIDEO_CLIP_SECONDS: f64 = 0.05;

/// The per-clip properties the context menu and the fade handles change.
/// Sent whole, so `None` always means "clear it" rather than "leave it".
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoClipProps {
    pub fade_in_seconds: Option<f64>,
    pub fade_out_seconds: Option<f64>,
    /// `None` = inherit the video output's global fit.
    pub fit: Option<VideoFit>,
    pub color: Option<String>,
}

fn require_video_track(song: &Song, track_id: &str) -> Result<(), DesktopError> {
    let is_video = song
        .tracks
        .iter()
        .any(|track| track.id == track_id && track.kind == TrackKind::Video);
    if is_video {
        Ok(())
    } else {
        Err(DesktopError::AudioCommand(
            "video clip must target a video track".into(),
        ))
    }
}

fn new_video_track(song: &Song, name: &str, auto_color: bool) -> libretracks_core::Track {
    libretracks_core::Track {
        id: format!("track_{}", timestamp_suffix()),
        name: name.to_string(),
        kind: TrackKind::Video,
        parent_track_id: None,
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: "master".to_string(),
        mono_downmix: false,
        color: super::track_colors::auto_color_for_new_track(
            &song.tracks,
            TrackKind::Video,
            auto_color,
        ),
        auto_created: false,
        midi_port: None,
        midi_channel: 1,
        midi_enabled: true,
        collapsed: false,
        height_offset: None,
    }
}

/// The top-level track containing `track_id` (itself if it has no parent).
fn top_level_ancestor(song: &Song, track_id: &str) -> Option<String> {
    let mut current = song.tracks.iter().find(|track| track.id == track_id)?;
    while let Some(parent_id) = current.parent_track_id.as_deref() {
        match song.tracks.iter().find(|track| track.id == parent_id) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    // The last descendant of that top-level track, so the new track lands
    // after the whole folder and not inside it.
    let top_id = current.id.clone();
    let mut last = top_id.clone();
    for track in &song.tracks {
        let mut ancestor = track.parent_track_id.clone();
        while let Some(id) = ancestor {
            if id == top_id {
                last = track.id.clone();
                break;
            }
            ancestor = song
                .tracks
                .iter()
                .find(|candidate| candidate.id == id)
                .and_then(|candidate| candidate.parent_track_id.clone());
        }
    }
    Some(last)
}

fn sort_video_clips(song: &mut Song) {
    song.video_clips.sort_by(|left, right| {
        left.timeline_start_seconds
            .partial_cmp(&right.timeline_start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn clamp_fades(clip: &mut VideoClip) {
    let duration = clip.duration_seconds.max(0.0);
    let fade_in = clip.fade_in_seconds.map(|fade| fade.clamp(0.0, duration));
    let room_left = duration - fade_in.unwrap_or(0.0);
    let fade_out = clip.fade_out_seconds.map(|fade| fade.clamp(0.0, room_left));
    clip.fade_in_seconds = fade_in.filter(|fade| *fade > 0.0);
    clip.fade_out_seconds = fade_out.filter(|fade| *fade > 0.0);
}

/// Split `clip` at `split_source` (source time). `None` when the point does
/// not leave both halves at least [`MIN_VIDEO_CLIP_SECONDS`] long.
pub(crate) fn split_video_clip_at(
    clip: &VideoClip,
    split_source: f64,
    left_id: String,
    right_id: String,
) -> Option<(VideoClip, VideoClip)> {
    let left_duration = split_source - clip.timeline_start_seconds;
    let right_duration = clip.end_seconds() - split_source;
    if left_duration < MIN_VIDEO_CLIP_SECONDS || right_duration < MIN_VIDEO_CLIP_SECONDS {
        return None;
    }
    // A cut keeps the outer fades on the outer edges; the new inner edges
    // start hard, like cutting an audio clip.
    let mut left = VideoClip {
        id: left_id,
        duration_seconds: left_duration,
        fade_out_seconds: None,
        ..clip.clone()
    };
    let mut right = VideoClip {
        id: right_id,
        timeline_start_seconds: split_source,
        source_start_seconds: clip.source_start_seconds + left_duration,
        duration_seconds: right_duration,
        fade_in_seconds: None,
        ..clip.clone()
    };
    clamp_fades(&mut left);
    clamp_fades(&mut right);
    Some((left, right))
}

/// Trim `clip` so it covers `[start_source, end_source)`. Moving the start
/// moves the media window with it (`source_start_seconds`), exactly like
/// dragging the left edge of an audio clip. Never trims before the start of
/// the file.
pub(crate) fn trim_video_clip_to(
    clip: &mut VideoClip,
    start_source: f64,
    end_source: f64,
) -> Result<(), DesktopError> {
    let start_delta = start_source - clip.timeline_start_seconds;
    let new_source_start = clip.source_start_seconds + start_delta;
    // Dragging the left edge past the first frame clamps at the first frame.
    let (start_source, new_source_start) = if new_source_start < 0.0 {
        (start_source - new_source_start, 0.0)
    } else {
        (start_source, new_source_start)
    };
    if !start_source.is_finite()
        || !end_source.is_finite()
        || start_source < 0.0
        || end_source - start_source < MIN_VIDEO_CLIP_SECONDS
    {
        return Err(DesktopError::AudioCommand(
            "el recorte dejaría el clip de vídeo vacío".into(),
        ));
    }
    clip.timeline_start_seconds = start_source;
    clip.source_start_seconds = new_source_start;
    clip.duration_seconds = end_source - start_source;
    clamp_fades(clip);
    Ok(())
}

impl DesktopSession {
    fn loaded_song_for_video_edit(
        &mut self,
        audio: &AudioController,
    ) -> Result<Song, DesktopError> {
        self.sync_position(audio)?;
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)
    }

    /// Place a new video clip. `timeline_start_seconds` is view time;
    /// `source_start_seconds` and `duration_seconds` are the media window,
    /// normally 0 and the file's length from the probe.
    pub fn create_video_clip(
        &mut self,
        track_id: &str,
        file_path: &str,
        timeline_start_seconds: f64,
        source_start_seconds: f64,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        require_video_track(&song, track_id)?;
        if file_path.trim().is_empty() {
            return Err(DesktopError::AudioCommand("video clip needs a file".into()));
        }
        if !duration_seconds.is_finite() || duration_seconds < MIN_VIDEO_CLIP_SECONDS {
            return Err(DesktopError::AudioCommand(
                "video clip duration must be positive".into(),
            ));
        }

        let clip = VideoClip {
            id: format!("vclip_{}_{}", timestamp_suffix(), song.video_clips.len()),
            track_id: track_id.to_string(),
            file_path: file_path.to_string(),
            timeline_start_seconds: source_seconds_at_view(&song, timeline_start_seconds.max(0.0)),
            source_start_seconds: source_start_seconds.max(0.0),
            duration_seconds,
            fade_in_seconds: None,
            fade_out_seconds: None,
            fit: None,
            color: None,
        };
        song.video_clips.push(clip);
        sort_video_clips(&mut song);
        self.commit_video_clips(song, audio)
    }

    /// Place videos from the library on the timeline, one after another from
    /// `timeline_start_seconds` (view time). They go on `target_track_id` when
    /// that is a video track; otherwise a new video track is created right
    /// after it (or at the end), named after the first file. One undo step.
    /// `items` are (file path, media duration in seconds).
    pub fn place_video_clips(
        &mut self,
        items: &[(String, f64)],
        timeline_start_seconds: f64,
        target_track_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let items: Vec<&(String, f64)> = items
            .iter()
            .filter(|(path, duration)| {
                !path.trim().is_empty()
                    && duration.is_finite()
                    && *duration >= MIN_VIDEO_CLIP_SECONDS
            })
            .collect();
        if items.is_empty() {
            return Err(DesktopError::AudioCommand(
                "no hay vídeos que colocar".into(),
            ));
        }

        let target_is_video = target_track_id.is_some_and(|id| {
            song.tracks
                .iter()
                .any(|track| track.id == id && track.kind == TrackKind::Video)
        });
        let track_id = if target_is_video {
            target_track_id.unwrap_or_default().to_string()
        } else {
            let name = super::song_edit::file_stem_for_auto_track(&items[0].0);
            let track =
                new_video_track(&song, &name, super::arrangement::auto_color_enabled(audio));
            let id = track.id.clone();
            // Next to the track it was dropped on, at top level: a video
            // track inside an audio folder would read as part of its mix.
            let after = target_track_id.and_then(|target| top_level_ancestor(&song, target));
            super::track_tree::insert_track(&mut song.tracks, track, after.as_deref(), None)?;
            id
        };

        let suffix = timestamp_suffix();
        let mut cursor = source_seconds_at_view(&song, timeline_start_seconds.max(0.0));
        for (index, (file_path, duration)) in items.into_iter().enumerate() {
            song.video_clips.push(VideoClip {
                id: format!("vclip_{suffix}_{index}"),
                track_id: track_id.clone(),
                file_path: file_path.clone(),
                timeline_start_seconds: cursor,
                source_start_seconds: 0.0,
                duration_seconds: *duration,
                fade_in_seconds: None,
                fade_out_seconds: None,
                fit: None,
                color: None,
            });
            cursor += duration;
        }
        sort_video_clips(&mut song);
        self.commit_video_clips(song, audio)
    }

    /// Replace a clip's fades, fit and colour.
    pub fn update_video_clip(
        &mut self,
        clip_id: &str,
        props: VideoClipProps,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let clip = song
            .video_clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.fade_in_seconds = props.fade_in_seconds;
        clip.fade_out_seconds = props.fade_out_seconds;
        clip.fit = props.fit;
        clip.color = props.color.filter(|color| !color.trim().is_empty());
        clamp_fades(clip);
        self.commit_video_clips(song, audio)
    }

    /// Move a clip along the timeline and optionally to another video track.
    /// Moving onto a track that is not a video track is refused.
    pub fn move_video_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        target_track_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        if let Some(track_id) = target_track_id {
            require_video_track(&song, track_id)?;
        }
        let source_start = source_seconds_at_view(&song, timeline_start_seconds.max(0.0));
        let clip = song
            .video_clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.timeline_start_seconds = source_start.max(0.0);
        if let Some(track_id) = target_track_id {
            clip.track_id = track_id.to_string();
        }
        sort_video_clips(&mut song);
        self.commit_video_clips(song, audio)
    }

    /// Trim a clip to `[start, end)`, both in view time.
    pub fn trim_video_clip(
        &mut self,
        clip_id: &str,
        start_seconds: f64,
        end_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let start_source = source_seconds_at_view(&song, start_seconds.max(0.0));
        let end_source = source_seconds_at_view(&song, end_seconds.max(0.0));
        let clip = song
            .video_clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        trim_video_clip_to(clip, start_source, end_source)?;
        sort_video_clips(&mut song);
        self.commit_video_clips(song, audio)
    }

    /// Split every clip in `clip_ids` that contains `split_seconds` (view
    /// time). Fails like `split_clips` when none does.
    pub fn split_video_clips(
        &mut self,
        clip_ids: &[String],
        split_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let split_source = source_seconds_at_view(&song, split_seconds.max(0.0));
        let suffix = timestamp_suffix();
        let mut any_split = false;
        for (offset, clip_id) in clip_ids.iter().enumerate() {
            let Some(index) = song.video_clips.iter().position(|clip| &clip.id == clip_id) else {
                continue;
            };
            let Some((left, right)) = split_video_clip_at(
                &song.video_clips[index],
                split_source,
                format!("vclip_{suffix}_{offset}_l"),
                format!("vclip_{suffix}_{offset}_r"),
            ) else {
                continue;
            };
            song.video_clips.splice(index..=index, [left, right]);
            any_split = true;
        }
        if !any_split {
            return Err(DesktopError::InvalidSplitPoint);
        }
        self.commit_video_clips(song, audio)
    }

    /// Copy each clip right after itself on the same track.
    pub fn duplicate_video_clips(
        &mut self,
        clip_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let suffix = timestamp_suffix();
        let copies: Vec<VideoClip> = song
            .video_clips
            .iter()
            .filter(|clip| clip_ids.contains(&clip.id))
            .enumerate()
            .map(|(offset, clip)| VideoClip {
                id: format!("vclip_{suffix}_{offset}_d"),
                timeline_start_seconds: clip.end_seconds(),
                ..clip.clone()
            })
            .collect();
        if copies.is_empty() {
            return Ok(self.snapshot());
        }
        song.video_clips.extend(copies);
        sort_video_clips(&mut song);
        self.commit_video_clips(song, audio)
    }

    pub fn delete_video_clips(
        &mut self,
        clip_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self.loaded_song_for_video_edit(audio)?;
        let before = song.video_clips.len();
        song.video_clips.retain(|clip| !clip_ids.contains(&clip.id));
        if song.video_clips.len() == before {
            return Ok(self.snapshot());
        }
        self.commit_video_clips(song, audio)
    }

    /// Commit an edit that touched only video clips. Records one undo entry
    /// and replaces the Rust model without touching the audio engine, which
    /// never sees video.
    fn commit_video_clips(
        &mut self,
        song: Song,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.persist_song_update_internal(
            song,
            audio,
            super::AudioChangeImpact::MixerOnly,
            true,
            true,
            super::UpdatePhase::Commit,
        )?;
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip() -> VideoClip {
        VideoClip {
            id: "vc".into(),
            track_id: "v1".into(),
            file_path: "D:/v.mp4".into(),
            timeline_start_seconds: 10.0,
            source_start_seconds: 2.0,
            duration_seconds: 8.0,
            fade_in_seconds: Some(1.0),
            fade_out_seconds: Some(2.0),
            fit: Some(VideoFit::Cover),
            color: None,
        }
    }

    #[test]
    fn split_keeps_outer_fades_and_advances_the_media_window() {
        let (left, right) =
            split_video_clip_at(&clip(), 13.0, "l".into(), "r".into()).expect("splits");
        assert_eq!(left.timeline_start_seconds, 10.0);
        assert_eq!(left.duration_seconds, 3.0);
        assert_eq!(left.source_start_seconds, 2.0);
        assert_eq!(left.fade_in_seconds, Some(1.0));
        assert_eq!(left.fade_out_seconds, None);
        assert_eq!(right.timeline_start_seconds, 13.0);
        assert_eq!(right.duration_seconds, 5.0);
        assert_eq!(right.source_start_seconds, 5.0);
        assert_eq!(right.fade_in_seconds, None);
        assert_eq!(right.fade_out_seconds, Some(2.0));
        assert_eq!(right.fit, Some(VideoFit::Cover));
    }

    #[test]
    fn split_outside_or_at_the_edge_is_refused() {
        assert!(split_video_clip_at(&clip(), 10.0, "l".into(), "r".into()).is_none());
        assert!(split_video_clip_at(&clip(), 18.0, "l".into(), "r".into()).is_none());
        assert!(split_video_clip_at(&clip(), 25.0, "l".into(), "r".into()).is_none());
    }

    #[test]
    fn trimming_the_left_edge_moves_the_media_window() {
        let mut trimmed = clip();
        trim_video_clip_to(&mut trimmed, 11.5, 18.0).expect("trim");
        assert_eq!(trimmed.timeline_start_seconds, 11.5);
        assert_eq!(trimmed.source_start_seconds, 3.5);
        assert_eq!(trimmed.duration_seconds, 6.5);
    }

    #[test]
    fn trimming_before_the_first_frame_clamps_at_it() {
        let mut trimmed = clip();
        // Start of the file is at timeline 8.0 (10.0 - source 2.0).
        trim_video_clip_to(&mut trimmed, 5.0, 18.0).expect("trim");
        assert_eq!(trimmed.timeline_start_seconds, 8.0);
        assert_eq!(trimmed.source_start_seconds, 0.0);
        assert_eq!(trimmed.duration_seconds, 10.0);
    }

    #[test]
    fn trimming_shrinks_fades_that_no_longer_fit() {
        let mut trimmed = clip();
        trim_video_clip_to(&mut trimmed, 10.0, 11.5).expect("trim");
        let fades =
            trimmed.fade_in_seconds.unwrap_or(0.0) + trimmed.fade_out_seconds.unwrap_or(0.0);
        assert!(fades <= trimmed.duration_seconds + 1e-9);
    }

    #[test]
    fn trimming_to_nothing_is_refused() {
        let mut trimmed = clip();
        assert!(trim_video_clip_to(&mut trimmed, 12.0, 12.0).is_err());
    }
}
