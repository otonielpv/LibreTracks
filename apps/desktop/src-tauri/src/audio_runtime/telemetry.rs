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
    ) {
        self.runtime_state.active_sinks = active_sinks;
        self.playback_anchor_position_seconds =
            Some(position_seconds.clamp(0.0, song_duration_seconds));
        self.playback_anchor_started_at = Some(Instant::now());
        self.playback_song_duration_seconds = Some(song_duration_seconds.max(0.0));
        self.last_start_reason = Some(reason);
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

        Some(match self.playback_song_duration_seconds {
            Some(song_duration_seconds) => estimated_position.clamp(0.0, song_duration_seconds),
            None => estimated_position.max(0.0),
        })
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
        AudioCommandKind::DebugSnapshot => "debug_snapshot",
        AudioCommandKind::Shutdown => "shutdown",
    }
}
