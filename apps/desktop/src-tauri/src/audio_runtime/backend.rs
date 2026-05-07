use super::*;
use cpal::{
    traits::{DeviceTrait, HostTrait},
    BufferSize, Device, Host, HostId, SampleFormat, SampleRate, Stream, StreamConfig,
    SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
};
use rtrb::{Consumer, Producer};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioBackendKind {
    Asio,
    Wasapi,
    CoreAudio,
    Alsa,
    Jack,
    DirectSound,
    Mme,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSampleFormat {
    F32,
    I16,
    U16,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioBufferSizeRequest {
    Default,
    Fixed(u32),
}

impl Default for AudioBufferSizeRequest {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChannelRequest {
    pub channels: Vec<usize>,
}

impl Default for OutputChannelRequest {
    fn default() -> Self {
        Self {
            channels: vec![0, 1],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceDescriptor {
    pub backend: AudioBackendKind,
    pub backend_id: String,
    pub stable_id: String,
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
    pub max_output_channels: usize,
    pub default_sample_rate: Option<u32>,
    pub supported_sample_rates: Vec<u32>,
    pub supported_buffer_sizes: Vec<u32>,
    pub supported_sample_formats: Vec<AudioSampleFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioOutputRequest {
    pub backend: Option<AudioBackendKind>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: AudioBufferSizeRequest,
    pub output_channels: OutputChannelRequest,
    pub sample_format: Option<AudioSampleFormat>,
    pub low_latency_mode: bool,
    pub safe_mode: bool,
}

impl AudioOutputRequest {
    pub fn has_explicit_device_selection(&self) -> bool {
        self.backend.is_some() && (self.device_id.is_some() || self.device_name.is_some())
    }

    pub fn requested_device_label(&self) -> String {
        self.device_id
            .as_deref()
            .or(self.device_name.as_deref())
            .unwrap_or("System default")
            .to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioDeviceResolveError {
    BackendNotAvailable {
        backend: AudioBackendKind,
        device: String,
    },
    DeviceNotFound {
        backend: AudioBackendKind,
        device: String,
    },
    NoDefaultOutputDevice,
}

impl AudioDeviceResolveError {
    pub fn failure_stage(&self) -> &'static str {
        match self {
            Self::BackendNotAvailable { .. } => "backend_not_available",
            Self::DeviceNotFound { .. } => "device_not_found",
            Self::NoDefaultOutputDevice => "device_not_found",
        }
    }
}

impl std::fmt::Display for AudioDeviceResolveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BackendNotAvailable { backend, device } => write!(
                formatter,
                "Selected output device is unavailable: backend={backend:?}, device={device}"
            ),
            Self::DeviceNotFound { backend, device } => write!(
                formatter,
                "Selected output device is unavailable: backend={backend:?}, device={device}"
            ),
            Self::NoDefaultOutputDevice => {
                write!(formatter, "No default output device is available")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AudioActualConfig {
    pub backend: AudioBackendKind,
    pub backend_id: String,
    pub device: AudioDeviceDescriptor,
    pub sample_rate: u32,
    pub channels: usize,
    pub sample_format: AudioSampleFormat,
    pub actual_buffer_size: usize,
    pub estimated_latency_frames: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct BackendPolicy {
    pub ring_min_frames: usize,
    pub ring_buffer_multiplier: usize,
    pub prefill_buffer_multiplier: usize,
}

impl BackendPolicy {
    pub fn for_backend(kind: AudioBackendKind, safe_mode: bool) -> Self {
        let mut policy = match kind {
            AudioBackendKind::Asio => Self {
                ring_min_frames: 16_384,
                ring_buffer_multiplier: 16,
                prefill_buffer_multiplier: 4,
            },
            AudioBackendKind::Wasapi => Self {
                ring_min_frames: 8_192,
                ring_buffer_multiplier: 10,
                prefill_buffer_multiplier: 3,
            },
            AudioBackendKind::CoreAudio | AudioBackendKind::Jack => Self {
                ring_min_frames: 8_192,
                ring_buffer_multiplier: 8,
                prefill_buffer_multiplier: 3,
            },
            AudioBackendKind::Alsa => Self {
                ring_min_frames: 8_192,
                ring_buffer_multiplier: 12,
                prefill_buffer_multiplier: 4,
            },
            _ => Self {
                ring_min_frames: 8_192,
                ring_buffer_multiplier: 8,
                prefill_buffer_multiplier: 2,
            },
        };
        if safe_mode {
            policy.ring_min_frames = policy.ring_min_frames.saturating_mul(2);
            policy.ring_buffer_multiplier = policy.ring_buffer_multiplier.saturating_mul(2);
            policy.prefill_buffer_multiplier = policy.prefill_buffer_multiplier.saturating_add(2);
        }
        policy
    }

    pub fn ring_capacity_frames(self, actual_buffer_size: usize) -> usize {
        self.ring_min_frames
            .max(actual_buffer_size.saturating_mul(self.ring_buffer_multiplier))
    }

    pub fn prefill_frames(self, actual_buffer_size: usize, ring_capacity_frames: usize) -> usize {
        ring_capacity_frames
            .saturating_sub(1)
            .min(actual_buffer_size.saturating_mul(self.prefill_buffer_multiplier))
    }
}

#[derive(Default)]
pub struct AudioRuntimeCounters {
    pub callback_count: AtomicU64,
    pub callback_min_frames: AtomicUsize,
    pub callback_max_frames: AtomicUsize,
    pub valid_rendered_frames: AtomicU64,
    pub underrun_frames: AtomicU64,
    pub xrun_count: AtomicU64,
    pub needs_resync: AtomicBool,
    pub stale_drop_count: AtomicU64,
    pub resync_count: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PrefillResult {
    pub requested_frames: usize,
    pub requested_samples: usize,
    pub available_frames: usize,
    pub available_samples: usize,
    pub elapsed_ms: f64,
    pub completed: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedOutputStreamConfig {
    pub supported_config: SupportedStreamConfig,
    pub requested_sample_rate: Option<u32>,
    pub resolved_sample_rate: u32,
    pub used_fallback: bool,
    pub fallback_reason: Option<String>,
}

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
    counters: Arc<AudioRuntimeCounters>,
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
                counters.clone(),
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
                counters.clone(),
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
                counters.clone(),
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
    let callback_frames = data.len() / state.channels.max(1);
    state.record_callback(callback_frames);
    let mut callback_had_underrun = false;
    let mut underrun_samples = 0_u64;
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
                    break Some(state.overflow.pop_front().unwrap().value);
                } else if front.generation > state.active_generation {
                    break None; // Wait for the main thread to catch up to this future generation
                } else {
                    state.overflow.pop_front(); // Drop stale
                    state
                        .counters
                        .stale_drop_count
                        .fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            match consumer.pop() {
                Ok(popped) => {
                    if popped.generation == state.active_generation {
                        break Some(popped.value);
                    } else if popped.generation > state.active_generation {
                        state.overflow.push_back(popped);
                        break None;
                    } else {
                        state
                            .counters
                            .stale_drop_count
                            .fetch_add(1, Ordering::Relaxed);
                        continue; // Drop stale
                    }
                }
                Err(_) => break None, // Buffer empty
            }
        };

        let mut final_sample = sample.unwrap_or(0.0);
        if sample.is_some() {
            state
                .counters
                .valid_rendered_frames
                .fetch_add(1, Ordering::Relaxed);
        } else {
            callback_had_underrun = true;
            underrun_samples = underrun_samples.saturating_add(1);
            state.counters.needs_resync.store(true, Ordering::Release);
        }

        if state.fade_index < state.fading_buffer.len() {
            let old_sample = state.fading_buffer[state.fade_index];
            let fade_progress = state.fade_index as f32 / state.fading_buffer.len().max(1) as f32;
            let fade_out = (fade_progress * std::f32::consts::FRAC_PI_2).cos();
            final_sample += old_sample * fade_out;
            state.fade_index += 1;
        }

        *output = convert(final_sample);
    }
    if callback_had_underrun {
        state.counters.xrun_count.fetch_add(1, Ordering::Relaxed);
        let underrun_frames = underrun_samples / state.channels.max(1) as u64;
        state
            .counters
            .underrun_frames
            .fetch_add(underrun_frames.max(1), Ordering::Relaxed);
    }
}

pub(crate) struct CpalCrossfadeState {
    pub active_generation: u64,
    pub fading_buffer: Vec<f32>,
    pub fade_index: usize,
    pub overflow: std::collections::VecDeque<OutputSample>,
    pub max_fade_samples: usize,
    pub channels: usize,
    pub counters: Arc<AudioRuntimeCounters>,
}

impl CpalCrossfadeState {
    pub fn new(
        active_generation: u64,
        sample_rate: u32,
        channels: usize,
        counters: Arc<AudioRuntimeCounters>,
    ) -> Self {
        Self {
            active_generation,
            fading_buffer: Vec::with_capacity(8192),
            fade_index: 0,
            overflow: std::collections::VecDeque::with_capacity(8192),
            max_fade_samples: (0.020 * sample_rate as f32).round() as usize * channels,
            channels,
            counters,
        }
    }

    fn record_callback(&self, frames: usize) {
        self.counters.callback_count.fetch_add(1, Ordering::Relaxed);
        update_atomic_min_nonzero(&self.counters.callback_min_frames, frames);
        update_atomic_max(&self.counters.callback_max_frames, frames);
    }
}

fn update_atomic_min_nonzero(target: &AtomicUsize, value: usize) {
    let mut current = target.load(Ordering::Relaxed);
    while current == 0 || value < current {
        match target.compare_exchange(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(next) => current = next,
        }
    }
}

fn update_atomic_max(target: &AtomicUsize, value: usize) {
    let mut current = target.load(Ordering::Relaxed);
    while value > current {
        match target.compare_exchange(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(next) => current = next,
        }
    }
}

pub fn backend_kind_from_host_id(host_id: HostId) -> AudioBackendKind {
    match host_id.name() {
        "ASIO" => AudioBackendKind::Asio,
        "WASAPI" => AudioBackendKind::Wasapi,
        "CoreAudio" => AudioBackendKind::CoreAudio,
        "ALSA" => AudioBackendKind::Alsa,
        "JACK" => AudioBackendKind::Jack,
        _ => AudioBackendKind::Unknown,
    }
}

pub fn host_id_for_backend(kind: AudioBackendKind) -> Option<HostId> {
    cpal::available_hosts()
        .into_iter()
        .find(|host_id| backend_kind_from_host_id(*host_id) == kind)
}

fn platform_system_default_backend_priority() -> &'static [AudioBackendKind] {
    #[cfg(target_os = "windows")]
    {
        &[AudioBackendKind::Wasapi]
    }
    #[cfg(target_os = "macos")]
    {
        &[AudioBackendKind::CoreAudio]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        &[AudioBackendKind::Alsa, AudioBackendKind::Jack]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        &[AudioBackendKind::Unknown]
    }
}

fn system_default_host_ids() -> Vec<HostId> {
    let available_hosts = cpal::available_hosts();
    platform_system_default_backend_priority()
        .iter()
        .filter_map(|backend| {
            available_hosts
                .iter()
                .copied()
                .find(|host_id| backend_kind_from_host_id(*host_id) == *backend)
        })
        .collect()
}

pub fn is_system_default_backend_candidate(backend: AudioBackendKind) -> bool {
    platform_system_default_backend_priority().contains(&backend)
}

#[cfg(test)]
pub fn system_default_backend_from_available_for_test(
    available_backends: &[AudioBackendKind],
) -> Option<AudioBackendKind> {
    platform_system_default_backend_priority()
        .iter()
        .copied()
        .find(|backend| available_backends.contains(backend))
}

pub fn enumerate_output_devices() -> Vec<AudioDeviceDescriptor> {
    let mut descriptors = Vec::new();
    let debug_logging_enabled = super::telemetry::env_flag("LIBRETRACKS_AUDIO_DEBUG");
    for host_id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(host_id) else {
            continue;
        };
        let backend = backend_kind_from_host_id(host_id);
        let default_name = host
            .default_output_device()
            .and_then(|device| device.name().ok());
        let Ok(devices) = host.output_devices() else {
            continue;
        };
        for device in devices {
            if let Some(descriptor) =
                describe_output_device(host_id, backend, default_name.as_deref(), device)
            {
                if debug_logging_enabled && backend == AudioBackendKind::Asio {
                    eprintln!("[asio_candidate_seen] device=\"{}\"", descriptor.name);
                }
                if debug_logging_enabled
                    && backend == AudioBackendKind::Asio
                    && descriptor.is_default
                {
                    eprintln!(
                        "[default_device_candidate_rejected] candidate_backend=\"ASIO\" candidate_device=\"{}\" reason=\"ASIO is opt-in only\"",
                        descriptor.name
                    );
                }
                descriptors.push(descriptor);
            }
        }
    }
    descriptors.sort_by(|left, right| {
        left.backend_id
            .cmp(&right.backend_id)
            .then(left.display_name.cmp(&right.display_name))
    });
    descriptors.dedup_by(|left, right| left.stable_id == right.stable_id);
    descriptors
}

pub fn describe_output_device(
    host_id: HostId,
    backend: AudioBackendKind,
    default_name: Option<&str>,
    device: Device,
) -> Option<AudioDeviceDescriptor> {
    let name = device.name().ok()?;
    let backend_id = host_id.name().to_string();
    let stable_id = format!("{}::{}", backend_id, name);
    let default_config = device.default_output_config().ok();
    let supported_ranges = device
        .supported_output_configs()
        .map(|configs| configs.collect::<Vec<_>>())
        .unwrap_or_default();
    let max_output_channels = supported_ranges
        .iter()
        .map(|range| usize::from(range.channels()))
        .chain(
            default_config
                .as_ref()
                .map(|config| usize::from(config.channels())),
        )
        .max()
        .unwrap_or(2);
    let default_sample_rate = default_config.as_ref().map(|config| config.sample_rate().0);
    let supported_sample_rates = collect_sample_rates(&supported_ranges, default_sample_rate);
    let supported_buffer_sizes = collect_buffer_sizes(&supported_ranges);
    let supported_sample_formats =
        collect_sample_formats(&supported_ranges, default_config.as_ref());

    Some(AudioDeviceDescriptor {
        backend,
        backend_id,
        stable_id,
        name: name.clone(),
        display_name: format!("{}: {}", host_id.name(), name),
        is_default: default_name.is_some_and(|default_name| default_name == name),
        max_output_channels,
        default_sample_rate,
        supported_sample_rates,
        supported_buffer_sizes,
        supported_sample_formats,
    })
}

pub fn resolve_output_device(
    request: &AudioOutputRequest,
) -> Result<(HostId, Host, Device), AudioDeviceResolveError> {
    #[cfg(test)]
    {
        let _ = request;
        return Err(AudioDeviceResolveError::NoDefaultOutputDevice);
    }

    #[cfg(not(test))]
    {
        if std::env::var("LIBRETRACKS_DUMMY_AUDIO")
            .ok()
            .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        {
            return Err(AudioDeviceResolveError::NoDefaultOutputDevice);
        }

        if super::telemetry::env_flag("LIBRETRACKS_AUDIO_DEBUG") {
            eprintln!(
                "[audio_backend_resolution] selected_backend_setting={:?} effective_backend={:?} reason=\"{}\"",
                request.backend,
                request.backend.unwrap_or_else(|| {
                    platform_system_default_backend_priority()
                        .first()
                        .copied()
                        .unwrap_or(AudioBackendKind::Unknown)
                }),
                if request.backend.is_some() {
                    "explicit backend selected"
                } else {
                    "system default uses platform-native backend; ASIO is opt-in only"
                }
            );
        }

        if request.has_explicit_device_selection() {
            let backend = request
                .backend
                .expect("explicit device selection has backend");
            let Some(host_id) = host_id_for_backend(backend) else {
                return Err(AudioDeviceResolveError::BackendNotAvailable {
                    backend,
                    device: request.requested_device_label(),
                });
            };
            let Ok(host) = cpal::host_from_id(host_id) else {
                return Err(AudioDeviceResolveError::BackendNotAvailable {
                    backend,
                    device: request.requested_device_label(),
                });
            };
            let Some(device) = resolve_device_on_host(&host, host_id, request, false) else {
                return Err(AudioDeviceResolveError::DeviceNotFound {
                    backend,
                    device: request.requested_device_label(),
                });
            };
            log_effective_device_resolution(request, host_id, &device, "explicit device selection");
            return Ok((host_id, host, device));
        }

        for host_id in requested_host_ids(request) {
            let Ok(host) = cpal::host_from_id(host_id) else {
                continue;
            };
            if let Some(device) = resolve_device_on_host(&host, host_id, request, true) {
                log_effective_device_resolution(
                    request,
                    host_id,
                    &device,
                    if request.backend.is_some() {
                        "backend default device"
                    } else {
                        "real OS default output device"
                    },
                );
                return Ok((host_id, host, device));
            }
        }

        let host = cpal::default_host();
        let host_id = cpal::default_host().id();
        if request.backend.is_none() && backend_kind_from_host_id(host_id) == AudioBackendKind::Asio
        {
            if let Some(device_name) = host
                .default_output_device()
                .and_then(|device| device.name().ok())
            {
                if super::telemetry::env_flag("LIBRETRACKS_AUDIO_DEBUG") {
                    eprintln!(
                        "[default_device_candidate_rejected] candidate_backend=\"ASIO\" candidate_device=\"{}\" reason=\"ASIO is opt-in only\"",
                        device_name
                    );
                }
            }
            return Err(AudioDeviceResolveError::NoDefaultOutputDevice);
        }
        host.default_output_device()
            .map(|device| {
                log_effective_device_resolution(
                    request,
                    host_id,
                    &device,
                    "cpal default host fallback",
                );
                (host_id, host, device)
            })
            .ok_or(AudioDeviceResolveError::NoDefaultOutputDevice)
    }
}

pub fn resolve_output_stream_config(
    device: &Device,
    request: &AudioOutputRequest,
) -> Result<ResolvedOutputStreamConfig, cpal::DefaultStreamConfigError> {
    let default_config = device.default_output_config()?;
    let desired_channels = request
        .output_channels
        .channels
        .iter()
        .max()
        .copied()
        .map(|channel| channel.saturating_add(1))
        .unwrap_or(2)
        .max(1)
        .clamp(1, u16::MAX as usize) as u16;
    let Some(config_range) =
        best_supported_config(device, request, desired_channels, &default_config)
    else {
        let resolved_sample_rate = default_config.sample_rate().0;
        return Ok(ResolvedOutputStreamConfig {
            supported_config: default_config,
            requested_sample_rate: request.sample_rate,
            resolved_sample_rate,
            used_fallback: request
                .sample_rate
                .is_some_and(|requested| requested != resolved_sample_rate),
            fallback_reason: request.sample_rate.and(Some(
                "no supported output stream range matched the request; using device default"
                    .to_string(),
            )),
        });
    };
    let requested_supported = request.sample_rate.map(SampleRate).filter(|sample_rate| {
        sample_rate.0 >= config_range.min_sample_rate().0
            && sample_rate.0 <= config_range.max_sample_rate().0
    });
    let fallback_reason = if request.sample_rate.is_some() && requested_supported.is_none() {
        Some("requested sample rate not supported".to_string())
    } else {
        None
    };
    let sample_rate = requested_supported.unwrap_or_else(|| {
        default_config
            .sample_rate()
            .min(config_range.max_sample_rate())
    });
    let supported_config = config_range.with_sample_rate(sample_rate);
    Ok(ResolvedOutputStreamConfig {
        supported_config,
        requested_sample_rate: request.sample_rate,
        resolved_sample_rate: sample_rate.0,
        used_fallback: fallback_reason.is_some(),
        fallback_reason,
    })
}

#[cfg(test)]
pub fn resolve_output_stream_config_for_test(
    requested_sample_rate: Option<u32>,
    default_sample_rate: u32,
    min_sample_rate: u32,
    max_sample_rate: u32,
) -> (Option<u32>, u32, bool, Option<String>) {
    let requested_supported = requested_sample_rate
        .filter(|requested| *requested >= min_sample_rate && *requested <= max_sample_rate);
    let fallback_reason = if requested_sample_rate.is_some() && requested_supported.is_none() {
        Some("requested sample rate not supported".to_string())
    } else {
        None
    };
    let resolved_sample_rate =
        requested_supported.unwrap_or_else(|| default_sample_rate.min(max_sample_rate));
    (
        requested_sample_rate,
        resolved_sample_rate,
        fallback_reason.is_some(),
        fallback_reason,
    )
}

pub fn resolve_output_supported_stream_config(
    device: &Device,
    request: &AudioOutputRequest,
) -> Result<SupportedStreamConfig, cpal::DefaultStreamConfigError> {
    resolve_output_stream_config(device, request).map(|diagnostic| diagnostic.supported_config)
}

pub fn stream_config_with_buffer_request(
    supported_config: &SupportedStreamConfig,
    request: &AudioOutputRequest,
) -> StreamConfig {
    let mut config: StreamConfig = supported_config.clone().into();
    config.buffer_size = match request.buffer_size {
        AudioBufferSizeRequest::Fixed(frames) if frames > 0 => BufferSize::Fixed(frames),
        AudioBufferSizeRequest::Default => match supported_config.buffer_size() {
            SupportedBufferSize::Range { min, max } if request.low_latency_mode => {
                BufferSize::Fixed((*min).max(1).min(*max))
            }
            _ => BufferSize::Default,
        },
        _ => BufferSize::Default,
    };
    config
}

pub fn actual_buffer_size_frames(
    config: &StreamConfig,
    supported_config: &SupportedStreamConfig,
) -> usize {
    match config.buffer_size {
        BufferSize::Fixed(frames) => frames as usize,
        BufferSize::Default => match supported_config.buffer_size() {
            SupportedBufferSize::Range { min, max } => (*min as usize).max(1).min(*max as usize),
            SupportedBufferSize::Unknown => 512,
        },
    }
}

pub fn sample_format_from_cpal(sample_format: SampleFormat) -> AudioSampleFormat {
    match sample_format {
        SampleFormat::F32 => AudioSampleFormat::F32,
        SampleFormat::I16 => AudioSampleFormat::I16,
        SampleFormat::U16 => AudioSampleFormat::U16,
        _ => AudioSampleFormat::Unknown,
    }
}

fn requested_host_ids(request: &AudioOutputRequest) -> Vec<HostId> {
    if let Some(backend) = request.backend.and_then(host_id_for_backend) {
        return vec![backend];
    }
    system_default_host_ids()
}

fn resolve_device_on_host(
    host: &Host,
    host_id: HostId,
    request: &AudioOutputRequest,
    allow_default: bool,
) -> Option<Device> {
    if request.device_id.is_none() && request.device_name.is_none() {
        return allow_default
            .then(|| host.default_output_device())
            .flatten();
    }
    let devices = host.output_devices().ok()?;
    for device in devices {
        let Ok(name) = device.name() else {
            continue;
        };
        let stable_id = format!("{}::{}", host_id.name(), name);
        if request
            .device_id
            .as_deref()
            .is_some_and(|id| id == stable_id)
            || request
                .device_name
                .as_deref()
                .is_some_and(|selected| selected == name)
        {
            return Some(device);
        }
    }
    allow_default
        .then(|| host.default_output_device())
        .flatten()
}

#[cfg(not(test))]
fn log_effective_device_resolution(
    request: &AudioOutputRequest,
    host_id: HostId,
    device: &Device,
    reason: &str,
) {
    if !super::telemetry::env_flag("LIBRETRACKS_AUDIO_DEBUG") {
        return;
    }
    let effective_device_name = device.name().unwrap_or_else(|_| "unknown".to_string());
    let effective_device_id = format!("{}::{}", host_id.name(), effective_device_name);
    eprintln!(
        "[audio_device_resolution] selected_device_id={:?} effective_device_name=\"{}\" effective_device_id=\"{}\" reason=\"{}\"",
        request.device_id,
        effective_device_name,
        effective_device_id,
        reason
    );
}

fn best_supported_config(
    device: &Device,
    request: &AudioOutputRequest,
    desired_channels: u16,
    default_config: &SupportedStreamConfig,
) -> Option<SupportedStreamConfigRange> {
    let configs = device.supported_output_configs().ok()?;
    let requested_format = request.sample_format;
    configs
        .filter(|config| config.channels() >= desired_channels)
        .filter(|config| {
            requested_format
                .is_none_or(|format| sample_format_from_cpal(config.sample_format()) == format)
        })
        .max_by_key(|config| {
            let format_match =
                usize::from(config.sample_format() == default_config.sample_format());
            let default_rate_in_range = usize::from(
                default_config.sample_rate().0 >= config.min_sample_rate().0
                    && default_config.sample_rate().0 <= config.max_sample_rate().0,
            );
            (format_match, default_rate_in_range, config.channels())
        })
}

fn collect_sample_rates(
    ranges: &[SupportedStreamConfigRange],
    default_sample_rate: Option<u32>,
) -> Vec<u32> {
    let common_rates = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];
    let mut rates = common_rates
        .into_iter()
        .filter(|rate| {
            ranges.iter().any(|range| {
                *rate >= range.min_sample_rate().0 && *rate <= range.max_sample_rate().0
            })
        })
        .collect::<Vec<_>>();
    if let Some(default_sample_rate) = default_sample_rate {
        rates.push(default_sample_rate);
    }
    rates.sort_unstable();
    rates.dedup();
    rates
}

fn collect_buffer_sizes(ranges: &[SupportedStreamConfigRange]) -> Vec<u32> {
    let common_sizes = [32, 64, 128, 256, 512, 1024, 2048, 4096];
    let mut sizes = common_sizes
        .into_iter()
        .filter(|size| {
            ranges.iter().any(|range| match range.buffer_size() {
                SupportedBufferSize::Range { min, max } => *size >= *min && *size <= *max,
                SupportedBufferSize::Unknown => false,
            })
        })
        .collect::<Vec<_>>();
    sizes.sort_unstable();
    sizes.dedup();
    sizes
}

fn collect_sample_formats(
    ranges: &[SupportedStreamConfigRange],
    default_config: Option<&SupportedStreamConfig>,
) -> Vec<AudioSampleFormat> {
    let mut formats = ranges
        .iter()
        .map(|range| sample_format_from_cpal(range.sample_format()))
        .chain(default_config.map(|config| sample_format_from_cpal(config.sample_format())))
        .filter(|format| *format != AudioSampleFormat::Unknown)
        .collect::<Vec<_>>();
    formats.sort_by_key(|format| format!("{format:?}"));
    formats.dedup();
    formats
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
