use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    let options = match CliOptions::parse(env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(error) = analyze_dump_dir(&options) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

struct CliOptions {
    dump_dir: PathBuf,
    reference: Option<String>,
    candidate: Option<String>,
    include_zero_transpose_candidates: bool,
}

impl CliOptions {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut dump_dir = None;
        let mut reference = None;
        let mut candidate = None;
        let mut include_zero_transpose_candidates = false;
        let mut args = args.peekable();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--reference" => {
                    reference = Some(
                        args.next()
                            .ok_or_else(|| "--reference requires a filename".to_string())?,
                    );
                }
                "--candidate" => {
                    candidate = Some(
                        args.next()
                            .ok_or_else(|| "--candidate requires a filename".to_string())?,
                    );
                }
                "--include-zero" => include_zero_transpose_candidates = true,
                "--help" | "-h" => return Err(String::new()),
                value if value.starts_with('-') => {
                    return Err(format!("unknown option: {value}"));
                }
                value => {
                    if dump_dir.is_some() {
                        return Err(format!("unexpected extra argument: {value}"));
                    }
                    dump_dir = Some(PathBuf::from(value));
                }
            }
        }

        Ok(Self {
            dump_dir: dump_dir
                .or_else(|| {
                    env::var("LIBRETRACKS_AUDIO_DUMP_DIR")
                        .ok()
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| PathBuf::from("audio-dumps")),
            reference,
            candidate,
            include_zero_transpose_candidates,
        })
    }
}

fn print_usage() {
    eprintln!(
        "usage: analyze_audio_dump [dump-dir] [--reference stem.wav] [--candidate stem.wav] [--include-zero]"
    );
}

fn analyze_dump_dir(options: &CliOptions) -> Result<(), String> {
    let output_dir = &options.dump_dir;
    if !output_dir.is_dir() {
        return Err(format!("dump dir does not exist: {}", output_dir.display()));
    }

    let metronome = read_wav_mono(&output_dir.join("metronome.wav")).ok();
    let mix = read_wav_mono(&output_dir.join("mix.wav")).ok();
    let mut dumps = fs::read_dir(output_dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            let stage = dump_stage_from_name(&name)?;
            if !name.ends_with(".wav") {
                return None;
            }
            let wav = read_wav_mono(&path).ok()?;
            Some(DumpFile { name, stage, wav })
        })
        .collect::<Vec<_>>();
    dumps.sort_by(|left, right| left.name.cmp(&right.name));
    let stems = dumps
        .iter()
        .filter(|dump| dump.stage == "final")
        .collect::<Vec<_>>();

    println!("dump_dir={}", output_dir.display());
    println!("mix_wav={}", mix.is_some());
    println!("metronome_wav={}", metronome.is_some());
    println!("stem_count={}", stems.len());
    println!(
        "pre_pitch_count={}",
        dumps
            .iter()
            .filter(|dump| dump.stage == "pre_pitch")
            .count()
    );
    println!(
        "post_pitch_count={}",
        dumps
            .iter()
            .filter(|dump| dump.stage == "post_pitch")
            .count()
    );

    if stems.is_empty() {
        return Err(
            "no stem_*.wav files found; rerun dump with LIBRETRACKS_AUDIO_DUMP_CLIP_STEMS=1"
                .to_string(),
        );
    }

    let zero_transpose_stems = stems
        .iter()
        .filter(|dump| transpose_from_stem_name(&dump.name) == Some(0))
        .map(|dump| dump.name.as_str())
        .collect::<Vec<_>>();
    if zero_transpose_stems.len() > 1 && options.reference.is_none() {
        println!(
            "warning=multiple transpose-0 stems found; using first as reference. Pass --reference to choose explicitly."
        );
        for name in &zero_transpose_stems {
            println!("reference_candidate={name}");
        }
    }

    let Some(reference) = choose_reference_stem(&stems, options.reference.as_deref()) else {
        return Err(
            "no non-transposed reference stem found; expected filename containing _transpose-0_"
                .to_string(),
        );
    };
    let reference_name = reference.name.as_str();
    let reference_wav = &reference.wav;

    println!("reference_stem={reference_name}");
    println!();

    let candidates = stems
        .iter()
        .copied()
        .filter(|dump| {
            if dump.name.as_str() == reference_name {
                return false;
            }
            if let Some(selected_candidate) = options.candidate.as_deref() {
                return dump.name == selected_candidate;
            }
            options.include_zero_transpose_candidates
                || transpose_from_stem_name(&dump.name) != Some(0)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        println!("warning=no candidate stems selected");
        println!("hint=by default only non-zero transpose stems are analyzed; pass --include-zero or --candidate stem.wav");
    }

    println!("candidate,stage,transpose,source_kind,offset_frames,offset_ms,classification,windows,method,offsets");
    for candidate in candidates {
        print_comparison(reference_wav, candidate);
    }

    for stage in ["pre_pitch", "post_pitch"] {
        for candidate in dumps.iter().filter(|dump| {
            dump.stage == stage
                && (options.include_zero_transpose_candidates
                    || transpose_from_stem_name(&dump.name) != Some(0))
                && options
                    .candidate
                    .as_deref()
                    .map(|selected| dump.name == selected)
                    .unwrap_or(true)
        }) {
            print_comparison(reference_wav, candidate);
        }
    }

    if let Some(metronome_wav) = metronome.as_ref() {
        let report = compare_offsets(
            &metronome_wav.samples,
            &reference_wav.samples,
            reference_wav.sample_rate,
        );
        println!();
        println!(
            "metronome_vs_reference,metronome,0,Metronome,{},{},{},{},{},{}",
            option_i64(report.offset_frames),
            option_f64(report.offset_ms),
            report.classification,
            report.windows,
            report.method,
            format_offsets(&report.offsets)
        );
    }

    Ok(())
}

struct DumpFile {
    name: String,
    stage: &'static str,
    wav: MonoWav,
}

fn choose_reference_stem<'a>(
    stems: &'a [&DumpFile],
    requested_reference: Option<&str>,
) -> Option<&'a DumpFile> {
    stems.iter().copied().find(|dump| {
        requested_reference
            .map(|requested| dump.name == requested)
            .unwrap_or_else(|| transpose_from_stem_name(&dump.name) == Some(0))
    })
}

fn print_comparison(reference_wav: &MonoWav, candidate: &DumpFile) {
    let report = compare_offsets(
        &reference_wav.samples,
        &candidate.wav.samples,
        reference_wav.sample_rate,
    );
    println!(
        "{},{},{},{},{},{},{},{},{},{}",
        candidate.name,
        candidate.stage,
        transpose_from_stem_name(&candidate.name)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        source_kind_from_stem_name(&candidate.name),
        option_i64(report.offset_frames),
        option_f64(report.offset_ms),
        report.classification,
        report.windows,
        report.method,
        format_offsets(&report.offsets)
    );
}

struct OffsetReport {
    offset_frames: Option<i64>,
    offset_ms: Option<f64>,
    classification: &'static str,
    windows: usize,
    offsets: Vec<i64>,
    method: &'static str,
}

fn compare_offsets(reference: &[f32], candidate: &[f32], sample_rate: u32) -> OffsetReport {
    let envelope_report = compare_offsets_by_envelope(reference, candidate, sample_rate);
    if envelope_report.windows >= 2 {
        return envelope_report;
    }

    let reference_peaks = detect_transient_peaks(reference, sample_rate);
    let candidate_peaks = detect_transient_peaks(candidate, sample_rate);
    if reference_peaks.len() < 2 || candidate_peaks.len() < 2 {
        return OffsetReport {
            offset_frames: None,
            offset_ms: None,
            classification: "inconclusive",
            windows: reference_peaks.len().min(candidate_peaks.len()),
            offsets: Vec::new(),
            method: "transient",
        };
    }

    let max_match_distance = (f64::from(sample_rate.max(1)) * 0.150).round() as usize;
    let offsets = reference_peaks
        .iter()
        .filter_map(|reference_peak| {
            candidate_peaks
                .iter()
                .min_by_key(|candidate_peak| candidate_peak.abs_diff(*reference_peak))
                .filter(|candidate_peak| {
                    candidate_peak.abs_diff(*reference_peak) <= max_match_distance
                })
                .map(|candidate_peak| *candidate_peak as i64 - *reference_peak as i64)
        })
        .collect::<Vec<_>>();

    if offsets.len() < 2 {
        return OffsetReport {
            offset_frames: None,
            offset_ms: None,
            classification: "inconclusive",
            windows: offsets.len(),
            offsets,
            method: "transient",
        };
    }

    let first = offsets[0];
    let last = *offsets.last().unwrap_or(&first);
    let mean = offsets.iter().sum::<i64>() as f64 / offsets.len() as f64;
    let max_deviation = offsets
        .iter()
        .map(|offset| (*offset as f64 - mean).abs())
        .fold(0.0, f64::max);
    let rounded_mean = mean.round() as i64;
    let classification = if rounded_mean.abs() <= 2 && max_deviation <= 2.0 {
        "aligned"
    } else if (last - first).abs() <= 4 {
        "constant offset"
    } else {
        "drift"
    };

    OffsetReport {
        offset_frames: Some(rounded_mean),
        offset_ms: Some((rounded_mean as f64 * 1_000.0) / f64::from(sample_rate.max(1))),
        classification,
        windows: offsets.len(),
        offsets,
        method: "transient",
    }
}

fn compare_offsets_by_envelope(
    reference: &[f32],
    candidate: &[f32],
    sample_rate: u32,
) -> OffsetReport {
    const HOP_FRAMES: usize = 64;
    const WINDOW_SECONDS: f64 = 2.0;
    const STEP_SECONDS: f64 = 1.0;
    const MAX_LAG_SECONDS: f64 = 0.200;

    let reference_env = envelope_hops(reference, HOP_FRAMES);
    let candidate_env = envelope_hops(candidate, HOP_FRAMES);
    let len = reference_env.len().min(candidate_env.len());
    if len == 0 {
        return inconclusive_envelope();
    }

    let window_hops = ((f64::from(sample_rate.max(1)) * WINDOW_SECONDS) / HOP_FRAMES as f64)
        .round()
        .max(8.0) as usize;
    let step_hops = ((f64::from(sample_rate.max(1)) * STEP_SECONDS) / HOP_FRAMES as f64)
        .round()
        .max(1.0) as usize;
    let max_lag_hops = ((f64::from(sample_rate.max(1)) * MAX_LAG_SECONDS) / HOP_FRAMES as f64)
        .round()
        .max(1.0) as isize;

    let reference_peak = reference_env.iter().copied().fold(0.0, f32::max);
    let candidate_peak = candidate_env.iter().copied().fold(0.0, f32::max);
    let active_threshold = reference_peak.max(candidate_peak) * 0.08;
    if active_threshold <= 0.000_001 {
        return inconclusive_envelope();
    }

    let mut offsets = Vec::new();
    let mut start = 0;
    while start + window_hops <= len {
        let end = start + window_hops;
        let reference_window = &reference_env[start..end];
        let candidate_window = &candidate_env[start..end];
        let reference_energy = reference_window.iter().copied().fold(0.0, f32::max);
        let candidate_energy = candidate_window.iter().copied().fold(0.0, f32::max);
        if reference_energy >= active_threshold && candidate_energy >= active_threshold {
            if let Some(lag_hops) =
                best_envelope_lag(reference_window, candidate_window, max_lag_hops)
            {
                offsets.push(lag_hops as i64 * HOP_FRAMES as i64);
            }
        }
        start += step_hops;
    }

    summarize_offsets(offsets, sample_rate, "envelope_xcorr")
}

fn envelope_hops(samples: &[f32], hop_frames: usize) -> Vec<f32> {
    samples
        .chunks(hop_frames.max(1))
        .map(|chunk| chunk.iter().map(|sample| sample.abs()).sum::<f32>() / chunk.len() as f32)
        .collect()
}

fn best_envelope_lag(reference: &[f32], candidate: &[f32], max_lag: isize) -> Option<isize> {
    let mut best_lag = 0;
    let mut best_score = f64::NEG_INFINITY;

    for lag in -max_lag..=max_lag {
        let (reference_start, candidate_start, compare_len) = if lag >= 0 {
            let lag = lag as usize;
            (0, lag, reference.len().saturating_sub(lag))
        } else {
            let lag = (-lag) as usize;
            (lag, 0, reference.len().saturating_sub(lag))
        };
        if compare_len < 8 {
            continue;
        }
        let reference_slice = &reference[reference_start..reference_start + compare_len];
        let candidate_slice = &candidate[candidate_start..candidate_start + compare_len];
        let score = normalized_dot(reference_slice, candidate_slice);
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    (best_score.is_finite() && best_score > 0.15).then_some(best_lag)
}

fn normalized_dot(left: &[f32], right: &[f32]) -> f64 {
    let left_mean = left.iter().sum::<f32>() as f64 / left.len() as f64;
    let right_mean = right.iter().sum::<f32>() as f64 / right.len() as f64;
    let mut dot = 0.0_f64;
    let mut left_power = 0.0_f64;
    let mut right_power = 0.0_f64;
    for (&left_sample, &right_sample) in left.iter().zip(right) {
        let left_value = left_sample as f64 - left_mean;
        let right_value = right_sample as f64 - right_mean;
        dot += left_value * right_value;
        left_power += left_value * left_value;
        right_power += right_value * right_value;
    }
    if left_power <= f64::EPSILON || right_power <= f64::EPSILON {
        return f64::NEG_INFINITY;
    }
    dot / (left_power.sqrt() * right_power.sqrt())
}

fn summarize_offsets(offsets: Vec<i64>, sample_rate: u32, method: &'static str) -> OffsetReport {
    if offsets.len() < 2 {
        return OffsetReport {
            offset_frames: None,
            offset_ms: None,
            classification: "inconclusive",
            windows: offsets.len(),
            offsets,
            method,
        };
    }

    let first = offsets[0];
    let last = *offsets.last().unwrap_or(&first);
    let mean = offsets.iter().sum::<i64>() as f64 / offsets.len() as f64;
    let max_deviation = offsets
        .iter()
        .map(|offset| (*offset as f64 - mean).abs())
        .fold(0.0, f64::max);
    let rounded_mean = mean.round() as i64;
    let classification = if rounded_mean.abs() <= 2 && max_deviation <= 2.0 {
        "aligned"
    } else if (last - first).abs() <= 128 && max_deviation <= 256.0 {
        "constant offset"
    } else {
        "drift"
    };

    OffsetReport {
        offset_frames: Some(rounded_mean),
        offset_ms: Some((rounded_mean as f64 * 1_000.0) / f64::from(sample_rate.max(1))),
        classification,
        windows: offsets.len(),
        offsets,
        method,
    }
}

fn inconclusive_envelope() -> OffsetReport {
    OffsetReport {
        offset_frames: None,
        offset_ms: None,
        classification: "inconclusive",
        windows: 0,
        offsets: Vec::new(),
        method: "envelope_xcorr",
    }
}

fn detect_transient_peaks(samples: &[f32], sample_rate: u32) -> Vec<usize> {
    let max_peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f32::max);
    if max_peak <= 0.000_1 {
        return Vec::new();
    }
    let threshold = max_peak * 0.4;
    let min_spacing = (f64::from(sample_rate.max(1)) * 0.040).round() as usize;
    let mut peaks = Vec::new();
    let mut index = 1;
    while index + 1 < samples.len() {
        let sample = samples[index].abs();
        if sample >= threshold
            && sample >= samples[index - 1].abs()
            && sample >= samples[index + 1].abs()
            && peaks
                .last()
                .map(|last| index - *last >= min_spacing)
                .unwrap_or(true)
        {
            peaks.push(index);
            index = index.saturating_add(min_spacing);
            continue;
        }
        index += 1;
    }
    peaks
}

struct MonoWav {
    samples: Vec<f32>,
    sample_rate: u32,
}

fn read_wav_mono(path: &Path) -> Result<MonoWav, hound::Error> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let mut mono = Vec::new();
    let mut frame_sum = 0.0_f32;
    let mut channel_index = 0;

    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                push_mono_sample(
                    sample?,
                    channels,
                    &mut frame_sum,
                    &mut channel_index,
                    &mut mono,
                );
            }
        }
        hound::SampleFormat::Int => {
            let scale = ((1_i64 << spec.bits_per_sample.saturating_sub(1)) - 1).max(1) as f32;
            for sample in reader.samples::<i32>() {
                push_mono_sample(
                    sample? as f32 / scale,
                    channels,
                    &mut frame_sum,
                    &mut channel_index,
                    &mut mono,
                );
            }
        }
    }

    Ok(MonoWav {
        samples: mono,
        sample_rate: spec.sample_rate,
    })
}

fn push_mono_sample(
    sample: f32,
    channels: usize,
    frame_sum: &mut f32,
    channel_index: &mut usize,
    mono: &mut Vec<f32>,
) {
    *frame_sum += sample;
    *channel_index += 1;
    if *channel_index == channels {
        mono.push(*frame_sum / channels as f32);
        *frame_sum = 0.0;
        *channel_index = 0;
    }
}

fn source_kind_from_stem_name(name: &str) -> String {
    name.split("_kind-")
        .nth(1)
        .and_then(|tail| tail.strip_suffix(".wav"))
        .unwrap_or("unknown")
        .to_string()
}

fn dump_stage_from_name(name: &str) -> Option<&'static str> {
    if name.starts_with("stem_") {
        Some("final")
    } else if name.starts_with("pre_pitch_") {
        Some("pre_pitch")
    } else if name.starts_with("post_pitch_") {
        Some("post_pitch")
    } else {
        None
    }
}

fn transpose_from_stem_name(name: &str) -> Option<i32> {
    let tail = name.split("_transpose-").nth(1)?;
    let value = tail.split("_kind-").next()?;
    value.parse::<i32>().ok()
}

fn format_offsets(offsets: &[i64]) -> String {
    if offsets.is_empty() {
        return "[]".to_string();
    }
    let preview = offsets
        .iter()
        .take(12)
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join("|");
    if offsets.len() > 12 {
        format!("[{preview}|...]")
    } else {
        format!("[{preview}]")
    }
}

fn option_i64(value: Option<i64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "NA".to_string())
}

fn option_f64(value: Option<f64>) -> String {
    value
        .map(|value| format!("{value:.3}"))
        .unwrap_or_else(|| "NA".to_string())
}
