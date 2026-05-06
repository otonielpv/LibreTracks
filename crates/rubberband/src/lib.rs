use std::{ffi::c_void, path::PathBuf, ptr::NonNull, sync::Arc};

pub type RubberBandOptions = i32;

pub const OPTION_PROCESS_REAL_TIME: RubberBandOptions = 0x0000_0001;
pub const OPTION_PITCH_HIGH_QUALITY: RubberBandOptions = 0x0200_0000;
pub const OPTION_CHANNELS_IDENTICAL: RubberBandOptions = 0x1000_0000;

type RubberBandState = *mut c_void;

#[derive(Debug)]
pub enum RubberBandError {
    LibraryUnavailable(String),
    ProcessorUnavailable,
    ChannelMismatch { expected: usize, actual: usize },
}

pub struct RubberBandProcessor {
    state: NonNull<c_void>,
    api: Arc<Api>,
    channels: usize,
}

unsafe impl Send for RubberBandProcessor {}

impl RubberBandProcessor {
    pub fn new(
        sample_rate: u32,
        channels: usize,
        options: RubberBandOptions,
        initial_time_ratio: f64,
        initial_pitch_scale: f64,
    ) -> Result<Self, RubberBandError> {
        let api = Api::load()?;
        let state = unsafe {
            (api.rubberband_new)(
                sample_rate.max(1),
                channels.max(1) as u32,
                options,
                initial_time_ratio,
                initial_pitch_scale,
            )
        };
        let state = NonNull::new(state).ok_or(RubberBandError::ProcessorUnavailable)?;
        Ok(Self {
            state,
            api,
            channels: channels.max(1),
        })
    }

    pub fn reset(&mut self) {
        unsafe { (self.api.rubberband_reset)(self.state.as_ptr()) };
    }

    pub fn latency(&self) -> usize {
        unsafe { (self.api.rubberband_get_latency)(self.state.as_ptr()) as usize }
    }

    pub fn available(&self) -> isize {
        unsafe { (self.api.rubberband_available)(self.state.as_ptr()) as isize }
    }

    pub fn process(
        &mut self,
        input: &[Vec<f32>],
        final_block: bool,
    ) -> Result<(), RubberBandError> {
        if input.len() != self.channels {
            return Err(RubberBandError::ChannelMismatch {
                expected: self.channels,
                actual: input.len(),
            });
        }
        let frames = input
            .first()
            .map(|channel| channel.len())
            .unwrap_or_default();
        let input_ptrs: Vec<*const f32> = input.iter().map(|channel| channel.as_ptr()).collect();
        unsafe {
            (self.api.rubberband_process)(
                self.state.as_ptr(),
                input_ptrs.as_ptr(),
                frames as u32,
                i32::from(final_block),
            );
        }
        Ok(())
    }

    pub fn retrieve(
        &mut self,
        output: &mut [Vec<f32>],
        frames: usize,
    ) -> Result<usize, RubberBandError> {
        if output.len() != self.channels {
            return Err(RubberBandError::ChannelMismatch {
                expected: self.channels,
                actual: output.len(),
            });
        }
        for channel in output.iter_mut() {
            channel.resize(frames, 0.0);
        }
        let output_ptrs: Vec<*mut f32> = output
            .iter_mut()
            .map(|channel| channel.as_mut_ptr())
            .collect();
        let retrieved = unsafe {
            (self.api.rubberband_retrieve)(self.state.as_ptr(), output_ptrs.as_ptr(), frames as u32)
        };
        Ok(retrieved as usize)
    }
}

impl Drop for RubberBandProcessor {
    fn drop(&mut self) {
        unsafe { (self.api.rubberband_delete)(self.state.as_ptr()) };
    }
}

type RubberBandNew = unsafe extern "C" fn(u32, u32, RubberBandOptions, f64, f64) -> RubberBandState;
type RubberBandDelete = unsafe extern "C" fn(RubberBandState);
type RubberBandReset = unsafe extern "C" fn(RubberBandState);
type RubberBandGetLatency = unsafe extern "C" fn(RubberBandState) -> u32;
type RubberBandProcess = unsafe extern "C" fn(RubberBandState, *const *const f32, u32, i32);
type RubberBandAvailable = unsafe extern "C" fn(RubberBandState) -> i32;
type RubberBandRetrieve = unsafe extern "C" fn(RubberBandState, *const *mut f32, u32) -> u32;

struct Api {
    _library: libloading::Library,
    rubberband_new: RubberBandNew,
    rubberband_delete: RubberBandDelete,
    rubberband_reset: RubberBandReset,
    rubberband_get_latency: RubberBandGetLatency,
    rubberband_process: RubberBandProcess,
    rubberband_available: RubberBandAvailable,
    rubberband_retrieve: RubberBandRetrieve,
}

impl Api {
    fn load() -> Result<Arc<Self>, RubberBandError> {
        let mut errors = Vec::new();
        for candidate in library_candidates() {
            match unsafe { libloading::Library::new(&candidate) } {
                Ok(library) => {
                    let api = unsafe { Self::from_library(library) }?;
                    return Ok(Arc::new(api));
                }
                Err(error) => errors.push(format!("{}: {error}", candidate.display())),
            }
        }
        Err(RubberBandError::LibraryUnavailable(errors.join("; ")))
    }

    unsafe fn from_library(library: libloading::Library) -> Result<Self, RubberBandError> {
        let rubberband_new = *library
            .get::<RubberBandNew>(b"rubberband_new\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_delete = *library
            .get::<RubberBandDelete>(b"rubberband_delete\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_reset = *library
            .get::<RubberBandReset>(b"rubberband_reset\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_get_latency = *library
            .get::<RubberBandGetLatency>(b"rubberband_get_latency\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_process = *library
            .get::<RubberBandProcess>(b"rubberband_process\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_available = *library
            .get::<RubberBandAvailable>(b"rubberband_available\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;
        let rubberband_retrieve = *library
            .get::<RubberBandRetrieve>(b"rubberband_retrieve\0")
            .map_err(|error| RubberBandError::LibraryUnavailable(error.to_string()))?;

        Ok(Self {
            _library: library,
            rubberband_new,
            rubberband_delete,
            rubberband_reset,
            rubberband_get_latency,
            rubberband_process,
            rubberband_available,
            rubberband_retrieve,
        })
    }
}

fn library_candidates() -> Vec<PathBuf> {
    if let Ok(path) = std::env::var("RUBBERBAND_LIBRARY") {
        return vec![PathBuf::from(path)];
    }

    #[cfg(target_os = "windows")]
    {
        vec![
            PathBuf::from("rubberband.dll"),
            PathBuf::from("librubberband.dll"),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("librubberband.dylib")]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("librubberband.so.2"),
            PathBuf::from("librubberband.so"),
        ]
    }
}
