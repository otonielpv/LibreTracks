use std::{
    collections::HashSet,
    fs,
    fs::File,
    path::{Path, PathBuf},
    thread,
    time::Instant,
};

use hound::{SampleFormat, WavSpec, WavWriter};
use libretracks_core::{
    validate_song, Clip, OutputBus, Song, SongRegion, Track, TrackKind,
};
use rayon::prelude::*;
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::{
    analyze_wav_file, create_song_folder, save_song, waveform_file_path_for_source,
    write_waveform_summary, ProjectError, TempoCandidate,
};

const INTERNAL_SAMPLE_RATE: u32 = 48_000;
const INTERNAL_BITS_PER_SAMPLE: u16 = 32;

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

pub fn read_wav_metadata(path: impl AsRef<Path>) -> Result<WavMetadata, ProjectError> {
    let path = path.as_ref();
    ensure_wav_extension(path)?;
    let reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let frame_count = reader.duration() as f64;
    let duration_seconds = frame_count / f64::from(spec.sample_rate.max(1));

    Ok(WavMetadata {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        duration_seconds,
        tempo_candidate: None,
    })
}

pub fn import_wav_files_to_library(
    song_dir: impl AsRef<Path>,
    wav_files: &[PathBuf],
) -> Result<ImportLibraryAssetsResult, ProjectError> {
    if wav_files.is_empty() {
        return Err(ProjectError::EmptyImportSet);
    }

    let song_dir = song_dir.as_ref();
    let mut used_file_names = collect_existing_file_names(song_dir)?;
    let mut metrics = ImportOperationMetrics::default();
    let planned_files = plan_import_files(song_dir, wav_files, &mut used_file_names)?;
    metrics.copy_millis = copy_import_files(&planned_files)?;
    let (imported_files, analysis_metrics) = analyze_import_files_in_parallel(planned_files)?;
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
                file_path: file
                    .imported_relative_path
                    .to_string_lossy()
                    .replace('\\', "/"),
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
    let mut used_clip_ids: HashSet<String> =
        song.clips.iter().map(|clip| clip.id.clone()).collect();
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

        let new_duration = next_song
            .duration_seconds
            .max(analyzed_file.metadata.duration_seconds);

        next_song.duration_seconds = new_duration;

        if let Some(last_region) = next_song.regions.last_mut() {
            if last_region.end_seconds < new_duration {
                last_region.end_seconds = new_duration;
            }
        }
    }

    validate_song(&next_song)?;
    Ok(AppendWavFilesResult {
        song: next_song,
        metrics,
    })
}

fn ensure_wav_extension(path: &Path) -> Result<(), ProjectError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
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
    let base_slug = slugify(stem);
    let mut index = 0_u32;

    loop {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let candidate = format!("{base_slug}{suffix}.wav");

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
        transcode_to_project_wav(&planned_file.source_path, &planned_file.destination_path)?;
    }

    Ok(started_at.elapsed().as_millis())
}

fn transcode_to_project_wav(
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), ProjectError> {
    let file = File::open(source_path)?;
    let mut hint = Hint::new();
    if let Some(extension) = source_path.extension().and_then(|value| value.to_str()) {
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
            path: source_path.to_path_buf(),
        })?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| ProjectError::UnsupportedAudioFormat {
            path: source_path.to_path_buf(),
        })?;

    let track_id = track.id;
    let input_sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
        ProjectError::AudioDecode(format!("missing sample rate for {}", source_path.display()))
    })?;
    let channel_count = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1)
        .max(1);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;

    let mut decoded_samples = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };

        append_decoded_samples(&mut decoded_samples, decoded);
    }

    let normalized_samples = resample_interleaved(
        &decoded_samples,
        channel_count,
        input_sample_rate,
        INTERNAL_SAMPLE_RATE,
    );
    write_normalized_wav(destination_path, &normalized_samples, channel_count as u16)?;
    Ok(())
}

fn append_decoded_samples(target: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
    let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
    sample_buffer.copy_interleaved_ref(decoded);
    target.extend_from_slice(sample_buffer.samples());
}

fn resample_interleaved(
    samples: &[f32],
    channels: usize,
    source_sample_rate: u32,
    target_sample_rate: u32,
) -> Vec<f32> {
    if samples.is_empty() || channels == 0 || source_sample_rate == target_sample_rate {
        return samples.to_vec();
    }

    let source_frame_count = samples.len() / channels;
    if source_frame_count <= 1 {
        return samples.to_vec();
    }

    let ratio = target_sample_rate as f64 / source_sample_rate.max(1) as f64;
    let target_frame_count = ((source_frame_count as f64) * ratio).round().max(1.0) as usize;
    let mut output = vec![0.0_f32; target_frame_count * channels];

    for target_frame in 0..target_frame_count {
        let source_position = target_frame as f64 / ratio;
        let base_frame = source_position.floor() as usize;
        let next_frame = (base_frame + 1).min(source_frame_count - 1);
        let blend = (source_position - base_frame as f64) as f32;

        for channel in 0..channels {
            let base_sample = samples[base_frame * channels + channel];
            let next_sample = samples[next_frame * channels + channel];
            output[target_frame * channels + channel] =
                base_sample + (next_sample - base_sample) * blend;
        }
    }

    output
}

fn write_normalized_wav(
    destination_path: &Path,
    samples: &[f32],
    channels: u16,
) -> Result<(), ProjectError> {
    let spec = WavSpec {
        channels: channels.max(1),
        sample_rate: INTERNAL_SAMPLE_RATE,
        bits_per_sample: INTERNAL_BITS_PER_SAMPLE,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(destination_path, spec)?;
    for &sample in samples {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(())
}

fn analyze_import_files_in_parallel(
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
            let analysis = analyze_wav_file(&next_file.destination_path)?;
            let wav_analysis_millis = analysis_started_at.elapsed().as_millis();

            let waveform_write_started_at = Instant::now();
            let waveform_path = waveform_file_path_for_source(&next_file.destination_path);
            write_waveform_summary(&waveform_path, &analysis.waveform)?;
            let waveform_write_millis = waveform_write_started_at.elapsed().as_millis();

            let metadata = WavMetadata {
                channels: analysis.channels,
                sample_rate: analysis.sample_rate,
                duration_seconds: analysis.duration_seconds,
                tempo_candidate: analysis.tempo_candidate,
            };

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
            destination_path: planned_file.destination_path,
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
        Some((file, tempo_candidate)) => ResolvedTempo {
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

fn collect_existing_file_names(song_dir: &Path) -> Result<HashSet<String>, ProjectError> {
    let mut used_file_names = HashSet::new();
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

fn collect_used_file_names(song_dir: &Path, song: &Song) -> Result<HashSet<String>, ProjectError> {
    let mut used_file_names = collect_existing_file_names(song_dir)?;

    for clip in &song.clips {
        if let Some(file_name) = Path::new(&clip.file_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            used_file_names.insert(file_name.to_string());
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
