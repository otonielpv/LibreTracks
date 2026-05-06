use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::mpsc::{self, Sender},
    thread,
};

const DEFAULT_DUMP_SECONDS: u64 = 20;

#[derive(Clone)]
pub(crate) struct PlaybackDumpRecorder {
    sender: Sender<DumpCommand>,
    channels: usize,
    max_frames: u64,
    clip_stems: bool,
}

enum DumpCommand {
    Block {
        stream: DumpStream,
        start_frame: u64,
        samples: Vec<f32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum DumpStream {
    Mix,
    Metronome,
    Stem(String),
}

struct StreamWriter {
    writer: hound::WavWriter<std::io::BufWriter<File>>,
    current_frame: u64,
}

impl PlaybackDumpRecorder {
    pub(crate) fn from_env(sample_rate: u32, channels: usize) -> Option<Self> {
        if !env_flag("LIBRETRACKS_AUDIO_DUMP_PLAYBACK") {
            return None;
        }

        let output_dir = std::env::var("LIBRETRACKS_AUDIO_DUMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("audio-dumps"));
        let dump_seconds = std::env::var("LIBRETRACKS_AUDIO_DUMP_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_DUMP_SECONDS)
            .max(1);
        let sample_rate = sample_rate.max(1);
        let channels = channels.max(1);
        let max_frames = dump_seconds.saturating_mul(u64::from(sample_rate));
        let clip_stems = env_flag("LIBRETRACKS_AUDIO_DUMP_CLIP_STEMS");
        let analyze = env_flag("LIBRETRACKS_AUDIO_DUMP_ANALYZE");

        let _ = fs::create_dir_all(&output_dir);
        let (sender, receiver) = mpsc::channel();
        let writer_dir = output_dir.clone();
        thread::Builder::new()
            .name("libretracks-audio-dump".into())
            .spawn(move || {
                run_writer_thread(
                    receiver,
                    writer_dir,
                    sample_rate,
                    channels,
                    max_frames,
                    analyze,
                )
            })
            .ok()?;

        eprintln!(
            "[libretracks-audio] playback dump enabled: dir={}, seconds={}, clip_stems={}, analyze={}",
            output_dir.display(),
            dump_seconds,
            clip_stems,
            analyze
        );

        Some(Self {
            sender,
            channels,
            max_frames,
            clip_stems,
        })
    }

    pub(crate) fn clip_stems_enabled(&self) -> bool {
        self.clip_stems
    }

    pub(crate) fn record_mix(&self, start_frame: u64, samples: &[f32]) {
        self.record(DumpStream::Mix, start_frame, samples);
    }

    pub(crate) fn record_metronome(&self, start_frame: u64, samples: &[f32]) {
        self.record(DumpStream::Metronome, start_frame, samples);
    }

    pub(crate) fn record_clip_stem(
        &self,
        start_frame: u64,
        track_id: &str,
        clip_id: &str,
        transpose_semitones: i32,
        source_kind: &str,
        samples: &[f32],
    ) {
        if !self.clip_stems || samples.is_empty() {
            return;
        }
        let name = format!(
            "stem_track-{}_clip-{}_transpose-{}_kind-{}.wav",
            sanitize_filename(track_id),
            sanitize_filename(clip_id),
            transpose_semitones,
            sanitize_filename(source_kind)
        );
        self.record(DumpStream::Stem(name), start_frame, samples);
    }

    pub(crate) fn record_pre_pitch(
        &self,
        start_frame: u64,
        track_id: &str,
        clip_id: &str,
        transpose_semitones: i32,
        source_kind: &str,
        samples: &[f32],
    ) {
        self.record_stage(
            "pre_pitch",
            start_frame,
            track_id,
            clip_id,
            transpose_semitones,
            source_kind,
            samples,
        );
    }

    pub(crate) fn record_post_pitch(
        &self,
        start_frame: u64,
        track_id: &str,
        clip_id: &str,
        transpose_semitones: i32,
        source_kind: &str,
        samples: &[f32],
    ) {
        self.record_stage(
            "post_pitch",
            start_frame,
            track_id,
            clip_id,
            transpose_semitones,
            source_kind,
            samples,
        );
    }

    fn record_stage(
        &self,
        prefix: &str,
        start_frame: u64,
        track_id: &str,
        clip_id: &str,
        transpose_semitones: i32,
        source_kind: &str,
        samples: &[f32],
    ) {
        if !self.clip_stems || samples.is_empty() {
            return;
        }
        let name = format!(
            "{}_track-{}_clip-{}_transpose-{}_kind-{}.wav",
            prefix,
            sanitize_filename(track_id),
            sanitize_filename(clip_id),
            transpose_semitones,
            sanitize_filename(source_kind)
        );
        self.record(DumpStream::Stem(name), start_frame, samples);
    }

    fn record(&self, stream: DumpStream, start_frame: u64, samples: &[f32]) {
        if start_frame >= self.max_frames {
            return;
        }
        let max_samples = self
            .max_frames
            .saturating_sub(start_frame)
            .saturating_mul(self.channels as u64) as usize;
        let sample_count = samples.len().min(max_samples);
        if sample_count == 0 {
            return;
        }
        let _ = self.sender.send(DumpCommand::Block {
            stream,
            start_frame,
            samples: samples[..sample_count].to_vec(),
        });
    }
}

fn run_writer_thread(
    receiver: mpsc::Receiver<DumpCommand>,
    output_dir: PathBuf,
    sample_rate: u32,
    channels: usize,
    max_frames: u64,
    analyze: bool,
) {
    let mut writers: HashMap<DumpStream, StreamWriter> = HashMap::new();
    let mut analysis_done = false;
    let mut had_data = false;

    while let Ok(command) = receiver.recv() {
        let DumpCommand::Block {
            stream,
            start_frame,
            samples,
        } = command;
        if start_frame >= max_frames || analysis_done {
            continue;
        }
        let writer = match writers.entry(stream.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let Ok(writer) = open_stream_writer(&output_dir, &stream, sample_rate, channels)
                else {
                    continue;
                };
                entry.insert(StreamWriter {
                    writer,
                    current_frame: 0,
                })
            }
        };
        if write_timeline_block(writer, start_frame, &samples, channels, max_frames).is_err() {
            continue;
        }
        had_data = true;

        if matches!(stream, DumpStream::Mix) && writer.current_frame >= max_frames {
            writers.clear();
            if analyze {
                analyze_dump_dir(&output_dir);
            } else {
                eprintln!(
                    "[libretracks-audio] playback dump complete: {}",
                    output_dir.display()
                );
            }
            analysis_done = true;
        }
    }

    if had_data && !analysis_done {
        writers.clear();
        if analyze {
            analyze_dump_dir(&output_dir);
        } else {
            eprintln!(
                "[libretracks-audio] playback dump complete: {}",
                output_dir.display()
            );
        }
    }
}

fn open_stream_writer(
    output_dir: &Path,
    stream: &DumpStream,
    sample_rate: u32,
    channels: usize,
) -> Result<hound::WavWriter<std::io::BufWriter<File>>, hound::Error> {
    let filename = match stream {
        DumpStream::Mix => "mix.wav".to_string(),
        DumpStream::Metronome => "metronome.wav".to_string(),
        DumpStream::Stem(name) => name.clone(),
    };
    let path = output_dir.join(filename);
    let spec = hound::WavSpec {
        channels: channels.max(1) as u16,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    hound::WavWriter::create(path, spec)
}

fn write_timeline_block(
    stream: &mut StreamWriter,
    start_frame: u64,
    samples: &[f32],
    channels: usize,
    max_frames: u64,
) -> Result<(), hound::Error> {
    let channels = channels.max(1);
    if start_frame > stream.current_frame {
        let silence_samples = (start_frame - stream.current_frame).saturating_mul(channels as u64);
        for _ in 0..silence_samples {
            stream.writer.write_sample(0.0_f32)?;
        }
        stream.current_frame = start_frame;
    }

    let mut sample_offset = 0;
    if start_frame < stream.current_frame {
        let skip_frames = (stream.current_frame - start_frame) as usize;
        sample_offset = skip_frames.saturating_mul(channels).min(samples.len());
    }
    let remaining_samples = max_frames
        .saturating_sub(stream.current_frame)
        .saturating_mul(channels as u64) as usize;
    let writable_samples = samples[sample_offset..].len().min(remaining_samples);
    for &sample in &samples[sample_offset..sample_offset + writable_samples] {
        stream.writer.write_sample(sample)?;
    }
    stream.current_frame = stream
        .current_frame
        .saturating_add((writable_samples / channels) as u64);
    Ok(())
}

fn analyze_dump_dir(output_dir: &Path) {
    let metronome = read_wav_mono(&output_dir.join("metronome.wav")).ok();
    let mut stems = fs::read_dir(output_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.starts_with("stem_") || !name.ends_with(".wav") {
                return None;
            }
            let wav = read_wav_mono(&path).ok()?;
            Some((name, wav))
        })
        .collect::<Vec<_>>();
    stems.sort_by(|left, right| left.0.cmp(&right.0));

    let Some((reference_name, reference_wav)) = stems
        .iter()
        .find(|(name, _)| name.contains("_transpose-0_"))
    else {
        eprintln!(
            "[libretracks-audio] playback dump analysis: inconclusive (no non-transposed stem)"
        );
        return;
    };

    eprintln!(
        "[libretracks-audio] playback dump analysis reference: {}",
        reference_name
    );

    for (candidate_name, candidate_wav) in stems
        .iter()
        .filter(|(name, _)| !name.contains("_transpose-0_"))
    {
        let report = compare_offsets(
            &reference_wav.samples,
            &candidate_wav.samples,
            reference_wav.sample_rate,
        );
        eprintln!(
            "[libretracks-audio] stem offset: candidate={}, source_kind={}, offset_frames={:?}, offset_ms={:?}, classification={}",
            candidate_name,
            source_kind_from_stem_name(candidate_name),
            report.offset_frames,
            report.offset_ms,
            report.classification
        );
    }

    if let Some(metronome_wav) = metronome.as_ref() {
        let report = compare_offsets(
            &metronome_wav.samples,
            &reference_wav.samples,
            reference_wav.sample_rate,
        );
        eprintln!(
            "[libretracks-audio] metronome vs reference stem: offset_frames={:?}, offset_ms={:?}, classification={}",
            report.offset_frames, report.offset_ms, report.classification
        );
    }
}

struct OffsetReport {
    offset_frames: Option<i64>,
    offset_ms: Option<f64>,
    classification: &'static str,
}

fn compare_offsets(reference: &[f32], candidate: &[f32], sample_rate: u32) -> OffsetReport {
    let reference_peaks = detect_transient_peaks(reference);
    let candidate_peaks = detect_transient_peaks(candidate);
    if reference_peaks.len() < 2 || candidate_peaks.len() < 2 {
        return OffsetReport {
            offset_frames: None,
            offset_ms: None,
            classification: "inconclusive",
        };
    }

    let offsets = reference_peaks
        .iter()
        .filter_map(|reference_peak| {
            candidate_peaks
                .iter()
                .min_by_key(|candidate_peak| candidate_peak.abs_diff(*reference_peak))
                .map(|candidate_peak| *candidate_peak as i64 - *reference_peak as i64)
        })
        .collect::<Vec<_>>();
    if offsets.is_empty() {
        return OffsetReport {
            offset_frames: None,
            offset_ms: None,
            classification: "inconclusive",
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
    }
}

fn detect_transient_peaks(samples: &[f32]) -> Vec<usize> {
    let max_peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f32::max);
    if max_peak <= 0.000_1 {
        return Vec::new();
    }
    let threshold = max_peak * 0.4;
    let min_spacing = 2_000;
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
    for sample in reader.samples::<f32>() {
        frame_sum += sample?;
        channel_index += 1;
        if channel_index == channels {
            mono.push(frame_sum / channels as f32);
            frame_sum = 0.0;
            channel_index = 0;
        }
    }
    Ok(MonoWav {
        samples: mono,
        sample_rate: spec.sample_rate,
    })
}

fn source_kind_from_stem_name(name: &str) -> String {
    name.split("_kind-")
        .nth(1)
        .and_then(|tail| tail.strip_suffix(".wav"))
        .unwrap_or("unknown")
        .to_string()
}

fn sanitize_filename(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}
