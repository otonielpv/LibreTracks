use base64::{engine::general_purpose::STANDARD, Engine as _};
use libretracks_audio::{ActiveVamp, JumpTrigger, PendingMarkerJump, TransitionType};
use libretracks_core::{
    audible_clip_duration_seconds, warp_timeline_seconds_at, Clip, Marker, Song, SongRegion,
    TempoMarker, TimeSignatureMarker, TrackKind,
};
use libretracks_project::{WaveformLod, WaveformSummary};
use serde::Serialize;
use std::collections::HashSet;

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
    pub active_vamp: Option<ActiveVampSummary>,
    pub musical_position: MusicalPositionSummary,
    pub transport_clock: TransportClockSummary,
    pub pitch: PitchPrepareSummary,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportClockSummary {
    pub anchor_position_seconds: f64,
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
    pub waveforms: Vec<WaveformSummaryDto>,
    pub project_revision: u64,
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
            })
            .collect(),
        waveforms,
        project_revision,
    }
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
