//! The audio of a video clip as an audio track (video plan, paso 11).
//!
//! Three phases so the decoding never runs under the session lock:
//!
//! 1. [`DesktopSession::plan_video_audio_extraction`] (locked, instant):
//!    finds the clip, picks a free `audio/<video> (audio).wav` and reserves it
//!    with an empty file, so a second extraction started meanwhile cannot pick
//!    the same name.
//! 2. The caller decodes into that path with libmpv, unlocked.
//! 3. [`DesktopSession::commit_video_audio_extraction`] (locked): registers
//!    the WAV in the library and puts it on a new audio track right below the
//!    video track, aligned with the clip — one undo step. Undo removes the
//!    track and the clip; the WAV stays in the library, like imported audio.

// Decoding a video's audio needs libmpv: on Android/iOS the extraction is
// `link_video_audio` instead, and the desktop never links. Both halves stay
// compiled (and tested) everywhere.
#![allow(dead_code)]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use libretracks_core::{Clip, TrackKind};
use libretracks_project::read_audio_metadata;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::{LibraryAssetSummary, TransportSnapshot};

use super::arrangement::new_track;
use super::library::{
    allocate_library_audio_path, collect_library_file_paths, list_library_assets,
    write_library_manifest_assets,
};
use super::song_edit::{ensure_region_covers_clip_for_file, ui_locale};
use super::timeline_math::refresh_song_duration;
use super::track_tree::insert_track;
use super::{resolve_audio_file_path, timestamp_suffix, AudioChangeImpact, DesktopSession};

/// What phase 1 decided; phase 2 fills `destination`.
#[derive(Debug, Clone)]
pub struct VideoAudioPlan {
    pub clip_id: String,
    /// The video file, absolute.
    pub source: PathBuf,
    /// The reserved WAV, absolute.
    pub destination: PathBuf,
    /// The same WAV as the library stores it (`audio/…`).
    pub relative_path: String,
    /// The whole video file, for the progress fraction.
    pub duration_seconds: f64,
}

impl VideoAudioPlan {
    /// The decoding failed or was cancelled: free the reserved name.
    pub fn abandon(&self) {
        let _ = fs::remove_file(&self.destination);
    }
}

/// "letras.mp4" → "letras (audio).wav".
fn extracted_file_name(video_path: &str) -> String {
    let stem = Path::new(video_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("video");
    format!("{stem} (audio).wav")
}

impl DesktopSession {
    /// The audio of a video clip as an audio track, on a phone (plan
    /// video-mobile): the new clip plays the VIDEO FILE ITSELF, whose sound
    /// the engine decodes like any compressed audio (MediaCodec on Android,
    /// libav on iOS, cached as PCM once). Nothing is extracted or written,
    /// unless an Android document cannot be read by path: then only that file
    /// is copied into `audio/`. Same placement as the desktop extraction: a
    /// new audio track right below the video track, aligned with the clip.
    pub fn link_video_audio(
        &mut self,
        clip_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let video = song
            .video_clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .cloned()
            .ok_or_else(|| {
                DesktopError::AudioCommand(format!("clip de vídeo no encontrado: {clip_id}"))
            })?;
        let info = self.video_asset_info(&video.file_path);
        if info.as_ref().is_some_and(|info| !info.has_audio) {
            return Err(DesktopError::AudioCommand("el vídeo no tiene audio".into()));
        }
        let media_seconds = info
            .as_ref()
            .map(|info| info.duration_seconds)
            .unwrap_or(video.source_start_seconds + video.duration_seconds);
        let duration = video
            .duration_seconds
            .min(media_seconds - video.source_start_seconds);
        if !(duration > 0.0) {
            return Err(DesktopError::AudioCommand(
                "el audio del vídeo no llega al tramo del clip".into(),
            ));
        }
        let shown_name = self
            .video_display_name(&video.file_path)
            .unwrap_or_else(|| video.file_path.clone());
        let audio_path = self.audio_path_for_video(&song_dir, &song, &video.file_path, &shown_name)?;

        let video_track = song
            .tracks
            .iter()
            .find(|track| track.id == video.track_id)
            .cloned()
            .ok_or_else(|| DesktopError::TrackNotFound(video.track_id.clone()))?;
        let track_name = format!(
            "{} (audio)",
            super::song_edit::file_stem_for_auto_track(&shown_name)
        );
        let track = new_track(
            &song,
            &track_name,
            TrackKind::Audio,
            video_track.parent_track_id.as_deref(),
            audio,
        );
        let track_id = track.id.clone();
        insert_track(
            &mut song.tracks,
            track,
            Some(&video_track.id),
            video_track.parent_track_id.as_deref(),
        )?;
        ensure_region_covers_clip_for_file(
            &mut song,
            video.timeline_start_seconds,
            video.timeline_start_seconds + duration,
            Some(&audio_path),
            ui_locale(audio).as_deref(),
        )?;
        song.clips.push(Clip {
            id: format!("clip_{}_{}", timestamp_suffix(), song.clips.len()),
            track_id,
            file_path: audio_path.clone(),
            timeline_start_seconds: video.timeline_start_seconds,
            source_start_seconds: video.source_start_seconds,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        });
        refresh_song_duration(&mut song);

        let mut assets = list_library_assets(&song_dir, self.engine.song())?;
        if !assets.iter().any(|asset| asset.file_path == audio_path) {
            assets.push(LibraryAssetSummary {
                file_name: Path::new(&shown_name)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&shown_name)
                    .to_string(),
                file_path: audio_path,
                duration_seconds: media_seconds,
                is_missing: false,
                folder_path: None,
            });
            assets.sort_by(|left, right| {
                left.folder_path
                    .cmp(&right.folder_path)
                    .then_with(|| left.file_name.cmp(&right.file_name))
            });
            write_library_manifest_assets(&song_dir, &assets)?;
        }

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
        Ok(self.snapshot())
    }

    /// What the audio clip of [`Self::link_video_audio`] plays: the video's
    /// own path, unless it is an Android document the engine cannot open by
    /// path — then a copy of it under `audio/`.
    fn audio_path_for_video(
        &self,
        song_dir: &Path,
        song: &libretracks_core::Song,
        video_path: &str,
        shown_name: &str,
    ) -> Result<String, DesktopError> {
        #[cfg(target_os = "android")]
        if crate::platform::content_uri::is_content_uri(video_path)
            && !crate::platform::android_content_uri::probe_referenceable(video_path)
        {
            let reserved: HashSet<String> = collect_library_file_paths(song_dir, Some(song))?
                .into_iter()
                .collect();
            let file_name = Path::new(shown_name)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("video.mp4");
            let relative = allocate_library_audio_path(song_dir, &reserved, None, file_name);
            let destination = resolve_audio_file_path(song_dir, &relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            if let Err(error) =
                crate::platform::android_content_uri::copy_content_to(video_path, &destination)
            {
                let _ = fs::remove_file(&destination);
                return Err(error.into());
            }
            return Ok(relative);
        }
        let _ = (song_dir, song, shown_name);
        Ok(video_path.to_string())
    }

    pub fn plan_video_audio_extraction(
        &self,
        clip_id: &str,
    ) -> Result<VideoAudioPlan, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        let clip = song
            .video_clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| {
                DesktopError::AudioCommand(format!("clip de vídeo no encontrado: {clip_id}"))
            })?;
        let info = self.video_asset_info(&clip.file_path);
        if info.as_ref().is_some_and(|info| !info.has_audio) {
            return Err(DesktopError::AudioCommand("el vídeo no tiene audio".into()));
        }

        let reserved: HashSet<String> = collect_library_file_paths(&song_dir, Some(song))?
            .into_iter()
            .collect();
        let relative_path = allocate_library_audio_path(
            &song_dir,
            &reserved,
            None,
            &extracted_file_name(&clip.file_path),
        );
        let destination = resolve_audio_file_path(&song_dir, &relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::File::create(&destination)?;

        Ok(VideoAudioPlan {
            clip_id: clip_id.to_string(),
            source: super::video_library::resolve_video_source(&song_dir, &clip.file_path),
            destination,
            relative_path,
            duration_seconds: info
                .map(|info| info.duration_seconds)
                .unwrap_or(clip.duration_seconds),
        })
    }

    /// Phase 3. If the video clip was deleted while decoding, the WAV still
    /// joins the library and nothing is placed. If the audio cannot be placed
    /// (it would invade the next song), the WAV is removed and the reason
    /// returned.
    pub fn commit_video_audio_extraction(
        &mut self,
        plan: &VideoAudioPlan,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let metadata = match read_audio_metadata(&plan.destination) {
            Ok(metadata) => metadata,
            Err(error) => {
                plan.abandon();
                return Err(error.into());
            }
        };
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let placed = match song
            .video_clips
            .iter()
            .find(|clip| clip.id == plan.clip_id)
            .cloned()
        {
            None => false,
            Some(video) => {
                let video_track = song
                    .tracks
                    .iter()
                    .find(|track| track.id == video.track_id)
                    .cloned()
                    .ok_or_else(|| DesktopError::TrackNotFound(video.track_id.clone()))?;
                let duration = video
                    .duration_seconds
                    .min(metadata.duration_seconds - video.source_start_seconds);
                if !(duration > 0.0) {
                    plan.abandon();
                    return Err(DesktopError::AudioCommand(
                        "el audio del vídeo no llega al tramo del clip".into(),
                    ));
                }
                let name = extracted_file_name(&video.file_path);
                let name = name.trim_end_matches(".wav");
                let track = new_track(
                    &song,
                    name,
                    TrackKind::Audio,
                    video_track.parent_track_id.as_deref(),
                    audio,
                );
                let track_id = track.id.clone();
                insert_track(
                    &mut song.tracks,
                    track,
                    Some(&video_track.id),
                    video_track.parent_track_id.as_deref(),
                )?;
                if let Err(error) = ensure_region_covers_clip_for_file(
                    &mut song,
                    video.timeline_start_seconds,
                    video.timeline_start_seconds + duration,
                    Some(&plan.relative_path),
                    ui_locale(audio).as_deref(),
                ) {
                    plan.abandon();
                    return Err(error);
                }
                song.clips.push(Clip {
                    id: format!("clip_{}_{}", timestamp_suffix(), song.clips.len()),
                    track_id,
                    file_path: plan.relative_path.clone(),
                    timeline_start_seconds: video.timeline_start_seconds,
                    source_start_seconds: video.source_start_seconds,
                    duration_seconds: duration,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                    color: None,
                });
                refresh_song_duration(&mut song);
                true
            }
        };

        let mut assets = list_library_assets(&song_dir, self.engine.song())?;
        if !assets
            .iter()
            .any(|asset| asset.file_path == plan.relative_path)
        {
            assets.push(LibraryAssetSummary {
                file_name: extracted_file_name_from_relative(&plan.relative_path),
                file_path: plan.relative_path.clone(),
                duration_seconds: metadata.duration_seconds,
                is_missing: false,
                folder_path: None,
            });
            assets.sort_by(|left, right| {
                left.folder_path
                    .cmp(&right.folder_path)
                    .then_with(|| left.file_name.cmp(&right.file_name))
            });
            write_library_manifest_assets(&song_dir, &assets)?;
        }

        if placed {
            self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
        }
        Ok(self.snapshot())
    }
}

fn extracted_file_name_from_relative(relative_path: &str) -> String {
    Path::new(relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative_path)
        .to_string()
}
