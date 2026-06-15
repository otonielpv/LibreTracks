use base64::{engine::general_purpose::STANDARD, Engine as _};
use libretracks_audio::{ActiveVamp, JumpTrigger, PendingMarkerJump, TransitionType};
use libretracks_core::{
    audible_clip_duration_seconds, warp_timeline_seconds_at, Clip, Marker, MarkerKind, Song,
    SongRegion, TempoMarker, TimeSignatureMarker, TrackKind,
};
use libretracks_project::{WaveformLod, WaveformSummary};
use serde::Serialize;
use std::collections::HashSet;

use crate::automation::{
    AutomationAction, AutomationCue, AutomationDocument, AutomationJumpTarget,
    AutomationTransitionMode, MixScene,
};
use crate::error::DesktopError;
use crate::state::WaveformMemoryCache;

const TIMELINE_TIMEBASE_HZ: u32 = 48_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    pub playback_state: String,
    pub position_seconds: f64,
    pub current_marker: Option<MarkerSummary>,
    pub pending_marker_jump: Option<PendingJumpSummary>,
    pub pending_automation_cue: Option<PendingAutomationCueSummary>,
    pub active_vamp: Option<ActiveVampSummary>,
    pub automation_cues: Vec<AutomationCueSummary>,
    pub mix_scenes: Vec<MixSceneSummary>,
    pub automation_track: Option<AutomationTrackSummary>,
    pub musical_position: MusicalPositionSummary,
    pub transport_clock: TransportClockSummary,
    pub pitch: PitchPrepareSummary,
    pub sources: SourceReadinessSummary,
    pub last_drift_sample: Option<TransportDriftSummary>,
    pub project_revision: u64,
    pub song_dir: Option<String>,
    pub song_file_path: Option<String>,
    pub is_native_runtime: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PitchPrepareSummary {
    pub pitch_prepare_active: bool,
    pub pitch_prepare_pending: bool,
    pub pitch_prepare_progress: f64,
    pub pitch_proxy_blocks_ready: u64,
    pub pitch_proxy_blocks_missing: u64,
    pub pitch_proxy_blocks_pending: u64,
    pub pitch_jobs_pending: u64,
    pub pitch_jobs_running: u64,
    pub pitch_jobs_completed: u64,
    pub pitch_jobs_failed: u64,
    pub pitch_prepare_status: String,
    pub pitch_prepare_message: String,
    pub active_pitch_render_path: String,
    pub last_pitch_prepare_reason: String,
    pub last_pitch_proxy_error: String,
    pub last_missing_proxy_key: String,
    pub last_missing_proxy_block_index: i64,
}

/// Aggregate readiness of the engine's audio sources (decode + PCM cache
/// preparation). Drives the global "Preparando audio…" indicator in the
/// transport. Progress is REAL — derived from each source's live
/// `progress_percent` reported by the C++ preparation queue — never an
/// indeterminate spinner.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReadinessSummary {
    /// True when every source has reached a terminal state (or there are none).
    pub sources_ready: bool,
    pub sources_total: usize,
    /// Sources decoded/cached and playable (`ready` | `cache_ready`).
    pub sources_ready_count: usize,
    /// Sources still being prepared (`unloaded` | `loading`).
    pub sources_loading_count: usize,
    pub sources_failed_count: usize,
    /// Aggregate 0-100 across all sources (Σ per-source progress / total).
    pub sources_progress_percent: f64,
    pub cache_ram_used_mb: u64,
    pub cache_disk_used_mb: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportClockSummary {
    pub anchor_position_seconds: f64,
    pub playback_rate: f64,
    pub running: bool,
    pub last_seek_position_seconds: Option<f64>,
    pub last_start_position_seconds: Option<f64>,
    pub last_jump_position_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportDriftSummary {
    pub event: String,
    pub transport_position_seconds: f64,
    pub engine_position_seconds: f64,
    pub runtime_estimated_position_seconds: Option<f64>,
    pub runtime_running: bool,
    pub transport_minus_engine_seconds: f64,
    pub runtime_minus_transport_seconds: Option<f64>,
    pub runtime_minus_engine_seconds: Option<f64>,
    pub max_observed_delta_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongView {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub key: Option<String>,
    pub bpm: f64,
    pub time_signature: String,
    pub duration_seconds: f64,
    pub tempo_markers: Vec<TempoMarkerSummary>,
    pub time_signature_markers: Vec<TimeSignatureMarkerSummary>,
    pub regions: Vec<SongRegionSummary>,
    pub section_markers: Vec<MarkerSummary>,
    pub clips: Vec<ClipSummary>,
    pub tracks: Vec<TrackSummary>,
    pub automation_cues: Vec<AutomationCueSummary>,
    pub mix_scenes: Vec<MixSceneSummary>,
    /// Present (non-null) only when the user has added the automation track to
    /// the timeline. The track is a synthetic UI lane, not a real `Track`.
    pub automation_track: Option<AutomationTrackSummary>,
    pub waveforms: Vec<WaveformSummaryDto>,
    pub project_revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrackSummary {
    /// Id of the audio track the automation lane sits after; `None` = first row.
    pub after_track_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCueSummary {
    pub id: String,
    pub name: String,
    pub at_seconds: f64,
    pub enabled: bool,
    /// Max times the cue fires per session; `None` = unlimited.
    pub max_runs: Option<u32>,
    /// True when the cue has hit its `max_runs` this session and will be skipped
    /// until reset (stop / seek before it). Runtime-derived, not persisted.
    pub exhausted: bool,
    /// Ordered actions of the job.
    pub actions: Vec<AutomationActionSummary>,
}

// Internally-tagged enum: rename_all renames the tags but not struct-variant
// fields, so rename per-field to emit camelCase for the frontend.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AutomationActionSummary {
    Jump {
        target: AutomationJumpTargetSummary,
        transition: AutomationTransitionSummary,
        #[serde(rename = "mixSceneId", skip_serializing_if = "Option::is_none")]
        mix_scene_id: Option<String>,
    },
    SetTrackMute {
        #[serde(rename = "trackId")]
        track_id: String,
        muted: bool,
    },
    SetTrackSolo {
        #[serde(rename = "trackId")]
        track_id: String,
        solo: bool,
    },
    SetTrackMix {
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pan: Option<f64>,
        #[serde(rename = "rampSeconds", skip_serializing_if = "Option::is_none")]
        ramp_seconds: Option<f64>,
    },
    ApplyScene {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "rampSeconds", skip_serializing_if = "Option::is_none")]
        ramp_seconds: Option<f64>,
    },
    Wait {
        #[serde(rename = "durationSeconds")]
        duration_seconds: f64,
    },
}

// Internally-tagged enum: rename_all renames the tags but not struct-variant
// fields, so rename per-field to emit camelCase (markerId/regionId) for the TS.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationJumpTargetSummary {
    Marker {
        #[serde(rename = "markerId")]
        marker_id: String,
    },
    Region {
        #[serde(rename = "regionId")]
        region_id: String,
    },
    Frame {
        seconds: f64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTransitionSummary {
    pub mode: String,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixSceneSummary {
    pub id: String,
    pub name: String,
    pub track_overrides: Vec<MixSceneTrackOverrideSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixSceneTrackOverrideSummary {
    pub track_id: String,
    pub volume: Option<f64>,
    pub pan: Option<f64>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAutomationCueSummary {
    pub cue_id: String,
    pub cue_name: String,
    pub execute_at_seconds: f64,
    /// The jump destination in view seconds, so the UI can move the playhead
    /// there the instant it reaches the cue (no waiting for the reanchor).
    pub target_seconds: f64,
    pub target: AutomationJumpTargetSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRegionSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub transpose_semitones: i32,
    pub warp_enabled: bool,
    pub warp_source_bpm: Option<f64>,
    pub master: SongMasterSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMasterSummary {
    pub gain: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoMarkerSummary {
    pub id: String,
    pub start_seconds: f64,
    pub source_start_seconds: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSignatureMarkerSummary {
    pub id: String,
    pub start_seconds: f64,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub parent_track_id: Option<String>,
    pub depth: usize,
    pub has_children: bool,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    pub transpose_enabled: bool,
    pub audio_to: String,
    pub color: Option<String>,
    pub auto_created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJumpSummary {
    pub target_marker_id: String,
    pub target_marker_name: String,
    pub target_digit: Option<u8>,
    pub trigger: String,
    pub execute_at_seconds: f64,
    pub transition: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveVampSummary {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub digit: Option<u8>,
    pub kind: MarkerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicalPositionSummary {
    pub bar_number: u32,
    pub beat_in_bar: u32,
    pub sub_beat: u32,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSummary {
    pub id: String,
    pub track_id: String,
    pub track_name: String,
    pub file_path: String,
    pub waveform_key: String,
    pub is_missing: bool,
    pub timeline_start_seconds: f64,
    pub source_start_seconds: f64,
    pub source_window_duration_seconds: f64,
    pub source_duration_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLodDto {
    pub resolution_frames: usize,
    pub bucket_count: usize,
    pub min_peaks_base64: String,
    pub max_peaks_base64: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub min_peaks_right_base64: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub max_peaks_right_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummaryDto {
    pub waveform_key: String,
    pub version: u32,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub lods: Vec<WaveformLodDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetSummary {
    pub file_name: String,
    pub file_path: String,
    pub duration_seconds: f64,
    pub is_missing: bool,
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongPackageImportResponse {
    pub snapshot: TransportSnapshot,
    pub library_assets: Vec<LibraryAssetSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPerformanceSnapshot {
    pub copy_millis: u128,
    pub wav_analysis_millis: u128,
    pub waveform_write_millis: u128,
    pub song_save_millis: u128,
    pub transport_snapshot_build_millis: u128,
    pub song_view_build_millis: u128,
    pub waveform_cache_hits: u64,
    pub waveform_cache_misses: u64,
    pub transport_snapshot_bytes: usize,
    pub song_view_bytes: usize,
    pub last_react_render_millis: f64,
    pub project_revision: u64,
    pub cached_waveforms: usize,
}

pub(crate) fn song_to_view(
    song: &Song,
    automation: &AutomationDocument,
    automation_run_counts: &std::collections::HashMap<String, u32>,
    waveform_cache: &WaveformMemoryCache,
    project_revision: u64,
    song_dir: Option<&std::path::Path>,
    include_waveforms: bool,
) -> SongView {
    // Waveform LODs base64-encoded dominate the payload size (~27 MB for a
    // multitrack church song). When the caller is responding to a mutation
    // that does not change clip audio (transpose, gain, mute, region rename,
    // …), skipping the waveforms collapses serialize+IPC from ~3s to ~50ms.
    // The frontend's waveform cache remains valid from the previous load.
    let waveforms = if include_waveforms {
        let mut waveform_keys = HashSet::new();
        song.clips
            .iter()
            .filter_map(|clip| {
                let waveform_key = waveform_key_for_file_path(&clip.file_path);
                if !waveform_keys.insert(waveform_key.clone()) {
                    return None;
                }
                waveform_cache
                    .summary(&waveform_key)
                    .map(|summary| waveform_summary_to_dto(&waveform_key, summary))
            })
            .collect()
    } else {
        Vec::new()
    };

    let view_duration_seconds = song
        .clips
        .iter()
        .map(|clip| {
            let track_transpose_enabled = song
                .tracks
                .iter()
                .find(|t| t.id == clip.track_id)
                .map(|t| t.transpose_enabled)
                .unwrap_or(true);
            warp_timeline_seconds_at(song, clip.timeline_start_seconds)
                + audible_clip_duration_seconds(
                    song,
                    clip.timeline_start_seconds,
                    clip.duration_seconds,
                    track_transpose_enabled,
                )
        })
        .fold(
            warp_timeline_seconds_at(song, song.duration_seconds),
            f64::max,
        )
        .max(1.0);

    SongView {
        id: song.id.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        key: song.key.clone(),
        bpm: song.bpm,
        time_signature: song.time_signature.clone(),
        duration_seconds: view_duration_seconds,
        tempo_markers: song
            .tempo_markers
            .iter()
            .map(|marker| tempo_marker_to_warped_summary(song, marker))
            .collect(),
        time_signature_markers: song
            .time_signature_markers
            .iter()
            .map(|marker| time_signature_marker_to_warped_summary(song, marker))
            .collect(),
        regions: song
            .regions
            .iter()
            .map(|region| region_to_summary(song, region))
            .collect(),
        section_markers: song
            .section_markers
            .iter()
            .map(|marker| marker_to_warped_summary(song, marker))
            .collect(),
        clips: song
            .clips
            .iter()
            .map(|clip| clip_to_summary(song, clip, waveform_cache, song_dir))
            .collect(),
        tracks: song
            .tracks
            .iter()
            .map(|track| TrackSummary {
                id: track.id.clone(),
                name: track.name.clone(),
                kind: track_kind_label(track.kind).to_string(),
                parent_track_id: track.parent_track_id.clone(),
                depth: track_depth(song, &track.id),
                has_children: song
                    .tracks
                    .iter()
                    .any(|child| child.parent_track_id.as_deref() == Some(track.id.as_str())),
                volume: track.volume,
                pan: track.pan,
                muted: track.muted,
                solo: track.solo,
                transpose_enabled: track.transpose_enabled,
                audio_to: track.audio_to.clone(),
                color: track.color.clone(),
                auto_created: track.auto_created,
            })
            .collect(),
        automation_cues: automation_cues_to_summary(
            song,
            &automation.cues,
            automation_run_counts,
        ),
        mix_scenes: mix_scenes_to_summary(&automation.mix_scenes),
        automation_track: if automation.track_present {
            Some(AutomationTrackSummary {
                after_track_id: automation.track_after_id.clone(),
            })
        } else {
            None
        },
        waveforms,
        project_revision,
    }
}

pub(crate) fn automation_cues_to_summary(
    song: &Song,
    cues: &[AutomationCue],
    run_counts: &std::collections::HashMap<String, u32>,
) -> Vec<AutomationCueSummary> {
    cues.iter()
        .map(|cue| automation_cue_to_summary(song, cue, run_counts))
        .collect()
}

pub(crate) fn automation_cue_to_summary(
    song: &Song,
    cue: &AutomationCue,
    run_counts: &std::collections::HashMap<String, u32>,
) -> AutomationCueSummary {
    let exhausted = cue
        .max_runs
        .is_some_and(|max| run_counts.get(&cue.id).copied().unwrap_or(0) >= max);
    AutomationCueSummary {
        id: cue.id.clone(),
        name: cue.name.clone(),
        at_seconds: warp_timeline_seconds_at(song, cue.at_seconds),
        enabled: cue.enabled,
        max_runs: cue.max_runs,
        exhausted,
        actions: cue
            .actions
            .iter()
            .map(|action| automation_action_to_summary(song, action))
            .collect(),
    }
}

pub(crate) fn automation_action_to_summary(
    song: &Song,
    action: &AutomationAction,
) -> AutomationActionSummary {
    match action {
        AutomationAction::Jump {
            target,
            transition,
            mix_scene_id,
        } => AutomationActionSummary::Jump {
            target: automation_jump_target_to_summary(song, target),
            transition: AutomationTransitionSummary {
                mode: match transition.mode {
                    AutomationTransitionMode::Instant => "instant".into(),
                    AutomationTransitionMode::FadeOut => "fade_out".into(),
                },
                duration_seconds: transition.duration_seconds,
            },
            mix_scene_id: mix_scene_id.clone(),
        },
        AutomationAction::SetTrackMute { track_id, muted } => {
            AutomationActionSummary::SetTrackMute {
                track_id: track_id.clone(),
                muted: *muted,
            }
        }
        AutomationAction::SetTrackSolo { track_id, solo } => {
            AutomationActionSummary::SetTrackSolo {
                track_id: track_id.clone(),
                solo: *solo,
            }
        }
        AutomationAction::SetTrackMix {
            track_id,
            volume,
            pan,
            ramp_seconds,
        } => AutomationActionSummary::SetTrackMix {
            track_id: track_id.clone(),
            volume: *volume,
            pan: *pan,
            ramp_seconds: *ramp_seconds,
        },
        AutomationAction::ApplyScene {
            scene_id,
            ramp_seconds,
        } => AutomationActionSummary::ApplyScene {
            scene_id: scene_id.clone(),
            ramp_seconds: *ramp_seconds,
        },
        AutomationAction::Wait { duration_seconds } => AutomationActionSummary::Wait {
            duration_seconds: *duration_seconds,
        },
    }
}

pub(crate) fn automation_jump_target_to_summary(
    song: &Song,
    target: &AutomationJumpTarget,
) -> AutomationJumpTargetSummary {
    match target {
        AutomationJumpTarget::Marker { marker_id } => AutomationJumpTargetSummary::Marker {
            marker_id: marker_id.clone(),
        },
        AutomationJumpTarget::Region { region_id } => AutomationJumpTargetSummary::Region {
            region_id: region_id.clone(),
        },
        AutomationJumpTarget::Frame { seconds } => AutomationJumpTargetSummary::Frame {
            seconds: warp_timeline_seconds_at(song, *seconds),
        },
    }
}

pub(crate) fn mix_scenes_to_summary(scenes: &[MixScene]) -> Vec<MixSceneSummary> {
    scenes
        .iter()
        .map(|scene| MixSceneSummary {
            id: scene.id.clone(),
            name: scene.name.clone(),
            track_overrides: scene
                .track_overrides
                .iter()
                .map(|override_| MixSceneTrackOverrideSummary {
                    track_id: override_.track_id.clone(),
                    volume: override_.volume,
                    pan: override_.pan,
                    muted: override_.muted,
                    solo: override_.solo,
                })
                .collect(),
        })
        .collect()
}

pub(crate) fn clip_to_summary(
    song: &Song,
    clip: &Clip,
    waveform_cache: &WaveformMemoryCache,
    song_dir: Option<&std::path::Path>,
) -> ClipSummary {
    let track = song.tracks.iter().find(|track| track.id == clip.track_id);
    let track_name = track
        .map(|t| t.name.clone())
        .unwrap_or_else(|| clip.track_id.clone());
    let track_transpose_enabled = track.map(|t| t.transpose_enabled).unwrap_or(true);
    let waveform_key = waveform_key_for_file_path(&clip.file_path);
    let source_duration_seconds = waveform_cache
        .source_duration_seconds(&waveform_key)
        .filter(|duration| *duration > 0.0)
        .unwrap_or(clip.source_start_seconds + clip.duration_seconds);

    ClipSummary {
        id: clip.id.clone(),
        track_id: clip.track_id.clone(),
        track_name,
        file_path: clip.file_path.clone(),
        waveform_key,
        is_missing: if let Some(dir) = song_dir {
            let path = std::path::Path::new(&clip.file_path);
            if path.is_absolute() {
                !path.exists()
            } else {
                !dir.join(path).exists()
            }
        } else {
            !std::path::Path::new(&clip.file_path).exists()
        },
        timeline_start_seconds: warp_timeline_seconds_at(song, clip.timeline_start_seconds),
        source_start_seconds: clip.source_start_seconds,
        source_window_duration_seconds: clip.duration_seconds,
        source_duration_seconds,
        // Phase-3 visual mapping: warp shrinks/expands by warp ratio, pitch
        // without warp shrinks/expands by pitch_scale (varispeed) on tracks
        // that allow transpose. Region/marker positions deliberately stay on
        // the musical grid — varispeed only changes this clip's audible end.
        duration_seconds: audible_clip_duration_seconds(
            song,
            clip.timeline_start_seconds,
            clip.duration_seconds,
            track_transpose_enabled,
        ),
        gain: clip.gain,
        color: clip.color.clone(),
    }
}

pub(crate) fn waveform_key_for_file_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

pub(crate) fn waveform_summary_to_dto(
    waveform_key: &str,
    summary: &WaveformSummary,
) -> WaveformSummaryDto {
    WaveformSummaryDto {
        waveform_key: waveform_key.to_string(),
        version: summary.version,
        duration_seconds: summary.duration_seconds,
        sample_rate: summary.sample_rate,
        lods: summary.lods.iter().map(waveform_lod_to_dto).collect(),
    }
}

fn waveform_lod_to_dto(lod: &WaveformLod) -> WaveformLodDto {
    WaveformLodDto {
        resolution_frames: lod.resolution_frames,
        bucket_count: lod.max_peaks.len(),
        min_peaks_base64: encode_peaks_base64(&lod.min_peaks),
        max_peaks_base64: encode_peaks_base64(&lod.max_peaks),
        min_peaks_right_base64: encode_peaks_base64(&lod.min_peaks_right),
        max_peaks_right_base64: encode_peaks_base64(&lod.max_peaks_right),
    }
}

fn encode_peaks_base64(values: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<f32>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    STANDARD.encode(bytes)
}

pub(crate) fn pending_jump_to_summary(pending_jump: &PendingMarkerJump) -> PendingJumpSummary {
    PendingJumpSummary {
        target_marker_id: pending_jump.target_marker_id.clone(),
        target_marker_name: pending_jump.target_marker_name.clone(),
        target_digit: pending_jump.target_digit,
        trigger: pending_jump_trigger_label(&pending_jump.trigger),
        execute_at_seconds: pending_jump.execute_at_seconds,
        transition: transition_type_label(&pending_jump.transition),
    }
}

pub(crate) fn pending_jump_to_warped_summary(
    song: &Song,
    pending_jump: &PendingMarkerJump,
) -> PendingJumpSummary {
    PendingJumpSummary {
        target_marker_id: pending_jump.target_marker_id.clone(),
        target_marker_name: pending_jump.target_marker_name.clone(),
        target_digit: pending_jump.target_digit,
        trigger: pending_jump_trigger_label(&pending_jump.trigger),
        execute_at_seconds: warp_timeline_seconds_at(song, pending_jump.execute_at_seconds),
        transition: transition_type_label(&pending_jump.transition),
    }
}

pub(crate) fn active_vamp_to_summary(active_vamp: &ActiveVamp) -> ActiveVampSummary {
    ActiveVampSummary {
        start_seconds: active_vamp.start_seconds,
        end_seconds: active_vamp.end_seconds,
    }
}

pub(crate) fn active_vamp_to_warped_summary(
    song: &Song,
    active_vamp: &ActiveVamp,
) -> ActiveVampSummary {
    ActiveVampSummary {
        start_seconds: warp_timeline_seconds_at(song, active_vamp.start_seconds),
        end_seconds: warp_timeline_seconds_at(song, active_vamp.end_seconds),
    }
}

pub(crate) fn marker_to_warped_summary(song: &Song, marker: &Marker) -> MarkerSummary {
    MarkerSummary {
        id: marker.id.clone(),
        name: marker.name.clone(),
        start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
        digit: marker.digit,
        kind: marker.kind,
        variant: marker.variant,
    }
}

pub(crate) fn region_to_summary(song: &Song, region: &SongRegion) -> SongRegionSummary {
    SongRegionSummary {
        id: region.id.clone(),
        name: region.name.clone(),
        start_seconds: warp_timeline_seconds_at(song, region.start_seconds),
        end_seconds: warp_timeline_seconds_at(song, region.end_seconds),
        transpose_semitones: region.transpose_semitones,
        warp_enabled: region.warp_enabled,
        warp_source_bpm: region.warp_source_bpm,
        master: SongMasterSummary {
            gain: region.master.gain,
        },
    }
}

fn tempo_marker_to_warped_summary(song: &Song, marker: &TempoMarker) -> TempoMarkerSummary {
    TempoMarkerSummary {
        id: marker.id.clone(),
        start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
        source_start_seconds: marker.start_seconds,
        bpm: marker.bpm,
    }
}

fn time_signature_marker_to_warped_summary(
    song: &Song,
    marker: &TimeSignatureMarker,
) -> TimeSignatureMarkerSummary {
    TimeSignatureMarkerSummary {
        id: marker.id.clone(),
        start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
        signature: marker.signature.clone(),
    }
}

pub(crate) fn musical_position_summary(
    song: &Song,
    position_seconds: f64,
) -> MusicalPositionSummary {
    if song.bpm <= 0.0 {
        return empty_musical_position_summary();
    }
    let clamped_seconds = position_seconds.max(0.0);
    let timing_regions = build_timing_regions(song, clamped_seconds);
    let mut cumulative_bars_start = 0.0_f64;

    for region in &timing_regions {
        let clamped_region_end = clamped_seconds.min(region.end_seconds.max(region.start_seconds));
        if clamped_region_end <= region.start_seconds {
            break;
        }

        let total_beats = cumulative_bars_start * f64::from(region.beats_per_bar)
            + (clamped_region_end - region.start_seconds) / region.beat_duration_seconds;

        if clamped_seconds < region.end_seconds {
            let total_whole_beats = (total_beats + f64::EPSILON).floor() as u64;
            let fractional_beat = (total_beats - total_whole_beats as f64).clamp(0.0, 0.999_999);
            let bar_number = (total_whole_beats / u64::from(region.beats_per_bar)) as u32 + 1;
            let beat_in_bar = (total_whole_beats % u64::from(region.beats_per_bar)) as u32 + 1;
            let sub_beat = (fractional_beat * 100.0).floor().min(99.0) as u32;

            return MusicalPositionSummary {
                bar_number,
                beat_in_bar,
                sub_beat,
                display: format!("{bar_number}.{beat_in_bar}.{sub_beat:02}"),
            };
        }

        cumulative_bars_start = region.cumulative_bars_end;
    }

    let total_beats = timing_regions
        .last()
        .map(|region| region.cumulative_bars_end * f64::from(region.beats_per_bar))
        .unwrap_or(0.0);
    let beats_per_bar = timing_regions
        .last()
        .map(|region| region.beats_per_bar)
        .unwrap_or(4);
    let total_whole_beats = (total_beats + f64::EPSILON).floor() as u64;
    let fractional_beat = (total_beats - total_whole_beats as f64).clamp(0.0, 0.999_999);
    let bar_number = (total_whole_beats / u64::from(beats_per_bar)) as u32 + 1;
    let beat_in_bar = (total_whole_beats % u64::from(beats_per_bar)) as u32 + 1;
    let sub_beat = (fractional_beat * 100.0).floor().min(99.0) as u32;

    MusicalPositionSummary {
        bar_number,
        beat_in_bar,
        sub_beat,
        display: format!("{bar_number}.{beat_in_bar}.{sub_beat:02}"),
    }
}

#[derive(Debug, Clone)]
struct TimingRegion {
    start_seconds: f64,
    end_seconds: f64,
    beats_per_bar: u32,
    beat_duration_seconds: f64,
    cumulative_bars_end: f64,
}

fn build_timing_regions(song: &Song, horizon_seconds: f64) -> Vec<TimingRegion> {
    let mut boundaries = song
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds > 0.0)
        .map(|marker| (marker.start_seconds, Some(marker.bpm), None))
        .chain(
            song.time_signature_markers
                .iter()
                .filter(|marker| marker.start_seconds > 0.0)
                .map(|marker| (marker.start_seconds, None, Some(marker.signature.clone()))),
        )
        .collect::<Vec<_>>();
    boundaries.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut regions = Vec::with_capacity(boundaries.len() + 1);
    let mut start_seconds = 0.0;
    let mut bpm = song.bpm;
    let mut time_signature = song.time_signature.clone();
    let mut cumulative_bars_end = 0.0_f64;

    for (boundary_seconds, boundary_bpm, boundary_signature) in boundaries {
        if boundary_seconds <= start_seconds {
            if let Some(next_bpm) = boundary_bpm {
                bpm = next_bpm;
            }
            if let Some(next_signature) = boundary_signature {
                time_signature = next_signature;
            }
            continue;
        }

        let Ok((beats_per_bar, denominator)) = parse_time_signature(&time_signature) else {
            continue;
        };
        let beat_duration_seconds =
            beat_frames_for_signature(bpm, denominator, TIMELINE_TIMEBASE_HZ) as f64
                / f64::from(TIMELINE_TIMEBASE_HZ);
        let bar_duration_seconds = beat_duration_seconds * f64::from(beats_per_bar);
        cumulative_bars_end += (boundary_seconds - start_seconds).max(0.0) / bar_duration_seconds;
        regions.push(TimingRegion {
            start_seconds,
            end_seconds: boundary_seconds,
            beats_per_bar,
            beat_duration_seconds,
            cumulative_bars_end,
        });
        start_seconds = boundary_seconds;
        if let Some(next_bpm) = boundary_bpm {
            bpm = next_bpm;
        }
        if let Some(next_signature) = boundary_signature {
            time_signature = next_signature;
        }
    }

    let Ok((beats_per_bar, denominator)) = parse_time_signature(&time_signature) else {
        return regions;
    };
    let beat_duration_seconds = beat_frames_for_signature(bpm, denominator, TIMELINE_TIMEBASE_HZ)
        as f64
        / f64::from(TIMELINE_TIMEBASE_HZ);
    let bar_duration_seconds = beat_duration_seconds * f64::from(beats_per_bar);
    cumulative_bars_end +=
        (horizon_seconds.max(start_seconds) - start_seconds).max(0.0) / bar_duration_seconds;
    regions.push(TimingRegion {
        start_seconds,
        end_seconds: horizon_seconds.max(start_seconds),
        beats_per_bar,
        beat_duration_seconds,
        cumulative_bars_end,
    });

    regions
}

fn track_kind_label(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Audio => "audio",
        TrackKind::Folder => "folder",
    }
}

fn track_depth(song: &Song, track_id: &str) -> usize {
    let mut depth = 0_usize;
    let mut cursor = song
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .and_then(|track| track.parent_track_id.as_deref());

    while let Some(parent_track_id) = cursor {
        depth += 1;
        cursor = song
            .tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .and_then(|track| track.parent_track_id.as_deref());
    }

    depth
}

pub(crate) fn empty_musical_position_summary() -> MusicalPositionSummary {
    MusicalPositionSummary {
        bar_number: 1,
        beat_in_bar: 1,
        sub_beat: 0,
        display: "1.1.00".to_string(),
    }
}

fn beat_frames_for_signature(bpm: f64, denominator: u32, sample_rate: u32) -> u64 {
    let safe_bpm = bpm.max(1.0);
    let safe_denominator = denominator.max(1);
    let quarter_note_frames = (f64::from(sample_rate.max(1)) * 60.0) / safe_bpm;
    (quarter_note_frames * (4.0 / f64::from(safe_denominator)))
        .round()
        .max(1.0) as u64
}

fn parse_time_signature(time_signature: &str) -> Result<(u32, u32), DesktopError> {
    let (numerator, denominator) = time_signature
        .split_once('/')
        .ok_or_else(|| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let numerator = numerator
        .parse::<u32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let denominator = denominator
        .parse::<u32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    if numerator == 0 || denominator == 0 {
        return Err(DesktopError::AudioCommand(
            "time signature is invalid".into(),
        ));
    }
    Ok((numerator, denominator))
}

fn pending_jump_trigger_label(trigger: &JumpTrigger) -> String {
    match trigger {
        JumpTrigger::Immediate => "immediate".to_string(),
        JumpTrigger::NextMarker => "next_marker".to_string(),
        JumpTrigger::RegionEnd => "region_end".to_string(),
        JumpTrigger::AfterBars(bars) => format!("after_bars:{bars}"),
    }
}

fn transition_type_label(transition: &TransitionType) -> String {
    match transition {
        TransitionType::Instant => "instant".to_string(),
        TransitionType::FadeOut { duration_seconds } => {
            format!("fade_out:{duration_seconds}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{SongMaster, Track};

    fn track(id: &str, kind: TrackKind, parent: Option<&str>) -> Track {
        Track {
            id: id.into(),
            name: format!("Track {id}"),
            kind,
            parent_track_id: parent.map(|p| p.to_string()),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            color: None,
            auto_created: false,
        }
    }

    fn clip(id: &str, track_id: &str, start: f64, dur: f64, file: &str) -> Clip {
        Clip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: file.into(),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: dur,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(id: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: id.into(),
            name: id.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
        }
    }

    fn base_song() -> Song {
        Song {
            id: "song".into(),
            title: "Title".into(),
            artist: Some("Artist".into()),
            key: Some("C".into()),
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![region("r1", 0.0, 12.0)],
            tracks: vec![track("t1", TrackKind::Audio, None)],
            clips: vec![clip("c1", "t1", 1.0, 4.0, "audio/a.wav")],
            section_markers: vec![Marker {
                id: "m1".into(),
                name: "Intro".into(),
                start_seconds: 2.0,
                digit: Some(1),
                kind: MarkerKind::Custom,
                variant: None,
            }],
        }
    }

    // ── small pure helpers ────────────────────────────────────────────────

    #[test]
    fn waveform_key_normalizes_backslashes() {
        assert_eq!(waveform_key_for_file_path("a\\b\\c.wav"), "a/b/c.wav");
        assert_eq!(waveform_key_for_file_path("a/b.wav"), "a/b.wav");
    }

    #[test]
    fn track_kind_label_maps_each_kind() {
        assert_eq!(track_kind_label(TrackKind::Audio), "audio");
        assert_eq!(track_kind_label(TrackKind::Folder), "folder");
    }

    #[test]
    fn track_depth_counts_the_parent_chain() {
        let mut song = base_song();
        song.tracks = vec![
            track("root", TrackKind::Folder, None),
            track("mid", TrackKind::Folder, Some("root")),
            track("leaf", TrackKind::Audio, Some("mid")),
        ];
        assert_eq!(track_depth(&song, "root"), 0);
        assert_eq!(track_depth(&song, "mid"), 1);
        assert_eq!(track_depth(&song, "leaf"), 2);
        assert_eq!(track_depth(&song, "missing"), 0);
    }

    #[test]
    fn parse_time_signature_accepts_valid_and_rejects_invalid() {
        assert_eq!(parse_time_signature("7/8").unwrap(), (7, 8));
        assert!(parse_time_signature("4").is_err());
        assert!(parse_time_signature("4/0").is_err());
        assert!(parse_time_signature("x/4").is_err());
    }

    #[test]
    fn beat_frames_scale_with_bpm_and_denominator() {
        // 120 bpm, quarter note, 48k -> 60/120 * 48000 = 24000 frames.
        assert_eq!(beat_frames_for_signature(120.0, 4, 48_000), 24_000);
        // Eighth-note beat unit halves the frames.
        assert_eq!(beat_frames_for_signature(120.0, 8, 48_000), 12_000);
        // Guards: never zero.
        assert!(beat_frames_for_signature(0.0, 0, 0) >= 1);
    }

    #[test]
    fn encode_peaks_base64_round_trips_little_endian_f32() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let values = [0.0_f32, 1.0, -0.5];
        let encoded = encode_peaks_base64(&values);
        let decoded = STANDARD.decode(encoded).unwrap();
        assert_eq!(decoded.len(), values.len() * 4);
        let first = f32::from_le_bytes(decoded[0..4].try_into().unwrap());
        assert_eq!(first, 0.0);
        let third = f32::from_le_bytes(decoded[8..12].try_into().unwrap());
        assert_eq!(third, -0.5);
    }

    #[test]
    fn encode_peaks_base64_is_empty_for_no_values() {
        assert_eq!(encode_peaks_base64(&[]), "");
    }

    // ── label helpers ─────────────────────────────────────────────────────

    #[test]
    fn jump_trigger_labels_match_the_frontend_contract() {
        assert_eq!(
            pending_jump_trigger_label(&JumpTrigger::Immediate),
            "immediate"
        );
        assert_eq!(
            pending_jump_trigger_label(&JumpTrigger::NextMarker),
            "next_marker"
        );
        assert_eq!(
            pending_jump_trigger_label(&JumpTrigger::RegionEnd),
            "region_end"
        );
        assert_eq!(
            pending_jump_trigger_label(&JumpTrigger::AfterBars(4)),
            "after_bars:4"
        );
    }

    #[test]
    fn transition_labels_match_the_frontend_contract() {
        assert_eq!(transition_type_label(&TransitionType::Instant), "instant");
        assert_eq!(
            transition_type_label(&TransitionType::FadeOut {
                duration_seconds: 1.5
            }),
            "fade_out:1.5"
        );
    }

    // ── summaries ─────────────────────────────────────────────────────────

    #[test]
    fn region_to_summary_carries_fields_through() {
        let song = base_song();
        let summary = region_to_summary(&song, &song.regions[0]);
        assert_eq!(summary.id, "r1");
        assert_eq!(summary.start_seconds, 0.0);
        assert_eq!(summary.end_seconds, 12.0);
        assert_eq!(summary.master.gain, 1.0);
    }

    #[test]
    fn marker_to_summary_preserves_digit_and_name() {
        let song = base_song();
        let summary = marker_to_warped_summary(&song, &song.section_markers[0]);
        assert_eq!(summary.id, "m1");
        assert_eq!(summary.name, "Intro");
        assert_eq!(summary.digit, Some(1));
        // No warp -> position unchanged.
        assert_eq!(summary.start_seconds, 2.0);
    }

    #[test]
    fn clip_to_summary_derives_track_name_and_marks_missing_files() {
        let song = base_song();
        let cache = WaveformMemoryCache::default();
        let summary = clip_to_summary(&song, &song.clips[0], &cache, None);
        assert_eq!(summary.id, "c1");
        assert_eq!(summary.track_name, "Track t1");
        assert_eq!(summary.waveform_key, "audio/a.wav");
        // The file does not exist on disk -> flagged missing.
        assert!(summary.is_missing);
        // No warp -> source window passes through.
        assert_eq!(summary.source_window_duration_seconds, 4.0);
    }

    #[test]
    fn clip_to_summary_falls_back_to_track_id_when_track_missing() {
        let mut song = base_song();
        song.clips[0].track_id = "ghost".into();
        let cache = WaveformMemoryCache::default();
        let summary = clip_to_summary(&song, &song.clips[0], &cache, None);
        assert_eq!(summary.track_name, "ghost");
    }

    // ── song_to_view ──────────────────────────────────────────────────────

    #[test]
    fn song_to_view_maps_top_level_fields() {
        let song = base_song();
        let cache = WaveformMemoryCache::default();
        let view = song_to_view(
            &song,
            &AutomationDocument::default(),
            &std::collections::HashMap::new(),
            &cache,
            7,
            None,
            false,
        );
        assert_eq!(view.id, "song");
        assert_eq!(view.title, "Title");
        assert_eq!(view.bpm, 120.0);
        assert_eq!(view.project_revision, 7);
        assert_eq!(view.tracks.len(), 1);
        assert_eq!(view.clips.len(), 1);
        assert_eq!(view.regions.len(), 1);
        assert_eq!(view.section_markers.len(), 1);
    }

    #[test]
    fn song_to_view_skips_waveforms_when_not_requested() {
        let song = base_song();
        let cache = WaveformMemoryCache::default();
        let view = song_to_view(
            &song,
            &AutomationDocument::default(),
            &std::collections::HashMap::new(),
            &cache,
            1,
            None,
            false,
        );
        assert!(view.waveforms.is_empty());
    }

    #[test]
    fn song_to_view_duration_covers_the_furthest_clip_and_song_duration() {
        let mut song = base_song();
        // Clip ends at 1 + 4 = 5; song.duration is 12 -> view duration >= 12.
        let view = song_to_view(
            &song,
            &AutomationDocument::default(),
            &std::collections::HashMap::new(),
            &WaveformMemoryCache::default(),
            1,
            None,
            false,
        );
        assert!(view.duration_seconds >= 12.0);

        // Extend a clip past the song duration -> view duration follows it.
        song.clips[0].timeline_start_seconds = 20.0;
        song.clips[0].duration_seconds = 5.0;
        let view = song_to_view(
            &song,
            &AutomationDocument::default(),
            &std::collections::HashMap::new(),
            &WaveformMemoryCache::default(),
            1,
            None,
            false,
        );
        assert!(view.duration_seconds >= 25.0);
    }
}
