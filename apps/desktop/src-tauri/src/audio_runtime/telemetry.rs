use super::*;

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
pub(crate) struct AudioCommandTrace {
    pub kind: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioOperationSummary {
    pub reason: Option<String>,
    pub elapsed_ms: f64,
    pub scheduled_clips: usize,
    pub active_sinks: usize,
    pub opened_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioStopSummary {
    pub elapsed_ms: f64,
    pub stopped_sinks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioRuntimeStateSummary {
    pub active_sinks: usize,
    pub files_opened_last_restart: usize,
    pub last_scheduled_clips: usize,
    pub cached_audio_buffers: usize,
    pub fully_cached_audio_buffers: usize,
    pub cached_audio_preload_bytes: usize,
    pub master_gain: f32,
    pub far_seek_cache_status: Option<String>,
    pub far_seek_exact_ready: bool,
    pub far_seek_used_fallback: bool,
    pub far_seek_prepare_requested: bool,
    pub far_seek_swap_to_exact_ms: Option<f64>,
    pub last_seek_path: Option<String>,
    pub last_seek_exact_pitch_hit: bool,
    pub last_seek_fallback_used: bool,
    pub last_seek_source_waited: bool,
    pub source_swap_ms_after_seek: Option<f64>,
    pub starved_frames: u64,
    pub streaming_reader_used_in_zero_latency_mode: bool,
    pub ram_cache_used_mb: usize,
    pub disk_cache_used_mb: usize,
    pub prepare_queue_len: usize,
    pub prepare_active_tasks: usize,
    pub prepare_cancelled_tasks: usize,
    pub source_swap_count: u64,
    pub silence_fallback_count: u64,
    pub last_silence_fallback_position: Option<f64>,
    pub last_silence_fallback_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioPlayheadEstimate {
    pub running: bool,
    pub anchor_position_seconds: Option<f64>,
    pub estimated_position_seconds: Option<f64>,
    pub song_duration_seconds: Option<f64>,
    pub anchor_age_ms: Option<f64>,
    pub last_start_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RestartReport {
    pub elapsed: Duration,
    pub scheduled_clips: usize,
    pub active_sinks: usize,
    pub opened_files: usize,
    pub cache_stats: source::AudioBufferCacheStats,
}

#[derive(Debug, Clone)]
pub(crate) struct SyncReport {
    pub elapsed: Duration,
    pub updated_sinks: usize,
    pub active_sinks: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct StopReport {
    pub elapsed: Duration,
    pub stopped_sinks: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioDebugConfig {
    pub enabled: bool,
    pub log_commands: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AudioDebugState {
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

impl Default for AudioRuntimeStateSummary {
    fn default() -> Self {
        Self {
            active_sinks: 0,
            files_opened_last_restart: 0,
            last_scheduled_clips: 0,
            cached_audio_buffers: 0,
            fully_cached_audio_buffers: 0,
            cached_audio_preload_bytes: 0,
            master_gain: 1.0,
            far_seek_cache_status: None,
            far_seek_exact_ready: false,
            far_seek_used_fallback: false,
            far_seek_prepare_requested: false,
            far_seek_swap_to_exact_ms: None,
            last_seek_path: None,
            last_seek_exact_pitch_hit: false,
            last_seek_fallback_used: false,
            last_seek_source_waited: false,
            source_swap_ms_after_seek: None,
            starved_frames: 0,
            streaming_reader_used_in_zero_latency_mode: false,
            ram_cache_used_mb: 0,
            disk_cache_used_mb: 0,
            prepare_queue_len: 0,
            prepare_active_tasks: 0,
            prepare_cancelled_tasks: 0,
            source_swap_count: 0,
            silence_fallback_count: 0,
            last_silence_fallback_position: None,
            last_silence_fallback_file: None,
        }
    }
}

impl AudioDebugConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            enabled: env_flag("LIBRETRACKS_AUDIO_DEBUG"),
            log_commands: env_flag("LIBRETRACKS_AUDIO_LOG_COMMANDS"),
        }
    }
}

impl AudioDebugState {
    pub(crate) fn new(config: AudioDebugConfig) -> Self {
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

    pub(crate) fn record_command(&mut self, kind: AudioCommandKind, reason: Option<String>) {
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

    pub(crate) fn record_restart(
        &mut self,
        reason: PlaybackStartReason,
        position_seconds: f64,
        song_duration_seconds: f64,
        report: &RestartReport,
    ) {
        self.runtime_state.active_sinks = report.active_sinks;
        self.runtime_state.files_opened_last_restart = report.opened_files;
        self.runtime_state.last_scheduled_clips = report.scheduled_clips;
        self.runtime_state.cached_audio_buffers = report.cache_stats.cached_buffers;
        self.runtime_state.fully_cached_audio_buffers = report.cache_stats.fully_cached_buffers;
        self.runtime_state.cached_audio_preload_bytes = report.cache_stats.preload_bytes;
        self.runtime_state.prepare_queue_len = report.cache_stats.prepare_queue_len;
        self.runtime_state.ram_cache_used_mb = report.cache_stats.ram_cache_used_mb;
        self.runtime_state.disk_cache_used_mb = report.cache_stats.disk_cache_used_mb;
        self.runtime_state.silence_fallback_count = report.cache_stats.silence_fallback_count;
        self.runtime_state.last_silence_fallback_position =
            report.cache_stats.last_silence_fallback_position;
        self.runtime_state.last_silence_fallback_file =
            report.cache_stats.last_silence_fallback_file.clone();
        self.playback_anchor_position_seconds = Some(position_seconds.max(0.0));
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

    pub(crate) fn record_sync(&mut self, report: &SyncReport) {
        self.runtime_state.active_sinks = report.active_sinks;

        if !self.config.enabled {
            return;
        }

        self.last_sync = Some(AudioOperationSummary {
            reason: Some("memory_mix".to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.updated_sinks,
            active_sinks: report.active_sinks,
            opened_files: 0,
        });
    }

    pub(crate) fn record_seek(
        &mut self,
        reason: PlaybackStartReason,
        position_seconds: f64,
        song_duration_seconds: f64,
        active_sinks: usize,
        far_seek: Option<&FarSeekTelemetry>,
    ) {
        self.runtime_state.active_sinks = active_sinks;
        self.playback_anchor_position_seconds = Some(position_seconds.max(0.0));
        self.playback_anchor_started_at = Some(Instant::now());
        self.playback_song_duration_seconds = Some(song_duration_seconds.max(0.0));
        self.last_start_reason = Some(reason);
        if let Some(far_seek) = far_seek {
            self.runtime_state.far_seek_cache_status = Some(far_seek.cache_status.clone());
            self.runtime_state.far_seek_exact_ready = far_seek.exact_ready;
            self.runtime_state.far_seek_used_fallback = far_seek.used_fallback;
            self.runtime_state.far_seek_prepare_requested = far_seek.prepare_requested;
            self.runtime_state.far_seek_swap_to_exact_ms = far_seek.swap_to_exact_ms;
            self.runtime_state.last_seek_path = Some(far_seek.cache_status.clone());
            self.runtime_state.last_seek_exact_pitch_hit = far_seek.exact_ready;
            self.runtime_state.last_seek_fallback_used = far_seek.used_fallback;
            self.runtime_state.last_seek_source_waited = false;
            self.runtime_state.source_swap_ms_after_seek = far_seek.swap_to_exact_ms;
        }
    }

    pub(crate) fn record_stop(&mut self, report: &StopReport, active_sinks_after_stop: usize) {
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

    pub(crate) fn snapshot(&self) -> AudioDebugSnapshot {
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

        Some(estimated_position.max(0.0))
    }
}

pub(crate) fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn playback_reason_label(reason: PlaybackStartReason) -> &'static str {
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

pub(crate) fn command_kind_label(kind: AudioCommandKind) -> &'static str {
    match kind {
        AudioCommandKind::Play => "play",
        AudioCommandKind::Seek => "seek",
        AudioCommandKind::SyncSong => "sync_song",
        AudioCommandKind::Stop => "stop",
        AudioCommandKind::StartMasterFade => "start_master_fade",
        AudioCommandKind::DebugSnapshot => "debug_snapshot",
        AudioCommandKind::Shutdown => "shutdown",
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FarSeekTelemetry {
    pub cache_status: String,
    pub exact_ready: bool,
    pub used_fallback: bool,
    pub prepare_requested: bool,
    pub swap_to_exact_ms: Option<f64>,
}
