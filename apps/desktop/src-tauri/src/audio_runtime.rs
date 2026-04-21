use std::{
    fs::File,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use libretracks_core::{Song, TrackKind};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Serialize;
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::{FormatOptions, FormatReader},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::state::DesktopError;

const PCM_RING_CAPACITY_FRAMES: usize = 16_384;
const DISK_RENDER_BLOCK_FRAMES: usize = 1_024;
const DISK_READER_IDLE_SLEEP: Duration = Duration::from_millis(2);
const SOURCE_BUFFER_COMPACT_THRESHOLD_FRAMES: u64 = 4_096;

pub struct AudioRuntime {
    session: Option<PlaybackSession>,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
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
    SyncSong,
    Stop,
    DebugSnapshot,
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDebugSnapshot {
    pub enabled: bool,
    pub log_commands: bool,
    pub command_count: u64,
    pub last_command: Option<AudioCommandTrace>,
    pub last_restart: Option<AudioOperationSummary>,
    pub last_sync: Option<AudioOperationSummary>,
    pub last_stop: Option<AudioStopSummary>,
    pub runtime_state: AudioRuntimeStateSummary,
    pub playhead: AudioPlayheadEstimate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCommandTrace {
    pub kind: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOperationSummary {
    pub reason: Option<String>,
    pub elapsed_ms: f64,
    pub scheduled_clips: usize,
    pub active_sinks: usize,
    pub opened_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStopSummary {
    pub elapsed_ms: f64,
    pub stopped_sinks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRuntimeStateSummary {
    pub active_sinks: usize,
    pub files_opened_last_restart: usize,
    pub last_scheduled_clips: usize,
    pub cached_audio_buffers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPlayheadEstimate {
    pub running: bool,
    pub anchor_position_seconds: Option<f64>,
    pub estimated_position_seconds: Option<f64>,
    pub song_duration_seconds: Option<f64>,
    pub anchor_age_ms: Option<f64>,
    pub last_start_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct RestartReport {
    elapsed: Duration,
    scheduled_clips: usize,
    active_sinks: usize,
    opened_files: usize,
    cached_buffers: usize,
}

#[derive(Debug, Clone)]
struct SyncReport {
    elapsed: Duration,
    updated_sinks: usize,
    active_sinks: usize,
}

#[derive(Debug, Clone)]
struct StopReport {
    elapsed: Duration,
    stopped_sinks: usize,
}

#[derive(Debug, Clone, Copy)]
struct AudioDebugConfig {
    enabled: bool,
    log_commands: bool,
}

#[derive(Debug, Clone)]
struct AudioDebugState {
    config: AudioDebugConfig,
    command_count: u64,
    last_command: Option<AudioCommandTrace>,
    last_restart: Option<AudioOperationSummary>,
    last_sync: Option<AudioOperationSummary>,
    last_stop: Option<AudioStopSummary>,
    runtime_state: AudioRuntimeStateSummary,
    playback_anchor_position_seconds: Option<f64>,
    playback_anchor_started_at: Option<Instant>,
    playback_song_duration_seconds: Option<f64>,
    last_start_reason: Option<PlaybackStartReason>,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
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
}

enum PlaybackBackend {
    Cpal { _stream: Stream },
    Null,
}

enum ReaderCommand {
    UpdateSong(Song),
    Stop,
}

#[derive(Default)]
struct DiskReaderReport;

#[derive(Debug, Clone)]
struct PlaybackClipPlan {
    clip_id: String,
    track_id: String,
    file_path: PathBuf,
    timeline_start_frame: u64,
    duration_frames: u64,
    source_start_seconds: f64,
}

struct DiskReaderState {
    song: Song,
    output_sample_rate: u32,
    output_channels: usize,
    timeline_cursor_frame: u64,
    remaining_song_frames: u64,
    next_plan_index: usize,
    plans: Vec<PlaybackClipPlan>,
    active_readers: Vec<StreamingClipReader>,
    producer: Producer<f32>,
    command_receiver: Receiver<ReaderCommand>,
    debug_config: AudioDebugConfig,
    opened_files: usize,
}

struct StreamingClipReader {
    plan: PlaybackClipPlan,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    source_sample_rate: u32,
    source_channels: usize,
    output_sample_rate: u32,
    decoded_samples: Vec<f32>,
    decoded_start_frame: u64,
    next_source_frame: f64,
    eof: bool,
}

struct OpenAudioSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: usize,
}

impl PlaybackClipPlan {
    fn timeline_end_frame(&self) -> u64 {
        self.timeline_start_frame
            .saturating_add(self.duration_frames)
    }
}

impl Default for AudioRuntimeStateSummary {
    fn default() -> Self {
        Self {
            active_sinks: 0,
            files_opened_last_restart: 0,
            last_scheduled_clips: 0,
            cached_audio_buffers: 0,
        }
    }
}

impl AudioDebugConfig {
    fn from_env() -> Self {
        Self {
            enabled: env_flag("LIBRETRACKS_AUDIO_DEBUG"),
            log_commands: env_flag("LIBRETRACKS_AUDIO_LOG_COMMANDS"),
        }
    }
}

impl AudioDebugState {
    fn new(config: AudioDebugConfig) -> Self {
        Self {
            config,
            command_count: 0,
            last_command: None,
            last_restart: None,
            last_sync: None,
            last_stop: None,
            runtime_state: AudioRuntimeStateSummary::default(),
            playback_anchor_position_seconds: None,
            playback_anchor_started_at: None,
            playback_song_duration_seconds: None,
            last_start_reason: None,
        }
    }

    fn record_command(&mut self, kind: AudioCommandKind, reason: Option<String>) {
        let kind_label = command_kind_label(kind);

        self.command_count += 1;
        self.last_command = Some(AudioCommandTrace {
            kind: kind_label.to_string(),
            reason: reason.clone(),
        });

        if self.config.log_commands {
            match reason {
                Some(reason) => {
                    eprintln!("[libretracks-audio] command={kind_label} reason={reason}")
                }
                None => eprintln!("[libretracks-audio] command={kind_label}"),
            }
        }
    }

    fn record_restart(
        &mut self,
        reason: PlaybackStartReason,
        position_seconds: f64,
        song_duration_seconds: f64,
        report: &RestartReport,
    ) {
        self.runtime_state.active_sinks = report.active_sinks;
        self.runtime_state.files_opened_last_restart = report.opened_files;
        self.runtime_state.last_scheduled_clips = report.scheduled_clips;
        self.runtime_state.cached_audio_buffers = report.cached_buffers;
        self.playback_anchor_position_seconds =
            Some(position_seconds.clamp(0.0, song_duration_seconds));
        self.playback_anchor_started_at = Some(Instant::now());
        self.playback_song_duration_seconds = Some(song_duration_seconds.max(0.0));
        self.last_start_reason = Some(reason);

        if !self.config.enabled {
            return;
        }

        self.last_restart = Some(AudioOperationSummary {
            reason: Some(playback_reason_label(reason).to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.scheduled_clips,
            active_sinks: report.active_sinks,
            opened_files: report.opened_files,
        });
    }

    fn record_sync(&mut self, report: &SyncReport) {
        self.runtime_state.active_sinks = report.active_sinks;

        if !self.config.enabled {
            return;
        }

        self.last_sync = Some(AudioOperationSummary {
            reason: Some("disk_stream".to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.updated_sinks,
            active_sinks: report.active_sinks,
            opened_files: 0,
        });
    }

    fn record_stop(&mut self, report: &StopReport, active_sinks_after_stop: usize) {
        self.runtime_state.active_sinks = active_sinks_after_stop;
        self.playback_anchor_position_seconds = self.estimated_position_seconds();
        self.playback_anchor_started_at = None;

        if !self.config.enabled {
            return;
        }

        self.last_stop = Some(AudioStopSummary {
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            stopped_sinks: report.stopped_sinks,
        });
    }

    fn snapshot(&self) -> AudioDebugSnapshot {
        AudioDebugSnapshot {
            enabled: self.config.enabled,
            log_commands: self.config.log_commands,
            command_count: self.command_count,
            last_command: self.last_command.clone(),
            last_restart: self.last_restart.clone(),
            last_sync: self.last_sync.clone(),
            last_stop: self.last_stop.clone(),
            runtime_state: self.runtime_state.clone(),
            playhead: AudioPlayheadEstimate {
                running: self.playback_anchor_started_at.is_some(),
                anchor_position_seconds: self.playback_anchor_position_seconds,
                estimated_position_seconds: self.estimated_position_seconds(),
                song_duration_seconds: self.playback_song_duration_seconds,
                anchor_age_ms: self
                    .playback_anchor_started_at
                    .map(|started_at| started_at.elapsed().as_secs_f64() * 1000.0),
                last_start_reason: self
                    .last_start_reason
                    .map(playback_reason_label)
                    .map(str::to_string),
            },
        }
    }

    fn estimated_position_seconds(&self) -> Option<f64> {
        let anchor_position = self.playback_anchor_position_seconds?;
        let estimated_position = match self.playback_anchor_started_at {
            Some(started_at) => anchor_position + started_at.elapsed().as_secs_f64(),
            None => anchor_position,
        };

        Some(match self.playback_song_duration_seconds {
            Some(song_duration_seconds) => estimated_position.clamp(0.0, song_duration_seconds),
            None => estimated_position.max(0.0),
        })
    }
}

impl AudioRuntime {
    fn new() -> Self {
        Self { session: None }
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
            debug_config,
        )?;
        let cached_buffers = usize::from(matches!(session.backend, PlaybackBackend::Cpal { .. }));

        self.session = Some(session);

        Ok(RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips,
            active_sinks: 1,
            opened_files: 0,
            cached_buffers,
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
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let debug_config = AudioDebugConfig::from_env();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || run_audio_thread(receiver, debug_config))
            .expect("audio thread should start");

        Self { sender }
    }

    pub fn play(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Play {
            song_dir,
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::SyncSong { song, respond_to })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(AudioCommand::DebugSnapshot { respond_to })
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)?
            .map_err(DesktopError::AudioCommand)
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
    }
}

impl PlaybackSession {
    fn start(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        debug_config: AudioDebugConfig,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            eprintln!("[libretracks-audio] no default output device available, using null backend");
            return Ok(Self {
                backend: PlaybackBackend::Null,
                reader_sender: None,
                reader_handle: None,
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
        let (producer, consumer) = RingBuffer::<f32>::new(ring_capacity_samples);
        let (reader_sender, reader_receiver) = mpsc::channel();

        let reader_handle = spawn_disk_reader(DiskReaderState {
            song: song.clone(),
            output_sample_rate,
            output_channels,
            timeline_cursor_frame: 0,
            remaining_song_frames: seconds_to_frames(
                (song.duration_seconds - position_seconds).max(0.0),
                output_sample_rate,
            ),
            next_plan_index: 0,
            plans: build_playback_plans(&song_dir, &song, position_seconds, output_sample_rate),
            active_readers: Vec::new(),
            producer,
            command_receiver: reader_receiver,
            debug_config,
            opened_files: 0,
        });

        let stream = build_output_stream(&device, &config, sample_format, consumer)?;
        stream.play().map_err(|error| error.to_string())?;

        Ok(Self {
            backend: PlaybackBackend::Cpal { _stream: stream },
            reader_sender: Some(reader_sender),
            reader_handle: Some(reader_handle),
        })
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

impl StreamingClipReader {
    fn open(plan: PlaybackClipPlan, output_sample_rate: u32) -> Result<Self, String> {
        let source = open_audio_source(&plan.file_path)?;
        let source_start_seconds = source_start_seconds_floor(plan.source_start_seconds);

        Ok(Self {
            plan,
            format: source.format,
            decoder: source.decoder,
            track_id: source.track_id,
            source_sample_rate: source.sample_rate.max(1),
            source_channels: source.channels.max(1),
            output_sample_rate: output_sample_rate.max(1),
            decoded_samples: Vec::new(),
            decoded_start_frame: 0,
            next_source_frame: source.sample_rate as f64 * source_start_seconds,
            eof: false,
        })
    }

    fn mix_into(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
    ) -> Result<(), String> {
        let frame_step = self.source_sample_rate as f64 / self.output_sample_rate as f64;

        for frame_offset in 0..frame_count {
            let source_frame = self.next_source_frame.round().max(0.0) as u64;
            if !self.ensure_source_frame_available(source_frame)? {
                self.eof = true;
                break;
            }

            if gain.abs() > 0.000_001 {
                let buffer_base = (offset_frames + frame_offset) * output_channels;
                for channel in 0..output_channels {
                    buffer[buffer_base + channel] +=
                        self.read_sample(source_frame, channel, output_channels) * gain;
                }
            }

            self.next_source_frame += frame_step;
            self.compact_decoded_prefix();
        }

        Ok(())
    }

    fn ensure_source_frame_available(&mut self, target_frame: u64) -> Result<bool, String> {
        loop {
            let decoded_frames = self.decoded_samples.len() / self.source_channels;
            if target_frame < self.decoded_start_frame + decoded_frames as u64 {
                return Ok(true);
            }

            if self.eof {
                return Ok(false);
            }

            if !self.decode_next_packet()? {
                self.eof = true;
                return Ok(false);
            }
        }
    }

    fn decode_next_packet(&mut self) -> Result<bool, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(error) => return Err(error.to_string()),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(error) => return Err(error.to_string()),
            };

            append_decoded_samples(&mut self.decoded_samples, decoded);
            return Ok(true);
        }
    }

    fn read_sample(&self, source_frame: u64, channel: usize, output_channels: usize) -> f32 {
        let frame_index = (source_frame.saturating_sub(self.decoded_start_frame)) as usize;
        let sample_index = frame_index.saturating_mul(self.source_channels);

        if sample_index >= self.decoded_samples.len() {
            return 0.0;
        }

        if output_channels == 1 && self.source_channels > 1 {
            let left = self.decoded_samples[sample_index];
            let right = self.decoded_samples[sample_index + 1.min(self.source_channels - 1)];
            return (left + right) * 0.5;
        }

        let source_channel = if self.source_channels == 1 {
            0
        } else {
            channel.min(self.source_channels - 1)
        };

        self.decoded_samples[sample_index + source_channel]
    }

    fn compact_decoded_prefix(&mut self) {
        let target_frame = self.next_source_frame.floor().max(0.0) as u64;
        if target_frame <= self.decoded_start_frame {
            return;
        }

        let frames_to_drop = target_frame - self.decoded_start_frame;
        if frames_to_drop < SOURCE_BUFFER_COMPACT_THRESHOLD_FRAMES {
            return;
        }

        let available_frames = (self.decoded_samples.len() / self.source_channels) as u64;
        let dropped_frames = frames_to_drop.min(available_frames);
        let dropped_samples = dropped_frames as usize * self.source_channels;
        self.decoded_samples.drain(0..dropped_samples);
        self.decoded_start_frame += dropped_frames;
    }
}

fn append_decoded_samples(target: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
    let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
    sample_buffer.copy_interleaved_ref(decoded);
    target.extend_from_slice(sample_buffer.samples());
}

fn source_start_seconds_floor(seconds: f64) -> f64 {
    if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    }
}

fn open_audio_source(file_path: &Path) -> Result<OpenAudioSource, String> {
    let file = File::open(file_path).map_err(|error| error.to_string())?;
    let mut hint = Hint::new();
    if let Some(extension) = file_path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;

    let format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| "no decodable audio track found".to_string())?;

    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "audio track sample rate is unavailable".to_string())?;
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1);
    let track_id = track.id;
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| error.to_string())?;

    Ok(OpenAudioSource {
        format,
        decoder,
        track_id,
        sample_rate,
        channels,
    })
}

fn spawn_disk_reader(state: DiskReaderState) -> JoinHandle<DiskReaderReport> {
    thread::Builder::new()
        .name("libretracks-disk-reader".into())
        .spawn(move || run_disk_reader(state))
        .expect("disk reader thread should start")
}

fn build_output_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    consumer: Consumer<f32>,
) -> Result<Stream, String> {
    let error_callback = |error| eprintln!("[libretracks-audio] cpal stream error: {error}");

    match sample_format {
        SampleFormat::F32 => {
            let mut consumer = consumer;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        drain_consumer_samples(data, &mut consumer, |sample| sample)
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::I16 => {
            let mut consumer = consumer;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        drain_consumer_samples(data, &mut consumer, |sample| {
                            (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                        })
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::U16 => {
            let mut consumer = consumer;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        drain_consumer_samples(data, &mut consumer, |sample| {
                            (((sample.clamp(-1.0, 1.0) * 0.5) + 0.5) * u16::MAX as f32) as u16
                        })
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        other => Err(format!("unsupported output sample format: {other:?}")),
    }
}

fn drain_consumer_samples<T>(
    data: &mut [T],
    consumer: &mut Consumer<f32>,
    convert: impl Fn(f32) -> T,
) where
    T: Copy,
{
    for output in data {
        let sample = consumer.pop().unwrap_or(0.0);
        *output = convert(sample);
    }
}

fn run_audio_thread(receiver: Receiver<AudioCommand>, debug_config: AudioDebugConfig) {
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

                let result = ensure_runtime(&mut runtime)
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
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let result = ensure_runtime(&mut runtime).sync_song(&song).map(|report| {
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
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all();
                }
                break;
            }
        }
    }
}

fn ensure_runtime(runtime: &mut Option<AudioRuntime>) -> &mut AudioRuntime {
    runtime.get_or_insert_with(AudioRuntime::new)
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

fn run_disk_reader(mut state: DiskReaderState) -> DiskReaderReport {
    while state.timeline_cursor_frame < state.remaining_song_frames {
        if state.consume_commands() {
            break;
        }

        let free_frames = state.producer.slots() / state.output_channels.max(1);
        if free_frames == 0 {
            thread::sleep(DISK_READER_IDLE_SLEEP);
            continue;
        }

        let remaining_frames = (state.remaining_song_frames - state.timeline_cursor_frame) as usize;
        let block_frames = DISK_RENDER_BLOCK_FRAMES
            .min(free_frames)
            .min(remaining_frames);
        if block_frames == 0 {
            break;
        }

        state.activate_due_readers(state.timeline_cursor_frame + block_frames as u64);
        let block = state.render_block(block_frames);
        if !push_block_into_ring(&mut state.producer, &block) {
            break;
        }

        state.timeline_cursor_frame += block_frames as u64;
    }

    DiskReaderReport
}

impl DiskReaderState {
    fn consume_commands(&mut self) -> bool {
        let mut should_stop = false;

        while let Ok(command) = self.command_receiver.try_recv() {
            match command {
                ReaderCommand::UpdateSong(song) => self.song = song,
                ReaderCommand::Stop => should_stop = true,
            }
        }

        should_stop
    }

    fn activate_due_readers(&mut self, window_end_frame: u64) {
        while self.next_plan_index < self.plans.len()
            && self.plans[self.next_plan_index].timeline_start_frame < window_end_frame
        {
            let plan = self.plans[self.next_plan_index].clone();
            self.next_plan_index += 1;

            match StreamingClipReader::open(plan, self.output_sample_rate) {
                Ok(reader) => {
                    self.opened_files += 1;
                    self.active_readers.push(reader);
                }
                Err(error) => {
                    if self.debug_config.enabled || self.debug_config.log_commands {
                        eprintln!("[libretracks-audio] failed to open clip reader: {error}");
                    }
                }
            }
        }
    }

    fn render_block(&mut self, block_frames: usize) -> Vec<f32> {
        let block_start = self.timeline_cursor_frame;
        let block_end = block_start + block_frames as u64;
        let mut mixed = vec![0.0_f32; block_frames * self.output_channels.max(1)];

        for reader in &mut self.active_readers {
            let overlap_start = block_start.max(reader.plan.timeline_start_frame);
            let overlap_end = block_end.min(reader.plan.timeline_end_frame());
            if overlap_end <= overlap_start {
                continue;
            }

            let offset_frames = (overlap_start - block_start) as usize;
            let overlap_frames = (overlap_end - overlap_start) as usize;
            let gain =
                resolve_clip_runtime_gain(&self.song, &reader.plan.clip_id, &reader.plan.track_id);

            if let Err(error) = reader.mix_into(
                &mut mixed,
                offset_frames,
                overlap_frames,
                self.output_channels,
                gain as f32,
            ) {
                reader.eof = true;
                if self.debug_config.enabled || self.debug_config.log_commands {
                    eprintln!("[libretracks-audio] clip decode failed: {error}");
                }
            }
        }

        self.active_readers
            .retain(|reader| !reader.eof && block_end < reader.plan.timeline_end_frame());

        mixed
    }
}

fn push_block_into_ring(producer: &mut Producer<f32>, block: &[f32]) -> bool {
    for &sample in block {
        if producer.push(sample).is_err() {
            return false;
        }
    }

    true
}

fn build_playback_plans(
    song_dir: &Path,
    song: &Song,
    position_seconds: f64,
    output_sample_rate: u32,
) -> Vec<PlaybackClipPlan> {
    let mut plans = Vec::new();

    for clip in &song.clips {
        let clip_end_seconds = clip.timeline_start_seconds + clip.duration_seconds;
        if clip_end_seconds <= position_seconds {
            continue;
        }

        let elapsed_inside_clip = (position_seconds - clip.timeline_start_seconds).max(0.0);
        let remaining_duration = (clip.duration_seconds - elapsed_inside_clip).max(0.0);
        if remaining_duration <= 0.0 {
            continue;
        }

        plans.push(PlaybackClipPlan {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            file_path: song_dir.join(&clip.file_path),
            timeline_start_frame: seconds_to_frames(
                (clip.timeline_start_seconds - position_seconds).max(0.0),
                output_sample_rate,
            ),
            duration_frames: seconds_to_frames(remaining_duration, output_sample_rate),
            source_start_seconds: clip.source_start_seconds + elapsed_inside_clip,
        });
    }

    plans.sort_by_key(|plan| plan.timeline_start_frame);
    plans
}

fn resolve_clip_runtime_gain(song: &Song, clip_id: &str, track_id: &str) -> f64 {
    let clip_gain = song
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .map(|clip| clip.gain)
        .unwrap_or(0.0);

    resolve_track_clip_gain(song, track_id, clip_gain).unwrap_or(0.0)
}

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let mut reader = StreamingClipReader::open(
        PlaybackClipPlan {
            clip_id: "probe".into(),
            track_id: "probe".into(),
            file_path: file_path.to_path_buf(),
            timeline_start_frame: 0,
            duration_frames: 1,
            source_start_seconds: 0.0,
        },
        44_100,
    )?;

    reader
        .ensure_source_frame_available(0)
        .and_then(|available| {
            available
                .then_some(())
                .ok_or_else(|| "empty audio stream".to_string())
        })
}

fn resolve_track_clip_gain(
    song: &Song,
    track_id: &str,
    clip_gain: f64,
) -> Result<f64, DesktopError> {
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

    if track.muted {
        return Ok(0.0);
    }

    let mut gain = track.volume;
    let mut cursor = track.parent_track_id.as_deref();

    while let Some(parent_track_id) = cursor {
        let parent_track = song
            .tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(parent_track_id.to_string()))?;

        if parent_track.kind != TrackKind::Folder {
            return Err(DesktopError::TrackNotFound(parent_track_id.to_string()));
        }

        if parent_track.muted {
            return Ok(0.0);
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
    }

    Ok(gain * clip_gain)
}

fn seconds_to_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * sample_rate.max(1) as f64).round() as u64
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn playback_reason_label(reason: PlaybackStartReason) -> &'static str {
    match reason {
        PlaybackStartReason::InitialPlay => "initial_play",
        PlaybackStartReason::ResumePlay => "resume_play",
        PlaybackStartReason::Seek => "seek",
        PlaybackStartReason::ImmediateJump => "immediate_jump",
        PlaybackStartReason::TimelineWindow => "timeline_window",
        PlaybackStartReason::StructureRebuild => "structure_rebuild",
        PlaybackStartReason::TransportResync => "transport_resync",
    }
}

fn command_kind_label(kind: AudioCommandKind) -> &'static str {
    match kind {
        AudioCommandKind::Play => "play",
        AudioCommandKind::SyncSong => "sync_song",
        AudioCommandKind::Stop => "stop",
        AudioCommandKind::DebugSnapshot => "debug_snapshot",
        AudioCommandKind::Shutdown => "shutdown",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::mpsc,
        thread,
        time::Duration,
    };

    use libretracks_core::{Clip, OutputBus, Song, TempoMetadata, TempoSource, Track};
    use rtrb::RingBuffer;
    use tempfile::tempdir;

    use super::{
        build_playback_plans, coalesce_sync_song_commands, drain_consumer_samples, env_flag,
        playback_reason_label, probe_audio_file, scheduled_clip_count, AudioCommand,
        AudioCommandKind, AudioDebugConfig, AudioDebugSnapshot, AudioDebugState,
        PlaybackStartReason, RestartReport, StopReport, SyncReport,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            bpm: 120.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
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

    #[test]
    fn playback_reason_labels_match_command_telemetry() {
        assert_eq!(playback_reason_label(PlaybackStartReason::Seek), "seek");
        assert_eq!(
            playback_reason_label(PlaybackStartReason::StructureRebuild),
            "structure_rebuild"
        );
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
                cached_buffers: 1,
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
                cached_buffers: 1,
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
    fn playback_plans_trim_running_clips_against_current_position() {
        let plans = build_playback_plans(Path::new("song"), &demo_song(), 1.0, 48_000);

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].clip_id, "clip_intro");
        assert_eq!(plans[0].timeline_start_frame, 0);
        assert_eq!(plans[0].duration_frames, 48_000 * 4);
        assert!((plans[0].source_start_seconds - 1.0).abs() < 0.000_001);

        assert_eq!(plans[1].clip_id, "clip_late");
        assert_eq!(plans[1].timeline_start_frame, 48_000 * 9);
    }

    #[test]
    fn ring_consumer_writes_silence_when_buffer_runs_empty() {
        let (mut producer, mut consumer) = RingBuffer::<f32>::new(4);
        producer.push(0.25).expect("sample should push");
        producer.push(-0.5).expect("sample should push");

        let mut output = [0.0_f32; 4];
        drain_consumer_samples(&mut output, &mut consumer, |sample| sample);

        assert_eq!(output, [0.25, -0.5, 0.0, 0.0]);
    }

    #[test]
    fn symphonia_probes_wav_assets() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        probe_audio_file(&audio_path).expect("wav should probe");
    }

    #[test]
    fn symphonia_probe_fails_for_missing_file() {
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
