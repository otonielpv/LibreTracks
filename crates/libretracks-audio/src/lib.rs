//! Motor de audio y transporte.

use libretracks_core::{validate_song, Clip, DomainError, Song, Track, TrackGroup};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    Empty,
    Stopped,
    Playing,
    Paused,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActiveClip {
    pub clip_id: String,
    pub track_id: String,
    pub track_name: String,
    pub file_path: String,
    pub output_bus_id: String,
    pub timeline_offset_seconds: f64,
    pub gain: f64,
}

#[derive(Debug, Error, PartialEq)]
pub enum AudioEngineError {
    #[error("song is invalid: {0}")]
    InvalidSong(#[from] DomainError),
    #[error("no song is loaded")]
    NoSongLoaded,
    #[error("position must be within song duration")]
    PositionOutOfRange,
    #[error("track not found: {0}")]
    TrackNotFound(String),
}

#[derive(Debug, Default)]
pub struct AudioEngine {
    song: Option<Song>,
    playback_state: PlaybackState,
    position_seconds: f64,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self::Empty
    }
}

impl AudioEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_song(&mut self, song: Song) -> Result<(), AudioEngineError> {
        validate_song(&song)?;
        self.song = Some(song);
        self.playback_state = PlaybackState::Stopped;
        self.position_seconds = 0.0;

        Ok(())
    }

    pub fn playback_state(&self) -> PlaybackState {
        self.playback_state
    }

    pub fn position_seconds(&self) -> f64 {
        self.position_seconds
    }

    pub fn song(&self) -> Option<&Song> {
        self.song.as_ref()
    }

    pub fn play(&mut self) -> Result<(), AudioEngineError> {
        self.ensure_song_loaded()?;
        self.playback_state = PlaybackState::Playing;
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), AudioEngineError> {
        self.ensure_song_loaded()?;
        self.playback_state = PlaybackState::Paused;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), AudioEngineError> {
        self.ensure_song_loaded()?;
        self.playback_state = PlaybackState::Stopped;
        self.position_seconds = 0.0;
        Ok(())
    }

    pub fn seek(&mut self, position_seconds: f64) -> Result<(), AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        if !(0.0..=song.duration_seconds).contains(&position_seconds) {
            return Err(AudioEngineError::PositionOutOfRange);
        }

        self.position_seconds = position_seconds;
        Ok(())
    }

    pub fn active_clips(&self) -> Result<Vec<ActiveClip>, AudioEngineError> {
        self.active_clips_at(self.position_seconds)
    }

    pub fn active_clips_at(
        &self,
        position_seconds: f64,
    ) -> Result<Vec<ActiveClip>, AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        let mut active_clips = Vec::new();

        for clip in &song.clips {
            if !is_clip_active(clip, position_seconds) {
                continue;
            }

            let track = find_track(song, &clip.track_id)?;
            let gain = self.effective_track_gain(&track.id)?;
            if gain <= 0.0 {
                continue;
            }

            active_clips.push(ActiveClip {
                clip_id: clip.id.clone(),
                track_id: track.id.clone(),
                track_name: track.name.clone(),
                file_path: clip.file_path.clone(),
                output_bus_id: track.output_bus_id.clone(),
                timeline_offset_seconds: position_seconds - clip.timeline_start_seconds,
                gain: gain * clip.gain,
            });
        }

        Ok(active_clips)
    }

    pub fn effective_track_gain(&self, track_id: &str) -> Result<f64, AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        let track = find_track(song, track_id)?;

        if track.muted {
            return Ok(0.0);
        }

        let group_gain = match track.group_id.as_deref() {
            Some(group_id) => {
                let group = find_group(song, group_id)?;
                if group.muted {
                    0.0
                } else {
                    group.volume
                }
            }
            None => 1.0,
        };

        Ok(track.volume * group_gain)
    }

    fn ensure_song_loaded(&self) -> Result<&Song, AudioEngineError> {
        self.song.as_ref().ok_or(AudioEngineError::NoSongLoaded)
    }
}

fn is_clip_active(clip: &Clip, position_seconds: f64) -> bool {
    let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
    position_seconds >= clip.timeline_start_seconds && position_seconds < clip_end
}

fn find_track<'a>(song: &'a Song, track_id: &str) -> Result<&'a Track, AudioEngineError> {
    song.tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| AudioEngineError::TrackNotFound(track_id.to_string()))
}

fn find_group<'a>(song: &'a Song, group_id: &str) -> Result<&'a TrackGroup, AudioEngineError> {
    song.groups
        .iter()
        .find(|group| group.id == group_id)
        .ok_or_else(|| AudioEngineError::TrackNotFound(group_id.to_string()))
}

#[cfg(test)]
mod tests {
    use libretracks_core::{Clip, OutputBus, Section, Song, Track, TrackGroup};

    use crate::{AudioEngine, PlaybackState};

    fn demo_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            bpm: 72.0,
            key: Some("D".into()),
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tracks: vec![
                Track {
                    id: "track_click".into(),
                    name: "Click".into(),
                    group_id: Some("group_monitor".into()),
                    volume: 0.8,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                Track {
                    id: "track_drums".into(),
                    name: "Drums".into(),
                    group_id: Some("group_main".into()),
                    volume: 0.5,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            groups: vec![
                TrackGroup {
                    id: "group_monitor".into(),
                    name: "Click + Guide".into(),
                    volume: 0.5,
                    muted: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                TrackGroup {
                    id: "group_main".into(),
                    name: "Drums + Bass".into(),
                    volume: 0.7,
                    muted: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![
                Clip {
                    id: "clip_click".into(),
                    track_id: "track_click".into(),
                    file_path: "audio/click.wav".into(),
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
                Clip {
                    id: "clip_drums".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/drums.wav".into(),
                    timeline_start_seconds: 10.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 4.0,
                    gain: 0.9,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
            ],
            sections: vec![Section {
                id: "section_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                end_seconds: 8.0,
            }],
        }
    }

    #[test]
    fn starts_empty() {
        let engine = AudioEngine::new();

        assert_eq!(engine.playback_state(), PlaybackState::Empty);
        assert_eq!(engine.position_seconds(), 0.0);
        assert!(engine.song().is_none());
    }

    #[test]
    fn play_changes_state_after_loading_song() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");

        engine.play().expect("play should work");

        assert_eq!(engine.playback_state(), PlaybackState::Playing);
    }

    #[test]
    fn stop_resets_position() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(4.5).expect("seek should work");

        engine.stop().expect("stop should work");

        assert_eq!(engine.playback_state(), PlaybackState::Stopped);
        assert_eq!(engine.position_seconds(), 0.0);
    }

    #[test]
    fn pause_preserves_position() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(3.0).expect("seek should work");

        engine.pause().expect("pause should work");

        assert_eq!(engine.playback_state(), PlaybackState::Paused);
        assert_eq!(engine.position_seconds(), 3.0);
    }

    #[test]
    fn seek_changes_position() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");

        engine.seek(12.5).expect("seek should work");

        assert_eq!(engine.position_seconds(), 12.5);
    }

    #[test]
    fn track_mute_applies_zero_gain() {
        let mut song = demo_song();
        song.tracks[0].muted = true;

        let mut engine = AudioEngine::new();
        engine.load_song(song).expect("song should load");

        assert_eq!(engine.effective_track_gain("track_click").unwrap(), 0.0);
    }

    #[test]
    fn group_mute_mutes_its_tracks() {
        let mut song = demo_song();
        song.groups[0].muted = true;

        let mut engine = AudioEngine::new();
        engine.load_song(song).expect("song should load");

        assert_eq!(engine.effective_track_gain("track_click").unwrap(), 0.0);
    }

    #[test]
    fn final_gain_is_track_times_group() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");

        let gain = engine.effective_track_gain("track_drums").unwrap();

        assert!((gain - 0.35).abs() < 0.0001);
    }

    #[test]
    fn clips_outside_current_range_are_not_active() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");

        let clips = engine.active_clips_at(7.0).expect("active clips should resolve");

        assert!(clips.is_empty());
    }

    #[test]
    fn displaced_clips_enter_at_the_expected_time() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");

        let clips = engine.active_clips_at(11.0).expect("active clips should resolve");

        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].clip_id, "clip_drums");
        assert!((clips[0].timeline_offset_seconds - 1.0).abs() < 0.0001);
    }
}
