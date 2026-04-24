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
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
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
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
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
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
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
    active_generation: &mut u64,
    convert: impl Fn(f32) -> T,
) where
    T: Copy,
{
    let latest_generation = seek_generation.load(Ordering::Acquire);
    if latest_generation != *active_generation {
        while consumer.pop().is_ok() {}
        *active_generation = latest_generation;
    }

    for output in data {
        let sample = match consumer.pop() {
            Ok(sample) if sample.generation == *active_generation => sample.value,
            Ok(_) | Err(_) => 0.0,
        };
        *output = convert(sample);
    }
}

pub(crate) fn run_disk_reader(mut state: DiskReaderState) -> DiskReaderReport {
    loop {
        if state.consume_commands() {
            break;
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
    }

    DiskReaderReport
}

impl DiskReaderState {
    fn consume_commands(&mut self) -> bool {
        let mut should_stop = false;

        while let Ok(command) = self.command_receiver.try_recv() {
            match command {
                ReaderCommand::UpdateSong(song) => self.mixer.apply_song_update(song),
                ReaderCommand::Seek {
                    song,
                    position_seconds,
                    generation,
                } => {
                    self.mixer.seek(song, position_seconds);
                    self.current_generation = generation;
                }
                ReaderCommand::Stop => should_stop = true,
            }
        }

        should_stop
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
