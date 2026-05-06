use super::*;
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use rtrb::{Consumer, Producer};

#[derive(Clone, Copy)]
pub(crate) struct OutputSample {
    pub(crate) generation: u64,
    pub(crate) value: f32,
}

pub(crate) struct DiskReaderState {
    pub(crate) mixer: mixer::Mixer,
    pub(crate) producer: Producer<OutputSample>,
    pub(crate) command_receiver: Receiver<ReaderCommand>,
    pub(crate) current_generation: u64,
    pub(crate) is_running: bool,
    pub(crate) stop_after_master_fade: bool,
}

#[derive(Default)]
pub(crate) struct DiskReaderReport;

pub(crate) fn spawn_disk_reader(state: DiskReaderState) -> JoinHandle<DiskReaderReport> {
    thread::Builder::new()
        .name("libretracks-disk-reader".into())
        .spawn(move || run_disk_reader(state))
        .expect("disk reader thread should start")
}

pub(crate) fn build_output_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    consumer: Consumer<OutputSample>,
    seek_generation: Arc<AtomicU64>,
) -> Result<Stream, String> {
    let error_callback = |error| eprintln!("[libretracks-audio] cpal stream error: {error}");

    match sample_format {
        SampleFormat::F32 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut state = CpalCrossfadeState::new(
                seek_generation.load(Ordering::Acquire),
                config.sample_rate.0,
                config.channels as usize,
            );
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut state,
                            |sample| sample,
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::I16 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut state = CpalCrossfadeState::new(
                seek_generation.load(Ordering::Acquire),
                config.sample_rate.0,
                config.channels as usize,
            );
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut state,
                            |sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16,
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::U16 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut state = CpalCrossfadeState::new(
                seek_generation.load(Ordering::Acquire),
                config.sample_rate.0,
                config.channels as usize,
            );
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut state,
                            |sample| {
                                (((sample.clamp(-1.0, 1.0) * 0.5) + 0.5) * u16::MAX as f32) as u16
                            },
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        other => Err(format!("unsupported output sample format: {other:?}")),
    }
}

pub(crate) fn drain_consumer_samples<T>(
    data: &mut [T],
    consumer: &mut Consumer<OutputSample>,
    seek_generation: &Arc<AtomicU64>,
    state: &mut CpalCrossfadeState,
    convert: impl Fn(f32) -> T,
) where
    T: Copy,
{
    let latest_generation = seek_generation.load(Ordering::Acquire);
    if latest_generation != state.active_generation {
        state.fading_buffer.clear();
        state.fade_index = 0;

        let mut new_overflow =
            std::collections::VecDeque::with_capacity(state.overflow.len() + consumer.slots());

        // 1. Process existing overflow: Drop stale, keep fading out the old active, stash the new.
        while let Some(sample) = state.overflow.pop_front() {
            if sample.generation == state.active_generation {
                state.fading_buffer.push(sample.value);
            } else if sample.generation == latest_generation {
                new_overflow.push_back(sample);
            }
        }

        // 2. Process current consumer items
        while let Ok(sample) = consumer.pop() {
            if sample.generation == state.active_generation {
                state.fading_buffer.push(sample.value);
            } else if sample.generation == latest_generation {
                new_overflow.push_back(sample);
            }
        }

        let fade_len = state.fading_buffer.len().min(state.max_fade_samples);
        state.fading_buffer.truncate(fade_len);

        state.overflow = new_overflow;
        state.active_generation = latest_generation;
    }

    for output in data {
        // 3. Strictly pull ONLY the active_generation, drop stales, and pause on futures.
        let sample = loop {
            if let Some(front) = state.overflow.front() {
                if front.generation == state.active_generation {
                    break state.overflow.pop_front().unwrap().value;
                } else if front.generation > state.active_generation {
                    break 0.0; // Wait for the main thread to catch up to this future generation
                } else {
                    state.overflow.pop_front(); // Drop stale
                    continue;
                }
            }

            match consumer.pop() {
                Ok(popped) => {
                    if popped.generation == state.active_generation {
                        break popped.value;
                    } else if popped.generation > state.active_generation {
                        state.overflow.push_back(popped);
                        break 0.0;
                    } else {
                        continue; // Drop stale
                    }
                }
                Err(_) => break 0.0, // Buffer empty
            }
        };

        let mut final_sample = sample;

        if state.fade_index < state.fading_buffer.len() {
            let old_sample = state.fading_buffer[state.fade_index];
            let fade_progress = state.fade_index as f32 / state.fading_buffer.len().max(1) as f32;
            let fade_out = (fade_progress * std::f32::consts::FRAC_PI_2).cos();
            final_sample += old_sample * fade_out;
            state.fade_index += 1;
        }

        *output = convert(final_sample);
    }
}

pub(crate) struct CpalCrossfadeState {
    pub active_generation: u64,
    pub fading_buffer: Vec<f32>,
    pub fade_index: usize,
    pub overflow: std::collections::VecDeque<OutputSample>,
    pub max_fade_samples: usize,
}

impl CpalCrossfadeState {
    pub fn new(active_generation: u64, sample_rate: u32, channels: usize) -> Self {
        Self {
            active_generation,
            fading_buffer: Vec::with_capacity(8192),
            fade_index: 0,
            overflow: std::collections::VecDeque::with_capacity(8192),
            max_fade_samples: (0.020 * sample_rate as f32).round() as usize * channels,
        }
    }
}

pub(crate) fn run_disk_reader(mut state: DiskReaderState) -> DiskReaderReport {
    loop {
        if state.consume_commands() {
            break;
        }

        if !state.is_running {
            thread::sleep(Duration::from_millis(1));
            continue;
        }

        state.mixer.refresh_cached_live_mix();

        let free_frames = state.producer.slots() / state.mixer.output_channels.max(1);
        if free_frames == 0 {
            thread::yield_now();
            continue;
        }

        let block_frames = DISK_RENDER_BLOCK_FRAMES.min(free_frames);
        if block_frames == 0 {
            break;
        }

        let block = state.mixer.render_next_block(block_frames);
        if !push_block_into_ring(&mut state.producer, &block, state.current_generation) {
            break;
        }

        state.finish_stop_after_fade_if_needed();
    }

    DiskReaderReport
}

impl DiskReaderState {
    pub(crate) fn consume_commands(&mut self) -> bool {
        let mut should_shutdown = false;

        while let Ok(command) = self.command_receiver.try_recv() {
            match command {
                ReaderCommand::UpdateSong(song) => self.mixer.apply_song_update(song),
                ReaderCommand::Play {
                    song,
                    position_seconds,
                    reason,
                    generation,
                } => {
                    self.mixer
                        .seek_with_transition(song, position_seconds, reason.into());
                    self.mixer.start_master_fade(1.0, 0.0);
                    self.current_generation = generation;
                    self.is_running = true;
                    self.stop_after_master_fade = false;
                }
                ReaderCommand::Seek {
                    song,
                    position_seconds,
                    reason,
                    generation,
                } => {
                    self.mixer
                        .seek_with_transition(song, position_seconds, reason.into());
                    self.current_generation = generation;
                    self.is_running = true;
                    self.stop_after_master_fade = false;
                }
                ReaderCommand::Stop {
                    fade_duration_seconds,
                } => {
                    if self.is_running && fade_duration_seconds > 0.0 {
                        self.mixer.start_master_fade(0.0, fade_duration_seconds);
                        self.stop_after_master_fade = true;
                    } else {
                        self.is_running = false;
                        self.stop_after_master_fade = false;
                    }
                }
                ReaderCommand::StartMasterFade {
                    target_gain,
                    duration_seconds,
                } => self.mixer.start_master_fade(target_gain, duration_seconds),
                ReaderCommand::Shutdown => should_shutdown = true,
            }
        }

        should_shutdown
    }

    pub(crate) fn finish_stop_after_fade_if_needed(&mut self) {
        if self.stop_after_master_fade
            && !self.mixer.is_master_fade_active()
            && self.mixer.master_gain() <= GAIN_EPSILON
        {
            self.is_running = false;
            self.stop_after_master_fade = false;
        }
    }
}

pub(crate) fn push_block_into_ring(
    producer: &mut Producer<OutputSample>,
    block: &[f32],
    generation: u64,
) -> bool {
    for &sample in block {
        if producer
            .push(OutputSample {
                generation,
                value: sample,
            })
            .is_err()
        {
            return false;
        }
    }

    true
}
