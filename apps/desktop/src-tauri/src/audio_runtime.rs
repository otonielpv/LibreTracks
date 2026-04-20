use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};

use libretracks_core::{Clip, Song};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;

use crate::state::DesktopError;

pub struct AudioRuntime {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sinks: Vec<ClipSink>,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
}

struct ClipSink {
    clip_id: String,
    track_id: String,
    current_gain: f32,
    sink: Sink,
}

#[derive(Debug, Clone, PartialEq)]
struct RuntimeClipSpec {
    clip_id: String,
    track_id: String,
    file_path: String,
    delay_seconds: f64,
    source_offset_seconds: f64,
    play_duration_seconds: f64,
    initial_volume: f64,
}

const MIX_RAMP_STEPS: u32 = 4;
const MIX_RAMP_DURATION: Duration = Duration::from_millis(12);

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
}

#[derive(Debug, Clone)]
struct RestartReport {
    elapsed: Duration,
    scheduled_clips: usize,
    active_sinks: usize,
    opened_files: usize,
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
}

impl Default for AudioRuntimeStateSummary {
    fn default() -> Self {
        Self {
            active_sinks: 0,
            files_opened_last_restart: 0,
            last_scheduled_clips: 0,
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

    fn record_restart(&mut self, reason: PlaybackStartReason, report: &RestartReport) {
        self.runtime_state.active_sinks = report.active_sinks;
        self.runtime_state.files_opened_last_restart = report.opened_files;
        self.runtime_state.last_scheduled_clips = report.scheduled_clips;

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
            reason: Some("mix_only".to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.updated_sinks,
            active_sinks: report.active_sinks,
            opened_files: 0,
        });
    }

    fn record_stop(&mut self, report: &StopReport, active_sinks_after_stop: usize) {
        self.runtime_state.active_sinks = active_sinks_after_stop;

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
        }
    }
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

impl AudioRuntime {
    pub fn new() -> Result<Self, DesktopError> {
        let (stream, handle) = OutputStream::try_default()?;

        Ok(Self {
            _stream: stream,
            handle,
            sinks: Vec::new(),
        })
    }

    fn stop_all(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = self.sinks.len();

        for sink in self.sinks.drain(..) {
            sink.sink.stop();
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
    ) -> Result<RestartReport, DesktopError> {
        let started_at = Instant::now();
        self.stop_all();

        let mut opened_files = 0;

        for clip in build_runtime_clip_specs(song, position_seconds)? {
            let file = File::open(song_dir.join(&clip.file_path))?;
            opened_files += 1;
            let decoder = Decoder::new(BufReader::new(file))?;
            let source = decoder
                .skip_duration(Duration::from_secs_f64(clip.source_offset_seconds))
                .take_duration(Duration::from_secs_f64(clip.play_duration_seconds));

            let sink = Sink::try_new(&self.handle)?;
            sink.pause();
            sink.set_volume(clip.initial_volume as f32);
            if clip.delay_seconds > 0.0 {
                sink.append(source.delay(Duration::from_secs_f64(clip.delay_seconds)));
            } else {
                sink.append(source);
            }
            self.sinks.push(ClipSink {
                clip_id: clip.clip_id,
                track_id: clip.track_id,
                current_gain: clip.initial_volume as f32,
                sink,
            });
        }

        for sink in &self.sinks {
            sink.sink.play();
        }

        Ok(RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips: self.sinks.len(),
            active_sinks: self.sinks.len(),
            opened_files,
        })
    }

    fn sync_song(&mut self, song: &Song) -> Result<SyncReport, DesktopError> {
        let started_at = Instant::now();
        let mut target_gains = Vec::with_capacity(self.sinks.len());

        for clip_sink in &self.sinks {
            let gain = resolve_clip_sink_target_gain(song, clip_sink)?;
            target_gains.push(gain as f32);
        }

        let updated_sinks = apply_mix_ramp(&mut self.sinks, &target_gains);

        Ok(SyncReport {
            elapsed: started_at.elapsed(),
            updated_sinks,
            active_sinks: self.sinks.len(),
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
                    .and_then(|runtime| runtime.restart(&song_dir, &song, position_seconds))
                    .map(|report| {
                        debug_state.record_restart(reason, &report);
                    })
                    .map_err(|error| error.to_string());

                let _ = respond_to.send(result);
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let result = ensure_runtime(&mut runtime)
                    .and_then(|runtime| runtime.sync_song(&song))
                    .map(|report| {
                        debug_state.record_sync(&report);
                    })
                    .map_err(|error| error.to_string());

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

                debug_state.record_stop(
                    &report,
                    runtime.as_ref().map_or(0, |runtime| runtime.sinks.len()),
                );

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::DebugSnapshot { respond_to } => {
                debug_state.record_command(AudioCommandKind::DebugSnapshot, None);
                let _ = respond_to.send(debug_state.snapshot());
            }
            AudioCommand::Shutdown => {
                debug_state.record_command(AudioCommandKind::Shutdown, None);
                break;
            }
        }
    }
}

fn ensure_runtime(runtime: &mut Option<AudioRuntime>) -> Result<&mut AudioRuntime, DesktopError> {
    if runtime.is_none() {
        *runtime = Some(AudioRuntime::new()?);
    }

    Ok(runtime.as_mut().expect("runtime should exist"))
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

fn build_runtime_clip_specs(
    song: &Song,
    position_seconds: f64,
) -> Result<Vec<RuntimeClipSpec>, DesktopError> {
    let mut specs = Vec::new();

    for clip in &song.clips {
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
        if clip_end <= position_seconds {
            continue;
        }

        let elapsed_inside_clip = (position_seconds - clip.timeline_start_seconds).max(0.0);
        let remaining_duration = (clip.duration_seconds - elapsed_inside_clip).max(0.0);
        if remaining_duration <= 0.0 {
            continue;
        }

        specs.push(RuntimeClipSpec {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            file_path: clip.file_path.clone(),
            delay_seconds: (clip.timeline_start_seconds - position_seconds).max(0.0),
            source_offset_seconds: clip.source_start_seconds + elapsed_inside_clip,
            play_duration_seconds: remaining_duration,
            initial_volume: resolve_clip_initial_volume(song, clip)?,
        });
    }

    Ok(specs)
}

fn resolve_clip_initial_volume(song: &Song, clip: &Clip) -> Result<f64, DesktopError> {
    Ok(resolve_track_clip_gain(song, &clip.track_id, clip.gain)?)
}

fn resolve_clip_sink_target_gain(song: &Song, clip_sink: &ClipSink) -> Result<f64, DesktopError> {
    let clip = song
        .clips
        .iter()
        .find(|clip| clip.id == clip_sink.clip_id)
        .ok_or_else(|| DesktopError::ClipNotFound(clip_sink.clip_id.clone()))?;

    resolve_track_clip_gain(song, &clip_sink.track_id, clip.gain)
}

fn apply_mix_ramp(sinks: &mut [ClipSink], target_gains: &[f32]) -> usize {
    let changed_sinks = sinks
        .iter()
        .zip(target_gains)
        .filter(|(clip_sink, target_gain)| (clip_sink.current_gain - **target_gain).abs() > 0.0005)
        .count();

    if changed_sinks == 0 {
        return 0;
    }

    let starting_gains: Vec<f32> = sinks
        .iter()
        .map(|clip_sink| clip_sink.current_gain)
        .collect();
    let step_sleep =
        Duration::from_secs_f64(MIX_RAMP_DURATION.as_secs_f64() / f64::from(MIX_RAMP_STEPS));

    for step in 1..=MIX_RAMP_STEPS {
        let ratio = step as f32 / MIX_RAMP_STEPS as f32;

        for ((clip_sink, start_gain), target_gain) in
            sinks.iter_mut().zip(&starting_gains).zip(target_gains)
        {
            let next_gain = *start_gain + (*target_gain - *start_gain) * ratio;
            clip_sink.sink.set_volume(next_gain);
            clip_sink.current_gain = next_gain;
        }

        if step < MIX_RAMP_STEPS {
            thread::sleep(step_sleep);
        }
    }

    changed_sinks
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

    let group_gain = match track.group_id.as_deref() {
        Some(group_id) => {
            let group = song
                .groups
                .iter()
                .find(|group| group.id == group_id)
                .ok_or_else(|| DesktopError::GroupNotFound(group_id.to_string()))?;

            if group.muted {
                0.0
            } else {
                group.volume
            }
        }
        None => 1.0,
    };

    Ok(track.volume * group_gain * clip_gain)
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
    use std::sync::mpsc;
    use std::time::Duration;

    use libretracks_core::{OutputBus, Song, Track, TrackGroup};
    use rodio::Sink;

    use super::{
        apply_mix_ramp, build_runtime_clip_specs, coalesce_sync_song_commands, env_flag,
        playback_reason_label, resolve_track_clip_gain, AudioCommand, AudioCommandKind,
        AudioDebugConfig, AudioDebugSnapshot, AudioDebugState, ClipSink, PlaybackStartReason,
        RestartReport, StopReport, SyncReport,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            bpm: 120.0,
            key: None,
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
                    name: "Monitor".into(),
                    volume: 0.5,
                    muted: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                TrackGroup {
                    id: "group_main".into(),
                    name: "Main".into(),
                    volume: 0.7,
                    muted: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![
                libretracks_core::Clip {
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
                libretracks_core::Clip {
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
            sections: vec![],
        }
    }

    #[test]
    fn build_runtime_clip_specs_keeps_current_and_future_clips() {
        let specs = build_runtime_clip_specs(&demo_song(), 1.0).expect("specs should build");

        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].clip_id, "clip_click");
        assert!((specs[0].source_offset_seconds - 1.0).abs() < 0.0001);
        assert!((specs[0].play_duration_seconds - 4.0).abs() < 0.0001);
        assert_eq!(specs[0].delay_seconds, 0.0);

        assert_eq!(specs[1].clip_id, "clip_drums");
        assert!((specs[1].delay_seconds - 9.0).abs() < 0.0001);
        assert!((specs[1].play_duration_seconds - 4.0).abs() < 0.0001);
        assert!((specs[1].initial_volume - 0.315).abs() < 0.0001);
    }

    #[test]
    fn muted_tracks_resolve_to_zero_gain_without_dropping_other_tracks() {
        let mut song = demo_song();
        song.tracks[0].muted = true;

        let click_gain =
            resolve_track_clip_gain(&song, "track_click", 1.0).expect("click gain should resolve");
        let drums_gain =
            resolve_track_clip_gain(&song, "track_drums", 0.9).expect("drums gain should resolve");

        assert_eq!(click_gain, 0.0);
        assert!((drums_gain - 0.315).abs() < 0.0001);
    }

    #[test]
    fn playback_reason_labels_are_stable_for_debug_metrics() {
        assert_eq!(playback_reason_label(PlaybackStartReason::Seek), "seek");
        assert_eq!(
            playback_reason_label(PlaybackStartReason::StructureRebuild),
            "structure_rebuild"
        );
    }

    #[test]
    fn debug_state_tracks_last_operations_when_enabled() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_command(AudioCommandKind::Play, Some("initial_play".into()));
        debug_state.record_restart(
            PlaybackStartReason::InitialPlay,
            &RestartReport {
                elapsed: Duration::from_millis(12),
                scheduled_clips: 3,
                active_sinks: 3,
                opened_files: 3,
            },
        );
        debug_state.record_sync(&SyncReport {
            elapsed: Duration::from_millis(2),
            updated_sinks: 3,
            active_sinks: 3,
        });
        debug_state.record_stop(
            &StopReport {
                elapsed: Duration::from_millis(1),
                stopped_sinks: 3,
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
        assert_eq!(snapshot.runtime_state.active_sinks, 0);
        assert_eq!(
            snapshot
                .last_stop
                .expect("stop summary should exist")
                .stopped_sinks,
            3
        );
    }

    #[test]
    fn env_flag_accepts_common_truthy_values() {
        let key = "LIBRETRACKS_AUDIO_ENV_FLAG_TEST";
        std::env::set_var(key, "YES");
        assert!(env_flag(key));
        std::env::remove_var(key);
    }

    #[test]
    fn apply_mix_ramp_updates_only_changed_sinks() {
        let (sink_1, _) = Sink::new_idle();
        let (sink_2, _) = Sink::new_idle();
        sink_1.set_volume(0.4);
        sink_2.set_volume(0.2);

        let mut sinks = vec![
            ClipSink {
                clip_id: "clip_1".into(),
                track_id: "track_1".into(),
                current_gain: 0.4,
                sink: sink_1,
            },
            ClipSink {
                clip_id: "clip_2".into(),
                track_id: "track_2".into(),
                current_gain: 0.2,
                sink: sink_2,
            },
        ];

        let changed_sinks = apply_mix_ramp(&mut sinks, &[0.4, 0.8]);

        assert_eq!(changed_sinks, 1);
        assert!((sinks[0].current_gain - 0.4).abs() < 0.0001);
        assert!((sinks[1].current_gain - 0.8).abs() < 0.0001);
    }

    #[test]
    fn coalesces_consecutive_mix_sync_commands() {
        let (sender, receiver) = mpsc::channel();
        let (respond_to_1, _) = mpsc::channel();
        let (respond_to_2, _) = mpsc::channel();
        let (respond_to_3, _) = mpsc::channel::<AudioDebugSnapshot>();

        let mut song_a = demo_song();
        song_a.tracks[0].volume = 0.2;
        let mut song_b = demo_song();
        song_b.tracks[0].volume = 0.7;

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

        assert_eq!(latest_song.tracks[0].volume, 0.7);
        assert_eq!(respond_tos.len(), 2);
        assert!(matches!(
            deferred_command,
            Some(AudioCommand::DebugSnapshot { .. })
        ));
    }
}
