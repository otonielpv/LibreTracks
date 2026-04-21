//! Motor de audio y transporte.

use libretracks_core::{
    validate_song, Clip, DerivedSection, DomainError, Song, Track, TrackKind,
};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JumpTrigger {
    Immediate,
    SectionEnd,
    AfterBars(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingSectionJump {
    pub target_marker_id: String,
    pub target_marker_name: String,
    pub target_digit: Option<u8>,
    pub trigger: JumpTrigger,
    pub execute_at_seconds: f64,
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
    #[error("section marker not found: {0}")]
    SectionMarkerNotFound(String),
    #[error("time signature is invalid: {0}")]
    InvalidTimeSignature(String),
}

#[derive(Debug, Default)]
pub struct AudioEngine {
    song: Option<Song>,
    playback_state: PlaybackState,
    position_seconds: f64,
    pending_section_jump: Option<PendingSectionJump>,
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
        self.pending_section_jump = None;

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

    pub fn pending_section_jump(&self) -> Option<&PendingSectionJump> {
        self.pending_section_jump.as_ref()
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
        self.pending_section_jump = None;
        Ok(())
    }

    pub fn seek(&mut self, position_seconds: f64) -> Result<(), AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        if !(0.0..=song.duration_seconds).contains(&position_seconds) {
            return Err(AudioEngineError::PositionOutOfRange);
        }

        let should_clear_pending_jump = self
            .pending_section_jump
            .as_ref()
            .map(|pending_jump| {
                find_marker(song, &pending_jump.target_marker_id).map(|target_marker| {
                    position_seconds >= target_marker.start_seconds
                        || position_seconds >= pending_jump.execute_at_seconds
                })
            })
            .transpose()?
            .unwrap_or(false);

        self.position_seconds = position_seconds;
        if should_clear_pending_jump {
            self.pending_section_jump = None;
        }
        Ok(())
    }

    pub fn current_section(&self) -> Result<Option<DerivedSection>, AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        Ok(song.derived_section_at(self.position_seconds))
    }

    pub fn schedule_section_jump(
        &mut self,
        target_section_id: &str,
        trigger: JumpTrigger,
    ) -> Result<Option<PendingSectionJump>, AudioEngineError> {
        let song = self.ensure_song_loaded()?;
        let target_marker = find_marker(song, target_section_id)?;

        if trigger == JumpTrigger::Immediate {
            self.position_seconds = target_marker.start_seconds;
            self.pending_section_jump = None;
            return Ok(None);
        }

        let execute_at_seconds = jump_execute_at(song, self.position_seconds, &trigger)?;

        let pending_jump = PendingSectionJump {
            target_marker_id: target_marker.id.clone(),
            target_marker_name: target_marker.name.clone(),
            target_digit: target_marker.digit,
            trigger,
            execute_at_seconds,
        };

        self.pending_section_jump = Some(pending_jump.clone());
        Ok(Some(pending_jump))
    }

    pub fn cancel_section_jump(&mut self) {
        self.pending_section_jump = None;
    }

    pub fn advance_transport(&mut self, delta_seconds: f64) -> Result<f64, AudioEngineError> {
        if delta_seconds < 0.0 {
            return Err(AudioEngineError::PositionOutOfRange);
        }

        let song = self.ensure_song_loaded()?.clone();
        let mut next_position = (self.position_seconds + delta_seconds).min(song.duration_seconds);

        if let Some(pending_jump) = self.pending_section_jump.clone() {
            let execute_at = pending_jump.execute_at_seconds;

            if execute_at <= next_position {
                let overshoot = next_position - execute_at;
                let target_marker = find_marker(&song, &pending_jump.target_marker_id)?;
                next_position = (target_marker.start_seconds + overshoot).min(song.duration_seconds);
                self.pending_section_jump = None;
            }
        }

        self.position_seconds = next_position;

        if self.position_seconds >= song.duration_seconds {
            self.playback_state = PlaybackState::Stopped;
            self.pending_section_jump = None;
        }

        Ok(self.position_seconds)
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
        effective_track_gain(song, track_id)
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

fn find_marker<'a>(
    song: &'a Song,
    marker_id: &str,
) -> Result<&'a libretracks_core::SectionMarker, AudioEngineError> {
    song.section_marker_by_id(marker_id)
        .ok_or_else(|| AudioEngineError::SectionMarkerNotFound(marker_id.to_string()))
}

fn jump_execute_at(
    song: &Song,
    current_position: f64,
    trigger: &JumpTrigger,
) -> Result<f64, AudioEngineError> {
    match trigger {
        JumpTrigger::Immediate => Ok(current_position),
        JumpTrigger::SectionEnd => {
            let current_section = song
                .derived_section_at(current_position)
                .ok_or_else(|| AudioEngineError::SectionMarkerNotFound("current".into()))?;
            Ok(current_section.end_seconds)
        }
        JumpTrigger::AfterBars(bars) => {
            let bar_duration = song_bar_duration_seconds(song)?;
            let current_bar_index = (current_position / bar_duration).floor();
            Ok(((current_bar_index + f64::from(*bars)) * bar_duration).min(song.duration_seconds))
        }
    }
}

fn song_bar_duration_seconds(song: &Song) -> Result<f64, AudioEngineError> {
    let (numerator, denominator) = parse_time_signature(&song.time_signature)?;
    let beat_duration_seconds = 60.0 / song.bpm;
    let quarter_notes_per_bar = f64::from(numerator) * (4.0 / f64::from(denominator));
    Ok(beat_duration_seconds * quarter_notes_per_bar)
}

fn parse_time_signature(time_signature: &str) -> Result<(u32, u32), AudioEngineError> {
    let (numerator, denominator) = time_signature
        .split_once('/')
        .ok_or_else(|| AudioEngineError::InvalidTimeSignature(time_signature.to_string()))?;

    let numerator = numerator
        .parse::<u32>()
        .map_err(|_| AudioEngineError::InvalidTimeSignature(time_signature.to_string()))?;
    let denominator = denominator
        .parse::<u32>()
        .map_err(|_| AudioEngineError::InvalidTimeSignature(time_signature.to_string()))?;

    if numerator == 0 || denominator == 0 {
        return Err(AudioEngineError::InvalidTimeSignature(
            time_signature.to_string(),
        ));
    }

    Ok((numerator, denominator))
}

fn effective_track_gain(song: &Song, track_id: &str) -> Result<f64, AudioEngineError> {
    let track = find_track(song, track_id)?;
    if track.muted {
        return Ok(0.0);
    }

    let mut gain = track.volume;
    let mut cursor = track.parent_track_id.as_deref();

    while let Some(parent_track_id) = cursor {
        let parent_track = find_track(song, parent_track_id)?;
        if parent_track.kind != TrackKind::Folder {
            return Err(AudioEngineError::TrackNotFound(parent_track_id.to_string()));
        }

        if parent_track.muted {
            return Ok(0.0);
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
    }

    Ok(gain)
}

#[cfg(test)]
mod tests {
    use libretracks_core::{
        Clip, OutputBus, SectionMarker, Song, TempoMetadata, TempoSource, Track, TrackKind,
    };

    use crate::{AudioEngine, JumpTrigger, PlaybackState};

    fn demo_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            bpm: 72.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: Some("D".into()),
            time_signature: "4/4".into(),
            duration_seconds: 24.0,
            tracks: vec![
                Track {
                    id: "folder_monitor".into(),
                    name: "Click + Guide".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 0.5,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                Track {
                    id: "track_click".into(),
                    name: "Click".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("folder_monitor".into()),
                    volume: 0.8,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                Track {
                    id: "folder_main".into(),
                    name: "Drums + Bass".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 0.7,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_drums".into(),
                    name: "Drums".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("folder_main".into()),
                    volume: 0.5,
                    pan: 0.0,
                    muted: false,
                    solo: false,
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
            section_markers: vec![
                SectionMarker {
                    id: "section_intro".into(),
                    name: "Intro".into(),
                    start_seconds: 0.0,
                    digit: Some(1),
                },
                SectionMarker {
                    id: "section_break".into(),
                    name: "Break".into(),
                    start_seconds: 8.0,
                    digit: None,
                },
                SectionMarker {
                    id: "section_outro".into(),
                    name: "Outro".into(),
                    start_seconds: 12.0,
                    digit: Some(2),
                },
            ],
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
    fn immediate_section_jump_moves_transport_now() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(1.0).expect("seek should work");

        let scheduled = engine
            .schedule_section_jump("section_outro", JumpTrigger::Immediate)
            .expect("jump should schedule");

        assert!(scheduled.is_none());
        assert_eq!(engine.position_seconds(), 12.0);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn jump_at_section_end_is_scheduled_and_executed() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(6.0).expect("seek should work");
        engine.play().expect("play should work");

        let scheduled = engine
            .schedule_section_jump("section_outro", JumpTrigger::SectionEnd)
            .expect("jump should schedule")
            .expect("jump should remain pending");

        assert_eq!(scheduled.target_marker_name, "Outro");

        let position = engine
            .advance_transport(3.0)
            .expect("transport should advance");

        assert!((position - 13.0).abs() < 0.0001);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn jump_after_bars_counts_from_the_current_bar() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(1.0).expect("seek should work");
        engine.play().expect("play should work");

        engine
            .schedule_section_jump("section_outro", JumpTrigger::AfterBars(2))
            .expect("jump should schedule");

        let position = engine
            .advance_transport(6.0)
            .expect("transport should advance");

        assert!((position - 12.3333333333).abs() < 0.0001);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn four_bar_jump_uses_the_local_bar_count_even_near_song_end() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(7.0).expect("seek should work");
        engine.play().expect("play should work");

        engine
            .schedule_section_jump("section_outro", JumpTrigger::AfterBars(4))
            .expect("jump should schedule");

        let position = engine
            .advance_transport(14.0)
            .expect("transport should advance");

        assert!((position - 13.0).abs() < 0.0001);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn scheduled_jump_can_be_cancelled() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(6.0).expect("seek should work");
        engine.play().expect("play should work");

        engine
            .schedule_section_jump("section_outro", JumpTrigger::SectionEnd)
            .expect("jump should schedule");
        engine.cancel_section_jump();

        let position = engine
            .advance_transport(3.0)
            .expect("transport should advance");

        assert!((position - 9.0).abs() < 0.0001);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn seek_to_pending_jump_target_clears_pending_jump() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(6.0).expect("seek should work");
        engine.play().expect("play should work");

        engine
            .schedule_section_jump("section_outro", JumpTrigger::SectionEnd)
            .expect("jump should schedule");
        assert!(engine.pending_section_jump().is_some());

        engine.seek(12.0).expect("seek to target should work");

        assert_eq!(engine.position_seconds(), 12.0);
        assert!(engine.pending_section_jump().is_none());
    }

    #[test]
    fn seek_before_pending_jump_target_keeps_pending_jump() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(6.0).expect("seek should work");
        engine.play().expect("play should work");

        engine
            .schedule_section_jump("section_outro", JumpTrigger::AfterBars(2))
            .expect("jump should schedule");
        assert!(engine.pending_section_jump().is_some());

        engine.seek(8.0).expect("seek before target should work");

        assert_eq!(engine.position_seconds(), 8.0);
        assert!(engine.pending_section_jump().is_some());
    }

    #[test]
    fn exposes_current_section_for_future_timeline_navigation() {
        let mut engine = AudioEngine::new();
        engine.load_song(demo_song()).expect("song should load");
        engine.seek(13.0).expect("seek should work");

        let section = engine
            .current_section()
            .expect("section should resolve")
            .expect("section should exist");

        assert_eq!(section.marker_id.as_deref(), Some("section_outro"));
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
    fn muted_folder_mutes_its_tracks() {
        let mut song = demo_song();
        song.tracks[0].muted = true;

        let mut engine = AudioEngine::new();
        engine.load_song(song).expect("song should load");

        assert_eq!(engine.effective_track_gain("track_click").unwrap(), 0.0);
    }

    #[test]
    fn final_gain_inherits_folder_gain() {
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
