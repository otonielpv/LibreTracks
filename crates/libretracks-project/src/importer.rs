use std::{
    collections::HashSet,
    fs::File,
    path::{Path, PathBuf},
    thread,
    time::Instant,
};

use libretracks_core::{validate_song, Clip, OutputBus, Song, SongRegion, Track, TrackKind};
use rayon::prelude::*;
use symphonia::core::{
    codecs::CODEC_TYPE_NULL, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions,
    probe::Hint,
};

use crate::{create_song_folder, save_song, ProjectError, TempoCandidate};

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
pub struct AudioMetadata {
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_seconds: f64,
    pub tempo_candidate: Option<TempoCandidate>,
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
pub struct ImportedLibraryAsset {
    pub source_path: PathBuf,
    pub imported_relative_path: PathBuf,
    pub duration_seconds: f64,
    pub detected_bpm: Option<f64>,
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportLibraryAssetsResult {
    pub assets: Vec<ImportedLibraryAsset>,
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

pub fn read_audio_metadata(path: impl AsRef<Path>) -> Result<AudioMetadata, ProjectError> {
    let path = path.as_ref();
    let file = File::open(path)?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| ProjectError::UnsupportedAudioFormat {
            path: path.to_path_buf(),
        })?;
    let format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| ProjectError::UnsupportedAudioFormat {
            path: path.to_path_buf(),
        })?;
    let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
        ProjectError::AudioDecode(format!("missing sample rate for {}", path.display()))
    })?;
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .unwrap_or(1)
        .max(1);
    let duration_seconds =
        if let (Some(n_frames), rate) = (track.codec_params.n_frames, sample_rate) {
            n_frames as f64 / f64::from(rate.max(1))
        } else if let Some(tb) = track.codec_params.time_base {
            track
                .codec_params
                .n_frames
                .map(|frames| {
                    tb.calc_time(frames).seconds as f64 + f64::from(tb.calc_time(frames).frac)
                })
                .unwrap_or(0.0)
        } else {
            0.0
        };

    Ok(AudioMetadata {
        channels,
        sample_rate,
        duration_seconds,
        tempo_candidate: None,
    })
}

pub type WavMetadata = AudioMetadata;

pub fn read_wav_metadata(path: impl AsRef<Path>) -> Result<AudioMetadata, ProjectError> {
    read_audio_metadata(path)
}

pub fn import_wav_files_to_library(
    song_dir: impl AsRef<Path>,
    audio_files: &[PathBuf],
    mut on_progress: impl FnMut(u8, String),
) -> Result<ImportLibraryAssetsResult, ProjectError> {
    if audio_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = song_dir.as_ref();
    let mut metrics = ImportOperationMetrics::default();
    metrics.copy_millis = 0;
    announce_probe_progress(audio_files, &mut on_progress);
    let planned_files = plan_import_files(audio_files)?;
    let (imported_files, analysis_metrics) =
        analyze_import_files_in_parallel(song_dir, planned_files)?;
    merge_import_metrics(&mut metrics, &analysis_metrics);

    let assets = imported_files
        .into_iter()
        .map(|file| ImportedLibraryAsset {
            source_path: file.source_path,
            imported_relative_path: file.imported_relative_path,
            duration_seconds: file.metadata.duration_seconds,
            detected_bpm: file.metadata.tempo_candidate.map(|tempo| tempo.bpm),
            folder_path: None,
        })
        .collect();

    Ok(ImportLibraryAssetsResult { assets, metrics })
}

pub fn import_wav_song(
    root: impl AsRef<Path>,
    folder_name: &str,
    request: &ProjectImportRequest,
    mut on_progress: impl FnMut(u8, String),
) -> Result<ImportedSong, ProjectError> {
    if request.wav_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = create_song_folder(root, folder_name)?;
    let mut metrics = ImportOperationMetrics::default();
    metrics.copy_millis = 0;
    announce_probe_progress(&request.wav_files, &mut on_progress);
    let planned_files = plan_import_files(&request.wav_files)?;
    let (analyzed_files, analysis_metrics) =
        analyze_import_files_in_parallel(&song_dir, planned_files)?;
    merge_import_metrics(&mut metrics, &analysis_metrics);

    let mut imported_files = Vec::with_capacity(analyzed_files.len());
    let mut duration_seconds = 0.0_f64;

    for analyzed_file in &analyzed_files {
        duration_seconds = duration_seconds.max(analyzed_file.metadata.duration_seconds);

        let stem = analyzed_file
            .source_path
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

    let detected_tempo = request
        .bpm
        .map(|bpm| ResolvedTempo { bpm })
        .unwrap_or_else(|| resolve_import_tempo(&analyzed_files));

    let song = Song {
        id: request.song_id.clone(),
        title: request.title.clone(),
        artist: request.artist.clone(),
        key: request.key.clone(),
        bpm: detected_tempo.bpm,
        time_signature: request.time_signature.clone(),
        duration_seconds,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: format!("region_{}", slugify(&request.title)),
            name: request.title.clone(),
            start_seconds: 0.0,
            end_seconds: duration_seconds,
        }],
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
                file_path: file.source_path.to_string_lossy().replace('\\', "/"),
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
    audio_files: &[PathBuf],
    mut on_progress: impl FnMut(u8, String),
) -> Result<AppendWavFilesResult, ProjectError> {
    if audio_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = song_dir.as_ref();
    let mut next_song = song.clone();
    let mut used_track_ids: HashSet<String> =
        song.tracks.iter().map(|track| track.id.clone()).collect();
    let mut used_clip_ids: HashSet<String> =
        song.clips.iter().map(|clip| clip.id.clone()).collect();
    let mut metrics = ImportOperationMetrics::default();
    metrics.copy_millis = 0;
    announce_probe_progress(audio_files, &mut on_progress);
    let planned_files = plan_import_files(audio_files)?;
    let (analyzed_files, analysis_metrics) =
        analyze_import_files_in_parallel(song_dir, planned_files)?;
    merge_import_metrics(&mut metrics, &analysis_metrics);

    for analyzed_file in analyzed_files {
        let stem = analyzed_file
            .source_path
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
                .source_path
                .to_string_lossy()
                .replace('\\', "/"),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: analyzed_file.metadata.duration_seconds,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
        });

        let new_duration = next_song
            .duration_seconds
            .max(analyzed_file.metadata.duration_seconds);

        next_song.duration_seconds = new_duration;
    }

    validate_song(&next_song)?;
    Ok(AppendWavFilesResult {
        song: next_song,
        metrics,
    })
}

#[derive(Debug, Clone)]
struct PlannedImportFile {
    index: usize,
    source_path: PathBuf,
    imported_relative_path: PathBuf,
}

#[derive(Debug, Clone)]
struct AnalyzedImportFile {
    index: usize,
    source_path: PathBuf,
    imported_relative_path: PathBuf,
    metadata: AudioMetadata,
}

fn plan_import_files(audio_files: &[PathBuf]) -> Result<Vec<PlannedImportFile>, ProjectError> {
    audio_files
        .iter()
        .enumerate()
        .map(|(index, source_path)| {
            let absolute_path = source_path
                .canonicalize()
                .unwrap_or_else(|_| source_path.clone());
            Ok(PlannedImportFile {
                index,
                source_path: absolute_path.clone(),
                imported_relative_path: absolute_path,
            })
        })
        .collect()
}

fn announce_probe_progress(audio_files: &[PathBuf], on_progress: &mut impl FnMut(u8, String)) {
    let total = audio_files.len().max(1);
    for (index, source_path) in audio_files.iter().enumerate() {
        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_else(|| source_path.to_str().unwrap_or("audio"));
        let percent = 10 + (((index + 1) * 20) / total) as u8;
        on_progress(
            percent,
            format!(
                "Analizando archivo {} de {}: {}",
                index + 1,
                total,
                file_name
            ),
        );
    }
}

fn analyze_import_files_in_parallel(
    _song_dir: &Path,
    planned_files: Vec<PlannedImportFile>,
) -> Result<(Vec<AnalyzedImportFile>, ImportOperationMetrics), ProjectError> {
    if planned_files.is_empty() {
        return Ok((Vec::new(), ImportOperationMetrics::default()));
    }

    let worker_count = planned_files.len().min(
        thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1),
    );

    let mut metrics = ImportOperationMetrics {
        analysis_workers: worker_count,
        ..ImportOperationMetrics::default()
    };
    let mut analyzed_files = Vec::new();
    let mut collected_results = planned_files
        .into_par_iter()
        .map(|next_file| {
            let analysis_started_at = Instant::now();
            let metadata = read_audio_metadata(&next_file.source_path)?;
            let wav_analysis_millis = analysis_started_at.elapsed().as_millis();
            let waveform_write_millis = 0;

            Ok((
                next_file,
                metadata,
                wav_analysis_millis,
                waveform_write_millis,
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    collected_results.sort_by_key(|(planned, _, _, _)| planned.index);

    for (planned_file, metadata, wav_analysis_millis, waveform_write_millis) in collected_results {
        metrics.wav_analysis_millis += wav_analysis_millis;
        metrics.waveform_write_millis += waveform_write_millis;
        analyzed_files.push(AnalyzedImportFile {
            index: planned_file.index,
            source_path: planned_file.source_path,
            imported_relative_path: planned_file.imported_relative_path,
            metadata,
        });
    }

    analyzed_files.sort_by_key(|file| file.index);
    Ok((analyzed_files, metrics))
}

#[derive(Debug, Clone)]
struct ResolvedTempo {
    bpm: f64,
}

fn resolve_import_tempo(analyzed_files: &[AnalyzedImportFile]) -> ResolvedTempo {
    let best_candidate = analyzed_files
        .iter()
        .filter_map(|file| {
            file.metadata
                .tempo_candidate
                .as_ref()
                .map(|tempo_candidate| (file, tempo_candidate))
        })
        .max_by(
            |(left_file, left_candidate), (right_file, right_candidate)| {
                import_file_priority(&left_file.imported_relative_path)
                    .cmp(&import_file_priority(&right_file.imported_relative_path))
                    .then_with(|| {
                        left_candidate
                            .confidence
                            .partial_cmp(&right_candidate.confidence)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            },
        );

    match best_candidate {
        Some((_file, tempo_candidate)) => ResolvedTempo {
            bpm: tempo_candidate.bpm,
        },
        None => ResolvedTempo { bpm: 120.0 },
    }
}

fn import_file_priority(path: &Path) -> u8 {
    let normalized = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if normalized.contains("guide click") {
        5
    } else if normalized.contains("click") {
        4
    } else if normalized.contains("met") || normalized.contains("metro") {
        3
    } else if normalized.contains("guide") {
        2
    } else if normalized.contains("drum") {
        1
    } else {
        0
    }
}

fn merge_import_metrics(target: &mut ImportOperationMetrics, source: &ImportOperationMetrics) {
    target.copy_millis += source.copy_millis;
    target.wav_analysis_millis += source.wav_analysis_millis;
    target.waveform_write_millis += source.waveform_write_millis;
    target.song_save_millis += source.song_save_millis;
    target.analysis_workers = target.analysis_workers.max(source.analysis_workers);
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
