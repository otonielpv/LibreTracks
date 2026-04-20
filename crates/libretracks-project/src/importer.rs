use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use hound::WavReader;
use libretracks_core::{validate_song, Clip, OutputBus, Song, Track, TrackKind};

use crate::{create_song_folder, generate_waveform_summary, save_song, ProjectError};

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectImportRequest {
    pub song_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub bpm: f64,
    pub key: Option<String>,
    pub time_signature: String,
    pub wav_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WavMetadata {
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedAudioFile {
    pub source_path: PathBuf,
    pub imported_relative_path: PathBuf,
    pub track_id: String,
    pub clip_id: String,
    pub track_name: String,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedSong {
    pub song_dir: PathBuf,
    pub song: Song,
    pub imported_files: Vec<ImportedAudioFile>,
}

pub fn read_wav_metadata(path: impl AsRef<Path>) -> Result<WavMetadata, ProjectError> {
    let path = path.as_ref();
    ensure_wav_extension(path)?;

    let reader = WavReader::open(path)?;
    let spec = reader.spec();

    Ok(WavMetadata {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        duration_seconds: reader.duration() as f64 / f64::from(spec.sample_rate),
    })
}

pub fn import_wav_song(
    root: impl AsRef<Path>,
    folder_name: &str,
    request: &ProjectImportRequest,
) -> Result<ImportedSong, ProjectError> {
    if request.wav_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = create_song_folder(root, folder_name)?;
    let audio_dir = song_dir.join("audio");

    let mut imported_files = Vec::with_capacity(request.wav_files.len());
    let mut used_file_names = HashSet::new();
    let mut duration_seconds = 0.0_f64;

    for source_path in &request.wav_files {
        ensure_wav_extension(source_path)?;
        let metadata = read_wav_metadata(source_path)?;
        duration_seconds = duration_seconds.max(metadata.duration_seconds);

        let file_name = unique_file_name(source_path, &mut used_file_names)?;
        let destination_path = audio_dir.join(&file_name);
        fs::copy(source_path, &destination_path)?;
        let imported_relative_path = PathBuf::from("audio").join(&file_name);
        generate_waveform_summary(&song_dir, &imported_relative_path)?;

        let stem = destination_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ProjectError::InvalidFileName(source_path.clone()))?;
        let track_slug = slugify(stem);

        imported_files.push(ImportedAudioFile {
            source_path: source_path.clone(),
            imported_relative_path,
            track_id: format!("track_{track_slug}"),
            clip_id: format!("clip_{track_slug}"),
            track_name: humanize_track_name(stem),
            duration_seconds: metadata.duration_seconds,
        });
    }

    let song = Song {
        id: request.song_id.clone(),
        title: request.title.clone(),
        artist: request.artist.clone(),
        bpm: request.bpm,
        key: request.key.clone(),
        time_signature: request.time_signature.clone(),
        duration_seconds,
        tracks: imported_files
            .iter()
            .map(|file| Track {
                id: file.track_id.clone(),
                name: file.track_name.clone(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                output_bus_id: OutputBus::Main.id(),
            })
            .collect(),
        clips: imported_files
            .iter()
            .map(|file| Clip {
                id: file.clip_id.clone(),
                track_id: file.track_id.clone(),
                file_path: file.imported_relative_path.to_string_lossy().replace('\\', "/"),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: file.duration_seconds,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            })
            .collect(),
        sections: vec![],
    };

    validate_song(&song)?;
    save_song(&song_dir, &song)?;

    Ok(ImportedSong {
        song_dir,
        song,
        imported_files,
    })
}

pub fn append_wav_files_to_song(
    song_dir: impl AsRef<Path>,
    song: &Song,
    wav_files: &[PathBuf],
) -> Result<Song, ProjectError> {
    if wav_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = song_dir.as_ref();
    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut next_song = song.clone();
    let mut used_file_names = collect_used_file_names(song_dir, song)?;
    let mut used_track_ids: HashSet<String> =
        song.tracks.iter().map(|track| track.id.clone()).collect();
    let mut used_clip_ids: HashSet<String> = song.clips.iter().map(|clip| clip.id.clone()).collect();

    for source_path in wav_files {
        ensure_wav_extension(source_path)?;
        let metadata = read_wav_metadata(source_path)?;

        let file_name = unique_file_name(source_path, &mut used_file_names)?;
        let destination_path = audio_dir.join(&file_name);
        fs::copy(source_path, &destination_path)?;
        let imported_relative_path = PathBuf::from("audio").join(&file_name);
        generate_waveform_summary(song_dir, &imported_relative_path)?;

        let stem = destination_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ProjectError::InvalidFileName(source_path.clone()))?;
        let track_slug = slugify(stem);
        let track_id = unique_entity_id("track", &track_slug, &mut used_track_ids);
        let clip_id = unique_entity_id("clip", &track_slug, &mut used_clip_ids);

        next_song.tracks.push(Track {
            id: track_id.clone(),
            name: humanize_track_name(stem),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            output_bus_id: OutputBus::Main.id(),
        });

        next_song.clips.push(Clip {
            id: clip_id,
            track_id,
            file_path: imported_relative_path.to_string_lossy().replace('\\', "/"),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: metadata.duration_seconds,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
        });

        next_song.duration_seconds = next_song.duration_seconds.max(metadata.duration_seconds);
    }

    validate_song(&next_song)?;
    Ok(next_song)
}

fn ensure_wav_extension(path: &Path) -> Result<(), ProjectError> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
    if extension.eq_ignore_ascii_case("wav") {
        Ok(())
    } else {
        Err(ProjectError::UnsupportedAudioFormat {
            path: path.to_path_buf(),
        })
    }
}

fn unique_file_name(
    source_path: &Path,
    used_file_names: &mut HashSet<String>,
) -> Result<String, ProjectError> {
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ProjectError::InvalidFileName(source_path.to_path_buf()))?;
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ProjectError::InvalidFileName(source_path.to_path_buf()))?;

    let base_slug = slugify(stem);
    let mut index = 0_u32;

    loop {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let candidate = format!("{base_slug}{suffix}.{extension}");

        if used_file_names.insert(candidate.clone()) {
            return Ok(candidate);
        }

        index += 1;
    }
}

fn collect_used_file_names(song_dir: &Path, song: &Song) -> Result<HashSet<String>, ProjectError> {
    let mut used_file_names = HashSet::new();

    for clip in &song.clips {
        if let Some(file_name) = Path::new(&clip.file_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            used_file_names.insert(file_name.to_string());
        }
    }

    let audio_dir = song_dir.join("audio");
    if audio_dir.exists() {
        for entry in fs::read_dir(audio_dir)? {
            let entry = entry?;
            if let Some(file_name) = entry.file_name().to_str() {
                used_file_names.insert(file_name.to_string());
            }
        }
    }

    Ok(used_file_names)
}

fn unique_entity_id(prefix: &str, slug: &str, used_ids: &mut HashSet<String>) -> String {
    let mut index = 0_u32;

    loop {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let candidate = format!("{prefix}_{slug}{suffix}");

        if used_ids.insert(candidate.clone()) {
            return candidate;
        }

        index += 1;
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "audio".to_string()
    } else {
        trimmed.to_string()
    }
}

fn humanize_track_name(value: &str) -> String {
    let words: Vec<String> = value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let mut word = String::new();
                    word.push(first.to_ascii_uppercase());
                    word.push_str(&chars.as_str().to_ascii_lowercase());
                    word
                }
                None => String::new(),
            }
        })
        .collect();

    if words.is_empty() {
        "Audio".to_string()
    } else {
        words.join(" ")
    }
}
