use std::{
    fs,
    path::{Path, PathBuf},
};

use hound::{SampleFormat, WavReader};
use serde::{Deserialize, Serialize};

use crate::ProjectError;

const WAVEFORM_BUCKETS_PER_SECOND: usize = 96;
const WAVEFORM_BUCKET_COUNT_MIN: usize = 2048;
const WAVEFORM_BUCKET_COUNT_MAX: usize = 16384;
const WAVEFORM_FORMAT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummary {
    pub version: u32,
    #[serde(default)]
    pub duration_seconds: f64,
    pub bucket_count: usize,
    #[serde(default)]
    pub peaks: Vec<f32>,
    #[serde(default)]
    pub min_peaks: Vec<f32>,
    #[serde(default)]
    pub max_peaks: Vec<f32>,
}

pub fn waveform_file_path(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> PathBuf {
    let file_stem = audio_relative_path
        .as_ref()
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("waveform");

    song_dir
        .as_ref()
        .join("cache")
        .join("waveforms")
        .join(format!("{file_stem}.waveform.json"))
}

pub fn generate_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let source_path = song_dir.join(audio_relative_path);

    let mut reader = WavReader::open(&source_path)?;
    let spec = reader.spec();
    let duration_seconds = reader.duration() as f64 / f64::from(spec.sample_rate.max(1));
    let waveform = match spec.sample_format {
        SampleFormat::Float => collect_float_waveform(&mut reader, spec.channels, spec.sample_rate)?,
        SampleFormat::Int => collect_int_waveform(
            &mut reader,
            spec.channels,
            spec.bits_per_sample,
            spec.sample_rate,
        )?,
    };

    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds,
        bucket_count: waveform.bucket_count,
        peaks: waveform.peaks,
        min_peaks: waveform.min_peaks,
        max_peaks: waveform.max_peaks,
    };

    let path = waveform_file_path(song_dir, audio_relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(&summary)?;
    fs::write(path, json)?;

    Ok(summary)
}

pub fn load_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let json = fs::read_to_string(waveform_file_path(song_dir, audio_relative_path))?;
    let summary: WaveformSummary = serde_json::from_str(&json)?;

    if summary.version < WAVEFORM_FORMAT_VERSION
        || summary.duration_seconds <= 0.0
        || summary.bucket_count == 0
        || summary.min_peaks.len() != summary.bucket_count
        || summary.max_peaks.len() != summary.bucket_count
    {
        return generate_waveform_summary(song_dir, audio_relative_path);
    }

    Ok(summary)
}

#[derive(Debug)]
struct BucketizedWaveform {
    bucket_count: usize,
    peaks: Vec<f32>,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
}

fn collect_float_waveform(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    channels: u16,
    sample_rate: u32,
) -> Result<BucketizedWaveform, ProjectError> {
    let mut samples = Vec::new();

    for sample in reader.samples::<f32>() {
        samples.push(sample?.clamp(-1.0, 1.0));
    }

    Ok(collapse_to_mono_waveform(&samples, channels, sample_rate))
}

fn collect_int_waveform(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    channels: u16,
    bits_per_sample: u16,
    sample_rate: u32,
) -> Result<BucketizedWaveform, ProjectError> {
    let mut samples = Vec::new();
    let max_value = ((1_i64 << (bits_per_sample.saturating_sub(1))) - 1).max(1) as f32;

    for sample in reader.samples::<i32>() {
        let value = (sample? as f32 / max_value).clamp(-1.0, 1.0);
        samples.push(value);
    }

    Ok(collapse_to_mono_waveform(&samples, channels, sample_rate))
}

fn collapse_to_mono_waveform(
    samples: &[f32],
    channels: u16,
    sample_rate: u32,
) -> BucketizedWaveform {
    let channel_count = usize::from(channels.max(1));
    let frame_count = samples.len() / channel_count;
    if frame_count == 0 {
        return BucketizedWaveform {
            bucket_count: WAVEFORM_BUCKET_COUNT_MIN,
            peaks: vec![0.0; WAVEFORM_BUCKET_COUNT_MIN],
            min_peaks: vec![0.0; WAVEFORM_BUCKET_COUNT_MIN],
            max_peaks: vec![0.0; WAVEFORM_BUCKET_COUNT_MIN],
        };
    }

    let mut mono_frames = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        let start = frame_index * channel_count;
        let end = start + channel_count;
        let sum = samples[start..end].iter().copied().sum::<f32>();
        mono_frames.push((sum / channel_count as f32).clamp(-1.0, 1.0));
    }

    bucketize_waveform(&mono_frames, desired_bucket_count(frame_count, sample_rate))
}

fn desired_bucket_count(frame_count: usize, sample_rate: u32) -> usize {
    let duration_seconds = frame_count as f64 / f64::from(sample_rate.max(1));
    let target = (duration_seconds * WAVEFORM_BUCKETS_PER_SECOND as f64).ceil() as usize;
    target.clamp(WAVEFORM_BUCKET_COUNT_MIN, WAVEFORM_BUCKET_COUNT_MAX)
}

fn bucketize_waveform(frames: &[f32], bucket_count: usize) -> BucketizedWaveform {
    if frames.is_empty() {
        return BucketizedWaveform {
            bucket_count,
            peaks: vec![0.0; bucket_count],
            min_peaks: vec![0.0; bucket_count],
            max_peaks: vec![0.0; bucket_count],
        };
    }

    let mut min_peaks = Vec::with_capacity(bucket_count);
    let mut max_peaks = Vec::with_capacity(bucket_count);
    let mut peaks = Vec::with_capacity(bucket_count);

    for bucket in 0..bucket_count {
        let start = (bucket * frames.len()) / bucket_count;
        let end = ((bucket + 1) * frames.len()) / bucket_count;
        let slice = &frames[start.min(frames.len())..end.min(frames.len())];

        let (min_peak, max_peak, peak) = if slice.is_empty() {
            (0.0, 0.0, 0.0)
        } else {
            let min_peak = slice.iter().copied().fold(1.0_f32, f32::min);
            let max_peak = slice.iter().copied().fold(-1.0_f32, f32::max);
            let peak = min_peak.abs().max(max_peak.abs());
            (min_peak, max_peak, peak)
        };

        min_peaks.push(min_peak);
        max_peaks.push(max_peak);
        peaks.push(peak);
    }

    BucketizedWaveform {
        bucket_count,
        peaks,
        min_peaks,
        max_peaks,
    }
}
