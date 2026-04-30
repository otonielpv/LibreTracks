use super::*;
use libretracks_project::load_waveform_summary;
use rayon::prelude::*;
use rtrb::{Consumer, Producer, RingBuffer};
use std::{collections::HashSet, fs::File};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::{FormatOptions, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};

const STREAM_SECONDS_PER_CLIP: usize = 2;
const STREAM_WORKER_CHUNK_FRAMES: usize = 512;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AudioBufferCacheStats {
    pub cached_buffers: usize,
    pub fully_cached_buffers: usize,
    pub preload_bytes: usize,
}

#[derive(Clone, Default)]
pub(crate) struct AudioBufferCache {
    entries: Arc<RwLock<HashMap<PathBuf, Arc<StreamingAudioSource>>>>,
}

#[derive(Debug)]
pub(crate) struct StreamingAudioSource {
    file_path: PathBuf,
    sample_rate: u32,
    channels: usize,
    frame_count: usize,
    seek_index: Vec<SeekIndexEntry>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SeekIndexEntry {
    pub timestamp: u64,
    pub packet_offset: u64,
}

pub(crate) struct StreamingClipReader {
    shared_source: Arc<StreamingAudioSource>,
    consumer: Consumer<f32>,
    command_sender: Sender<StreamingWorkerCommand>,
    output_sample_rate: u32,
    emitted_frames: usize,
    total_output_frames: usize,
    declick_fade_frames: usize,
    declick_frames_remaining: usize,
    pub(crate) eof: bool,
}

enum StreamingWorkerCommand {
    Seek { source_start_seconds: f64 },
    Shutdown,
}

impl StreamingAudioSource {
    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub(crate) fn channels(&self) -> usize {
        self.channels
    }

    pub(crate) fn preload_frame_count(&self) -> usize {
        self.frame_count
    }

    pub(crate) fn is_fully_cached(&self) -> bool {
        false
    }

    pub(crate) fn has_mapped_audio(&self) -> bool {
        false
    }

    #[cfg(test)]
    pub(crate) fn from_preloaded(
        preload_samples: Vec<f32>,
        sample_rate: u32,
        channels: usize,
        _fully_cached: bool,
    ) -> Self {
        let temp_path = std::env::temp_dir().join(format!(
            "libretracks-test-source-{}-{}.wav",
            std::process::id(),
            randomish_id()
        ));
        write_test_wav(&temp_path, &preload_samples, sample_rate, channels)
            .expect("test wav should be writable");
        Self {
            file_path: temp_path,
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            frame_count: preload_samples.len() / channels.max(1),
            seek_index: Vec::new(),
        }
    }

    fn preload_bytes(&self) -> usize {
        self.frame_count
            .saturating_mul(self.channels)
            .saturating_mul(size_of::<f32>())
    }

    #[cfg(test)]
    pub(crate) fn read_preloaded_sample_for_test(
        &self,
        frame_index: usize,
        channel: usize,
        output_channels: usize,
    ) -> f32 {
        decode_file_region(
            &self.file_path,
            self.sample_rate,
            self.channels,
            frame_index as f64 / f64::from(self.sample_rate.max(1)),
            1,
        )
        .ok()
        .and_then(|samples| {
            let source_channel = if output_channels == 1 && self.channels > 1 {
                return Some((samples[0] + samples[1.min(samples.len() - 1)]) * 0.5);
            } else if self.channels == 1 {
                0
            } else {
                channel.min(self.channels - 1)
            };
            samples.get(source_channel).copied()
        })
        .unwrap_or(0.0)
    }
}

impl AudioBufferCache {
    #[cfg(test)]
    pub(crate) fn insert_for_test(&self, file_path: PathBuf, source: StreamingAudioSource) {
        self.entries
            .write()
            .expect("audio cache should lock")
            .insert(file_path, Arc::new(source));
    }

    pub(crate) fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), String> {
        let mut unique_paths = Vec::new();
        let mut seen_paths = HashSet::new();

        for clip in &song.clips {
            let file_path = resolve_clip_audio_path(song_dir, &clip.file_path);
            if seen_paths.insert(file_path.clone()) {
                unique_paths.push((file_path, clip.file_path.clone()));
            }
        }

        unique_paths.sort_by(|left, right| left.0.cmp(&right.0));

        let existing_entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        let mut next_entries = HashMap::with_capacity(unique_paths.len());
        let mut missing_paths = Vec::new();

        for (file_path, waveform_key) in unique_paths {
            if let Some(buffer) = existing_entries.get(&file_path) {
                next_entries.insert(file_path.clone(), Arc::clone(buffer));
            } else {
                missing_paths.push((file_path, waveform_key));
            }
        }

        drop(existing_entries);

        let prepared_entries = missing_paths
            .into_par_iter()
            .filter_map(|(file_path, waveform_key)| match prepare_audio_source(&file_path) {
                Ok(mut source) => {
                    if let Ok(summary) = load_waveform_summary(song_dir, &waveform_key) {
                        source.seek_index = summary
                            .seek_index
                            .into_iter()
                            .map(|entry| SeekIndexEntry {
                                timestamp: entry.timestamp,
                                packet_offset: entry.packet_offset,
                            })
                            .collect();
                    }
                    Some((file_path, Arc::new(source)))
                }
                Err(error) => {
                    eprintln!(
                        "[libretracks-audio] Skipping missing or invalid file {}: {}",
                        file_path.display(),
                        error
                    );
                    None
                }
            })
            .collect::<Vec<_>>();

        for (file_path, prepared_source) in prepared_entries {
            next_entries.insert(file_path, prepared_source);
        }

        let mut entries = self
            .entries
            .write()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        *entries = next_entries;

        Ok(())
    }

    pub(crate) fn get(
        &self,
        file_path: &Path,
    ) -> Result<Option<Arc<StreamingAudioSource>>, String> {
        let entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        Ok(entries.get(file_path).cloned())
    }

    pub(crate) fn stats(&self) -> AudioBufferCacheStats {
        self.entries
            .read()
            .map(|entries| AudioBufferCacheStats {
                cached_buffers: entries.len(),
                fully_cached_buffers: 0,
                preload_bytes: entries.values().map(|source| source.preload_bytes()).sum(),
            })
            .unwrap_or_default()
    }
}

impl StreamingClipReader {
    pub(crate) fn open(
        plan: &mixer::PlaybackClipPlan,
        output_sample_rate: u32,
        audio_buffers: &AudioBufferCache,
        timeline_frame: u64,
    ) -> Result<Self, String> {
        let shared_source = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio source is not prepared: {}", plan.file_path.display()))?;
        let output_sample_rate = output_sample_rate.max(1);
        let source_start_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            shared_source.sample_rate,
        );
        let source_start_seconds =
            source_start_frame as f64 / f64::from(shared_source.sample_rate.max(1));
        let ring_capacity =
            output_sample_rate as usize * STREAM_SECONDS_PER_CLIP * shared_source.channels.max(1);
        let (producer, consumer) = RingBuffer::<f32>::new(ring_capacity.max(256));
        let (command_sender, command_receiver) = mpsc::channel();
        let worker_source = Arc::clone(&shared_source);
        let _worker_handle = thread::Builder::new()
            .name("libretracks-streaming-source".into())
            .spawn(move || {
                run_streaming_worker(
                    worker_source,
                    output_sample_rate,
                    source_start_seconds,
                    producer,
                    command_receiver,
                )
            })
            .map_err(|error| error.to_string())?;

        let elapsed_frames = timeline_frame.saturating_sub(plan.timeline_start_frame);
        let remaining_frames = plan.duration_frames.saturating_sub(elapsed_frames) as usize;
        let declick_fade_frames = (0.005 * output_sample_rate as f32).round() as usize;
        Ok(Self {
            shared_source,
            consumer,
            command_sender,
            output_sample_rate,
            emitted_frames: 0,
            total_output_frames: remaining_frames,
            declick_fade_frames,
            declick_frames_remaining: declick_fade_frames,
            eof: remaining_frames == 0,
        })
    }

    fn seek_to_internal(&mut self, target_frame: usize) -> Result<(), String> {
        while self.consumer.pop().is_ok() {}
        self.emitted_frames = 0;
        self.declick_frames_remaining = self.declick_fade_frames;
        self.eof = self.total_output_frames == 0;
        let source_start_seconds =
            target_frame as f64 / f64::from(self.shared_source.sample_rate.max(1));
        self.command_sender
            .send(StreamingWorkerCommand::Seek {
                source_start_seconds,
            })
            .map_err(|_| "streaming worker is unavailable".to_string())
    }

    #[cfg(test)]
    pub(crate) fn seek_to(&mut self, target_frame: usize) {
        let _ = self.seek_to_internal(target_frame);
    }

    #[cfg(test)]
    pub(crate) fn current_frame(&self) -> usize {
        let source_ratio = self.shared_source.sample_rate as f64 / self.output_sample_rate as f64;
        (self.emitted_frames as f64 * source_ratio).round() as usize
    }

    #[cfg(test)]
    pub(crate) fn shared_source(&self) -> &StreamingAudioSource {
        &self.shared_source
    }

    pub(crate) fn next_stereo_frame(&mut self, gain: f32, pan: f32) -> Option<(f32, f32)> {
        if self.eof {
            return None;
        }

        let pan = pan.clamp(-1.0, 1.0);
        let channels = self.shared_source.channels.max(1);
        let (left_input, right_input) = if channels <= 1 {
            match self.consumer.pop() {
                Ok(sample) => (sample, sample),
                Err(_) => {
                    self.declick_frames_remaining = self.declick_fade_frames;
                    (0.0, 0.0)
                }
            }
        } else {
            match (self.consumer.pop(), self.consumer.pop()) {
                (Ok(left), Ok(right)) => {
                    for _ in 2..channels {
                        let _ = self.consumer.pop();
                    }
                    (left, right)
                }
                _ => {
                    self.declick_frames_remaining = self.declick_fade_frames;
                    (0.0, 0.0)
                }
            }
        };

        self.emitted_frames = self.emitted_frames.saturating_add(1);
        if self.emitted_frames >= self.total_output_frames {
            self.eof = true;
        }

        let mut final_gain = gain;
        if self.declick_frames_remaining > 0 {
            let fade_progress =
                1.0 - (self.declick_frames_remaining as f32 / self.declick_fade_frames as f32);
            final_gain *= fade_progress;
            self.declick_frames_remaining -= 1;
        }

        if final_gain.abs() <= GAIN_EPSILON {
            return Some((0.0, 0.0));
        }

        let (left_output, right_output) =
            mixer::apply_runtime_pan(left_input, right_input, pan, channels);
        Some((left_output * final_gain, right_output * final_gain))
    }

    pub(crate) fn mix_into_with_channel_gains(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
        pan: f32,
    ) -> (f32, f32) {
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;

        for frame_offset in 0..frame_count {
            let Some((left_output, right_output)) = self.next_stereo_frame(gain, pan) else {
                break;
            };
            let buffer_base = (offset_frames + frame_offset) * output_channels;
            if output_channels <= 1 {
                let mono_sample = (left_output + right_output) * 0.5;
                buffer[buffer_base] += mono_sample;
                let mono_peak = mono_sample.abs();
                left_peak = left_peak.max(mono_peak);
                right_peak = right_peak.max(mono_peak);
            } else {
                buffer[buffer_base] += left_output;
                buffer[buffer_base + 1] += right_output;
                left_peak = left_peak.max(left_output.abs());
                right_peak = right_peak.max(right_output.abs());
            }
        }

        (left_peak, right_peak)
    }
}

impl Drop for StreamingClipReader {
    fn drop(&mut self) {
        let _ = self.command_sender.send(StreamingWorkerCommand::Shutdown);
    }
}

pub(crate) type SharedAudioSource = StreamingAudioSource;
pub(crate) type MemoryClipReader = StreamingClipReader;

fn run_streaming_worker(
    source: Arc<StreamingAudioSource>,
    output_sample_rate: u32,
    initial_start_seconds: f64,
    mut producer: Producer<f32>,
    command_receiver: Receiver<StreamingWorkerCommand>,
) {
    let mut start_seconds = initial_start_seconds;

    loop {
        match stream_decode_from(
            &source,
            output_sample_rate,
            start_seconds,
            &mut producer,
            &command_receiver,
        ) {
            WorkerOutcome::Restart(next_start) => start_seconds = next_start,
            WorkerOutcome::Shutdown | WorkerOutcome::Finished => break,
        }
    }
}

enum WorkerOutcome {
    Restart(f64),
    Finished,
    Shutdown,
}

fn stream_decode_from(
    source: &StreamingAudioSource,
    output_sample_rate: u32,
    start_seconds: f64,
    producer: &mut Producer<f32>,
    command_receiver: &Receiver<StreamingWorkerCommand>,
) -> WorkerOutcome {
    let mut decoder = match StreamingDecoder::open(source, output_sample_rate, start_seconds) {
        Ok(decoder) => decoder,
        Err(_) => return WorkerOutcome::Finished,
    };

    loop {
        while let Ok(command) = command_receiver.try_recv() {
            match command {
                StreamingWorkerCommand::Seek {
                    source_start_seconds,
                } => {
                    return WorkerOutcome::Restart(source_start_seconds);
                }
                StreamingWorkerCommand::Shutdown => return WorkerOutcome::Shutdown,
            }
        }

        if producer.slots() < source.channels.max(1) {
            thread::yield_now();
            continue;
        }

        let samples = match decoder.next_output_chunk(STREAM_WORKER_CHUNK_FRAMES) {
            Ok(samples) if samples.is_empty() => return WorkerOutcome::Finished,
            Ok(samples) => samples,
            Err(_) => return WorkerOutcome::Finished,
        };

        for sample in samples {
            while producer.push(sample).is_err() {
                if let Ok(command) = command_receiver.try_recv() {
                    match command {
                        StreamingWorkerCommand::Seek {
                            source_start_seconds,
                        } => return WorkerOutcome::Restart(source_start_seconds),
                        StreamingWorkerCommand::Shutdown => return WorkerOutcome::Shutdown,
                    }
                }
                thread::yield_now();
            }
        }
    }
}

struct StreamingDecoder {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    channels: usize,
    input_sample_rate: u32,
    output_sample_rate: u32,
    discard_input_frames: usize,
}

impl StreamingDecoder {
    fn open(
        source: &StreamingAudioSource,
        output_sample_rate: u32,
        start_seconds: f64,
    ) -> Result<Self, String> {
        let file = File::open(&source.file_path).map_err(|error| error.to_string())?;
        let mut hint = Hint::new();
        if let Some(extension) = source
            .file_path
            .extension()
            .and_then(|value| value.to_str())
        {
            hint.with_extension(extension);
        }
        let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                media_source_stream,
                &FormatOptions {
                    prebuild_seek_index: false,
                    seek_index_fill_rate: 1,
                    ..FormatOptions::default()
                },
                &MetadataOptions::default(),
            )
            .map_err(|error| error.to_string())?;
        let mut format = probed.format;
        let track = format
            .default_track()
            .or_else(|| {
                format
                    .tracks()
                    .iter()
                    .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            })
            .ok_or_else(|| "unsupported audio stream".to_string())?;
        let track_id = track.id;
        let codec_params = track.codec_params.clone();
        let input_sample_rate = codec_params
            .sample_rate
            .unwrap_or(source.sample_rate)
            .max(1);
        let channels = codec_params
            .channels
            .map(|channels| channels.count())
            .unwrap_or(source.channels)
            .max(1);
        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|error| error.to_string())?;

        let mut actual_seek_seconds = 0.0;
        if start_seconds > 0.0 {
            let seek_time = nearest_seek_time(source, start_seconds, input_sample_rate);
            if let Ok(seeked) = format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seek_time),
                    track_id: Some(track_id),
                },
            ) {
                actual_seek_seconds = seeked.actual_ts as f64 / f64::from(input_sample_rate);
            }
        }
        let discard_input_frames = ((start_seconds.max(0.0) - actual_seek_seconds).max(0.0)
            * f64::from(input_sample_rate))
        .round() as usize;

        Ok(Self {
            format,
            decoder,
            track_id,
            channels,
            input_sample_rate,
            output_sample_rate: output_sample_rate.max(1),
            discard_input_frames,
        })
    }

    fn next_output_chunk(&mut self, max_frames: usize) -> Result<Vec<f32>, String> {
        let mut input = Vec::new();
        while input.len() < max_frames.saturating_mul(self.channels) {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(error) => return Err(error.to_string()),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => return Err(error.to_string()),
            };
            let mut sample_buffer =
                SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            sample_buffer.copy_interleaved_ref(decoded);
            let mut samples = sample_buffer.samples();
            if self.discard_input_frames > 0 {
                let decoded_frames = samples.len() / self.channels.max(1);
                let skip_frames = self.discard_input_frames.min(decoded_frames);
                self.discard_input_frames -= skip_frames;
                samples = &samples[skip_frames * self.channels.max(1)..];
            }
            input.extend_from_slice(samples);
        }

        Ok(resample_interleaved(
            &input,
            self.channels,
            self.input_sample_rate,
            self.output_sample_rate,
        ))
    }
}

pub(crate) fn prepare_audio_source(file_path: &Path) -> Result<StreamingAudioSource, String> {
    let file = File::open(file_path).map_err(|error| error.to_string())?;
    let mut hint = Hint::new();
    if let Some(extension) = file_path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source_stream,
            &FormatOptions {
                prebuild_seek_index: true,
                seek_index_fill_rate: 1,
                ..FormatOptions::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| format!("unsupported audio stream: {}", file_path.display()))?;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48_000).max(1);
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1)
        .max(1);
    let frame_count = track.codec_params.n_frames.unwrap_or(0) as usize;

    Ok(StreamingAudioSource {
        file_path: file_path.to_path_buf(),
        sample_rate,
        channels,
        frame_count,
        seek_index: Vec::new(),
    })
}

fn nearest_seek_time(source: &StreamingAudioSource, start_seconds: f64, sample_rate: u32) -> f64 {
    if source.seek_index.is_empty() {
        return start_seconds.max(0.0);
    }
    let target_ts = (start_seconds.max(0.0) * f64::from(sample_rate.max(1))) as u64;
    source
        .seek_index
        .iter()
        .take_while(|entry| entry.timestamp <= target_ts)
        .max_by_key(|entry| (entry.timestamp, entry.packet_offset))
        .map(|entry| entry.timestamp as f64 / f64::from(sample_rate.max(1)))
        .unwrap_or(0.0)
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

fn source_start_seconds_floor(seconds: f64) -> f64 {
    if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    }
}

fn source_frame_for_timeline_position(
    plan: &mixer::PlaybackClipPlan,
    timeline_frame: u64,
    output_sample_rate: u32,
    source_sample_rate: u32,
) -> usize {
    let elapsed_frames = timeline_frame.saturating_sub(plan.timeline_start_frame);
    let elapsed_seconds = elapsed_frames as f64 / output_sample_rate.max(1) as f64;
    seconds_to_frames(
        source_start_seconds_floor(plan.source_start_seconds) + elapsed_seconds,
        source_sample_rate,
    ) as usize
}

pub(crate) fn resolve_clip_audio_path(song_dir: &Path, file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir.join(path)
    }
}

#[cfg(test)]
pub(crate) fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let prepared = prepare_audio_source(file_path)?;
    (prepared.channels() > 0 && prepared.sample_rate() > 0)
        .then_some(())
        .ok_or_else(|| "empty audio stream".to_string())
}

#[cfg(test)]
fn decode_file_region(
    file_path: &Path,
    _sample_rate: u32,
    channels: usize,
    start_seconds: f64,
    frames: usize,
) -> Result<Vec<f32>, String> {
    let source = prepare_audio_source(file_path)?;
    let mut decoder = StreamingDecoder::open(&source, source.sample_rate, start_seconds)?;
    let samples = decoder.next_output_chunk(frames)?;
    let wanted = frames.saturating_mul(channels.max(1));
    Ok(samples.into_iter().take(wanted).collect())
}

#[cfg(test)]
fn randomish_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
fn write_test_wav(
    path: &Path,
    samples: &[f32],
    sample_rate: u32,
    channels: usize,
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: channels.max(1) as u16,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for &sample in samples {
        writer
            .write_sample(sample)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}
