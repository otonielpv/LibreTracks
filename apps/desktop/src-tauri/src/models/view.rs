use base64::{engine::general_purpose::STANDARD, Engine as _};
use libretracks_audio::{JumpTrigger, PendingMarkerJump, TransitionType};
use libretracks_core::{Clip, Marker, Song, SongRegion, TempoMarker, TrackKind};
use libretracks_project::{WaveformLod, WaveformSummary};
use serde::Serialize;

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
    pub musical_position: MusicalPositionSummary,
    pub transport_clock: TransportClockSummary,
    pub last_drift_sample: Option<TransportDriftSummary>,
    pub project_revision: u64,
    pub song_dir: Option<String>,
    pub song_file_path: Option<String>,
    pub is_native_runtime: bool,
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
    pub regions: Vec<SongRegionSummary>,
    pub section_markers: Vec<MarkerSummary>,
    pub clips: Vec<ClipSummary>,
    pub tracks: Vec<TrackSummary>,
    pub project_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRegionSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoMarkerSummary {
    pub id: String,
    pub start_seconds: f64,
    pub bpm: f64,
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
    pub timeline_start_seconds: f64,
    pub source_start_seconds: f64,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummaryDto {
    pub waveform_key: String,
    pub version: u32,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub lods: Vec<WaveformLodDto>,
    #[serde(default)]
    pub is_preview: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetSummary {
    pub file_name: String,
    pub file_path: String,
    pub duration_seconds: f64,
    pub detected_bpm: Option<f64>,
    pub folder_path: Option<String>,
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
) -> SongView {
    SongView {
        id: song.id.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        key: song.key.clone(),
        bpm: song.bpm,
        time_signature: song.time_signature.clone(),
        duration_seconds: song.duration_seconds,
        tempo_markers: song
            .tempo_markers
            .iter()
            .map(tempo_marker_to_summary)
            .collect(),
        regions: song.regions.iter().map(region_to_summary).collect(),
        section_markers: song.section_markers.iter().map(marker_to_summary).collect(),
        clips: song
            .clips
            .iter()
            .map(|clip| clip_to_summary(song, clip, waveform_cache))
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
            })
            .collect(),
        project_revision,
    }
}

pub(crate) fn clip_to_summary(
    song: &Song,
    clip: &Clip,
    waveform_cache: &WaveformMemoryCache,
) -> ClipSummary {
    let track_name = song
        .tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .map(|track| track.name.clone())
        .unwrap_or_else(|| clip.track_id.clone());
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
        timeline_start_seconds: clip.timeline_start_seconds,
        source_start_seconds: clip.source_start_seconds,
        source_duration_seconds,
        duration_seconds: clip.duration_seconds,
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
        is_preview: false,
    }
}

fn waveform_lod_to_dto(lod: &WaveformLod) -> WaveformLodDto {
    WaveformLodDto {
        resolution_frames: lod.resolution_frames,
        bucket_count: lod.max_peaks.len(),
        min_peaks_base64: encode_peaks_base64(&lod.min_peaks),
        max_peaks_base64: encode_peaks_base64(&lod.max_peaks),
    }
}

fn encode_peaks_base64(values: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<f32>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    STANDARD.encode(bytes)
}

pub(crate) fn marker_to_summary(marker: &Marker) -> MarkerSummary {
    MarkerSummary {
        id: marker.id.clone(),
        name: marker.name.clone(),
        start_seconds: marker.start_seconds,
        digit: marker.digit,
    }
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

pub(crate) fn region_to_summary(region: &SongRegion) -> SongRegionSummary {
    SongRegionSummary {
        id: region.id.clone(),
        name: region.name.clone(),
        start_seconds: region.start_seconds,
        end_seconds: region.end_seconds,
    }
}

pub(crate) fn tempo_marker_to_summary(marker: &TempoMarker) -> TempoMarkerSummary {
    TempoMarkerSummary {
        id: marker.id.clone(),
        start_seconds: marker.start_seconds,
        bpm: marker.bpm,
    }
}

pub(crate) fn musical_position_summary(
    song: &Song,
    position_seconds: f64,
) -> MusicalPositionSummary {
    let Ok((numerator, denominator)) = parse_time_signature(&song.time_signature) else {
        return empty_musical_position_summary();
    };
    if song.bpm <= 0.0 {
        return empty_musical_position_summary();
    }

    let beats_per_bar = numerator.max(1);
    let clamped_seconds = position_seconds.max(0.0);
    let tempo_regions = build_tempo_regions(song, clamped_seconds);
    let mut total_beats = 0.0_f64;

    for region in tempo_regions {
        let clamped_region_end = clamped_seconds.min(region.end_seconds.max(region.start_seconds));
        if clamped_region_end <= region.start_seconds {
            break;
        }

        let beat_duration_seconds = beat_frames_for_signature(
            region.bpm,
            denominator,
            TIMELINE_TIMEBASE_HZ,
        ) as f64
            / f64::from(TIMELINE_TIMEBASE_HZ);
        total_beats += (clamped_region_end - region.start_seconds) / beat_duration_seconds;

        if clamped_seconds < region.end_seconds {
            let total_whole_beats = (total_beats + f64::EPSILON).floor() as u64;
            let fractional_beat = (total_beats - total_whole_beats as f64).clamp(0.0, 0.999_999);
            let bar_number = (total_whole_beats / u64::from(beats_per_bar)) as u32 + 1;
            let beat_in_bar = (total_whole_beats % u64::from(beats_per_bar)) as u32 + 1;
            let sub_beat = (fractional_beat * 100.0).floor().min(99.0) as u32;

            return MusicalPositionSummary {
                bar_number,
                beat_in_bar,
                sub_beat,
                display: format!("{bar_number}.{beat_in_bar}.{sub_beat:02}"),
            };
        }
    }

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
struct TempoRegion {
    start_seconds: f64,
    end_seconds: f64,
    bpm: f64,
}

fn build_tempo_regions(song: &Song, horizon_seconds: f64) -> Vec<TempoRegion> {
    let mut markers = song
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds > 0.0)
        .collect::<Vec<_>>();
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut regions = Vec::with_capacity(markers.len() + 1);
    let mut start_seconds = 0.0;
    let mut bpm = song.bpm;

    for marker in markers {
        if marker.start_seconds <= start_seconds {
            bpm = marker.bpm;
            continue;
        }

        regions.push(TempoRegion {
            start_seconds,
            end_seconds: marker.start_seconds,
            bpm,
        });
        start_seconds = marker.start_seconds;
        bpm = marker.bpm;
    }

    regions.push(TempoRegion {
        start_seconds,
        end_seconds: horizon_seconds.max(start_seconds),
        bpm,
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

fn seconds_to_timebase_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * f64::from(sample_rate.max(1))).round() as u64
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
