use super::*;
use std::{collections::HashSet, fs::File};

use memmap2::Mmap;
use rayon::prelude::*;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AudioBufferCacheStats {
    pub cached_buffers: usize,
    pub fully_cached_buffers: usize,
    pub preload_bytes: usize,
}

#[derive(Clone, Default)]
pub(crate) struct AudioBufferCache {
    entries: Arc<RwLock<HashMap<PathBuf, Arc<SharedAudioSource>>>>,
}

#[derive(Debug)]
pub(crate) struct SharedAudioSource {
    preload_samples: Vec<f32>,
    mapped_audio: Option<MappedAudioSource>,
    preload_frame_count: usize,
    sample_rate: u32,
    channels: usize,
    fully_cached: bool,
}

#[derive(Debug)]
pub(crate) struct MappedAudioSource {
    mmap: Mmap,
    data_offset: usize,
    data_len: usize,
    bytes_per_sample: usize,
    encoding: WavSampleEncoding,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum WavSampleEncoding {
    Float32,
    SignedInt8,
    SignedInt16,
    SignedInt24,
    SignedInt32,
}

pub(crate) struct MemoryClipReader {
    shared_source: Arc<SharedAudioSource>,
    output_sample_rate: u32,
    current_frame: usize,
    source_frame_cursor: f64,
    pub(crate) eof: bool,
}

pub(crate) struct ParsedWavLayout {
    sample_rate: u32,
    channels: usize,
    bits_per_sample: u16,
    data_offset: usize,
    data_len: usize,
    encoding: WavSampleEncoding,
}

impl SharedAudioSource {
    pub(crate) fn preload_frame_count(&self) -> usize {
        self.preload_frame_count
    }

    fn preload_bytes(&self) -> usize {
        self.mapped_audio
            .as_ref()
            .map(MappedAudioSource::data_bytes)
            .unwrap_or_else(|| self.preload_samples.len().saturating_mul(size_of::<f32>()))
    }

    fn read_preloaded_sample(
        &self,
        frame_index: usize,
        channel: usize,
        output_channels: usize,
    ) -> f32 {
        if frame_index >= self.preload_frame_count {
            return 0.0;
        }

        if let Some(mapped_audio) = &self.mapped_audio {
            if output_channels == 1 && self.channels > 1 {
                let left = mapped_audio.read_sample(frame_index, 0, self.channels);
                let right = mapped_audio.read_sample(
                    frame_index,
                    1.min(self.channels.saturating_sub(1)),
                    self.channels,
                );
                return (left + right) * 0.5;
            }

            let source_channel = if self.channels == 1 {
                0
            } else {
                channel.min(self.channels - 1)
            };

            return mapped_audio.read_sample(frame_index, source_channel, self.channels);
        }

        let sample_index = frame_index.saturating_mul(self.channels);
        if sample_index >= self.preload_samples.len() {
            return 0.0;
        }

        if output_channels == 1 && self.channels > 1 {
            let left = self.preload_samples[sample_index];
            let right = self.preload_samples[sample_index + 1.min(self.channels - 1)];
            return (left + right) * 0.5;
        }

        let source_channel = if self.channels == 1 {
            0
        } else {
            channel.min(self.channels - 1)
        };

        self.preload_samples[sample_index + source_channel]
    }
}

impl MappedAudioSource {
    fn data_bytes(&self) -> usize {
        self.data_len
    }

    fn read_sample(&self, frame_index: usize, channel: usize, channels: usize) -> f32 {
        let sample_index = frame_index
            .saturating_mul(channels)
            .saturating_add(channel.min(channels.saturating_sub(1)));
        let byte_offset = self
            .data_offset
            .saturating_add(sample_index.saturating_mul(self.bytes_per_sample));
        if byte_offset.saturating_add(self.bytes_per_sample) > self.mmap.len() {
            return 0.0;
        }

        let bytes = &self.mmap[byte_offset..byte_offset + self.bytes_per_sample];
        match self.encoding {
            WavSampleEncoding::Float32 => {
                let mut sample = [0_u8; 4];
                sample.copy_from_slice(bytes);
                f32::from_le_bytes(sample)
            }
            WavSampleEncoding::SignedInt8 => bytes[0] as i8 as f32 / i8::MAX as f32,
            WavSampleEncoding::SignedInt16 => {
                let mut sample = [0_u8; 2];
                sample.copy_from_slice(bytes);
                i16::from_le_bytes(sample) as f32 / i16::MAX as f32
            }
            WavSampleEncoding::SignedInt24 => {
                let sign = if bytes[2] & 0x80 == 0 { 0 } else { 0xFF };
                let sample = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], sign]);
                sample as f32 / 8_388_607.0
            }
            WavSampleEncoding::SignedInt32 => {
                let mut sample = [0_u8; 4];
                sample.copy_from_slice(bytes);
                i32::from_le_bytes(sample) as f32 / i32::MAX as f32
            }
        }
    }
}

impl AudioBufferCache {
    pub(crate) fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), String> {
        let mut unique_paths = Vec::new();
        let mut seen_paths = HashSet::new();

        for clip in &song.clips {
            let file_path = song_dir.join(&clip.file_path);
            if seen_paths.insert(file_path.clone()) {
                unique_paths.push(file_path);
            }
        }

        unique_paths.sort();

        let existing_entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        let mut next_entries = HashMap::with_capacity(unique_paths.len());
        let mut missing_paths = Vec::new();

        for file_path in unique_paths {
            if let Some(buffer) = existing_entries.get(&file_path) {
                next_entries.insert(file_path.clone(), Arc::clone(buffer));
            } else {
                missing_paths.push(file_path);
            }
        }

        drop(existing_entries);

        let prepared_entries = missing_paths
            .into_par_iter()
            .map(|file_path| {
                prepare_audio_source(&file_path).map(|source| (file_path, Arc::new(source)))
            })
            .collect::<Result<Vec<_>, _>>()?;

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

    pub(crate) fn get(&self, file_path: &Path) -> Result<Option<Arc<SharedAudioSource>>, String> {
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
                fully_cached_buffers: entries
                    .values()
                    .filter(|source| source.fully_cached)
                    .count(),
                preload_bytes: entries.values().map(|source| source.preload_bytes()).sum(),
            })
            .unwrap_or_default()
    }
}

impl MemoryClipReader {
    pub(crate) fn open(
        plan: &mixer::PlaybackClipPlan,
        output_sample_rate: u32,
        audio_buffers: &AudioBufferCache,
        timeline_frame: u64,
    ) -> Result<Self, String> {
        let shared_source = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio buffer is not cached: {}", plan.file_path.display()))?;
        let mut reader = Self {
            shared_source,
            output_sample_rate: output_sample_rate.max(1),
            current_frame: 0,
            source_frame_cursor: 0.0,
            eof: false,
        };
        let source_start_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            reader.shared_source.sample_rate,
        );
        reader.seek_to_internal(source_start_frame)?;
        Ok(reader)
    }

    fn seek_to_internal(&mut self, target_frame: usize) -> Result<(), String> {
        self.current_frame = target_frame;
        self.source_frame_cursor = self.current_frame as f64;
        self.eof = self.current_frame >= self.shared_source.preload_frame_count();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn seek_to(&mut self, target_frame: usize) {
        let _ = self.seek_to_internal(target_frame);
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
        if self.eof {
            return (0.0, 0.0);
        }

        let frame_step = self.shared_source.sample_rate as f64 / self.output_sample_rate as f64;
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;
        let pan = pan.clamp(-1.0, 1.0);

        for frame_offset in 0..frame_count {
            if !self.ensure_frame_available(self.current_frame) {
                self.eof = true;
                break;
            }

            if gain.abs() > GAIN_EPSILON {
                let buffer_base = (offset_frames + frame_offset) * output_channels;
                if output_channels <= 1 {
                    let mono_sample =
                        self.read_sample(self.current_frame, 0, output_channels) * gain;
                    buffer[buffer_base] += mono_sample;
                    let mono_peak = mono_sample.abs();
                    left_peak = left_peak.max(mono_peak);
                    right_peak = right_peak.max(mono_peak);
                } else {
                    let left_input = self.read_sample(self.current_frame, 0, 2);
                    let right_input = if self.shared_source.channels > 1 {
                        self.read_sample(self.current_frame, 1, 2)
                    } else {
                        left_input
                    };
                    let (mut left_output, mut right_output) = mixer::apply_runtime_pan(
                        left_input,
                        right_input,
                        pan,
                        self.shared_source.channels,
                    );
                    left_output *= gain;
                    right_output *= gain;

                    buffer[buffer_base] += left_output;
                    buffer[buffer_base + 1] += right_output;
                    left_peak = left_peak.max(left_output.abs());
                    right_peak = right_peak.max(right_output.abs());
                }
            }

            self.source_frame_cursor += frame_step;
            self.current_frame = self.source_frame_cursor.round().max(0.0) as usize;
        }

        if self.current_frame >= self.shared_source.preload_frame_count() {
            self.eof = true;
        }

        (left_peak, right_peak)
    }

    fn ensure_frame_available(&mut self, frame_index: usize) -> bool {
        frame_index < self.shared_source.preload_frame_count()
    }

    fn read_sample(&self, frame_index: usize, channel: usize, output_channels: usize) -> f32 {
        if frame_index < self.shared_source.preload_frame_count() {
            return self
                .shared_source
                .read_preloaded_sample(frame_index, channel, output_channels);
        }

        self.shared_source
            .read_preloaded_sample(frame_index, channel, output_channels)
    }
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

pub(crate) fn prepare_audio_source(file_path: &Path) -> Result<SharedAudioSource, String> {
    let file = File::open(file_path).map_err(|error| error.to_string())?;
    let mmap = unsafe { Mmap::map(&file).map_err(|error| error.to_string())? };
    let layout = parse_wav_layout(&mmap, file_path)?;
    let preload_frame_count = layout
        .data_len
        .checked_div(
            layout
                .channels
                .saturating_mul(usize::from(layout.bits_per_sample / 8)),
        )
        .unwrap_or(0);

    Ok(SharedAudioSource {
        preload_samples: Vec::new(),
        mapped_audio: Some(MappedAudioSource {
            mmap,
            data_offset: layout.data_offset,
            data_len: layout.data_len,
            bytes_per_sample: usize::from(layout.bits_per_sample / 8),
            encoding: layout.encoding,
        }),
        preload_frame_count,
        sample_rate: layout.sample_rate.max(1),
        channels: layout.channels.max(1),
        fully_cached: true,
    })
}

pub(crate) fn parse_wav_layout(bytes: &[u8], file_path: &Path) -> Result<ParsedWavLayout, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!(
            "unsupported wav container: {}",
            file_path.display()
        ));
    }

    let mut cursor = 12usize;
    let mut sample_rate = 0u32;
    let mut channels = 0usize;
    let mut bits_per_sample = 0u16;
    let mut encoding = None;
    let mut data_offset = None;
    let mut data_len = None;

    while cursor.saturating_add(8) <= bytes.len() {
        let chunk_id = &bytes[cursor..cursor + 4];
        let chunk_len = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        let chunk_data_start = cursor + 8;
        let chunk_data_end = chunk_data_start.saturating_add(chunk_len).min(bytes.len());

        match chunk_id {
            b"fmt " if chunk_len >= 16 && chunk_data_end <= bytes.len() => {
                let fmt_bytes = &bytes[chunk_data_start..chunk_data_end];
                let audio_format = u16::from_le_bytes([fmt_bytes[0], fmt_bytes[1]]);
                channels = usize::from(u16::from_le_bytes([fmt_bytes[2], fmt_bytes[3]]).max(1));
                sample_rate =
                    u32::from_le_bytes([fmt_bytes[4], fmt_bytes[5], fmt_bytes[6], fmt_bytes[7]]);
                bits_per_sample = u16::from_le_bytes([fmt_bytes[14], fmt_bytes[15]]);
                encoding = Some(resolve_wav_sample_encoding(
                    audio_format,
                    bits_per_sample,
                    fmt_bytes,
                    file_path,
                )?);
            }
            b"data" => {
                data_offset = Some(chunk_data_start);
                data_len = Some(chunk_len.min(bytes.len().saturating_sub(chunk_data_start)));
            }
            _ => {}
        }

        let padded_chunk_len = chunk_len + (chunk_len % 2);
        cursor = chunk_data_start.saturating_add(padded_chunk_len);
    }

    let encoding =
        encoding.ok_or_else(|| format!("missing fmt chunk in {}", file_path.display()))?;
    let data_offset =
        data_offset.ok_or_else(|| format!("missing data chunk in {}", file_path.display()))?;
    let data_len =
        data_len.ok_or_else(|| format!("missing data chunk in {}", file_path.display()))?;
    if channels == 0 || bits_per_sample == 0 || sample_rate == 0 {
        return Err(format!("invalid wav metadata in {}", file_path.display()));
    }

    Ok(ParsedWavLayout {
        sample_rate,
        channels,
        bits_per_sample,
        data_offset,
        data_len,
        encoding,
    })
}

fn resolve_wav_sample_encoding(
    audio_format: u16,
    bits_per_sample: u16,
    fmt_bytes: &[u8],
    file_path: &Path,
) -> Result<WavSampleEncoding, String> {
    let canonical_format = match audio_format {
        0xFFFE => parse_wave_format_extensible_subformat(fmt_bytes, file_path)?,
        other => other,
    };

    match (canonical_format, bits_per_sample) {
        (1, 8) => Ok(WavSampleEncoding::SignedInt8),
        (1, 16) => Ok(WavSampleEncoding::SignedInt16),
        (1, 24) => Ok(WavSampleEncoding::SignedInt24),
        (1, 32) => Ok(WavSampleEncoding::SignedInt32),
        (3, 32) => Ok(WavSampleEncoding::Float32),
        _ => Err(format!(
            "unsupported wav sample format {audio_format}/{bits_per_sample} for {}",
            file_path.display()
        )),
    }
}

fn parse_wave_format_extensible_subformat(
    fmt_bytes: &[u8],
    file_path: &Path,
) -> Result<u16, String> {
    if fmt_bytes.len() < 40 {
        return Err(format!(
            "unsupported wav extensible fmt chunk in {}",
            file_path.display()
        ));
    }

    let extension_size = u16::from_le_bytes([fmt_bytes[16], fmt_bytes[17]]) as usize;
    if extension_size < 22 {
        return Err(format!(
            "unsupported wav extensible metadata in {}",
            file_path.display()
        ));
    }

    Ok(u16::from_le_bytes([fmt_bytes[24], fmt_bytes[25]]))
}

#[cfg(test)]
pub(crate) fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let prepared = prepare_audio_source(file_path)?;
    (prepared.preload_frame_count() > 0)
        .then_some(())
        .ok_or_else(|| "empty audio stream".to_string())
}
