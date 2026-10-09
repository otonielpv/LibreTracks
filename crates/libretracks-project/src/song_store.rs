use std::{
    fs,
    path::{Path, PathBuf},
};

use libretracks_core::{
    validate_song, Clip, DomainError, Marker, MarkerKind, Song, SongRegion, TempoMetadata,
    TimeSignatureMarker, Track, TrackKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const SONG_FILE_NAME: &str = "song.ltsession";
/// v8 added `videoClips`. The bump is not needed to read old documents (the
/// field defaults to empty) but to make an older app REFUSE a v8 document:
/// otherwise it would open a session with video and save it back without
/// the clips.
const SONG_FORMAT_VERSION: u32 = 8;

/// A song without video is written as v7 so that 1.12.x still opens it: a
/// session made in 1.13 and moved to a device one release behind was refused
/// although it held nothing that release could not represent.
const NO_VIDEO_SONG_FORMAT_VERSION: u32 = 7;

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
    let song_file = song_file.as_ref();
    let song_dir = song_file.parent().ok_or_else(|| {
        ProjectError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "song file must live inside a folder",
        ))
    })?;
    fs::create_dir_all(song_dir)?;

    let json = serialize_song_document(song)?;
    // Todo o nada: `fs::write` vacia el fichero antes de escribir, y un
    // pendrive quitado justo despues de guardar dejo una sesion de 0 bytes.
    crate::atomic_write::write_file_atomically(song_file, json.as_bytes())?;

    Ok(song_file.to_path_buf())
}

/// Serialize a song into the current versioned on-disk document (the same bytes
/// [`save_song_to_file`] writes), validating it first. Exposed so a `.ltset`
/// export can embed an in-memory session as a valid `session.ltsession` without
/// writing it to the live project folder.
pub fn serialize_song_document(song: &Song) -> Result<String, ProjectError> {
    validate_song(song)?;
    let document = SongDocument {
        version: written_format_version(song),
        song: song.clone(),
    };
    Ok(serde_json::to_string_pretty(&document)?)
}

/// The oldest format that can hold `song` without losing anything. A video
/// track without clips still needs v8: an older reader does not know the
/// `video` track kind.
fn written_format_version(song: &Song) -> u32 {
    let has_video = !song.video_clips.is_empty()
        || song
            .tracks
            .iter()
            .any(|track| track.kind == TrackKind::Video);
    if has_video {
        SONG_FORMAT_VERSION
    } else {
        NO_VIDEO_SONG_FORMAT_VERSION
    }
}

pub fn load_song(song_dir: impl AsRef<Path>) -> Result<Song, ProjectError> {
    load_song_from_file(song_file_path(song_dir))
}

pub fn load_song_from_file(song_file: impl AsRef<Path>) -> Result<Song, ProjectError> {
    let json = fs::read_to_string(song_file)?;
    parse_song_document(&json, SONG_FORMAT_VERSION)
}

/// Parse a song document written by a version of the app whose newest format
/// was `newest_known_version`. Anything newer is rejected, never read with its
/// unknown fields dropped. Taking the version as an argument lets the tests
/// play an older reader against a newer document.
pub(crate) fn parse_song_document(json: &str, newest_known_version: u32) -> Result<Song, ProjectError> {
    let raw_document: Value = serde_json::from_str(json)?;
    reject_legacy_group_format(&raw_document)?;
    match document_version(&raw_document)? {
        version if version > newest_known_version => {
            Err(ProjectError::UnsupportedVersion(version))
        }
        SONG_FORMAT_VERSION => {
            let document: SongDocument = serde_json::from_str(json)?;
            load_current_song(document.song)
        }
        7 => {
            // v7 is v8 without `videoClips`; `#[serde(default)]` fills the
            // empty list and the next save writes v8.
            let document: SongDocument = serde_json::from_str(json)?;
            load_current_song(document.song)
        }
        6 => {
            // v6 is v7 without `midiClips`; `#[serde(default)]` on the field
            // fills the empty list, so the document parses as-is and only the
            // stored version number changes on the next save.
            let document: SongDocument = serde_json::from_str(json)?;
            load_current_song(document.song)
        }
        5 => {
            // v5 had the same on-disk shape as v6 but predates the
            // "clip lives inside one region" invariant. Deserialize as
            // `Song`, run the tolerant region-fitting pass, and validate.
            let document: SongDocument = serde_json::from_str(json)?;
            migrate_v5_song(document.song)
        }
        4 => {
            let legacy_document: LegacySongDocumentV4 = serde_json::from_str(json)?;
            migrate_v4_song(legacy_document)
        }
        3 => {
            let legacy_document: LegacySongDocumentV3 = serde_json::from_str(json)?;
            migrate_v3_song(legacy_document)
        }
        2 => {
            let legacy_document: LegacySongDocumentV2 = serde_json::from_str(json)?;
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
            color: None,
            // Legacy sessions predate draggable lanes too: no marker was ever
            // moved out of its kind's lane.
            category_override: None,
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
        key: document.key.clone(),
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
            key: document.key.clone(),
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            structure: None,
        }],
        tracks: document.tracks,
        clips: document.clips,
        midi_clips: vec![],
        video_clips: vec![],
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
        key: document.key.clone(),
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
            key: document.key.clone(),
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            structure: None,
        }],
        tracks: document.tracks,
        clips: document.clips,
        midi_clips: vec![],
        video_clips: vec![],
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
        midi_clips: vec![],
        video_clips: vec![],
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
                    key: None,
                    warp_enabled: false,
                    warp_source_bpm: None,
                    master: libretracks_core::SongMaster::default(),
                    compact_column_width_rem: None,
                    chart: None,
                    structure: None,
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
                key: None,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
                compact_column_width_rem: None,
                chart: None,
                structure: None,
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

    /// Una sesión sin arreglos se guarda byte a byte igual que antes de que
    /// existiera `SongRegion.structure`. El fichero de referencia se generó
    /// con el código anterior a ese campo, guardando la sesión de demo.
    #[test]
    fn a_session_without_structure_saves_exactly_as_before() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/src-tauri/resources/demo/song.ltsession"
        );
        let song = load_song_from_file(fixture).expect("load demo");
        let saved = serialize_song_document(&song).expect("serialize");
        let golden = include_str!("../tests/fixtures/demo_song_golden.ltsession");
        assert_eq!(saved, golden);
    }

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
                mono_downmix: false,
                color: None,
                auto_created: false,
                midi_port: None,
                midi_channel: 1,
                midi_enabled: true,
                collapsed: false,
                height_offset: None,
            }],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![],
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
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            structure: None,
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

    #[test]
    fn loading_v6_song_without_midi_clips_migrates_to_v7() {
        // A project saved before MIDI tracks existed: no `midiClips` key at
        // all. It must load with an empty list rather than being rejected as
        // an unsupported version.
        let v6_json = r#"{
            "version": 6,
            "id": "song_test",
            "title": "Pre-MIDI",
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
                "endSeconds": 30.0,
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
            "clips": [],
            "sectionMarkers": []
        }"#;

        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("song.ltsession");
        std::fs::write(&path, v6_json).expect("write json");

        let song = load_song_from_file(&path).expect("v6 song must load");
        assert!(song.midi_clips.is_empty());
        validate_song(&song).expect("migrated song must satisfy invariants");
    }

    /// A folder the user collapsed must still be collapsed after reopening the
    /// session — before the flag was persisted it lived only in frontend state,
    /// so every folder came back expanded.
    #[test]
    fn folder_collapsed_state_round_trips_through_save_and_load() {
        let mut song = base_song();
        song.tracks.push(libretracks_core::Track {
            id: "folder1".into(),
            name: "Rhythm".into(),
            kind: TrackKind::Folder,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: true,
            height_offset: None,
        });

        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song with a collapsed folder");
        let loaded = load_song(dir.path()).expect("reload song");

        let folder = loaded
            .tracks
            .iter()
            .find(|track| track.id == "folder1")
            .expect("folder track survives the round trip");
        assert!(folder.collapsed, "collapsed folder must reload collapsed");
        // Non-folder tracks stay false; the flag is meaningless on them.
        let audio = loaded
            .tracks
            .iter()
            .find(|track| track.id == "t1")
            .expect("audio track");
        assert!(!audio.collapsed);
    }

    /// A track the user made taller than the rest must come back that tall.
    /// Same reasoning as the collapsed flag above: it is view state, but view
    /// state the user set deliberately and expects to find again.
    #[test]
    fn track_height_offset_round_trips_through_save_and_load() {
        let mut song = base_song();
        song.tracks[0].height_offset = Some(140);

        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song with a resized track");
        let loaded = load_song(dir.path()).expect("reload song");

        assert_eq!(loaded.tracks[0].height_offset, Some(140));
    }

    /// Sessions written before the field existed must still load, with every
    /// track on the global height rather than failing to parse.
    #[test]
    fn songs_without_the_height_offset_field_follow_the_global_height() {
        let song = base_song();
        assert_eq!(song.tracks[0].height_offset, None);

        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song");
        let raw = std::fs::read_to_string(dir.path().join("song.ltsession"))
            .expect("read back the saved session");
        assert!(
            !raw.contains("heightOffset"),
            "a track on the global height must not write the field at all",
        );

        let loaded = load_song(dir.path()).expect("reload song");
        assert_eq!(loaded.tracks[0].height_offset, None);
    }

    /// Sessions written before the field existed must still load, with every
    /// folder treated as expanded rather than failing to parse.
    #[test]
    fn songs_without_the_collapsed_field_default_to_expanded() {
        let mut song = base_song();
        song.tracks[0].kind = TrackKind::Folder;

        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song");

        // Strip the field the way an older LibreTracks would have written it.
        let song_path = dir.path().join(SONG_FILE_NAME);
        let raw = std::fs::read_to_string(&song_path).expect("read song file");
        let mut document: serde_json::Value =
            serde_json::from_str(&raw).expect("song file is json");
        for track in document["tracks"]
            .as_array_mut()
            .expect("tracks is an array")
        {
            track
                .as_object_mut()
                .expect("track is an object")
                .remove("collapsed");
        }
        std::fs::write(&song_path, document.to_string()).expect("rewrite song file");

        let loaded = load_song(dir.path()).expect("legacy song still loads");
        assert!(!loaded.tracks[0].collapsed);
    }

    #[test]
    fn midi_clips_round_trip_through_save_and_load() {
        let mut song = base_song();
        song.tracks.push(libretracks_core::Track {
            id: "midi1".into(),
            name: "Lights".into(),
            kind: TrackKind::Midi,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: Some("loopMIDI Port 2".into()),
            midi_channel: 3,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        });
        song.midi_clips.push(libretracks_core::MidiClip {
            id: "mc1".into(),
            track_id: "midi1".into(),
            timeline_start_seconds: 12.5,
            name: "Chorus lights".into(),
            events: vec![
                libretracks_core::MidiEvent {
                    id: "e1".into(),
                    at_seconds: 0.0,
                    // No channel: inherits the track's (3).
                    channel: None,
                    kind: libretracks_core::MidiEventKind::ProgramChange { program: 7 },
                },
                libretracks_core::MidiEvent {
                    id: "e2".into(),
                    at_seconds: 0.25,
                    // Explicit override, so both cases round-trip.
                    channel: Some(10),
                    kind: libretracks_core::MidiEventKind::ControlCurve {
                        controller: 74,
                        from_value: 0,
                        to_value: 127,
                        duration_seconds: 8.0,
                    },
                },
            ],
            color: None,
        });

        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song with midi clips");
        let loaded = load_song(dir.path()).expect("reload song with midi clips");

        assert_eq!(loaded.midi_clips, song.midi_clips);
        // Inherited (None) must not be persisted as a concrete channel, or the
        // track's channel would stop governing the event after a reload.
        assert_eq!(loaded.midi_clips[0].events[0].channel, None);
        assert_eq!(loaded.midi_clips[0].events[1].channel, Some(10));
        let midi_track = loaded
            .tracks
            .iter()
            .find(|track| track.id == "midi1")
            .expect("midi track");
        assert_eq!(midi_track.midi_port.as_deref(), Some("loopMIDI Port 2"));
        assert_eq!(midi_track.midi_channel, 3);
        assert_eq!(
            loaded
                .tracks
                .iter()
                .find(|track| track.id == "midi1")
                .map(|track| track.kind),
            Some(TrackKind::Midi)
        );
    }

    fn video_track(id: &str, name: &str) -> libretracks_core::Track {
        libretracks_core::Track {
            id: id.into(),
            name: name.into(),
            kind: TrackKind::Video,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    fn video_clip(
        id: &str,
        track_id: &str,
        start: f64,
        fit: Option<libretracks_core::VideoFit>,
    ) -> libretracks_core::VideoClip {
        libretracks_core::VideoClip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: format!("D:/Visuales/{id}.mp4"),
            timeline_start_seconds: start,
            source_start_seconds: 1.5,
            duration_seconds: 6.0,
            fade_in_seconds: Some(0.5),
            fade_out_seconds: Some(1.0),
            fit,
            color: Some("#ff8800".into()),
        }
    }

    fn song_with_video() -> Song {
        use libretracks_core::VideoFit;
        let mut song = base_song();
        song.tracks.push(video_track("v1", "Letras"));
        song.tracks.push(video_track("v2", "Fondos"));
        song.video_clips = vec![
            video_clip("vc1", "v1", 0.0, Some(VideoFit::Contain)),
            video_clip("vc2", "v1", 8.0, None),
            video_clip("vc3", "v2", 2.0, Some(VideoFit::Stretch)),
        ];
        song
    }

    /// C1 del paso 03 del plan de vídeo.
    #[test]
    fn video_clips_round_trip_through_save_and_load() {
        let song = song_with_video();
        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song with video clips");
        let loaded = load_song(dir.path()).expect("reload song with video clips");

        assert_eq!(loaded, song);
        let raw: Value = serde_json::from_str(
            &std::fs::read_to_string(song_file_path(dir.path())).expect("read saved file"),
        )
        .expect("saved file is json");
        assert_eq!(raw["version"], 8);
        assert_eq!(raw["videoClips"][0]["fit"], "contain");
        // `None` = inherit the output's fit, and must stay absent on disk.
        assert!(raw["videoClips"][1].get("fit").is_none());
        assert_eq!(raw["tracks"][1]["kind"], "video");
    }

    /// C2: a real v7 document shipped in the repo opens with no video clips
    /// and, having no video, is saved back as the same v7 document.
    #[test]
    fn real_v7_document_without_video_saves_back_as_v7() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources/demo/song.ltsession");
        let v7_json = std::fs::read_to_string(&fixture).expect("demo fixture");
        let v7_raw: Value = serde_json::from_str(&v7_json).expect("fixture is json");
        assert_eq!(v7_raw["version"], 7, "the fixture must stay a v7 document");

        let song = load_song_from_file(&fixture).expect("v7 document loads");
        assert!(song.video_clips.is_empty());

        let saved = serialize_song_document(&song).expect("serialize");
        let saved_raw: Value = serde_json::from_str(&saved).expect("saved is json");
        assert_eq!(saved_raw["version"], 7);
        assert!(saved_raw.get("videoClips").is_none());

        let reread = parse_song_document(&saved, 7).expect("a v7 reader opens it");
        assert_eq!(reread, song);
    }

    /// A session saved by 1.13 without video must open in 1.12.x (a v7
    /// reader). It used to be written as v8 and refused.
    #[test]
    fn a_v7_reader_opens_a_song_without_video_saved_by_the_current_app() {
        let song = base_song();
        let dir = tempfile::tempdir().expect("temp dir");
        save_song(dir.path(), &song).expect("save song");
        let json = std::fs::read_to_string(song_file_path(dir.path())).expect("read saved file");
        let raw: Value = serde_json::from_str(&json).expect("saved file is json");
        assert_eq!(raw["version"], 7);
        assert!(raw.get("videoClips").is_none());

        let loaded = parse_song_document(&json, 7).expect("a v7 reader opens it");
        assert_eq!(loaded, song);
    }

    /// A video track without clips still needs v8: an older reader does not
    /// know the `video` track kind and would fail or drop the track.
    #[test]
    fn a_video_track_without_clips_is_still_written_as_v8() {
        let mut song = base_song();
        song.tracks.push(video_track("v1", "Letras"));
        let json = serialize_song_document(&song).expect("serialize");
        let raw: Value = serde_json::from_str(&json).expect("json");
        assert_eq!(raw["version"], 8);
        assert!(matches!(
            parse_song_document(&json, 7),
            Err(ProjectError::UnsupportedVersion(8))
        ));
    }

    /// C3: a reader that only knows v7 must refuse a v8 document with video
    /// instead of reading it without the clips (and later saving it so).
    #[test]
    fn a_v7_reader_rejects_a_v8_document_with_video() {
        let json = serialize_song_document(&song_with_video()).expect("serialize");
        match parse_song_document(&json, 7) {
            Err(ProjectError::UnsupportedVersion(8)) => {}
            other => panic!("a v7 reader must reject v8, got {other:?}"),
        }
        // The current reader, of course, accepts it.
        let song = parse_song_document(&json, SONG_FORMAT_VERSION).expect("v8 reader");
        assert_eq!(song.video_clips.len(), 3);
    }
}
