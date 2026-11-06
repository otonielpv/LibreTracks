//! Mirror mix (redundancy step 09): the main's live mix reaches the backup,
//! so switching to it sounds the same.
//!
//! What is mirrored: track and folder volume, pan, mute and solo; each
//! song's master gain (`region.master.gain`); metronome on/off and volume;
//! voice guide volume. Values in the model's own units (the dB faders store
//! a linear gain: that is what travels).
//!
//! Not mirrored: ambient pads (they belong to the machine, independent from
//! the transport and the session, see the pads design), structural edits
//! (they change the fingerprint and the backup goes to `SessionMismatch`),
//! and volume automation (identical on both sides by the fingerprint).
//!
//! - Live changes (fader drags) leave the audio controller through
//!   [`emit`]: a process-wide bus, so the hot path takes no session lock.
//! - The publisher coalesces them ([`MixCoalescer`], ≤ 1 per control every
//!   30 ms, the last value always arrives) and sends the WHOLE mix
//!   ([`MixSnapshot`]) on connect and every couple of seconds; the backup
//!   applies it, which also overwrites any local change made there.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use libretracks_core::Song;
use libretracks_link::redundancy::MixControl;
use tokio::sync::broadcast;

use crate::infra::settings::AppSettings;
use crate::models::SongView;

/// One message per control at most this often (ns).
pub const COALESCE_NS: u64 = 30_000_000;

static BUS: OnceLock<broadcast::Sender<MixControl>> = OnceLock::new();

fn bus() -> &'static broadcast::Sender<MixControl> {
    BUS.get_or_init(|| broadcast::channel(256).0)
}

/// A live mix change happened (never blocks; nobody listening = dropped).
pub fn emit(control: MixControl) {
    let sender = bus();
    if sender.receiver_count() > 0 {
        let _ = sender.send(control);
    }
}

pub fn subscribe() -> broadcast::Receiver<MixControl> {
    bus().subscribe()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackMix {
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

/// The whole live mix.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MixSnapshot {
    pub tracks: BTreeMap<String, TrackMix>,
    pub song_masters: BTreeMap<String, f64>,
    pub metronome_enabled: bool,
    pub metronome_volume: f64,
    pub voice_guide_enabled: bool,
    pub voice_guide_volume: f64,
}

impl MixSnapshot {
    fn with_settings(mut self, settings: &AppSettings) -> Self {
        self.metronome_enabled = settings.metronome_enabled;
        self.metronome_volume = settings.metronome_volume;
        self.voice_guide_enabled = settings.voice_guide_enabled;
        self.voice_guide_volume = settings.voice_guide_volume;
        self
    }

    pub fn from_song(song: &Song, settings: &AppSettings) -> Self {
        Self {
            tracks: song
                .tracks
                .iter()
                .map(|track| {
                    (
                        track.id.clone(),
                        TrackMix {
                            volume: track.volume,
                            pan: track.pan,
                            muted: track.muted,
                            solo: track.solo,
                        },
                    )
                })
                .collect(),
            song_masters: song
                .regions
                .iter()
                .map(|region| (region.id.clone(), region.master.gain))
                .collect(),
            ..Self::default()
        }
        .with_settings(settings)
    }

    pub fn from_view(song: &SongView, settings: &AppSettings) -> Self {
        Self {
            tracks: song
                .tracks
                .iter()
                .map(|track| {
                    (
                        track.id.clone(),
                        TrackMix {
                            volume: track.volume,
                            pan: track.pan,
                            muted: track.muted,
                            solo: track.solo,
                        },
                    )
                })
                .collect(),
            song_masters: song
                .regions
                .iter()
                .map(|region| (region.id.clone(), region.master.gain))
                .collect(),
            ..Self::default()
        }
        .with_settings(settings)
    }

    /// A whole mix as sent by the main.
    pub fn from_controls(controls: &[MixControl]) -> Self {
        let mut mix = Self::default();
        for control in controls {
            match control {
                MixControl::Track {
                    track_id,
                    volume,
                    pan,
                    muted,
                    solo,
                } => {
                    mix.tracks.insert(
                        track_id.clone(),
                        TrackMix {
                            volume: volume.unwrap_or(1.0),
                            pan: pan.unwrap_or(0.0),
                            muted: muted.unwrap_or(false),
                            solo: solo.unwrap_or(false),
                        },
                    );
                }
                MixControl::SongMaster { region_id, gain } => {
                    mix.song_masters.insert(region_id.clone(), *gain);
                }
                MixControl::Metronome { enabled, volume } => {
                    mix.metronome_enabled = enabled.unwrap_or(mix.metronome_enabled);
                    mix.metronome_volume = volume.unwrap_or(mix.metronome_volume);
                }
                MixControl::VoiceGuide { enabled, volume } => {
                    mix.voice_guide_enabled = enabled.unwrap_or(mix.voice_guide_enabled);
                    mix.voice_guide_volume = volume.unwrap_or(mix.voice_guide_volume);
                }
            }
        }
        mix
    }

    /// Every control, full values.
    pub fn controls(&self) -> Vec<MixControl> {
        let mut controls: Vec<MixControl> = self
            .tracks
            .iter()
            .map(|(id, mix)| MixControl::Track {
                track_id: id.clone(),
                volume: Some(mix.volume),
                pan: Some(mix.pan),
                muted: Some(mix.muted),
                solo: Some(mix.solo),
            })
            .collect();
        controls.extend(self.song_masters.iter().map(|(id, gain)| MixControl::SongMaster {
            region_id: id.clone(),
            gain: *gain,
        }));
        controls.push(MixControl::Metronome {
            enabled: Some(self.metronome_enabled),
            volume: Some(self.metronome_volume),
        });
        controls.push(MixControl::VoiceGuide {
            enabled: Some(self.voice_guide_enabled),
            volume: Some(self.voice_guide_volume),
        });
        controls
    }

    /// Same mix, with a tolerance for float noise.
    pub fn matches(&self, other: &MixSnapshot) -> bool {
        const EPS: f64 = 1e-6;
        let close = |a: f64, b: f64| (a - b).abs() <= EPS;
        self.tracks.len() == other.tracks.len()
            && self.tracks.iter().all(|(id, mix)| {
                other.tracks.get(id).is_some_and(|theirs| {
                    close(mix.volume, theirs.volume)
                        && close(mix.pan, theirs.pan)
                        && mix.muted == theirs.muted
                        && mix.solo == theirs.solo
                })
            })
            && self.song_masters.len() == other.song_masters.len()
            && self.song_masters.iter().all(|(id, gain)| {
                other
                    .song_masters
                    .get(id)
                    .is_some_and(|theirs| close(*gain, *theirs))
            })
            && self.metronome_enabled == other.metronome_enabled
            && close(self.metronome_volume, other.metronome_volume)
            && self.voice_guide_enabled == other.voice_guide_enabled
            && close(self.voice_guide_volume, other.voice_guide_volume)
    }
}

fn control_key(control: &MixControl) -> String {
    match control {
        MixControl::Track { track_id, .. } => format!("track:{track_id}"),
        MixControl::SongMaster { region_id, .. } => format!("master:{region_id}"),
        MixControl::Metronome { .. } => "metronome".into(),
        MixControl::VoiceGuide { .. } => "voiceGuide".into(),
    }
}

/// Fold a newer partial change onto an older one of the same control.
fn merge(older: MixControl, newer: MixControl) -> MixControl {
    match (older, newer) {
        (
            MixControl::Track {
                track_id,
                volume,
                pan,
                muted,
                solo,
            },
            MixControl::Track {
                volume: new_volume,
                pan: new_pan,
                muted: new_muted,
                solo: new_solo,
                ..
            },
        ) => MixControl::Track {
            track_id,
            volume: new_volume.or(volume),
            pan: new_pan.or(pan),
            muted: new_muted.or(muted),
            solo: new_solo.or(solo),
        },
        (
            MixControl::Metronome { enabled, volume },
            MixControl::Metronome {
                enabled: new_enabled,
                volume: new_volume,
            },
        ) => MixControl::Metronome {
            enabled: new_enabled.or(enabled),
            volume: new_volume.or(volume),
        },
        (
            MixControl::VoiceGuide { enabled, volume },
            MixControl::VoiceGuide {
                enabled: new_enabled,
                volume: new_volume,
            },
        ) => MixControl::VoiceGuide {
            enabled: new_enabled.or(enabled),
            volume: new_volume.or(volume),
        },
        (_, newer) => newer,
    }
}

/// At most one message per control every [`COALESCE_NS`]; what arrives in
/// between is folded and sent when the window passes, so the last value
/// always goes out. Pure: time injected.
#[derive(Debug, Default)]
pub struct MixCoalescer {
    last_sent_ns: HashMap<String, u64>,
    pending: BTreeMap<String, MixControl>,
}

impl MixCoalescer {
    /// A change: returned at once when its control is free, else held.
    pub fn push(&mut self, control: MixControl, now_ns: u64) -> Option<MixControl> {
        let key = control_key(&control);
        let control = match self.pending.remove(&key) {
            Some(older) => merge(older, control),
            None => control,
        };
        let free = self
            .last_sent_ns
            .get(&key)
            .is_none_or(|last| now_ns.saturating_sub(*last) >= COALESCE_NS);
        if free {
            self.last_sent_ns.insert(key, now_ns);
            Some(control)
        } else {
            self.pending.insert(key, control);
            None
        }
    }

    /// Held changes whose window has passed.
    pub fn flush(&mut self, now_ns: u64) -> Vec<MixControl> {
        let due: Vec<String> = self
            .pending
            .keys()
            .filter(|key| {
                self.last_sent_ns
                    .get(*key)
                    .is_none_or(|last| now_ns.saturating_sub(*last) >= COALESCE_NS)
            })
            .cloned()
            .collect();
        due.into_iter()
            .filter_map(|key| {
                let control = self.pending.remove(&key)?;
                self.last_sent_ns.insert(key, now_ns);
                Some(control)
            })
            .collect()
    }
}

/// Metronome / voice guide controls onto the settings. Returns whether
/// anything changed.
pub fn apply_to_settings(settings: &mut AppSettings, control: &MixControl) -> bool {
    let before = (
        settings.metronome_enabled,
        settings.metronome_volume,
        settings.voice_guide_enabled,
        settings.voice_guide_volume,
    );
    match control {
        MixControl::Metronome { enabled, volume } => {
            if let Some(enabled) = enabled {
                settings.metronome_enabled = *enabled;
            }
            if let Some(volume) = volume {
                settings.metronome_volume = volume.clamp(0.0, 10.0);
            }
        }
        MixControl::VoiceGuide { enabled, volume } => {
            if let Some(enabled) = enabled {
                settings.voice_guide_enabled = *enabled;
            }
            if let Some(volume) = volume {
                settings.voice_guide_volume = volume.clamp(0.0, 10.0);
            }
        }
        MixControl::Track { .. } | MixControl::SongMaster { .. } => {}
    }
    before
        != (
            settings.metronome_enabled,
            settings.metronome_volume,
            settings.voice_guide_enabled,
            settings.voice_guide_volume,
        )
}

/// A track or song-master control onto the backup's session. `full`
/// (snapshot) commits to the model, only when it differs (no undo entry for
/// nothing); a live change goes straight to the engine like the main's drag.
/// Never touches the transport.
pub fn apply_to_session(
    session: &mut crate::state::DesktopSession,
    audio: &crate::audio::engine::AudioController,
    control: &MixControl,
    full: bool,
) -> Result<(), String> {
    let error = |error: crate::infra::error::DesktopError| error.to_string();
    match control {
        MixControl::Track {
            track_id,
            volume,
            pan,
            muted,
            solo,
        } => {
            if !full {
                return audio
                    .update_live_track_mix(track_id, *volume, *pan, *muted, *solo, None)
                    .map_err(error);
            }
            let Some(current) = session
                .engine
                .song()
                .and_then(|song| song.tracks.iter().find(|track| &track.id == track_id))
                .map(|track| TrackMix {
                    volume: track.volume,
                    pan: track.pan,
                    muted: track.muted,
                    solo: track.solo,
                })
            else {
                return Ok(()); // a track the backup does not have: the fingerprint says so
            };
            let wanted = TrackMix {
                volume: volume.unwrap_or(current.volume),
                pan: pan.unwrap_or(current.pan),
                muted: muted.unwrap_or(current.muted),
                solo: solo.unwrap_or(current.solo),
            };
            if wanted != current {
                session
                    .update_track(
                        track_id,
                        None,
                        Some(wanted.volume),
                        Some(wanted.pan),
                        Some(wanted.muted),
                        Some(wanted.solo),
                        None,
                        audio,
                    )
                    .map_err(error)?;
            }
            Ok(())
        }
        MixControl::SongMaster { region_id, gain } => {
            if !full {
                return audio
                    .update_live_region_master_gain(region_id, *gain as f32)
                    .map_err(error);
            }
            let current = session.engine.song().and_then(|song| {
                song.regions
                    .iter()
                    .find(|region| &region.id == region_id)
                    .map(|region| region.master.gain)
            });
            if current.is_some_and(|current| (current - gain).abs() > 1e-9) {
                session
                    .update_song_region_master_gain(region_id, *gain, audio)
                    .map_err(error)?;
            }
            Ok(())
        }
        MixControl::Metronome { .. } | MixControl::VoiceGuide { .. } => Ok(()),
    }
}

#[cfg(test)]
#[path = "mix_tests.rs"]
mod tests;
