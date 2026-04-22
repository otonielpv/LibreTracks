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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TempoCandidate {
    pub bpm: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzedWav {
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub waveform: WaveformSummary,
    pub tempo_candidate: Option<TempoCandidate>,
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

pub fn waveform_file_path_for_source(source_path: impl AsRef<Path>) -> PathBuf {
    let source_path = source_path.as_ref();
    let file_stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("waveform");

    source_path
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .join("cache")
        .join("waveforms")
        .join(format!("{file_stem}.waveform.json"))
}

pub fn analyze_wav_file(path: impl AsRef<Path>) -> Result<AnalyzedWav, ProjectError> {
    let path = path.as_ref();
    let mut reader = WavReader::open(path)?;
    let spec = reader.spec();
    let frame_count = reader.duration() as usize;
    let duration_seconds = frame_count as f64 / f64::from(spec.sample_rate.max(1));
    let waveform = match spec.sample_format {
        SampleFormat::Float => collect_float_waveform_streaming(
            &mut reader,
            frame_count,
            spec.channels,
            spec.sample_rate,
        )?,
        SampleFormat::Int => collect_int_waveform_streaming(
            &mut reader,
            frame_count,
            spec.channels,
            spec.bits_per_sample,
            spec.sample_rate,
        )?,
    };

    let waveform = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds,
        bucket_count: waveform.bucket_count,
        peaks: waveform.peaks,
        min_peaks: waveform.min_peaks,
        max_peaks: waveform.max_peaks,
    };

    Ok(AnalyzedWav {
        duration_seconds,
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        tempo_candidate: estimate_tempo_candidate(&waveform),
        waveform,
    })
}

fn estimate_tempo_candidate(waveform: &WaveformSummary) -> Option<TempoCandidate> {
    if waveform.duration_seconds <= 0.0 || waveform.max_peaks.len() < 64 {
        return None;
    }

    let bucket_rate = waveform.bucket_count as f64 / waveform.duration_seconds.max(0.0001);
    if bucket_rate <= 0.0 {
        return None;
    }

    let onset_envelope = waveform
        .max_peaks
        .windows(2)
        .map(|pair| f64::from((pair[1] - pair[0]).max(0.0)))
        .collect::<Vec<_>>();
    if onset_envelope.len() < 32 {
        return None;
    }

    let mean = onset_envelope.iter().sum::<f64>() / onset_envelope.len() as f64;
    let centered = onset_envelope
        .iter()
        .map(|value| (value - mean).max(0.0))
        .collect::<Vec<_>>();
    let centered_energy = centered.iter().map(|value| value * value).sum::<f64>();
    if centered_energy <= 0.000001 {
        return None;
    }

    let lag_min = ((bucket_rate * 60.0 / 220.0).round() as usize).max(1);
    let lag_max = ((bucket_rate * 60.0 / 60.0).round() as usize)
        .min(centered.len().saturating_sub(1));
    if lag_min >= lag_max {
        return None;
    }

    let mut scores = vec![0.0_f64; lag_max.saturating_add(1)];
    let mut best_lag = 0_usize;
    let mut best_score = 0.0_f64;

    for lag in lag_min..=lag_max {
        let mut score = 0.0_f64;
        let mut left_energy = 0.0_f64;
        let mut right_energy = 0.0_f64;

        for index in lag..centered.len() {
            let left = centered[index];
            let right = centered[index - lag];
            score += left * right;
            left_energy += left * left;
            right_energy += right * right;
        }

        if left_energy <= 0.0 || right_energy <= 0.0 {
            continue;
        }

        let normalized_score = score / (left_energy.sqrt() * right_energy.sqrt());
        scores[lag] = normalized_score;
        if normalized_score > best_score {
            best_score = normalized_score;
            best_lag = lag;
        }
    }

    if best_lag == 0 || best_score <= 0.05 {
        return None;
    }

    let mut resolved_lag = best_lag;
    let mut resolved_score = best_score;
    while resolved_lag / 2 >= lag_min {
        let half_lag = resolved_lag / 2;
        let half_score = scores[half_lag];
        if half_score >= resolved_score * 0.92 {
            resolved_lag = half_lag;
            resolved_score = half_score;
        } else {
            break;
        }
    }

    let refined_lag = refine_lag_with_parabolic_peak(&scores, resolved_lag).max(lag_min as f64);
    let mut bpm = 60.0 * bucket_rate / refined_lag;
    while bpm < 60.0 {
        bpm *= 2.0;
    }
    while bpm > 220.0 {
        bpm /= 2.0;
    }
    bpm = snap_detected_bpm(bpm, resolved_score);

    Some(TempoCandidate {
        bpm: (bpm * 10.0).round() / 10.0,
        confidence: resolved_score.clamp(0.0, 1.0),
    })
}

fn refine_lag_with_parabolic_peak(scores: &[f64], lag: usize) -> f64 {
    if lag == 0 || lag + 1 >= scores.len() {
        return lag as f64;
    }

    let left = scores[lag - 1];
    let center = scores[lag];
    let right = scores[lag + 1];
    let denominator = left - (2.0 * center) + right;
    if denominator.abs() <= f64::EPSILON {
        return lag as f64;
    }

    let offset = 0.5 * (left - right) / denominator;
    (lag as f64 + offset.clamp(-0.5, 0.5)).max(1.0)
}

fn snap_detected_bpm(bpm: f64, confidence: f64) -> f64 {
    if !bpm.is_finite() || bpm <= 0.0 {
        return bpm;
    }

    let nearest_integer = bpm.round();
    if confidence >= 0.1 && (bpm - nearest_integer).abs() <= 0.35 {
        return nearest_integer;
    }

    bpm
}

pub fn write_waveform_summary(
    output_path: impl AsRef<Path>,
    summary: &WaveformSummary,
) -> Result<(), ProjectError> {
    let path = output_path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(summary)?;
    fs::write(path, json)?;
    Ok(())
}

pub fn generate_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let source_path = song_dir.join(audio_relative_path);
    let summary = analyze_wav_file(&source_path)?.waveform;

    let path = waveform_file_path(song_dir, audio_relative_path);
    write_waveform_summary(path, &summary)?;

    Ok(summary)
}

pub fn load_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let path = waveform_file_path(song_dir, audio_relative_path);
    let json = fs::read_to_string(&path)?;
    let summary: WaveformSummary = serde_json::from_str(&json)?;

    if summary.version < WAVEFORM_FORMAT_VERSION
        || summary.duration_seconds <= 0.0
        || summary.bucket_count == 0
        || summary.min_peaks.len() != summary.bucket_count
        || summary.max_peaks.len() != summary.bucket_count
    {
        return Err(ProjectError::InvalidWaveformSummary(path));
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

struct WaveformBuckets {
    frame_count: usize,
    bucket_count: usize,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
    touched: Vec<bool>,
}

impl WaveformBuckets {
    fn new(frame_count: usize, sample_rate: u32) -> Self {
        let bucket_count = if frame_count == 0 {
            WAVEFORM_BUCKET_COUNT_MIN
        } else {
            desired_bucket_count(frame_count, sample_rate)
        };

        Self {
            frame_count,
            bucket_count,
            min_peaks: vec![1.0; bucket_count],
            max_peaks: vec![-1.0; bucket_count],
            touched: vec![false; bucket_count],
        }
    }

    fn push_frame(&mut self, frame_index: usize, sample: f32) {
        if self.bucket_count == 0 {
            return;
        }

        let bucket_index = if self.frame_count == 0 {
            0
        } else {
            ((frame_index * self.bucket_count) / self.frame_count).min(self.bucket_count - 1)
        };

        self.min_peaks[bucket_index] = self.min_peaks[bucket_index].min(sample);
        self.max_peaks[bucket_index] = self.max_peaks[bucket_index].max(sample);
        self.touched[bucket_index] = true;
    }

    fn finish(mut self) -> BucketizedWaveform {
        let mut peaks = Vec::with_capacity(self.bucket_count);

        for bucket_index in 0..self.bucket_count {
            if !self.touched[bucket_index] {
                self.min_peaks[bucket_index] = 0.0;
                self.max_peaks[bucket_index] = 0.0;
            }

            peaks.push(
                self.min_peaks[bucket_index]
                    .abs()
                    .max(self.max_peaks[bucket_index].abs()),
            );
        }

        BucketizedWaveform {
            bucket_count: self.bucket_count,
            peaks,
            min_peaks: self.min_peaks,
            max_peaks: self.max_peaks,
        }
    }
}

fn collect_float_waveform_streaming(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    frame_count: usize,
    channels: u16,
    sample_rate: u32,
) -> Result<BucketizedWaveform, ProjectError> {
    let channel_count = usize::from(channels.max(1));
    let mut buckets = WaveformBuckets::new(frame_count, sample_rate);
    let mut channel_index = 0;
    let mut frame_index = 0usize;
    let mut frame_sum = 0.0_f32;

    for sample in reader.samples::<f32>() {
        frame_sum += sample?.clamp(-1.0, 1.0);
        channel_index += 1;

        if channel_index == channel_count {
            buckets.push_frame(frame_index, (frame_sum / channel_count as f32).clamp(-1.0, 1.0));
            frame_sum = 0.0;
            channel_index = 0;
            frame_index += 1;
        }
    }

    Ok(buckets.finish())
}

fn collect_int_waveform_streaming(
    reader: &mut WavReader<std::io::BufReader<std::fs::File>>,
    frame_count: usize,
    channels: u16,
    bits_per_sample: u16,
    sample_rate: u32,
) -> Result<BucketizedWaveform, ProjectError> {
    let channel_count = usize::from(channels.max(1));
    let mut buckets = WaveformBuckets::new(frame_count, sample_rate);
    let max_value = ((1_i64 << (bits_per_sample.saturating_sub(1))) - 1).max(1) as f32;
    let mut channel_index = 0;
    let mut frame_index = 0usize;
    let mut frame_sum = 0.0_f32;

    for sample in reader.samples::<i32>() {
        let value = (sample? as f32 / max_value).clamp(-1.0, 1.0);
        frame_sum += value;
        channel_index += 1;

        if channel_index == channel_count {
            buckets.push_frame(frame_index, (frame_sum / channel_count as f32).clamp(-1.0, 1.0));
            frame_sum = 0.0;
            channel_index = 0;
            frame_index += 1;
        }
    }

    Ok(buckets.finish())
}

fn desired_bucket_count(frame_count: usize, sample_rate: u32) -> usize {
    let duration_seconds = frame_count as f64 / f64::from(sample_rate.max(1));
    let target = (duration_seconds * WAVEFORM_BUCKETS_PER_SECOND as f64).ceil() as usize;
    target.clamp(WAVEFORM_BUCKET_COUNT_MIN, WAVEFORM_BUCKET_COUNT_MAX)
}
