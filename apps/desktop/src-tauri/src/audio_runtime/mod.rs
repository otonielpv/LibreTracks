mod backend;
mod mixer;
mod source;
mod telemetry;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Stream, StreamConfig,
};
use libretracks_core::Song;
use rtrb::RingBuffer;
use serde::Serialize;
use tauri::AppHandle;

use crate::error::DesktopError;
use crate::settings::AppSettings;

#[cfg(test)]
use self::backend::drain_consumer_samples;
use self::backend::{
    build_output_stream, spawn_disk_reader, DiskReaderReport, DiskReaderState, OutputSample,
};
#[cfg(test)]
use self::mixer::{
    apply_runtime_pan, build_live_mix_map, build_playback_plans, interpolated_gain,
    resolve_track_runtime_pan, PlaybackClipPlan,
};
use self::mixer::{replace_shared_live_mix, update_shared_track_mix, LiveTrackMix, Mixer};
#[cfg(test)]
use self::source::{prepare_audio_source, probe_audio_file, MemoryClipReader, SharedAudioSource};
use self::source::{AudioBufferCache, AudioBufferCacheStats};
pub use self::telemetry::AudioDebugSnapshot;
#[cfg(test)]
use self::telemetry::{command_kind_label, env_flag};
use self::telemetry::{
    playback_reason_label, AudioDebugConfig, AudioDebugState, RestartReport, StopReport, SyncReport,
};

const PCM_RING_CAPACITY_FRAMES: usize = 4_096;
const DISK_RENDER_BLOCK_FRAMES: usize = 512;
const GAIN_EPSILON: f32 = 0.000_001;
const AUDIO_METER_EVENT: &str = "audio:meters";
const AUDIO_METER_EMIT_INTERVAL: Duration = Duration::from_millis(16);
const AUDIO_COMMAND_RESPONSE_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_HIERARCHY_DEPTH: usize = 16;

type SharedAppHandle = Arc<RwLock<Option<AppHandle>>>;
type SharedTrackMixState = Arc<RwLock<HashMap<String, LiveTrackMix>>>;
type SharedAudioSettings = Arc<RwLock<AppSettings>>;

pub struct AudioRuntime {
    session: Option<PlaybackSession>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
    audio_thread_handle: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevicesResponse {
    pub devices: Vec<String>,
    pub default_device: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterLevel {
    pub track_id: String,
    pub left_peak: f32,
    pub right_peak: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStartReason {
    InitialPlay,
    ResumePlay,
    Seek,
    ImmediateJump,
    TimelineWindow,
    StructureRebuild,
    TransportResync,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioCommandKind {
    Play,
    Seek,
    SyncSong,
    Stop,
    DebugSnapshot,
    Shutdown,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        respond_to: Sender<Result<(), String>>,
    },
    Seek {
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        respond_to: Sender<Result<(), String>>,
    },
    SyncSong {
        song: Song,
        respond_to: Sender<Result<(), String>>,
    },
    Stop {
        respond_to: Sender<Result<(), String>>,
    },
    DebugSnapshot {
        respond_to: Sender<AudioDebugSnapshot>,
    },
    Shutdown,
}

struct PlaybackSession {
    backend: PlaybackBackend,
    reader_sender: Option<Sender<ReaderCommand>>,
    reader_handle: Option<JoinHandle<DiskReaderReport>>,
    seek_generation: Arc<AtomicU64>,
    audio_buffers: AudioBufferCache,
}

enum PlaybackBackend {
    Cpal { _stream: Stream },
    Null,
}

enum ReaderCommand {
    UpdateSong(Song),
    Seek {
        song: Song,
        position_seconds: f64,
        generation: u64,
    },
    Stop,
}

impl AudioRuntime {
    fn new(
        audio_buffers: AudioBufferCache,
        app_handle: SharedAppHandle,
        live_mix_state: SharedTrackMixState,
        audio_settings: SharedAudioSettings,
    ) -> Self {
        Self {
            session: None,
            audio_buffers,
            app_handle,
            live_mix_state,
            audio_settings,
        }
    }

    fn stop_all(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = usize::from(self.session.is_some());

        if let Some(session) = self.session.take() {
            let _ = session.stop();
        }

        StopReport {
            elapsed: started_at.elapsed(),
            stopped_sinks,
        }
    }

    fn restart(
        &mut self,
        song_dir: &Path,
        song: &Song,
        position_seconds: f64,
        debug_config: AudioDebugConfig,
    ) -> Result<RestartReport, String> {
        let started_at = Instant::now();
        self.stop_all();

        let scheduled_clips = scheduled_clip_count(song, position_seconds);
        let session = PlaybackSession::start(
            song_dir.to_path_buf(),
            song.clone(),
            position_seconds,
            self.app_handle.clone(),
            self.live_mix_state.clone(),
            self.audio_settings.clone(),
            debug_config,
            self.audio_buffers.clone(),
        )?;
        let cache_stats = session.cache_stats();

        self.session = Some(session);

        Ok(RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips,
            active_sinks: 1,
            opened_files: 0,
            cache_stats,
        })
    }

    fn sync_song(&mut self, song: &Song) -> Result<SyncReport, String> {
        let started_at = Instant::now();
        let updated_sinks = match self.session.as_mut() {
            Some(session) => usize::from(session.update_song(song.clone())?),
            None => 0,
        };

        Ok(SyncReport {
            elapsed: started_at.elapsed(),
            updated_sinks,
            active_sinks: usize::from(self.session.is_some()),
        })
    }

    fn seek(&mut self, song: &Song, position_seconds: f64) -> Result<usize, String> {
        let updated_sinks = match self.session.as_mut() {
            Some(session) => usize::from(session.seek(song.clone(), position_seconds)?),
            None => 0,
        };
        Ok(updated_sinks)
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let debug_config = AudioDebugConfig::from_env();
        let audio_buffers = AudioBufferCache::default();
        let app_handle = Arc::new(RwLock::new(None));
        let live_mix_state = Arc::new(RwLock::new(HashMap::new()));
        let audio_settings = Arc::new(RwLock::new(AppSettings::default()));
        let runtime_audio_buffers = audio_buffers.clone();
        let runtime_app_handle = app_handle.clone();
        let runtime_live_mix_state = live_mix_state.clone();
        let runtime_audio_settings = audio_settings.clone();

        let audio_thread_handle = thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || {
                run_audio_thread(
                    receiver,
                    debug_config,
                    runtime_audio_buffers,
                    runtime_app_handle,
                    runtime_live_mix_state,
                    runtime_audio_settings,
                )
            })
            .expect("audio thread should start");

        Self {
            sender,
            audio_buffers,
            app_handle,
            live_mix_state,
            audio_settings,
            audio_thread_handle: Some(audio_thread_handle),
        }
    }

    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut shared_app_handle) = self.app_handle.write() {
            *shared_app_handle = Some(app_handle);
        }
    }

    pub fn play(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::Play {
            song_dir,
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    pub fn seek(
        &self,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::Seek {
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    #[allow(dead_code)]
    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::SyncSong { song, respond_to })
    }

    pub fn sync_live_mix(&self, song: &Song) -> Result<(), DesktopError> {
        replace_shared_live_mix(&self.live_mix_state, song).map_err(DesktopError::AudioCommand)
    }

    pub fn ensure_live_track(&self, song: &Song, track_id: &str) -> Result<(), DesktopError> {
        let has_track = self
            .live_mix_state
            .read()
            .map_err(|_| DesktopError::AudioCommand("live mix state lock poisoned".into()))?
            .contains_key(track_id);
        if !has_track {
            self.sync_live_mix(song)?;
        }
        Ok(())
    }

    pub fn update_live_track_mix(
        &self,
        track_id: &str,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
    ) -> Result<(), DesktopError> {
        update_shared_track_mix(&self.live_mix_state, track_id, volume, pan, muted, solo)
            .map_err(DesktopError::AudioCommand)
    }

    pub fn current_settings(&self) -> Result<AppSettings, DesktopError> {
        self.audio_settings
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| DesktopError::AudioCommand("audio settings lock poisoned".into()))
    }

    pub fn apply_settings(&self, settings: AppSettings) -> Result<(), DesktopError> {
        let mut current_settings = self
            .audio_settings
            .write()
            .map_err(|_| DesktopError::AudioCommand("audio settings lock poisoned".into()))?;
        *current_settings = settings;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(AudioCommand::DebugSnapshot { respond_to })
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response)
    }

    pub fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), DesktopError> {
        self.audio_buffers
            .replace_song_buffers(song_dir, song)
            .map_err(DesktopError::AudioCommand)
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response)?.map_err(DesktopError::AudioCommand)
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let _ = self.sender.send(AudioCommand::Shutdown);
        if let Some(audio_thread_handle) = self.audio_thread_handle.take() {
            let _ = audio_thread_handle.join();
        }
    }
}

impl PlaybackSession {
    fn start(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        app_handle: SharedAppHandle,
        live_mix_state: SharedTrackMixState,
        audio_settings: SharedAudioSettings,
        debug_config: AudioDebugConfig,
        audio_buffers: AudioBufferCache,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let selected_device_name = audio_settings
            .read()
            .ok()
            .and_then(|settings| settings.selected_output_device.clone())
            .and_then(|device_name| {
                let trimmed = device_name.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        let Some(device) = resolve_output_device(&host, selected_device_name.as_deref()) else {
            eprintln!("[libretracks-audio] no default output device available, using null backend");
            return Ok(Self {
                backend: PlaybackBackend::Null,
                reader_sender: None,
                reader_handle: None,
                seek_generation: Arc::new(AtomicU64::new(0)),
                audio_buffers,
            });
        };

        let supported_config = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();
        let output_channels = usize::from(config.channels.max(1));
        let output_sample_rate = config.sample_rate.0.max(1);
        let ring_capacity_samples = PCM_RING_CAPACITY_FRAMES.saturating_mul(output_channels.max(1));
        let (producer, consumer) = RingBuffer::<OutputSample>::new(ring_capacity_samples);
        let (reader_sender, reader_receiver) = mpsc::channel();
        let seek_generation = Arc::new(AtomicU64::new(0));

        let reader_handle = spawn_disk_reader(DiskReaderState {
            mixer: Mixer::new(
                song_dir.clone(),
                song.clone(),
                position_seconds,
                output_sample_rate,
                output_channels,
                app_handle,
                live_mix_state,
                audio_settings,
                debug_config,
                audio_buffers.clone(),
            ),
            producer,
            command_receiver: reader_receiver,
            current_generation: 0,
        });

        let stream = build_output_stream(
            &device,
            &config,
            sample_format,
            consumer,
            seek_generation.clone(),
        )?;
        stream.play().map_err(|error| error.to_string())?;

        Ok(Self {
            backend: PlaybackBackend::Cpal { _stream: stream },
            reader_sender: Some(reader_sender),
            reader_handle: Some(reader_handle),
            seek_generation,
            audio_buffers,
        })
    }

    fn cache_stats(&self) -> AudioBufferCacheStats {
        self.audio_buffers.stats()
    }

    fn update_song(&mut self, song: Song) -> Result<bool, String> {
        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::UpdateSong(song))
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(false)
    }

    fn seek(&mut self, song: Song, position_seconds: f64) -> Result<bool, String> {
        let generation = self
            .seek_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);

        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::Seek {
                    song,
                    position_seconds,
                    generation,
                })
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(matches!(self.backend, PlaybackBackend::Null))
    }

    fn stop(mut self) -> DiskReaderReport {
        if let Some(reader_sender) = self.reader_sender.take() {
            let _ = reader_sender.send(ReaderCommand::Stop);
        }

        self.reader_handle
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
    }
}

fn run_audio_thread(
    receiver: Receiver<AudioCommand>,
    debug_config: AudioDebugConfig,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
) {
    let mut runtime: Option<AudioRuntime> = None;
    let mut debug_state = AudioDebugState::new(debug_config);
    let mut deferred_command: Option<AudioCommand> = None;

    while let Some(command) = next_audio_command(&receiver, &mut deferred_command) {
        match command {
            AudioCommand::Play {
                song_dir,
                song,
                position_seconds,
                reason,
                respond_to,
            } => {
                debug_state.record_command(
                    AudioCommandKind::Play,
                    Some(playback_reason_label(reason).to_string()),
                );

                let result =
                    ensure_runtime(
                        &mut runtime,
                        &audio_buffers,
                        &app_handle,
                        &live_mix_state,
                        &audio_settings,
                    )
                        .restart(&song_dir, &song, position_seconds, debug_config)
                        .map(|report| {
                            debug_state.record_restart(
                                reason,
                                position_seconds,
                                song.duration_seconds,
                                &report,
                            );
                        });

                let _ = respond_to.send(result);
            }
            AudioCommand::Seek {
                song,
                position_seconds,
                reason,
                respond_to,
            } => {
                debug_state.record_command(
                    AudioCommandKind::Seek,
                    Some(playback_reason_label(reason).to_string()),
                );

                let result =
                    ensure_runtime(
                        &mut runtime,
                        &audio_buffers,
                        &app_handle,
                        &live_mix_state,
                        &audio_settings,
                    )
                        .seek(&song, position_seconds)
                        .map(|active_sinks| {
                            debug_state.record_seek(
                                reason,
                                position_seconds,
                                song.duration_seconds,
                                active_sinks.max(1),
                            );
                        });

                let _ = respond_to.send(result);
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let result =
                    ensure_runtime(
                        &mut runtime,
                        &audio_buffers,
                        &app_handle,
                        &live_mix_state,
                        &audio_settings,
                    )
                        .sync_song(&song)
                        .map(|report| {
                            debug_state.record_sync(&report);
                        });

                for respond_to in respond_tos {
                    let _ = respond_to.send(result.clone());
                }
            }
            AudioCommand::Stop { respond_to } => {
                debug_state.record_command(AudioCommandKind::Stop, None);

                let report = if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all()
                } else {
                    StopReport {
                        elapsed: Duration::ZERO,
                        stopped_sinks: 0,
                    }
                };

                debug_state.record_stop(&report, 0);

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::DebugSnapshot { respond_to } => {
                debug_state.record_command(AudioCommandKind::DebugSnapshot, None);
                let _ = respond_to.send(debug_state.snapshot());
            }
            AudioCommand::Shutdown => {
                debug_state.record_command(AudioCommandKind::Shutdown, None);
                if let Some(mut active_runtime) = runtime.take() {
                    active_runtime.stop_all();
                }
                break;
            }
        }
    }
}

fn ensure_runtime<'a>(
    runtime: &'a mut Option<AudioRuntime>,
    audio_buffers: &AudioBufferCache,
    app_handle: &SharedAppHandle,
    live_mix_state: &SharedTrackMixState,
    audio_settings: &SharedAudioSettings,
) -> &'a mut AudioRuntime {
    runtime.get_or_insert_with(|| {
        AudioRuntime::new(
            audio_buffers.clone(),
            app_handle.clone(),
            live_mix_state.clone(),
            audio_settings.clone(),
        )
    })
}

#[tauri::command]
pub fn get_audio_output_devices() -> Result<AudioOutputDevicesResponse, String> {
    let host = cpal::default_host();
    let default_device = host.default_output_device().and_then(|device| device.name().ok());
    let mut devices = host
        .output_devices()
        .map_err(|error| error.to_string())?
        .filter_map(|device| device.name().ok())
        .collect::<Vec<_>>();

    devices.sort();
    devices.dedup();

    Ok(AudioOutputDevicesResponse {
        devices,
        default_device,
    })
}

fn resolve_output_device(host: &cpal::Host, selected_device_name: Option<&str>) -> Option<Device> {
    if std::env::var("LIBRETRACKS_DUMMY_AUDIO")
        .ok()
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
    {
        return None;
    }

    if let Some(selected_device_name) = selected_device_name {
        let normalized_name = selected_device_name.trim();
        if !normalized_name.is_empty() {
            if let Ok(devices) = host.output_devices() {
                for device in devices {
                    let Ok(device_name) = device.name() else {
                        continue;
                    };
                    if device_name == normalized_name {
                        return Some(device);
                    }
                }
            }
        }
    }

    host.default_output_device()
}

fn next_audio_command(
    receiver: &Receiver<AudioCommand>,
    deferred_command: &mut Option<AudioCommand>,
) -> Option<AudioCommand> {
    match deferred_command.take() {
        Some(command) => Some(command),
        None => receiver.recv().ok(),
    }
}

fn coalesce_sync_song_commands(
    receiver: &Receiver<AudioCommand>,
    mut latest_song: Song,
    initial_respond_to: Sender<Result<(), String>>,
) -> (Song, Vec<Sender<Result<(), String>>>, Option<AudioCommand>) {
    let mut respond_tos = vec![initial_respond_to];
    let mut deferred_command = None;

    while let Ok(command) = receiver.try_recv() {
        match command {
            AudioCommand::SyncSong { song, respond_to } => {
                latest_song = song;
                respond_tos.push(respond_to);
            }
            other => {
                deferred_command = Some(other);
                break;
            }
        }
    }

    (latest_song, respond_tos, deferred_command)
}

fn recv_audio_response<T>(response: Receiver<T>) -> Result<T, DesktopError> {
    response
        .recv_timeout(AUDIO_COMMAND_RESPONSE_TIMEOUT)
        .map_err(map_audio_response_error)
}

fn map_audio_response_error(error: RecvTimeoutError) -> DesktopError {
    match error {
        RecvTimeoutError::Timeout => DesktopError::AudioCommand(format!(
            "audio thread did not respond within {} ms",
            AUDIO_COMMAND_RESPONSE_TIMEOUT.as_millis()
        )),
        RecvTimeoutError::Disconnected => DesktopError::AudioThreadUnavailable,
    }
}

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

fn seconds_to_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * sample_rate.max(1) as f64).round() as u64
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, RwLock,
        },
        thread,
        time::{Duration, Instant},
    };

    use libretracks_core::{Clip, OutputBus, Song, SongRegion, Track};
    use rtrb::RingBuffer;
    use tempfile::tempdir;

    use crate::settings::AppSettings;

    use super::{
        apply_runtime_pan, build_live_mix_map, build_playback_plans, coalesce_sync_song_commands,
        drain_consumer_samples, env_flag, interpolated_gain, playback_reason_label,
        prepare_audio_source, probe_audio_file, resolve_track_runtime_pan, scheduled_clip_count,
        update_shared_track_mix, AudioBufferCache, AudioBufferCacheStats, AudioCommand,
        AudioCommandKind, AudioDebugConfig, AudioDebugSnapshot, AudioDebugState, AudioMeterLevel,
        MemoryClipReader, Mixer, OutputSample, PlaybackBackend, PlaybackClipPlan, PlaybackSession,
        PlaybackStartReason, RestartReport, SharedAudioSource, StopReport, SyncReport,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tempo_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Audio Runtime".into(),
                start_seconds: 0.0,
                end_seconds: 20.0,
            }],
            tracks: vec![
                Track {
                    id: "folder_main".into(),
                    name: "Main".into(),
                    kind: libretracks_core::TrackKind::Folder,
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
                    kind: libretracks_core::TrackKind::Audio,
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
                    id: "clip_intro".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/intro.wav".into(),
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
                Clip {
                    id: "clip_late".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/late.wav".into(),
                    timeline_start_seconds: 10.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
            ],
            section_markers: vec![],
        }
    }

    fn write_silent_test_wav(path: &std::path::Path) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        for _ in 0..44_100 {
            writer.write_sample(0_i16).expect("sample should write");
            writer.write_sample(0_i16).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");
    }

    fn write_counting_test_wav(path: &std::path::Path, sample_rate: u32, frame_count: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        for frame_index in 0..frame_count {
            let normalized = ((frame_index % 200) as f32 / 100.0) - 1.0;
            let sample = (normalized * i16::MAX as f32 * 0.5) as i16;
            writer.write_sample(sample).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");
    }

    fn write_extensible_float_test_wav(path: &std::path::Path) {
        let channels = 1u16;
        let sample_rate = 48_000u32;
        let bits_per_sample = 32u16;
        let bytes_per_sample = usize::from(bits_per_sample / 8);
        let samples = [0.25_f32, -0.5_f32];

        let mut data_bytes = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            data_bytes.extend_from_slice(&sample.to_le_bytes());
        }

        let fmt_chunk_len = 40u32;
        let data_chunk_len = data_bytes.len() as u32;
        let riff_chunk_len = 4 + (8 + fmt_chunk_len) + (8 + data_chunk_len);
        let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample / 8);
        let block_align = channels * (bits_per_sample / 8);

        let mut wav_bytes = Vec::with_capacity((riff_chunk_len + 8) as usize);
        wav_bytes.extend_from_slice(b"RIFF");
        wav_bytes.extend_from_slice(&riff_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(b"WAVE");

        wav_bytes.extend_from_slice(b"fmt ");
        wav_bytes.extend_from_slice(&fmt_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(&0xFFFEu16.to_le_bytes());
        wav_bytes.extend_from_slice(&channels.to_le_bytes());
        wav_bytes.extend_from_slice(&sample_rate.to_le_bytes());
        wav_bytes.extend_from_slice(&byte_rate.to_le_bytes());
        wav_bytes.extend_from_slice(&block_align.to_le_bytes());
        wav_bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav_bytes.extend_from_slice(&22u16.to_le_bytes());
        wav_bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav_bytes.extend_from_slice(&0u32.to_le_bytes());
        wav_bytes.extend_from_slice(&[
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38,
            0x9B, 0x71,
        ]);

        wav_bytes.extend_from_slice(b"data");
        wav_bytes.extend_from_slice(&data_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(&data_bytes);

        fs::write(path, wav_bytes).expect("wav should be created");
    }

    fn cache_with_shared_buffer(
        path: &Path,
        samples: Vec<f32>,
        sample_rate: u32,
        channels: usize,
    ) -> AudioBufferCache {
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            path.to_path_buf(),
            SharedAudioSource::from_preloaded(samples, sample_rate, channels, true),
        );
        cache
    }

    fn shared_mix_state(
        song: &Song,
    ) -> Arc<RwLock<std::collections::HashMap<String, super::LiveTrackMix>>> {
        Arc::new(RwLock::new(build_live_mix_map(song)))
    }

    #[test]
    fn playback_reason_labels_match_command_telemetry() {
        assert_eq!(playback_reason_label(PlaybackStartReason::Seek), "seek");
        assert_eq!(
            playback_reason_label(PlaybackStartReason::StructureRebuild),
            "structure_rebuild"
        );
        assert_eq!(super::command_kind_label(AudioCommandKind::Seek), "seek");
        assert_eq!(super::command_kind_label(AudioCommandKind::Stop), "stop");
    }

    #[test]
    fn debug_state_tracks_restart_sync_and_stop() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_command(
            AudioCommandKind::Play,
            Some(playback_reason_label(PlaybackStartReason::InitialPlay).to_string()),
        );
        debug_state.record_restart(
            PlaybackStartReason::InitialPlay,
            1.25,
            20.0,
            &RestartReport {
                elapsed: Duration::from_millis(12),
                scheduled_clips: 3,
                active_sinks: 1,
                opened_files: 0,
                cache_stats: AudioBufferCacheStats {
                    cached_buffers: 1,
                    fully_cached_buffers: 1,
                    preload_bytes: 16,
                },
            },
        );
        debug_state.record_sync(&SyncReport {
            elapsed: Duration::from_millis(2),
            updated_sinks: 1,
            active_sinks: 1,
        });
        debug_state.record_stop(
            &StopReport {
                elapsed: Duration::from_millis(1),
                stopped_sinks: 1,
            },
            0,
        );

        let snapshot = debug_state.snapshot();
        assert!(snapshot.enabled);
        assert_eq!(snapshot.command_count, 1);
        assert_eq!(
            snapshot
                .last_restart
                .expect("restart summary should exist")
                .scheduled_clips,
            3
        );
        assert_eq!(
            snapshot.playhead.last_start_reason.as_deref(),
            Some("initial_play")
        );
        assert_eq!(snapshot.runtime_state.active_sinks, 0);
        assert_eq!(snapshot.runtime_state.cached_audio_buffers, 1);
        assert_eq!(snapshot.runtime_state.fully_cached_audio_buffers, 1);
        assert_eq!(snapshot.runtime_state.cached_audio_preload_bytes, 16);
        assert_eq!(
            snapshot
                .last_stop
                .expect("stop summary should exist")
                .stopped_sinks,
            1
        );
        assert!(!snapshot.playhead.running);
        assert!(
            snapshot
                .playhead
                .estimated_position_seconds
                .unwrap_or_default()
                >= 1.25
        );
    }

    #[test]
    fn debug_state_estimates_playhead_while_running_and_freezes_after_stop() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_restart(
            PlaybackStartReason::Seek,
            2.0,
            10.0,
            &RestartReport {
                elapsed: Duration::from_millis(4),
                scheduled_clips: 2,
                active_sinks: 1,
                opened_files: 0,
                cache_stats: AudioBufferCacheStats {
                    cached_buffers: 1,
                    fully_cached_buffers: 0,
                    preload_bytes: 8,
                },
            },
        );

        thread::sleep(Duration::from_millis(20));
        let running_snapshot = debug_state.snapshot();
        let running_position = running_snapshot
            .playhead
            .estimated_position_seconds
            .expect("running playhead should exist");

        assert!(running_snapshot.playhead.running);
        assert!(running_snapshot.playhead.anchor_age_ms.unwrap_or_default() >= 10.0);
        assert!(running_position > 2.0);
        assert_eq!(
            running_snapshot.playhead.last_start_reason.as_deref(),
            Some("seek")
        );

        debug_state.record_stop(
            &StopReport {
                elapsed: Duration::from_millis(1),
                stopped_sinks: 1,
            },
            0,
        );

        let stopped_snapshot = debug_state.snapshot();
        let stopped_position = stopped_snapshot
            .playhead
            .estimated_position_seconds
            .expect("stopped playhead should remain visible");

        thread::sleep(Duration::from_millis(20));
        let frozen_snapshot = debug_state.snapshot();
        let frozen_position = frozen_snapshot
            .playhead
            .estimated_position_seconds
            .expect("frozen playhead should remain visible");

        assert!(!stopped_snapshot.playhead.running);
        assert!(stopped_snapshot.playhead.anchor_age_ms.is_none());
        assert!((frozen_position - stopped_position).abs() < 0.001);
    }

    #[test]
    fn debug_state_does_not_clamp_playhead_to_song_duration() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_seek(PlaybackStartReason::Seek, 12.0, 8.0, 0);

        let snapshot = debug_state.snapshot();

        assert_eq!(snapshot.playhead.anchor_position_seconds, Some(12.0));
        assert!(snapshot
            .playhead
            .estimated_position_seconds
            .unwrap_or_default()
            >= 12.0);
        assert_eq!(snapshot.playhead.song_duration_seconds, Some(8.0));
    }

    #[test]
    fn env_flag_accepts_common_truthy_values() {
        let key = "LIBRETRACKS_AUDIO_ENV_FLAG_TEST";
        std::env::set_var(key, "YES");
        assert!(env_flag(key));
        std::env::remove_var(key);
    }

    #[test]
    fn coalesces_consecutive_mix_sync_commands() {
        let (sender, receiver) = mpsc::channel();
        let (respond_to_1, _) = mpsc::channel();
        let (respond_to_2, _) = mpsc::channel();
        let (respond_to_3, _) = mpsc::channel::<AudioDebugSnapshot>();

        let song_a = demo_song();
        let mut song_b = demo_song();
        song_b.tracks[0].volume = 0.2;

        sender
            .send(AudioCommand::SyncSong {
                song: song_b.clone(),
                respond_to: respond_to_2,
            })
            .expect("second sync command should queue");
        sender
            .send(AudioCommand::DebugSnapshot {
                respond_to: respond_to_3,
            })
            .expect("debug command should queue");

        let (latest_song, respond_tos, deferred_command) =
            coalesce_sync_song_commands(&receiver, song_a, respond_to_1);

        assert_eq!(latest_song.tracks[0].volume, 0.2);
        assert_eq!(respond_tos.len(), 2);
        assert!(matches!(
            deferred_command,
            Some(AudioCommand::DebugSnapshot { .. })
        ));
    }

    #[test]
    fn scheduled_clip_count_ignores_finished_regions() {
        assert_eq!(scheduled_clip_count(&demo_song(), 1.0), 2);
        assert_eq!(scheduled_clip_count(&demo_song(), 6.0), 1);
        assert_eq!(scheduled_clip_count(&demo_song(), 16.0), 0);
    }

    #[test]
    fn playback_plans_use_absolute_song_timeline_frames() {
        let plans = build_playback_plans(Path::new("song"), &demo_song(), 48_000);

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].clip_id, "clip_intro");
        assert_eq!(plans[0].timeline_start_frame, 0);
        assert_eq!(plans[0].duration_frames, 48_000 * 5);
        assert!((plans[0].source_start_seconds - 0.0).abs() < 0.000_001);

        assert_eq!(plans[1].clip_id, "clip_late");
        assert_eq!(plans[1].timeline_start_frame, 48_000 * 10);
    }

    #[test]
    fn interpolated_gain_reaches_target_on_last_sample() {
        assert!((interpolated_gain(0.2, 1.0, 0, 4) - 0.2).abs() < 0.000_001);
        assert!((interpolated_gain(0.2, 1.0, 1, 4) - 0.466_666_67).abs() < 0.000_1);
        assert!((interpolated_gain(0.2, 1.0, 3, 4) - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn interpolated_gain_handles_empty_and_single_frame_blocks() {
        assert!((interpolated_gain(0.2, 1.0, 0, 0) - 0.2).abs() < 0.000_001);
        assert!((interpolated_gain(0.2, 1.0, 0, 1) - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn playback_plan_edge_gain_applies_fades_in_sample_domain() {
        let plan = PlaybackClipPlan {
            clip_id: "clip".into(),
            track_id: "track".into(),
            file_path: PathBuf::from("audio/test.wav"),
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: 100,
            fade_in_frames: 20,
            fade_out_frames: 20,
            source_start_seconds: 0.0,
        };

        assert!((plan.edge_gain(0) - 0.0).abs() < 0.000_001);
        assert!(plan.edge_gain(10) > 0.45 && plan.edge_gain(10) < 0.55);
        assert!((plan.edge_gain(50) - 1.0).abs() < 0.000_001);
        assert!(plan.edge_gain(90) > 0.45 && plan.edge_gain(90) < 0.55);
    }

    #[test]
    fn memory_clip_reader_reads_pcm_from_shared_buffer() {
        let clip_path = PathBuf::from("audio/shared-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.25, -0.25, 0.5, -0.5], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 2,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 4];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 2, 2, 1.0, 0.0);

        assert_eq!(mixed, [0.25, -0.25, 0.5, -0.5]);
        assert!(reader.eof);
        assert_eq!(reader.current_frame(), 2);
    }

    #[test]
    fn memory_clip_reader_applies_true_stereo_pan_folding() {
        let clip_path = PathBuf::from("audio/pan-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.3, 0.7], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 2];
        let (left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 2, 1.0, -0.5);

        assert_eq!(mixed, [0.65, 0.35]);
        assert!((left_peak - 0.65).abs() < 0.000_001);
        assert!((right_peak - 0.35).abs() < 0.000_001);
    }

    #[test]
    fn runtime_pan_folds_stereo_and_balances_mono() {
        let (hard_left_l, hard_left_r) = apply_runtime_pan(0.25, 0.75, -1.0, 2);
        let (center_l, center_r) = apply_runtime_pan(0.25, 0.75, 0.0, 2);
        let (hard_right_l, hard_right_r) = apply_runtime_pan(0.25, 0.75, 1.0, 2);
        let (mono_left, mono_right) = apply_runtime_pan(0.5, 0.5, 0.4, 1);

        assert!((hard_left_l - 1.0).abs() < 0.000_001);
        assert!(hard_left_r.abs() < 0.000_001);
        assert!((center_l - 0.25).abs() < 0.000_001);
        assert!((center_r - 0.75).abs() < 0.000_001);
        assert!(hard_right_l.abs() < 0.000_001);
        assert!((hard_right_r - 1.0).abs() < 0.000_001);
        assert!((mono_left - 0.3).abs() < 0.000_001);
        assert!((mono_right - 0.5).abs() < 0.000_001);
    }

    #[test]
    fn memory_clip_reader_keeps_extra_output_channels_silent() {
        let clip_path = PathBuf::from("audio/multichannel-pan-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.25, 0.75], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 4];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 4, 1.0, -1.0);

        assert_eq!(mixed, [1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn resolve_track_runtime_pan_accumulates_folder_pan_and_clamps() {
        let mut song = demo_song();
        song.tracks[0].pan = -0.35;
        song.tracks[1].pan = -0.8;

        let pan = resolve_track_runtime_pan(&build_live_mix_map(&song), "track_drums");

        assert!((pan + 1.0).abs() < 0.000_001);
    }

    #[test]
    fn resolve_track_runtime_pan_rejects_circular_folder_hierarchies() {
        let song = Song {
            id: "cycle_song".into(),
            title: "Cycle".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 1.0,
            tempo_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Cycle".into(),
                start_seconds: 0.0,
                end_seconds: 1.0,
            }],
            tracks: vec![
                Track {
                    id: "folder_a".into(),
                    name: "Folder A".into(),
                    kind: libretracks_core::TrackKind::Folder,
                    parent_track_id: Some("folder_b".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "folder_b".into(),
                    name: "Folder B".into(),
                    kind: libretracks_core::TrackKind::Folder,
                    parent_track_id: Some("folder_a".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_cycle".into(),
                    name: "Track".into(),
                    kind: libretracks_core::TrackKind::Audio,
                    parent_track_id: Some("folder_a".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![],
            section_markers: vec![],
        };

        let pan = resolve_track_runtime_pan(&build_live_mix_map(&song), "track_cycle");

        assert_eq!(pan, 0.0);
    }

    #[test]
    fn mixer_rolls_child_meter_peaks_up_to_folder_tracks() {
        let song = demo_song();
        let mixer = Mixer::new(
            PathBuf::from("song"),
            song.clone(),
            0.0,
            48_000,
            2,
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            AudioBufferCache::default(),
        );
        let mut track_meters = vec![
            AudioMeterLevel {
                track_id: "folder_main".into(),
                left_peak: 0.0,
                right_peak: 0.0,
            },
            AudioMeterLevel {
                track_id: "track_drums".into(),
                left_peak: 0.5,
                right_peak: 0.25,
            },
        ];

        mixer.roll_up_folder_track_meters(&mut track_meters);

        assert!((track_meters[0].left_peak - 0.35).abs() < 0.000_001);
        assert!((track_meters[0].right_peak - 0.175).abs() < 0.000_001);
    }

    #[test]
    fn mixer_render_stays_responsive_during_live_mix_updates() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 10], 48_000, 2, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 10], 48_000, 2, true),
        );

        let live_mix_state = shared_mix_state(&song);
        let render_iterations = Arc::new(AtomicU64::new(0));
        let update_iterations = Arc::new(AtomicU64::new(0));
        let should_stop = Arc::new(AtomicBool::new(false));

        let render_handle = {
            let live_mix_state = live_mix_state.clone();
            let render_iterations = render_iterations.clone();
            let should_stop = should_stop.clone();
            let cache = cache.clone();
            let song = song.clone();
            let song_dir = song_dir.clone();

            thread::spawn(move || {
                let mut mixer = Mixer::new(
                    song_dir,
                    song,
                    0.0,
                    48_000,
                    2,
                    Arc::new(RwLock::new(None)),
                    live_mix_state,
                    Arc::new(RwLock::new(AppSettings::default())),
                    AudioDebugConfig {
                        enabled: false,
                        log_commands: false,
                    },
                    cache,
                );
                let started_at = Instant::now();

                while started_at.elapsed() < Duration::from_millis(150) {
                    let _ = mixer.render_next_block(64);
                    render_iterations.fetch_add(1, Ordering::Relaxed);
                }

                should_stop.store(true, Ordering::Release);
            })
        };

        let update_handle = {
            let live_mix_state = live_mix_state.clone();
            let update_iterations = update_iterations.clone();
            let should_stop = should_stop.clone();

            thread::spawn(move || {
                let mut volume = 0.0_f64;
                let mut solo = false;
                let started_at = Instant::now();

                while !should_stop.load(Ordering::Acquire)
                    && started_at.elapsed() < Duration::from_millis(300)
                {
                    update_shared_track_mix(
                        &live_mix_state,
                        "track_drums",
                        Some(volume),
                        Some(volume * 2.0 - 1.0),
                        Some(false),
                        Some(solo),
                    )
                    .expect("track mix update should succeed");
                    update_iterations.fetch_add(1, Ordering::Relaxed);
                    volume = (volume + 0.07).fract();
                    solo = !solo;
                    thread::sleep(Duration::from_millis(1));
                }
            })
        };

        render_handle
            .join()
            .expect("render thread should not panic");
        should_stop.store(true, Ordering::Release);
        update_handle
            .join()
            .expect("update thread should not panic");

        assert!(render_iterations.load(Ordering::Relaxed) > 10);
        assert!(update_iterations.load(Ordering::Relaxed) > 10);
    }

    #[test]
    fn memory_clip_reader_seek_to_jumps_directly_to_target_frame() {
        let clip_path = PathBuf::from("audio/seek-buffer.wav");
        let cache =
            cache_with_shared_buffer(&clip_path, vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 3,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(1);
        let mut mixed = [0.0_f32; 2];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 2, 1.0, 0.0);

        assert_eq!(mixed, [0.3, 0.4]);
        assert_eq!(reader.current_frame(), 2);
        assert!(!reader.eof);
    }

    #[test]
    fn memory_clip_reader_honors_source_start_offset_when_opening() {
        let clip_path = PathBuf::from("audio/offset-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.1, 0.2, 0.3, 0.4], 4, 1);
        let reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.5,
            },
            4,
            &cache,
            0,
        )
        .expect("memory reader should open");

        assert_eq!(reader.current_frame(), 2);
        assert!(!reader.eof);
    }

    #[test]
    fn prepared_audio_source_maps_entire_pcm_payload_for_long_files() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("long.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 4);

        let source = prepare_audio_source(&audio_path).expect("audio source should prepare");

        assert_eq!(source.sample_rate(), 8_000);
        assert_eq!(source.channels(), 1);
        assert_eq!(source.preload_frame_count(), 8_000 * 4);
        assert!(source.is_fully_cached());
        assert!(source.has_mapped_audio());
    }

    #[test]
    fn prepared_audio_source_accepts_wave_format_extensible_float32() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("extensible-float.wav");
        write_extensible_float_test_wav(&audio_path);

        let source = prepare_audio_source(&audio_path).expect("audio source should prepare");

        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.channels(), 1);
        assert_eq!(source.preload_frame_count(), 2);
        assert!(source.has_mapped_audio());
        assert!((source.read_preloaded_sample_for_test(0, 0, 1) - 0.25).abs() < 0.000_001);
        assert!((source.read_preloaded_sample_for_test(1, 0, 1) + 0.5).abs() < 0.000_001);
    }

    #[test]
    fn memory_clip_reader_reads_past_the_old_preload_boundary() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("streaming.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 3);

        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            audio_path.clone(),
            prepare_audio_source(&audio_path).expect("audio source should prepare"),
        );

        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: audio_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 8_000 * 3,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            8_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(8_000 * 2 + 32);
        let mut mixed = [0.0_f32; 1];
        let (_left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 1, 1.0, 0.0);

        assert!(mixed[0].abs() > 0.01);
        assert!(right_peak.abs() > 0.01);
        assert!(reader.shared_source().has_mapped_audio());
    }

    #[test]
    fn mixer_seek_reuses_absolute_plans_and_activates_overlapping_clip() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 5], 48_000, 1, true),
        );

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        assert_eq!(mixer.plans().len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 0);
        assert_eq!(mixer.active_clips().len(), 1);
        assert_eq!(mixer.active_clips()[0].plan().clip_id, "clip_intro");

        mixer.seek(song, 11.0);

        assert_eq!(mixer.plans().len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 48_000 * 11);
        assert_eq!(mixer.active_clips().len(), 1);
        assert_eq!(mixer.active_clips()[0].plan().clip_id, "clip_late");
        assert_eq!(mixer.active_clips()[0].reader_current_frame(), 48_000);
    }

    #[test]
    fn ring_consumer_writes_silence_when_buffer_runs_empty() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut active_generation = 0;
        producer
            .push(OutputSample {
                generation: 0,
                value: 0.25,
            })
            .expect("sample should push");
        producer
            .push(OutputSample {
                generation: 0,
                value: -0.5,
            })
            .expect("sample should push");

        let mut output = [0.0_f32; 4];
        drain_consumer_samples(
            &mut output,
            &mut consumer,
            &seek_generation,
            &mut active_generation,
            |sample| sample,
        );

        assert_eq!(output, [0.25, -0.5, 0.0, 0.0]);
    }

    #[test]
    fn ring_consumer_flushes_stale_generation_on_seek() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut active_generation = 0;

        producer
            .push(OutputSample {
                generation: 0,
                value: 0.75,
            })
            .expect("stale sample should push");
        seek_generation.store(1, Ordering::Release);
        producer
            .push(OutputSample {
                generation: 1,
                value: 0.5,
            })
            .expect("fresh sample should push");

        let mut output = [0.0_f32; 2];
        drain_consumer_samples(
            &mut output,
            &mut consumer,
            &seek_generation,
            &mut active_generation,
            |sample| sample,
        );

        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(active_generation, 1);
    }

    #[test]
    fn playback_session_seek_increments_generation_for_buffer_flush() {
        let song = demo_song();
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut session = PlaybackSession {
            backend: PlaybackBackend::Null,
            reader_sender: None,
            reader_handle: None,
            seek_generation: seek_generation.clone(),
            audio_buffers: AudioBufferCache::default(),
        };

        let consumed_null_backend = session
            .seek(song, 8.0)
            .expect("seek should succeed on null backend");

        assert!(consumed_null_backend);
        assert_eq!(seek_generation.load(Ordering::Acquire), 1);
    }

    #[test]
    fn wav_pcm_cache_probes_assets() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        probe_audio_file(&audio_path).expect("wav should probe");
    }

    #[test]
    fn wav_pcm_cache_probe_fails_for_missing_file() {
        let missing = PathBuf::from("missing-audio-file.wav");
        assert!(probe_audio_file(&missing).is_err());
    }

    #[test]
    fn silent_wav_fixture_is_created_for_tests() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        let metadata = fs::metadata(audio_path).expect("wav metadata should load");
        assert!(metadata.len() > 0);
    }
}
