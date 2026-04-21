use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};

use libretracks_core::{
    validate_song, Clip, OutputBus, Song, TempoMetadata, TempoSource, Track, TrackKind,
};

use crate::{
    analyze_wav_file, create_song_folder, save_song, waveform_file_path_for_source,
    write_waveform_summary, ProjectError,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectImportRequest {
    pub song_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub bpm: Option<f64>,
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
    pub metrics: ImportOperationMetrics,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppendWavFilesResult {
    pub song: Song,
    pub metrics: ImportOperationMetrics,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportOperationMetrics {
    pub copy_millis: u128,
    pub wav_analysis_millis: u128,
    pub waveform_write_millis: u128,
    pub song_save_millis: u128,
    pub analysis_workers: usize,
}

pub fn read_wav_metadata(path: impl AsRef<Path>) -> Result<WavMetadata, ProjectError> {
    let path = path.as_ref();
    ensure_wav_extension(path)?;
    let analysis = analyze_wav_file(path)?;

    Ok(WavMetadata {
        channels: analysis.channels,
        sample_rate: analysis.sample_rate,
        duration_seconds: analysis.duration_seconds,
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
    let mut metrics = ImportOperationMetrics::default();
    let planned_files = plan_import_files(&song_dir, &request.wav_files, &mut HashSet::new())?;
    metrics.copy_millis = copy_import_files(&planned_files)?;
    let (analyzed_files, analysis_metrics) = analyze_import_files_in_parallel(planned_files)?;
    merge_import_metrics(&mut metrics, &analysis_metrics);

    let mut imported_files = Vec::with_capacity(analyzed_files.len());
    let mut duration_seconds = 0.0_f64;

    for analyzed_file in &analyzed_files {
        duration_seconds = duration_seconds.max(analyzed_file.metadata.duration_seconds);

        let stem = analyzed_file
            .destination_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ProjectError::InvalidFileName(analyzed_file.source_path.clone()))?;
        let track_slug = slugify(stem);

        imported_files.push(ImportedAudioFile {
            source_path: analyzed_file.source_path.clone(),
            imported_relative_path: analyzed_file.imported_relative_path.clone(),
            track_id: format!("track_{track_slug}"),
            clip_id: format!("clip_{track_slug}"),
            track_name: humanize_track_name(stem),
            duration_seconds: analyzed_file.metadata.duration_seconds,
        });
    }

    let song = Song {
        id: request.song_id.clone(),
        title: request.title.clone(),
        artist: request.artist.clone(),
        bpm: request.bpm.unwrap_or(120.0),
        tempo_metadata: TempoMetadata {
            source: if request.bpm.is_some() {
                TempoSource::Manual
            } else {
                TempoSource::AutoImport
            },
            confidence: None,
            reference_file_path: None,
        },
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
        section_markers: vec![],
    };

    validate_song(&song)?;
    let save_started_at = Instant::now();
    save_song(&song_dir, &song)?;
    metrics.song_save_millis = save_started_at.elapsed().as_millis();

    Ok(ImportedSong {
        song_dir,
        song,
        imported_files,
        metrics,
    })
}

pub fn append_wav_files_to_song(
    song_dir: impl AsRef<Path>,
    song: &Song,
    wav_files: &[PathBuf],
) -> Result<AppendWavFilesResult, ProjectError> {
    if wav_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = song_dir.as_ref();
    let mut next_song = song.clone();
    let mut used_file_names = collect_used_file_names(song_dir, song)?;
    let mut used_track_ids: HashSet<String> =
        song.tracks.iter().map(|track| track.id.clone()).collect();
    let mut used_clip_ids: HashSet<String> = song.clips.iter().map(|clip| clip.id.clone()).collect();
    let mut metrics = ImportOperationMetrics::default();
    let planned_files = plan_import_files(song_dir, wav_files, &mut used_file_names)?;
    metrics.copy_millis = copy_import_files(&planned_files)?;
    let (analyzed_files, analysis_metrics) = analyze_import_files_in_parallel(planned_files)?;
    merge_import_metrics(&mut metrics, &analysis_metrics);

    for analyzed_file in analyzed_files {
        let stem = analyzed_file
            .destination_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ProjectError::InvalidFileName(analyzed_file.source_path.clone()))?;
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
            file_path: analyzed_file
                .imported_relative_path
                .to_string_lossy()
                .replace('\\', "/"),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: analyzed_file.metadata.duration_seconds,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
        });

        next_song.duration_seconds = next_song
            .duration_seconds
            .max(analyzed_file.metadata.duration_seconds);
    }

    validate_song(&next_song)?;
    Ok(AppendWavFilesResult {
        song: next_song,
        metrics,
    })
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

#[derive(Debug, Clone)]
struct PlannedImportFile {
    index: usize,
    source_path: PathBuf,
    destination_path: PathBuf,
    imported_relative_path: PathBuf,
}

#[derive(Debug, Clone)]
struct AnalyzedImportFile {
    index: usize,
    source_path: PathBuf,
    destination_path: PathBuf,
    imported_relative_path: PathBuf,
    metadata: WavMetadata,
}

fn plan_import_files(
    song_dir: &Path,
    wav_files: &[PathBuf],
    used_file_names: &mut HashSet<String>,
) -> Result<Vec<PlannedImportFile>, ProjectError> {
    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    wav_files
        .iter()
        .enumerate()
        .map(|(index, source_path)| {
            ensure_wav_extension(source_path)?;
            let file_name = unique_file_name(source_path, used_file_names)?;
            let destination_path = audio_dir.join(&file_name);
            Ok(PlannedImportFile {
                index,
                source_path: source_path.clone(),
                imported_relative_path: PathBuf::from("audio").join(&file_name),
                destination_path,
            })
        })
        .collect()
}

fn copy_import_files(planned_files: &[PlannedImportFile]) -> Result<u128, ProjectError> {
    let started_at = Instant::now();

    for planned_file in planned_files {
        fs::copy(&planned_file.source_path, &planned_file.destination_path)?;
    }

    Ok(started_at.elapsed().as_millis())
}

fn analyze_import_files_in_parallel(
    planned_files: Vec<PlannedImportFile>,
) -> Result<(Vec<AnalyzedImportFile>, ImportOperationMetrics), ProjectError> {
    if planned_files.is_empty() {
        return Ok((Vec::new(), ImportOperationMetrics::default()));
    }

    let worker_count = planned_files
        .len()
        .min(thread::available_parallelism().map(|count| count.get()).unwrap_or(1))
        .min(4);
    let queue = Arc::new(Mutex::new(VecDeque::from(planned_files)));
    let results = Arc::new(Mutex::new(Vec::new()));
    let first_error = Arc::new(Mutex::new(None));

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let results = Arc::clone(&results);
            let first_error = Arc::clone(&first_error);

            scope.spawn(move || loop {
                let next_file = {
                    let mut queue = queue.lock().expect("import queue lock should not poison");
                    queue.pop_front()
                };

                let Some(next_file) = next_file else {
                    break;
                };

                let analysis_started_at = Instant::now();
                let analysis = match analyze_wav_file(&next_file.destination_path) {
                    Ok(analysis) => analysis,
                    Err(error) => {
                        let mut first_error =
                            first_error.lock().expect("error lock should not poison");
                        if first_error.is_none() {
                            *first_error = Some(error);
                        }
                        break;
                    }
                };
                let wav_analysis_millis = analysis_started_at.elapsed().as_millis();

                let waveform_write_started_at = Instant::now();
                let waveform_path = waveform_file_path_for_source(&next_file.destination_path);
                if let Err(error) = write_waveform_summary(&waveform_path, &analysis.waveform) {
                    let mut first_error = first_error.lock().expect("error lock should not poison");
                    if first_error.is_none() {
                        *first_error = Some(error);
                    }
                    break;
                }
                let waveform_write_millis = waveform_write_started_at.elapsed().as_millis();

                let metadata = WavMetadata {
                    channels: analysis.channels,
                    sample_rate: analysis.sample_rate,
                    duration_seconds: analysis.duration_seconds,
                };

                results
                    .lock()
                    .expect("results lock should not poison")
                    .push((next_file, metadata, wav_analysis_millis, waveform_write_millis));
            });
        }
    });

    if let Some(error) = first_error.lock().expect("error lock should not poison").take() {
        return Err(error);
    }

    let mut metrics = ImportOperationMetrics {
        analysis_workers: worker_count,
        ..ImportOperationMetrics::default()
    };
    let mut analyzed_files = Vec::new();
    let mut collected_results = results
        .lock()
        .expect("results lock should not poison")
        .drain(..)
        .collect::<Vec<_>>();
    collected_results.sort_by_key(|(planned, _, _, _)| planned.index);

    for (planned_file, metadata, wav_analysis_millis, waveform_write_millis) in collected_results {
        metrics.wav_analysis_millis += wav_analysis_millis;
        metrics.waveform_write_millis += waveform_write_millis;
        analyzed_files.push(AnalyzedImportFile {
            index: planned_file.index,
            source_path: planned_file.source_path,
            destination_path: planned_file.destination_path,
            imported_relative_path: planned_file.imported_relative_path,
            metadata,
        });
    }

    analyzed_files.sort_by_key(|file| file.index);
    Ok((analyzed_files, metrics))
}

fn merge_import_metrics(target: &mut ImportOperationMetrics, source: &ImportOperationMetrics) {
    target.copy_millis += source.copy_millis;
    target.wav_analysis_millis += source.wav_analysis_millis;
    target.waveform_write_millis += source.waveform_write_millis;
    target.song_save_millis += source.song_save_millis;
    target.analysis_workers = target.analysis_workers.max(source.analysis_workers);
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
