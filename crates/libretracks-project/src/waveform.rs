use std::{
    fs,
    path::{Path, PathBuf},
};

use hound::{SampleFormat, WavReader};
use serde::{Deserialize, Serialize};

use crate::ProjectError;

const WAVEFORM_BUCKET_COUNT: usize = 96;
const WAVEFORM_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummary {
    pub version: u32,
    pub bucket_count: usize,
    pub peaks: Vec<f32>,
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
    let peaks = match spec.sample_format {
        SampleFormat::Float => collect_float_peaks(&mut reader, spec.channels)?,
        SampleFormat::Int => collect_int_peaks(&mut reader, spec.channels, spec.bits_per_sample)?,
    };

    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        bucket_count: peaks.len(),
        peaks,
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
    let json = fs::read_to_string(waveform_file_path(song_dir, audio_relative_path))?;
    let summary: WaveformSummary = serde_json::from_str(&json)?;
    Ok(summary)
}

fn collect_float_peaks(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    channels: u16,
) -> Result<Vec<f32>, ProjectError> {
    let mut samples = Vec::new();

    for sample in reader.samples::<f32>() {
        samples.push(sample?.abs().clamp(0.0, 1.0));
    }

    Ok(collapse_to_mono_peaks(&samples, channels))
}

fn collect_int_peaks(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    channels: u16,
    bits_per_sample: u16,
) -> Result<Vec<f32>, ProjectError> {
    let mut samples = Vec::new();
    let max_value = ((1_i64 << (bits_per_sample.saturating_sub(1))) - 1).max(1) as f32;

    for sample in reader.samples::<i32>() {
        let value = (sample? as f32 / max_value).abs().clamp(0.0, 1.0);
        samples.push(value);
    }

    Ok(collapse_to_mono_peaks(&samples, channels))
}

fn collapse_to_mono_peaks(samples: &[f32], channels: u16) -> Vec<f32> {
    let channel_count = usize::from(channels.max(1));
    let frame_count = samples.len() / channel_count;
    if frame_count == 0 {
        return vec![0.0; WAVEFORM_BUCKET_COUNT];
    }

    let mut mono_frames = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        let start = frame_index * channel_count;
        let end = start + channel_count;
        let peak = samples[start..end]
            .iter()
            .copied()
            .fold(0.0_f32, f32::max);
        mono_frames.push(peak);
    }

    bucketize_peaks(&mono_frames, WAVEFORM_BUCKET_COUNT)
}

fn bucketize_peaks(frames: &[f32], bucket_count: usize) -> Vec<f32> {
    if frames.is_empty() {
        return vec![0.0; bucket_count];
    }

    let mut peaks = Vec::with_capacity(bucket_count);

    for bucket in 0..bucket_count {
        let start = (bucket * frames.len()) / bucket_count;
        let end = ((bucket + 1) * frames.len()) / bucket_count;
        let slice = &frames[start.min(frames.len())..end.min(frames.len())];

        let peak = if slice.is_empty() {
            0.0
        } else {
            slice.iter().copied().fold(0.0_f32, f32::max)
        };

        peaks.push(peak);
    }

    peaks
}
