use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Cursor, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use libretracks_core::{
    Clip, OutputBus, Song, SongRegion, TempoMarker, TimeSignatureMarker, Track,
};
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use crate::song_store::ProjectError;

fn timestamp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn song_bpm_at(song: &Song, position_seconds: f64) -> f64 {
    song.tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds <= position_seconds + 0.001)
        .max_by(|a, b| {
            a.start_seconds
                .partial_cmp(&b.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|marker| marker.bpm)
        .unwrap_or(song.bpm)
}

fn song_time_signature_at(song: &Song, position_seconds: f64) -> String {
    song.time_signature_markers
        .iter()
        .filter(|marker| marker.start_seconds <= position_seconds + 0.001)
        .max_by(|a, b| {
            a.start_seconds
                .partial_cmp(&b.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|marker| marker.signature.clone())
        .unwrap_or(song.time_signature.clone())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManifest {
    #[serde(default)]
    file_paths: Vec<String>,
    #[serde(default)]
    assets: Vec<PackageLibraryAssetEntry>,
}

fn normalize_package_file_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

fn read_library_meta(song_dir: &Path) -> Result<Vec<PackageLibraryAssetEntry>, ProjectError> {
    let manifest_path = song_dir.join("library.json");
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }

    let manifest = serde_json::from_slice::<LibraryManifest>(&fs::read(manifest_path)?)
        .map_err(ProjectError::from)?;
    if !manifest.assets.is_empty() {
        return Ok(manifest
            .assets
            .into_iter()
            .map(|mut entry| {
                entry.file_path = normalize_package_file_path(&entry.file_path);
                entry.folder_path = entry
                    .folder_path
                    .map(|folder_path| folder_path.replace('\\', "/"));
                entry
            })
            .collect());
    }

    Ok(manifest
        .file_paths
        .into_iter()
        .map(|file_path| PackageLibraryAssetEntry {
            file_path: normalize_package_file_path(&file_path),
            detected_bpm: None,
            folder_path: None,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageLibraryAssetEntry {
    pub file_path: String,
    #[serde(default)]
    pub detected_bpm: Option<f64>,
    #[serde(default)]
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongPackageManifest {
    song_title: String,
    base_bpm: f64,
    base_time_signature: String,
    duration_seconds: f64,
    #[serde(default)]
    tracks: Vec<Track>,
    #[serde(default)]
    clips: Vec<Clip>,
    #[serde(default)]
    section_markers: Vec<libretracks_core::Marker>,
    #[serde(default)]
    tempo_markers: Vec<TempoMarker>,
    #[serde(default)]
    time_signature_markers: Vec<TimeSignatureMarker>,
    #[serde(default)]
    library_meta: Vec<PackageLibraryAssetEntry>,
}

#[derive(Debug, Clone)]
pub struct SongPackageExport {
    pub output_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SongPackageImportResult {
    pub song: Song,
    pub package_title: String,
    pub library_meta: Vec<PackageLibraryAssetEntry>,
}

pub fn export_region_as_package(
    song_dir: &Path,
    song: &Song,
    region_id: &str,
    output_path: &Path,
) -> Result<SongPackageExport, ProjectError> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| ProjectError::AudioDecode(format!("song region not found: {region_id}")))?;
    let region_duration = (region.end_seconds - region.start_seconds).max(0.0);

    let clips = song
        .clips
        .iter()
        .filter(|clip| {
            clip.timeline_start_seconds >= region.start_seconds - 0.01
                && clip.timeline_start_seconds < region.end_seconds
        })
        .cloned()
        .map(|mut clip| {
            clip.timeline_start_seconds -= region.start_seconds;
            clip
        })
        .collect::<Vec<_>>();
    let used_track_ids = clips
        .iter()
        .map(|clip| clip.track_id.as_str())
        .collect::<HashSet<_>>();
    let tracks = song
        .tracks
        .iter()
        .filter(|track| used_track_ids.contains(track.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let section_markers = song
        .section_markers
        .iter()
        .filter(|marker| {
            marker.start_seconds >= region.start_seconds - 0.01
                && marker.start_seconds < region.end_seconds
        })
        .cloned()
        .map(|mut marker| {
            marker.start_seconds -= region.start_seconds;
            marker
        })
        .collect::<Vec<_>>();
    let tempo_markers = song
        .tempo_markers
        .iter()
        .filter(|marker| {
            marker.start_seconds >= region.start_seconds - 0.01
                && marker.start_seconds < region.end_seconds
        })
        .cloned()
        .map(|mut marker| {
            marker.start_seconds -= region.start_seconds;
            marker
        })
        .collect::<Vec<_>>();
    let time_signature_markers = song
        .time_signature_markers
        .iter()
        .filter(|marker| {
            marker.start_seconds >= region.start_seconds - 0.01
                && marker.start_seconds < region.end_seconds
        })
        .cloned()
        .map(|mut marker| {
            marker.start_seconds -= region.start_seconds;
            marker
        })
        .collect::<Vec<_>>();
    let library_meta = {
        let region_name = region.name.clone();
        let library_meta_map = read_library_meta(song_dir)?
            .into_iter()
            .map(|entry| (normalize_package_file_path(&entry.file_path), entry))
            .collect::<HashMap<_, _>>();
        let mut entries = Vec::new();
        let mut added_files = HashSet::new();

        for clip in &clips {
            let normalized_file_path = normalize_package_file_path(&clip.file_path);
            if !added_files.insert(normalized_file_path.clone()) {
                continue;
            }

            let mut entry = library_meta_map
                .get(&normalized_file_path)
                .cloned()
                .unwrap_or(PackageLibraryAssetEntry {
                    file_path: normalized_file_path.clone(),
                    detected_bpm: None,
                    folder_path: None,
                });

            if entry.folder_path.is_none() {
                entry.folder_path = Some(region_name.clone());
            }
            entry.file_path = normalized_file_path;
            entries.push(entry);
        }

        entries
    };

    let manifest = SongPackageManifest {
        song_title: region.name.clone(),
        base_bpm: song.bpm,
        base_time_signature: song.time_signature.clone(),
        duration_seconds: region_duration,
        tracks,
        clips: clips.clone(),
        section_markers,
        tempo_markers,
        time_signature_markers,
        library_meta,
    };

    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let audio_options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    zip.write_all(serde_json::to_vec_pretty(&manifest)?.as_slice())?;

    let mut added_files = HashSet::new();
    for clip in &clips {
        if !added_files.insert(clip.file_path.clone()) {
            continue;
        }
        let source_path = song_dir.join(&clip.file_path);
        zip.start_file(clip.file_path.replace('\\', "/"), audio_options)
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        zip.write_all(&fs::read(source_path)?)?;
    }

    zip.finish()
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    Ok(SongPackageExport {
        output_path: output_path.to_path_buf(),
    })
}

pub fn import_song_package(
    song_dir: &Path,
    song: &Song,
    package_path: &Path,
    insert_at_seconds: f64,
) -> Result<SongPackageImportResult, ProjectError> {
    let file = File::open(package_path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    import_song_package_from_archive(song_dir, song, &mut archive, insert_at_seconds)
}

pub fn import_song_package_from_bytes(
    song_dir: &Path,
    song: &Song,
    package_bytes: &[u8],
    insert_at_seconds: f64,
) -> Result<SongPackageImportResult, ProjectError> {
    let cursor = Cursor::new(package_bytes.to_vec());
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    import_song_package_from_archive(song_dir, song, &mut archive, insert_at_seconds)
}

pub fn import_song_package_from_base64(
    song_dir: &Path,
    song: &Song,
    package_base64: &str,
    insert_at_seconds: f64,
) -> Result<SongPackageImportResult, ProjectError> {
    let package_bytes = general_purpose::STANDARD
        .decode(package_base64)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    import_song_package_from_bytes(song_dir, song, &package_bytes, insert_at_seconds)
}

fn import_song_package_from_archive<R: Read + Seek>(
    song_dir: &Path,
    song: &Song,
    archive: &mut ZipArchive<R>,
    insert_at_seconds: f64,
) -> Result<SongPackageImportResult, ProjectError> {
    let mut manifest_json = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?
        .read_to_string(&mut manifest_json)?;
    let manifest: SongPackageManifest = serde_json::from_str(&manifest_json)?;
    let library_meta = manifest.library_meta.clone();

    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut next_song = song.clone();
    let mut track_ids_by_name = next_song
        .tracks
        .iter()
        .map(|track| (track.name.clone(), track.id.clone()))
        .collect::<HashMap<_, _>>();
    let mut used_track_ids = next_song
        .tracks
        .iter()
        .map(|track| track.id.clone())
        .collect::<HashSet<_>>();
    let mut used_clip_ids = next_song
        .clips
        .iter()
        .map(|clip| clip.id.clone())
        .collect::<HashSet<_>>();
    let insert_at_seconds = insert_at_seconds.max(0.0);
    let is_empty_session = next_song.tracks.is_empty() && next_song.clips.is_empty();

    for clip in &manifest.clips {
        let mut zip_file = archive
            .by_name(&clip.file_path.replace('\\', "/"))
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        let destination_path = audio_dir.join(
            Path::new(&clip.file_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("audio.wav"),
        );
        let mut bytes = Vec::new();
        zip_file.read_to_end(&mut bytes)?;
        fs::write(&destination_path, bytes)?;
    }

    for track in &manifest.tracks {
        if track_ids_by_name.contains_key(&track.name) {
            continue;
        }
        let track_id = unique_id("track", &track.id, &mut used_track_ids);
        next_song.tracks.push(Track {
            id: track_id.clone(),
            name: track.name.clone(),
            kind: track.kind,
            parent_track_id: None,
            volume: track.volume,
            pan: track.pan,
            muted: false,
            solo: false,
            output_bus_id: OutputBus::Main.id(),
        });
        track_ids_by_name.insert(track.name.clone(), track_id);
    }

    for clip in &manifest.clips {
        let source_track = manifest
            .tracks
            .iter()
            .find(|track| track.id == clip.track_id)
            .ok_or_else(|| ProjectError::AudioDecode("package track not found".into()))?;
        let target_track_id = track_ids_by_name
            .get(&source_track.name)
            .cloned()
            .ok_or_else(|| ProjectError::AudioDecode("merged track not found".into()))?;
        let clip_id = unique_id("clip", &clip.id, &mut used_clip_ids);
        let file_name = Path::new(&clip.file_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("audio.wav");
        next_song.clips.push(Clip {
            id: clip_id,
            track_id: target_track_id,
            file_path: format!("audio/{file_name}"),
            timeline_start_seconds: clip.timeline_start_seconds + insert_at_seconds,
            source_start_seconds: clip.source_start_seconds,
            duration_seconds: clip.duration_seconds,
            gain: clip.gain,
            fade_in_seconds: clip.fade_in_seconds,
            fade_out_seconds: clip.fade_out_seconds,
        });
    }

    for marker in &manifest.section_markers {
        let mut marker = marker.clone();
        marker.start_seconds += insert_at_seconds;
        next_song.section_markers.push(marker);
    }
    next_song.section_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    next_song.regions.push(SongRegion {
        id: format!("region_import_{}", timestamp_suffix()),
        name: manifest.song_title.clone(),
        start_seconds: insert_at_seconds,
        end_seconds: insert_at_seconds + manifest.duration_seconds,
    });
    next_song.regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let injected_bpm = manifest
        .tempo_markers
        .first()
        .map(|marker| marker.bpm)
        .unwrap_or(manifest.base_bpm);
    if is_empty_session {
        next_song.bpm = injected_bpm;
    } else if (song_bpm_at(&next_song, insert_at_seconds) - injected_bpm).abs() > 0.001 {
        next_song.tempo_markers.push(TempoMarker {
            id: format!("tempo_marker_import_{}", timestamp_suffix()),
            start_seconds: insert_at_seconds,
            bpm: injected_bpm,
        });
    }
    for marker in &manifest.tempo_markers {
        let mut marker = marker.clone();
        marker.start_seconds += insert_at_seconds;
        if (song_bpm_at(&next_song, marker.start_seconds) - marker.bpm).abs() > 0.001 {
            next_song.tempo_markers.push(marker);
        }
    }
    next_song.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let injected_signature = manifest
        .time_signature_markers
        .first()
        .map(|marker| marker.signature.clone())
        .unwrap_or(manifest.base_time_signature.clone());
    if is_empty_session {
        next_song.time_signature = injected_signature.clone();
    } else if song_time_signature_at(&next_song, insert_at_seconds) != injected_signature {
        next_song.time_signature_markers.push(TimeSignatureMarker {
            id: format!("time_signature_marker_import_{}", timestamp_suffix()),
            start_seconds: insert_at_seconds,
            signature: injected_signature,
        });
    }
    for marker in &manifest.time_signature_markers {
        let mut marker = marker.clone();
        marker.start_seconds += insert_at_seconds;
        if song_time_signature_at(&next_song, marker.start_seconds) != marker.signature {
            next_song.time_signature_markers.push(marker);
        }
    }
    next_song.time_signature_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    next_song.duration_seconds = next_song
        .duration_seconds
        .max(insert_at_seconds + manifest.duration_seconds);

    Ok(SongPackageImportResult {
        song: next_song,
        package_title: manifest.song_title,
        library_meta,
    })
}

fn unique_id(prefix: &str, seed: &str, used: &mut HashSet<String>) -> String {
    let mut index = 0_u32;
    loop {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let candidate = format!("{prefix}_{seed}{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}
