use std::{
    fs,
    path::{Path, PathBuf},
};

use libretracks_core::{
    validate_song, Clip, DomainError, Marker, MarkerKind, Song, SongRegion, TempoMetadata,
    TimeSignatureMarker, Track,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const SONG_FILE_NAME: &str = "song.ltsession";
const SONG_FORMAT_VERSION: u32 = 6;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("song is invalid: {0}")]
    InvalidSong(#[from] DomainError),
    #[error("unsupported song format version: {0}")]
    UnsupportedVersion(u32),
    #[error("song folder name is empty")]
    EmptySongFolderName,
    #[error("wav import requires at least one audio file")]
    EmptyImportSet,
    #[error("unsupported audio format for file: {path}")]
    UnsupportedAudioFormat { path: PathBuf },
    #[error("invalid file name for path: {0}")]
    InvalidFileName(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "Este proyecto usa el formato anterior de grupos y no es compatible con la version actual"
    )]
    LegacyGroupFormatUnsupported,
    #[error("wav error: {0}")]
    Wav(#[from] hound::Error),
    #[error("audio decode error: {0}")]
    AudioDecode(String),
    #[error("waveform summary is invalid or stale: {0}")]
    InvalidWaveformSummary(PathBuf),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongDocument {
    version: u32,
    #[serde(flatten)]
    song: Song,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySongDocumentV2 {
    id: String,
    title: String,
    artist: Option<String>,
    bpm: f64,
    key: Option<String>,
    time_signature: String,
    duration_seconds: f64,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    sections: Vec<LegacySectionV2>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySongDocumentV3 {
    id: String,
    title: String,
    artist: Option<String>,
    bpm: f64,
    #[serde(default)]
    tempo_metadata: TempoMetadata,
    key: Option<String>,
    time_signature: String,
    duration_seconds: f64,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    #[serde(default)]
    section_markers: Vec<Marker>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySongDocumentV4 {
    id: String,
    title: String,
    artist: Option<String>,
    bpm: f64,
    key: Option<String>,
    time_signature: String,
    duration_seconds: f64,
    #[serde(default)]
    tempo_markers: Vec<libretracks_core::TempoMarker>,
    #[serde(default)]
    regions: Vec<SongRegion>,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    #[serde(default)]
    section_markers: Vec<Marker>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySectionV2 {
    id: String,
    name: String,
    start_seconds: f64,
}

pub fn song_file_path(song_dir: impl AsRef<Path>) -> PathBuf {
    song_dir.as_ref().join(SONG_FILE_NAME)
}

pub fn create_song_folder(
    root: impl AsRef<Path>,
    folder_name: &str,
) -> Result<PathBuf, ProjectError> {
    let trimmed = folder_name.trim();
    if trimmed.is_empty() {
        return Err(ProjectError::EmptySongFolderName);
    }

    let song_dir = root.as_ref().join(trimmed);
    fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;

    Ok(song_dir)
}

pub fn save_song(song_dir: impl AsRef<Path>, song: &Song) -> Result<PathBuf, ProjectError> {
    save_song_to_file(song_file_path(song_dir), song)
}

pub fn save_song_to_file(
    song_file: impl AsRef<Path>,
    song: &Song,
) -> Result<PathBuf, ProjectError> {
    validate_song(song)?;

    let song_file = song_file.as_ref();
    let song_dir = song_file.parent().ok_or_else(|| {
        ProjectError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "song file must live inside a folder",
        ))
    })?;
    fs::create_dir_all(song_dir)?;

    let document = SongDocument {
        version: SONG_FORMAT_VERSION,
        song: song.clone(),
    };

    let json = serde_json::to_string_pretty(&document)?;
    fs::write(song_file, json)?;

    Ok(song_file.to_path_buf())
}

pub fn load_song(song_dir: impl AsRef<Path>) -> Result<Song, ProjectError> {
    load_song_from_file(song_file_path(song_dir))
}

pub fn load_song_from_file(song_file: impl AsRef<Path>) -> Result<Song, ProjectError> {
    let json = fs::read_to_string(song_file)?;
    let raw_document: Value = serde_json::from_str(&json)?;
    reject_legacy_group_format(&raw_document)?;
    match document_version(&raw_document)? {
        SONG_FORMAT_VERSION => {
            let document: SongDocument = serde_json::from_str(&json)?;
            load_current_song(document.song)
        }
        5 => {
            // v5 had the same on-disk shape as v6 but predates the
            // "clip lives inside one region" invariant. Deserialize as
            // `Song`, run the tolerant region-fitting pass, and validate.
            let document: SongDocument = serde_json::from_str(&json)?;
            migrate_v5_song(document.song)
        }
        4 => {
            let legacy_document: LegacySongDocumentV4 = serde_json::from_str(&json)?;
            migrate_v4_song(legacy_document)
        }
        3 => {
            let legacy_document: LegacySongDocumentV3 = serde_json::from_str(&json)?;
            migrate_v3_song(legacy_document)
        }
        2 => {
            let legacy_document: LegacySongDocumentV2 = serde_json::from_str(&json)?;
            migrate_v2_song(legacy_document)
        }
        version => Err(ProjectError::UnsupportedVersion(version)),
    }
}

fn document_version(document: &Value) -> Result<u32, ProjectError> {
    document
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ProjectError::UnsupportedVersion(0))
}

fn migrate_v2_song(document: LegacySongDocumentV2) -> Result<Song, ProjectError> {
    let mut section_markers = document
        .sections
        .into_iter()
        .map(|section| Marker {
            id: section.id,
            name: section.name,
            start_seconds: section.start_seconds,
            digit: None,
            // Legacy v2 sessions predate semantic marker kinds; they carry only
            // free-text names, so they migrate to Custom.
            kind: MarkerKind::Custom,
            variant: None,
        })
        .collect::<Vec<_>>();
    section_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let song = Song {
        id: document.id,
        title: document.title,
        artist: document.artist,
        key: document.key,
        bpm: document.bpm,
        time_signature: document.time_signature.clone(),
        duration_seconds: document.duration_seconds,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: "Song 1".into(),
            start_seconds: 0.0,
            end_seconds: document.duration_seconds,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        }],
        tracks: document.tracks,
        clips: document.clips,
        section_markers,
    };

    validate_song(&song)?;
    Ok(song)
}

fn migrate_v3_song(document: LegacySongDocumentV3) -> Result<Song, ProjectError> {
    let region_name = document.title.clone();
    let song = Song {
        id: document.id,
        title: document.title,
        artist: document.artist,
        key: document.key,
        bpm: document.bpm,
        time_signature: document.time_signature.clone(),
        duration_seconds: document.duration_seconds,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: region_name,
            start_seconds: 0.0,
            end_seconds: document.duration_seconds,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        }],
        tracks: document.tracks,
        clips: document.clips,
        section_markers: document.section_markers,
    };

    let _ = document.tempo_metadata;
    validate_song(&song)?;
    Ok(song)
}

fn migrate_v4_song(document: LegacySongDocumentV4) -> Result<Song, ProjectError> {
    let mut song = Song {
        id: document.id,
        title: document.title,
        artist: document.artist,
        key: document.key,
        bpm: document.bpm,
        time_signature: document.time_signature,
        duration_seconds: document.duration_seconds,
        tempo_markers: document.tempo_markers,
        time_signature_markers: Vec::<TimeSignatureMarker>::new(),
        regions: document.regions,
        tracks: document.tracks,
        clips: document.clips,
        section_markers: document.section_markers,
    };

    fit_regions_to_clips(&mut song);
    validate_song(&song)?;
    Ok(song)
}

/// v5 had the same on-disk shape as v6 but predates the "clip lives inside
/// one region" invariant. Apply the tolerant fitting pass and validate.
fn migrate_v5_song(mut song: Song) -> Result<Song, ProjectError> {
    fit_regions_to_clips(&mut song);
    validate_song(&song)?;
    Ok(song)
}

fn load_current_song(song: Song) -> Result<Song, ProjectError> {
    match validate_song(&song) {
        Ok(()) => Ok(song),
        Err(
            DomainError::ClipCrossesRegionBoundary { .. }
            | DomainError::ClipOutsideAnyRegion { .. },
        ) => {
            let mut repaired = song;
            fit_regions_to_clips(&mut repaired);
            validate_song(&repaired)?;
            Ok(repaired)
        }
        Err(error) => Err(ProjectError::InvalidSong(error)),
    }
}

/// Adjust the song's regions in-place so every clip falls inside exactly one
/// region. The pass is intentionally conservative — it never moves clips,
/// only resizes or creates regions:
///
/// - If a clip starts outside every region, we either extend the closest
///   existing region to engulf the clip's range, or create a new region
///   tightly around it when no neighbour is close enough.
/// - If a clip straddles the boundary between two regions, the earlier of
///   the two regions extends to cover the clip's end, and the later one
///   shifts its start forward by the same amount so the boundary moves with
///   the clip rather than splitting it.
/// - Regions are then sorted by start_seconds and stripped of any zero-or-
///   negative spans that the shifts may have produced.
fn fit_regions_to_clips(song: &mut Song) {
    if song.clips.is_empty() {
        return;
    }

    // Work in start-sorted order so adjacency decisions are deterministic.
    song.regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for clip in song.clips.clone().iter() {
        let clip_start = clip.timeline_start_seconds;
        let clip_end = clip_start + clip.duration_seconds;
        if clip_end <= clip_start {
            continue;
        }

        // Try to find a region that already covers the clip's start.
        if let Some(idx) = song.regions.iter().position(|region| {
            clip_start >= region.start_seconds && clip_start < region.end_seconds
        }) {
            // Extend the containing region forward if the clip overflows.
            if clip_end > song.regions[idx].end_seconds {
                song.regions[idx].end_seconds = clip_end;
                // Push any later regions that would now overlap to start
                // after the new end (their own end stays put unless the
                // shift would invert them — pruned below).
                let new_end = song.regions[idx].end_seconds;
                for region in song.regions.iter_mut().skip(idx + 1) {
                    if region.start_seconds < new_end {
                        region.start_seconds = new_end;
                    }
                }
            }
            continue;
        }

        // Clip is outside every region. Look for the closest neighbour to
        // extend; otherwise insert a fresh region tightly around the clip.
        let preceding_idx = song
            .regions
            .iter()
            .rposition(|region| region.end_seconds <= clip_start);
        let following_idx = song
            .regions
            .iter()
            .position(|region| region.start_seconds >= clip_end);

        match (preceding_idx, following_idx) {
            (Some(pre_idx), Some(fol_idx))
                if clip_start - song.regions[pre_idx].end_seconds
                    <= song.regions[fol_idx].start_seconds - clip_end =>
            {
                song.regions[pre_idx].end_seconds = clip_end;
                if song
                    .regions
                    .get(pre_idx + 1)
                    .is_some_and(|next| next.start_seconds < song.regions[pre_idx].end_seconds)
                {
                    let new_end = song.regions[pre_idx].end_seconds;
                    song.regions[pre_idx + 1].start_seconds = new_end;
                }
            }
            (_, Some(fol_idx)) => {
                song.regions[fol_idx].start_seconds = clip_start;
                if song.regions[fol_idx].end_seconds < clip_end {
                    song.regions[fol_idx].end_seconds = clip_end;
                }
            }
            (Some(pre_idx), None) => {
                song.regions[pre_idx].end_seconds = clip_end;
            }
            (None, None) => {
                song.regions.push(SongRegion {
                    id: format!("region_v5_migrated_{}", song.regions.len()),
                    name: "Cancion".into(),
                    start_seconds: clip_start,
                    end_seconds: clip_end,
                    transpose_semitones: 0,
                    warp_enabled: false,
                    warp_source_bpm: None,
                    master: libretracks_core::SongMaster::default(),
                });
            }
        }

        // Resort after any insertion / shift so the next iteration sees
        // the new layout.
        song.regions.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    // Drop any region whose shift collapsed its span to zero or less.
    song.regions
        .retain(|region| region.end_seconds > region.start_seconds);

    // Final guarantee: if a project somehow had clips but no regions
    // survived, drop a catch-all region covering the whole clip span.
    if song.regions.is_empty() {
        let mut min_start = f64::INFINITY;
        let mut max_end = f64::NEG_INFINITY;
        for clip in &song.clips {
            let end = clip.timeline_start_seconds + clip.duration_seconds;
            if clip.timeline_start_seconds < min_start {
                min_start = clip.timeline_start_seconds;
            }
            if end > max_end {
                max_end = end;
            }
        }
        if max_end > min_start {
            song.regions.push(SongRegion {
                id: "region_v5_migrated_default".into(),
                name: "Cancion".into(),
                start_seconds: min_start,
                end_seconds: max_end,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            });
        }
    }
}

fn reject_legacy_group_format(document: &Value) -> Result<(), ProjectError> {
    let Some(object) = document.as_object() else {
        return Ok(());
    };

    if object.contains_key("groups") {
        return Err(ProjectError::LegacyGroupFormatUnsupported);
    }

    let Some(tracks) = object.get("tracks").and_then(Value::as_array) else {
        return Ok(());
    };

    if tracks.iter().any(|track| {
        track
            .as_object()
            .map(|track| track.contains_key("groupId") || track.contains_key("group_id"))
            .unwrap_or(false)
    }) {
        return Err(ProjectError::LegacyGroupFormatUnsupported);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, SongMaster, Track, TrackKind};

    fn base_song() -> Song {
        Song {
            id: "song_test".into(),
            title: "Test".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![Track {
                id: "t1".into(),
                name: "T1".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".into(),
                color: None,
                auto_created: false,
            }],
            clips: vec![],
            section_markers: vec![],
        }
    }

    fn clip(id: &str, start: f64, dur: f64) -> Clip {
        Clip {
            id: id.into(),
            track_id: "t1".into(),
            file_path: "audio/x.wav".into(),
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

    #[test]
    fn fit_regions_extends_containing_region_to_cover_overflowing_clip() {
        let mut song = base_song();
        song.regions = vec![region("r1", 0.0, 5.0)];
        song.clips = vec![clip("c1", 2.0, 6.0)]; // ends at 8.0, past r1.end=5.0
        fit_regions_to_clips(&mut song);
        assert_eq!(song.regions.len(), 1);
        assert!((song.regions[0].end_seconds - 8.0).abs() < 1e-9);
        validate_song(&song).expect("song must be valid after fitting");
    }

    #[test]
    fn fit_regions_creates_new_region_when_clip_falls_in_empty_timeline() {
        let mut song = base_song();
        song.regions = vec![];
        song.clips = vec![clip("c1", 10.0, 5.0)];
        fit_regions_to_clips(&mut song);
        assert_eq!(song.regions.len(), 1);
        assert!((song.regions[0].start_seconds - 10.0).abs() < 1e-9);
        assert!((song.regions[0].end_seconds - 15.0).abs() < 1e-9);
        validate_song(&song).expect("song must be valid after fitting");
    }

    #[test]
    fn fit_regions_extends_nearest_existing_region_for_clip_between_two() {
        let mut song = base_song();
        song.regions = vec![region("r1", 0.0, 5.0), region("r2", 20.0, 30.0)];
        // Clip is closer to r1 (gap 1.0) than to r2 (gap 12.0)
        song.clips = vec![clip("c1", 6.0, 2.0)];
        fit_regions_to_clips(&mut song);
        let r1 = song.regions.iter().find(|r| r.id == "r1").unwrap();
        assert!((r1.end_seconds - 8.0).abs() < 1e-9);
        validate_song(&song).expect("song must be valid after fitting");
    }

    #[test]
    fn fit_regions_pushes_following_region_when_extension_would_overlap() {
        let mut song = base_song();
        song.regions = vec![region("r1", 0.0, 5.0), region("r2", 6.0, 10.0)];
        // Clip inside r1 extends past r1.end and would land inside r2.
        song.clips = vec![clip("c1", 3.0, 5.0)]; // ends at 8.0
        fit_regions_to_clips(&mut song);
        let r1 = song.regions.iter().find(|r| r.id == "r1").unwrap();
        let r2 = song.regions.iter().find(|r| r.id == "r2").unwrap();
        assert!((r1.end_seconds - 8.0).abs() < 1e-9);
        assert!(r2.start_seconds >= r1.end_seconds);
        validate_song(&song).expect("song must be valid after fitting");
    }

    #[test]
    fn fit_regions_noop_when_song_has_no_clips() {
        let mut song = base_song();
        song.regions = vec![region("r1", 0.0, 5.0)];
        fit_regions_to_clips(&mut song);
        assert_eq!(song.regions.len(), 1);
        assert!((song.regions[0].end_seconds - 5.0).abs() < 1e-9);
    }

    #[test]
    fn loading_v5_song_with_clip_overflow_succeeds_after_tolerant_migration() {
        // Hand-craft a v5 JSON whose clip pokes past the region boundary —
        // the kind of project the old format accepted but v6 rejects.
        let v5_json = r#"{
            "version": 5,
            "id": "song_test",
            "title": "Legacy",
            "artist": null,
            "key": null,
            "bpm": 120.0,
            "timeSignature": "4/4",
            "durationSeconds": 30.0,
            "tempoMarkers": [],
            "timeSignatureMarkers": [],
            "regions": [{
                "id": "r1",
                "name": "Cancion",
                "startSeconds": 0.0,
                "endSeconds": 10.0,
                "transposeSemitones": 0,
                "warpEnabled": false,
                "warpSourceBpm": null
            }],
            "tracks": [{
                "id": "t1",
                "name": "T1",
                "kind": "audio",
                "parentTrackId": null,
                "volume": 1.0,
                "pan": 0.0,
                "muted": false,
                "solo": false,
                "transposeEnabled": true,
                "audioTo": "master"
            }],
            "clips": [{
                "id": "c1",
                "trackId": "t1",
                "filePath": "audio/x.wav",
                "timelineStartSeconds": 5.0,
                "sourceStartSeconds": 0.0,
                "durationSeconds": 20.0,
                "gain": 1.0,
                "fadeInSeconds": null,
                "fadeOutSeconds": null
            }],
            "sectionMarkers": []
        }"#;

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("song.ltsession");
        std::fs::write(&path, v5_json).expect("write json");

        let song = load_song_from_file(&path).expect("v5 song must load via tolerant migration");
        // Region was extended forward to cover the overflowing clip
        // (start kept at 0, end pushed from 10 → 25).
        assert_eq!(song.regions.len(), 1);
        assert!((song.regions[0].start_seconds - 0.0).abs() < 1e-9);
        assert!((song.regions[0].end_seconds - 25.0).abs() < 1e-9);
        validate_song(&song).expect("migrated song must satisfy invariants");
    }

    #[test]
    fn loading_current_song_with_saved_region_boundary_overflow_recovers() {
        let v6_json = r#"{
            "version": 6,
            "id": "song_test",
            "title": "Current",
            "artist": null,
            "key": null,
            "bpm": 120.0,
            "timeSignature": "4/4",
            "durationSeconds": 30.0,
            "tempoMarkers": [],
            "timeSignatureMarkers": [],
            "regions": [{
                "id": "r1",
                "name": "Cancion 1",
                "startSeconds": 0.0,
                "endSeconds": 10.0,
                "transposeSemitones": 0,
                "warpEnabled": false,
                "warpSourceBpm": null
            }, {
                "id": "r2",
                "name": "Cancion 2",
                "startSeconds": 10.5,
                "endSeconds": 20.0,
                "transposeSemitones": 0,
                "warpEnabled": false,
                "warpSourceBpm": null
            }],
            "tracks": [{
                "id": "t1",
                "name": "T1",
                "kind": "audio",
                "parentTrackId": null,
                "volume": 1.0,
                "pan": 0.0,
                "muted": false,
                "solo": false,
                "transposeEnabled": true,
                "audioTo": "master"
            }],
            "clips": [{
                "id": "c1",
                "trackId": "t1",
                "filePath": "audio/x.wav",
                "timelineStartSeconds": 5.0,
                "sourceStartSeconds": 0.0,
                "durationSeconds": 6.0,
                "gain": 1.0,
                "fadeInSeconds": null,
                "fadeOutSeconds": null
            }],
            "sectionMarkers": []
        }"#;

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("song.ltsession");
        std::fs::write(&path, v6_json).expect("write json");

        let song = load_song_from_file(&path).expect("current song must recover boundary overflow");
        let r1 = song
            .regions
            .iter()
            .find(|region| region.id == "r1")
            .expect("first region");
        assert!((r1.end_seconds - 11.0).abs() < 1e-9);
        validate_song(&song).expect("recovered song must satisfy invariants");
    }
}
