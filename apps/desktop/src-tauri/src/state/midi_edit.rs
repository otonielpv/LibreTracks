//! Editing of MIDI clips: upsert, delete and move.
//!
//! Sibling `impl DesktopSession` block, same shape as `state/song_edit.rs`.
//! The runtime that *plays* these clips lives in `state/midi_runtime.rs`.

use libretracks_core::{
    source_seconds_at_view, MidiClip, TrackKind, MAX_MIDI_CHANNEL, MIN_MIDI_CHANNEL,
};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::DesktopSession;

impl DesktopSession {
    /// Insert or replace a MIDI clip.
    ///
    /// `timeline_start_seconds` arrives in view time (what the user clicked)
    /// and is mapped back to source time before storing, the same conversion
    /// `upsert_automation_cue` does — otherwise a clip placed on a warped
    /// region would drift from where it was dropped.
    pub fn upsert_midi_clip(
        &mut self,
        mut clip: MidiClip,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        clip.timeline_start_seconds =
            source_seconds_at_view(&song, clip.timeline_start_seconds.max(0.0));
        clip.name = clip.name.trim().to_string();
        if clip.name.is_empty() {
            clip.name = "MIDI".into();
        }

        let track_is_midi = song
            .tracks
            .iter()
            .any(|track| track.id == clip.track_id && track.kind == TrackKind::Midi);
        if !track_is_midi {
            return Err(DesktopError::AudioCommand(
                "midi clip must target a midi track".into(),
            ));
        }

        self.push_history_entry();
        self.redo_stack.clear();

        if let Some(existing) = song
            .midi_clips
            .iter_mut()
            .find(|existing| existing.id == clip.id)
        {
            *existing = clip;
        } else {
            song.midi_clips.push(clip);
        }
        song.midi_clips.sort_by(|left, right| {
            left.timeline_start_seconds
                .partial_cmp(&right.timeline_start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.commit_midi_clips(song, audio)
    }

    pub fn delete_midi_clip(
        &mut self,
        clip_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let before = song.midi_clips.len();
        song.midi_clips.retain(|clip| clip.id != clip_id);
        if song.midi_clips.len() == before {
            return Ok(self.snapshot());
        }

        self.push_history_entry();
        self.redo_stack.clear();
        self.commit_midi_clips(song, audio)
    }

    /// Move a clip along the timeline (and optionally to another MIDI track).
    pub fn move_midi_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        target_track_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let source_seconds = source_seconds_at_view(&song, timeline_start_seconds.max(0.0));

        if let Some(track_id) = target_track_id {
            let is_midi = song
                .tracks
                .iter()
                .any(|track| track.id == track_id && track.kind == TrackKind::Midi);
            if !is_midi {
                return Err(DesktopError::AudioCommand(
                    "midi clip must target a midi track".into(),
                ));
            }
        }

        let Some(clip) = song.midi_clips.iter_mut().find(|clip| clip.id == clip_id) else {
            return Ok(self.snapshot());
        };
        clip.timeline_start_seconds = source_seconds;
        if let Some(track_id) = target_track_id {
            clip.track_id = track_id.to_string();
        }

        self.push_history_entry();
        self.redo_stack.clear();
        song.midi_clips.sort_by(|left, right| {
            left.timeline_start_seconds
                .partial_cmp(&right.timeline_start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.commit_midi_clips(song, audio)
    }

    /// Set a MIDI track's routing: which port its messages leave by and which
    /// channel they carry by default.
    ///
    /// `port` of `None` means "use the app-wide output device". Kept out of
    /// `update_track` (the mixer path, which issues engine commands per changed
    /// field) because none of this reaches the engine.
    pub fn set_midi_track_routing(
        &mut self,
        track_id: &str,
        port: Option<&str>,
        channel: Option<u8>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let Some(track) = song
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id && track.kind == TrackKind::Midi)
        else {
            return Err(DesktopError::AudioCommand(
                "midi routing can only be set on a midi track".into(),
            ));
        };

        if let Some(channel) = channel {
            if !(MIN_MIDI_CHANNEL..=MAX_MIDI_CHANNEL).contains(&channel) {
                return Err(DesktopError::AudioCommand(format!(
                    "midi channel must be {MIN_MIDI_CHANNEL}-{MAX_MIDI_CHANNEL}, got {channel}"
                )));
            }
            track.midi_channel = channel;
        }
        // A blank name clears the override back to the app-wide port.
        track.midi_port = port.map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);

        self.push_history_entry();
        self.redo_stack.clear();
        self.commit_midi_clips(song, audio)
    }

    /// Persist a song whose MIDI clips changed.
    ///
    /// Committed as `MixerOnly`: MIDI never reaches the native engine, so
    /// there is nothing to rebuild there and a full reload would needlessly
    /// interrupt playback. History is recorded by the callers, which is why
    /// `persist_song_update_internal` is called with `record_history: false`.
    /// The playback cursor is re-anchored so an edit made mid-playback doesn't
    /// replay events the playhead has already passed.
    fn commit_midi_clips(
        &mut self,
        song: libretracks_core::Song,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.persist_song_update_internal(
            song,
            audio,
            super::AudioChangeImpact::MixerOnly,
            false,
            true,
        )?;
        self.reset_midi_cursor(self.engine.position_seconds());
        Ok(self.snapshot())
    }
}
