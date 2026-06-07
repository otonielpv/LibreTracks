use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use libretracks_core::{Clip, Song, SongRegion, TempoMarker, TimeSignatureMarker, Track};
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
            folder_path: None,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageLibraryAssetEntry {
    pub file_path: String,
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
    region_transpose_semitones: i32,
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
    /// True when the package bundles the source audio files (under `audio/` in
    /// the zip), making it self-contained and portable to another machine.
    /// Absent/false in light packages that only reference audio by path.
    #[serde(default)]
    bundled_audio: bool,
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
    /// Audio files bundled in a self-contained package, keyed by their original
    /// file name. Empty for light packages. The caller copies these into the
    /// destination project's `audio/` folder and re-points the imported clips.
    pub bundled_audio: std::collections::HashMap<String, Vec<u8>>,
}

pub fn export_region_as_package(
    cache_root: &Path,
    song_dir: &Path,
    song: &Song,
    region_id: &str,
    output_path: &Path,
    include_audio: bool,
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
        region_transpose_semitones: region.transpose_semitones,
        tracks,
        clips: clips.clone(),
        section_markers,
        tempo_markers,
        time_signature_markers,
        library_meta,
        bundled_audio: include_audio,
    };

    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let waveform_options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    zip.write_all(serde_json::to_vec_pretty(&manifest)?.as_slice())?;

    let mut added_files = HashSet::new();
    for clip in &clips {
        if !added_files.insert(clip.file_path.clone()) {
            continue;
        }
        let source_abs = if Path::new(&clip.file_path).is_absolute() {
            PathBuf::from(&clip.file_path)
        } else {
            song_dir.join(&clip.file_path)
        };

        // Full packages bundle the source audio so they open on another machine
        // without the original file. Stored under `audio/<file_name>`; the import
        // copies it into the destination project's `audio/` folder and re-points
        // the clip. Independent of the waveform below — a source we can't analyse
        // for peaks should still ship its audio.
        if include_audio {
            if let Some(file_name) = source_abs.file_name().and_then(|value| value.to_str()) {
                if let Ok(audio_bytes) = fs::read(&source_abs) {
                    zip.start_file(format!("audio/{file_name}"), waveform_options)
                        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
                    zip.write_all(&audio_bytes)?;
                }
            }
        }

        // Bundle the waveform so the package opens instantly on another machine.
        // Resolve (and, if missing, generate) it in the per-file global cache,
        // then ship the encoded `.ltpeaks` bytes from disk. A failure here only
        // skips this clip's waveform, not its audio.
        if crate::load_or_generate_global_waveform(cache_root, song_dir, Path::new(&clip.file_path))
            .is_err()
        {
            continue;
        }
        let waveform_path = crate::global_waveform_file_path(cache_root, &source_abs);
        let Ok(waveform_bytes) = fs::read(&waveform_path) else {
            continue;
        };
        let stem = Path::new(&clip.file_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("waveform");
        zip.start_file(
            format!("waveforms/{stem}.waveform.ltpeaks"),
            waveform_options,
        )
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        zip.write_all(&waveform_bytes)?;
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
    if !(libretracks_core::MIN_TRANSPOSE_SEMITONES..=libretracks_core::MAX_TRANSPOSE_SEMITONES)
        .contains(&manifest.region_transpose_semitones)
    {
        return Err(ProjectError::AudioDecode(format!(
            "invalid region transpose semitones: {}",
            manifest.region_transpose_semitones
        )));
    }
    let library_meta = manifest.library_meta.clone();

    // The package still ships its `.ltpeaks`; we extract them into the legacy
    // project staging dir. The waveform loader's lazy migration then copies each
    // into the per-file global cache the first time the clip is loaded (keyed by
    // the audio's path+size+mtime on THIS machine), so a freshly imported
    // package opens without re-analysing on the destination.
    let waveform_dir = song_dir.join("cache").join("waveforms");
    fs::create_dir_all(&waveform_dir)?;

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

    let mut bundled_audio: std::collections::HashMap<String, Vec<u8>> =
        std::collections::HashMap::new();
    for index in 0..archive.len() {
        let mut zip_file = archive
            .by_index(index)
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        let entry_name = zip_file.name().to_string();

        // Bundled source audio (full packages): keep the bytes for the caller to
        // place into the destination project's audio/ folder.
        if let Some(file_name) = entry_name
            .strip_prefix("audio/")
            .filter(|name| !name.is_empty() && !name.contains('/') && !name.contains('\\'))
        {
            let file_name = file_name.to_string();
            let mut bytes = Vec::new();
            zip_file.read_to_end(&mut bytes)?;
            bundled_audio.insert(file_name, bytes);
            continue;
        }

        let file_name = match entry_name
            .strip_prefix("waveforms/")
            .filter(|file_name| !file_name.is_empty() && !file_name.contains('/'))
        {
            Some(file_name) => file_name.to_string(),
            None => {
                continue;
            }
        };
        if file_name.contains('\\') {
            continue;
        }
        let destination_path = waveform_dir.join(&file_name);
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
            transpose_enabled: track.transpose_enabled,
            audio_to: "master".to_string(),
            color: track.color.clone(),
            auto_created: false,
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
        next_song.clips.push(Clip {
            id: clip_id,
            track_id: target_track_id,
            file_path: clip.file_path.clone(),
            timeline_start_seconds: clip.timeline_start_seconds + insert_at_seconds,
            source_start_seconds: clip.source_start_seconds,
            duration_seconds: clip.duration_seconds,
            gain: clip.gain,
            fade_in_seconds: clip.fade_in_seconds,
            fade_out_seconds: clip.fade_out_seconds,
            color: clip.color.clone(),
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

    // Region span has to cover every clip that landed inside it, not
    // just the manifest's nominal duration. Older packages were
    // exported with a region length that didn't always account for
    // clips extending past region.end_seconds (the exporter filters
    // by timeline_start only), so taking the max of "manifest length"
    // and "furthest clip end among the freshly-inserted clips" keeps
    // imports of those packages valid against the engine's
    // "clip-must-live-inside-its-region" invariant.
    let imported_clip_count = manifest.clips.len();
    let furthest_clip_end_offset = next_song
        .clips
        .iter()
        .rev()
        .take(imported_clip_count)
        .map(|clip| (clip.timeline_start_seconds + clip.duration_seconds) - insert_at_seconds)
        .fold(0.0_f64, f64::max);
    let region_span = manifest.duration_seconds.max(furthest_clip_end_offset);
    next_song.regions.push(SongRegion {
        id: format!("region_import_{}", timestamp_suffix()),
        name: manifest.song_title.clone(),
        start_seconds: insert_at_seconds,
        end_seconds: insert_at_seconds + region_span,
        transpose_semitones: manifest.region_transpose_semitones,
        warp_enabled: false,
        warp_source_bpm: None,
        master: libretracks_core::SongMaster::default(),
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
        .max(insert_at_seconds + region_span);

    Ok(SongPackageImportResult {
        song: next_song,
        package_title: manifest.song_title,
        library_meta,
        bundled_audio,
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

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{validate_song, SongMaster, TrackKind};
    use tempfile::tempdir;

    fn track(id: &str, name: &str) -> Track {
        Track {
            id: id.into(),
            name: name.into(),
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
        }
    }

    fn clip(id: &str, track_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: "audio/loop.wav".into(),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(id: &str, name: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: id.into(),
            name: name.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
        }
    }

    fn song() -> Song {
        Song {
            id: "s".into(),
            title: "Set".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![region("r1", "Verse", 0.0, 30.0)],
            tracks: vec![track("t1", "Drums")],
            clips: vec![clip("c1", "t1", 4.0, 8.0)],
            section_markers: vec![libretracks_core::Marker {
                id: "m1".into(),
                name: "Drop".into(),
                start_seconds: 5.0,
                digit: None,
            }],
        }
    }

    #[test]
    fn normalize_package_file_path_uses_forward_slashes() {
        assert_eq!(
            normalize_package_file_path("a\\b\\c.wav"),
            "a/b/c.wav".to_string()
        );
    }

    #[test]
    fn unique_id_appends_a_suffix_only_on_collision() {
        let mut used = HashSet::new();
        assert_eq!(unique_id("clip", "abc", &mut used), "clip_abc");
        assert_eq!(unique_id("clip", "abc", &mut used), "clip_abc-1");
        assert_eq!(unique_id("clip", "abc", &mut used), "clip_abc-2");
    }

    #[test]
    fn song_bpm_at_returns_the_latest_marker_value() {
        let mut s = song();
        s.tempo_markers = vec![
            TempoMarker { id: "a".into(), start_seconds: 0.0, bpm: 100.0 },
            TempoMarker { id: "b".into(), start_seconds: 10.0, bpm: 140.0 },
        ];
        assert_eq!(song_bpm_at(&s, 5.0), 100.0);
        assert_eq!(song_bpm_at(&s, 12.0), 140.0);
        // No marker at-or-before -> base bpm.
        s.tempo_markers.clear();
        assert_eq!(song_bpm_at(&s, 5.0), 120.0);
    }

    #[test]
    fn song_time_signature_at_returns_the_latest_marker_value() {
        let mut s = song();
        s.time_signature_markers = vec![TimeSignatureMarker {
            id: "ts".into(),
            start_seconds: 8.0,
            signature: "3/4".into(),
        }];
        assert_eq!(song_time_signature_at(&s, 4.0), "4/4");
        assert_eq!(song_time_signature_at(&s, 10.0), "3/4");
    }

    #[test]
    fn export_then_import_round_trips_into_a_valid_song() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let source = song();
        let package_path = song_dir.join("verse.ltsong");

        export_region_as_package(song_dir, song_dir, &source, "r1", &package_path, false)
            .expect("export region");
        assert!(package_path.exists());

        // Import into a fresh empty session at offset 0.
        let empty = Song {
            tracks: vec![],
            clips: vec![],
            regions: vec![],
            section_markers: vec![],
            ..song()
        };
        let result = import_song_package(song_dir, &empty, &package_path, 0.0)
            .expect("import package");

        assert_eq!(result.package_title, "Verse");
        // The drums track and its clip came across.
        assert_eq!(result.song.tracks.len(), 1);
        assert_eq!(result.song.clips.len(), 1);
        assert_eq!(result.song.regions.len(), 1);
        // The imported region must span the clip so the song stays valid.
        assert!(validate_song(&result.song).is_ok());
    }

    #[test]
    fn full_export_bundles_audio_and_import_exposes_it() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let source = song();

        // The clip references audio/loop.wav (relative to song_dir); create it so
        // the exporter can bundle its bytes. Content is opaque to bundling.
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
        fs::write(song_dir.join("audio").join("loop.wav"), b"RIFF....fake-wav-bytes")
            .expect("write fake audio");

        let package_path = song_dir.join("verse.ltpkg");
        export_region_as_package(song_dir, song_dir, &source, "r1", &package_path, true)
            .expect("export full");

        // The archive must contain an audio/ entry and the manifest flag.
        let file = File::open(&package_path).expect("open pkg");
        let mut archive = ZipArchive::new(file).expect("zip");
        let mut has_audio = false;
        for i in 0..archive.len() {
            let name = archive.by_index(i).expect("entry").name().to_string();
            if name.starts_with("audio/") {
                has_audio = true;
            }
        }
        assert!(has_audio, "full package must bundle audio/");

        // Import surfaces the bundled bytes keyed by original file name.
        let empty = Song {
            tracks: vec![],
            clips: vec![],
            regions: vec![],
            section_markers: vec![],
            ..song()
        };
        let target = tempdir().expect("target");
        let result = import_song_package(target.path(), &empty, &package_path, 0.0)
            .expect("import full");
        assert_eq!(result.bundled_audio.len(), 1);
        assert!(result.bundled_audio.contains_key("loop.wav"));
    }

    #[test]
    fn light_export_does_not_bundle_audio() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let source = song();
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
        fs::write(song_dir.join("audio").join("loop.wav"), b"fake").expect("audio");

        let package_path = song_dir.join("verse.ltpkg");
        export_region_as_package(song_dir, song_dir, &source, "r1", &package_path, false)
            .expect("export light");

        let target = tempdir().expect("target");
        let empty = Song {
            tracks: vec![],
            clips: vec![],
            regions: vec![],
            section_markers: vec![],
            ..song()
        };
        let result = import_song_package(target.path(), &empty, &package_path, 0.0)
            .expect("import light");
        assert!(result.bundled_audio.is_empty());
    }

    #[test]
    fn import_offsets_clips_and_markers_by_insert_position() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let source = song();
        let package_path = song_dir.join("verse.ltsong");
        export_region_as_package(song_dir, song_dir, &source, "r1", &package_path, false)
            .expect("export");

        let empty = Song {
            tracks: vec![],
            clips: vec![],
            regions: vec![],
            section_markers: vec![],
            ..song()
        };
        let result = import_song_package(song_dir, &empty, &package_path, 100.0)
            .expect("import");

        // Original clip started at 4s within the region; inserted at 100s it
        // should now sit at 104s.
        assert!((result.song.clips[0].timeline_start_seconds - 104.0).abs() < 1e-6);
        assert!(result.song.regions[0].start_seconds >= 100.0);
    }

    #[test]
    fn import_rejects_out_of_range_transpose() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let mut source = song();
        source.regions[0].transpose_semitones = 99; // beyond MAX
        let package_path = song_dir.join("bad.ltsong");
        export_region_as_package(song_dir, song_dir, &source, "r1", &package_path, false)
            .expect("export");

        let empty = Song {
            tracks: vec![],
            clips: vec![],
            regions: vec![],
            section_markers: vec![],
            ..song()
        };
        assert!(import_song_package(song_dir, &empty, &package_path, 0.0).is_err());
    }

    #[test]
    fn export_errors_for_an_unknown_region() {
        let dir = tempdir().expect("tempdir");
        let result = export_region_as_package(
            dir.path(),
            dir.path(),
            &song(),
            "nonexistent",
            &dir.path().join("x.ltsong"),
            false,
        );
        assert!(result.is_err());
    }
}
