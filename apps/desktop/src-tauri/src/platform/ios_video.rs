//! The video output on iOS (plan `video-mobile`, pasos 03 and 04): C calls
//! into `VideoOutputBridge.swift` (in the `ios-folder-picker` plugin's Swift
//! package, which the iOS build already links), which owns the window on the
//! external screen and the two AVPlayers.
//!
//! Not Tauri's plugin channel (`run_mobile_plugin`): that goes through JSON
//! and the webview's async machinery, far too slow for a ~100 Hz command
//! stream (00-DISENO §4.1). The Swift functions are exported with `@_cdecl`
//! and declared below; the events come back through the `lt_video_ios_*`
//! functions at the bottom, which Swift declares with `@_silgen_name`, the
//! same way it already reaches `libretracks_log_ios_webcontent_terminated`.
//!
//! Every Swift entry point copies its arguments and `DispatchQueue.main.async`s
//! the work, so none of these calls waits.

#![cfg(target_os = "ios")]

use std::ffi::{c_char, c_void, CStr, CString};

use libretracks_core::VideoFit;
use libretracks_video::native::NativeVideoBridge;
use libretracks_video::output::{BackendError, BackendEvent, PlayerCommand, Slot};

use crate::video::native_events;

extern "C" {
    fn lt_video_swift_start();
    fn lt_video_swift_open(display: *const c_char, fit: i32) -> bool;
    fn lt_video_swift_close();
    fn lt_video_swift_load(slot: i32, path: *const c_char, start_seconds: f64, paused: bool);
    fn lt_video_swift_seek(slot: i32, seconds: f64);
    fn lt_video_swift_set_pause(slot: i32, paused: bool);
    fn lt_video_swift_set_speed(slot: i32, speed: f64);
    fn lt_video_swift_stop(slot: i32);
    fn lt_video_swift_show_slot(slot: i32);
    fn lt_video_swift_set_brightness(value: f64);
    fn lt_video_swift_set_fit(fit: i32);
    fn lt_video_swift_show_image(slot: i32, path: *const c_char);
    fn lt_video_swift_set_keep_awake(on: bool);
    // Paso 07: analysis and thumbnails, blocking, answered through the
    // callback during the call (`VideoProbe.swift`).
    fn lt_video_swift_probe(
        path: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_char),
    );
    fn lt_video_swift_frames(
        path: *const c_char,
        times: *const f64,
        count: i32,
        width: i32,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32, *const u8, usize),
    );
}

extern "C" fn collect_probe(context: *mut c_void, json: *const c_char) {
    let out = unsafe { &mut *(context as *mut Option<String>) };
    if !json.is_null() {
        *out = Some(
            unsafe { CStr::from_ptr(json) }
                .to_string_lossy()
                .into_owned(),
        );
    }
}

extern "C" fn collect_frame(context: *mut c_void, index: i32, data: *const u8, len: usize) {
    let out = unsafe { &mut *(context as *mut Vec<Option<Vec<u8>>>) };
    let Some(slot) = usize::try_from(index)
        .ok()
        .and_then(|index| out.get_mut(index))
    else {
        return;
    };
    if !data.is_null() && len > 0 {
        *slot = Some(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
    }
}

/// `VideoProbe.swift`: the analysis as JSON
/// (`libretracks_video::media::parse_native_probe`). Blocking.
pub fn probe_json(path: &str) -> Result<String, String> {
    let path = c_string(path).ok_or_else(|| "ruta de vídeo no válida".to_string())?;
    let mut out: Option<String> = None;
    unsafe {
        lt_video_swift_probe(
            path.as_ptr(),
            &mut out as *mut Option<String> as *mut c_void,
            collect_probe,
        )
    };
    out.ok_or_else(|| "el análisis nativo no respondió".to_string())
}

/// One JPEG per time, `None` where the decoder produced nothing. Blocking.
pub fn frames(path: &str, times: &[f64], max_width: u32) -> Vec<Option<Vec<u8>>> {
    let mut out: Vec<Option<Vec<u8>>> = vec![None; times.len()];
    let Some(path) = c_string(path) else {
        return out;
    };
    unsafe {
        lt_video_swift_frames(
            path.as_ptr(),
            times.as_ptr(),
            times.len() as i32,
            max_width as i32,
            &mut out as *mut Vec<Option<Vec<u8>>> as *mut c_void,
            collect_frame,
        )
    };
    out
}

fn slot_arg(slot: Slot) -> i32 {
    match slot {
        Slot::A => 0,
        Slot::B => 1,
    }
}

fn fit_arg(fit: VideoFit) -> i32 {
    match fit {
        VideoFit::Contain => 0,
        VideoFit::Cover => 1,
        VideoFit::Stretch => 2,
    }
}

/// A C string for Swift, or `None` for text with an inner NUL (a path can
/// not contain one; refusing beats truncating it).
fn c_string(text: &str) -> Option<CString> {
    CString::new(text).ok()
}

/// [`NativeVideoBridge`] over the Swift functions.
pub struct IosVideoBridge;

impl IosVideoBridge {
    /// Start listening for external screens; the current list arrives
    /// through `lt_video_ios_displays`.
    pub fn start() {
        unsafe { lt_video_swift_start() };
    }
}

impl NativeVideoBridge for IosVideoBridge {
    fn open(&self, display: &str, fit: VideoFit) -> Result<(), BackendError> {
        let display = c_string(display)
            .ok_or_else(|| BackendError::Failed("nombre de pantalla no válido".into()))?;
        if unsafe { lt_video_swift_open(display.as_ptr(), fit_arg(fit)) } {
            Ok(())
        } else {
            Err(BackendError::Failed(
                "la salida de vídeo no se pudo preparar".into(),
            ))
        }
    }

    fn close(&self) {
        unsafe { lt_video_swift_close() };
    }

    fn player(&self, slot: Slot, command: &PlayerCommand) {
        let slot = slot_arg(slot);
        match command {
            PlayerCommand::Load {
                path,
                start_seconds,
                paused,
            } => match c_string(path) {
                Some(path) => unsafe {
                    lt_video_swift_load(slot, path.as_ptr(), *start_seconds, *paused)
                },
                None => native_events::emit(BackendEvent::LoadFailed {
                    slot: if slot == 1 { Slot::B } else { Slot::A },
                    reason: "ruta de vídeo no válida".into(),
                }),
            },
            PlayerCommand::Seek { seconds } => unsafe { lt_video_swift_seek(slot, *seconds) },
            PlayerCommand::SetPause(paused) => unsafe { lt_video_swift_set_pause(slot, *paused) },
            PlayerCommand::SetSpeed(speed) => unsafe { lt_video_swift_set_speed(slot, *speed) },
            PlayerCommand::Stop => unsafe { lt_video_swift_stop(slot) },
        }
    }

    fn show_slot(&self, slot: Slot) {
        unsafe { lt_video_swift_show_slot(slot_arg(slot)) };
    }

    fn set_brightness(&self, value: f64) {
        unsafe { lt_video_swift_set_brightness(value) };
    }

    fn set_fit(&self, fit: VideoFit) {
        unsafe { lt_video_swift_set_fit(fit_arg(fit)) };
    }

    fn show_image(&self, slot: Slot, path: Option<&str>) {
        let path = path.and_then(c_string);
        let pointer = path.as_ref().map_or(std::ptr::null(), |path| path.as_ptr());
        unsafe { lt_video_swift_show_image(slot_arg(slot), pointer) };
    }

    fn dual_players(&self) -> bool {
        // AVPlayer has no decoder budget to run out of on any device that
        // runs the app (00-DISENO §4.3); the spike of paso 01 C6 measures it.
        true
    }

    fn set_keep_awake(&self, on: bool) {
        unsafe { lt_video_swift_set_keep_awake(on) };
    }
}

unsafe fn optional_str<'a>(text: *const c_char) -> Option<&'a str> {
    if text.is_null() {
        None
    } else {
        CStr::from_ptr(text).to_str().ok()
    }
}

/// Swift's `CADisplayLink` tick, per playing player.
#[no_mangle]
pub extern "C" fn lt_video_ios_time(slot: i32, seconds: f64) {
    native_events::emit(BackendEvent::TimePos {
        slot: if slot == 1 { Slot::B } else { Slot::A },
        seconds,
    });
}

/// Everything else, by kind (`native_events::kind`). `text` may be null and
/// is only read during the call.
#[no_mangle]
pub extern "C" fn lt_video_ios_event(kind: i32, slot: i32, text: *const c_char) {
    let text = unsafe { optional_str(text) };
    if let Some(event) = native_events::decode_event(kind, slot, text) {
        native_events::emit(event);
    }
}

/// The external screens, one per line (`native_events::parse_displays`).
#[no_mangle]
pub extern "C" fn lt_video_ios_displays(lines: *const c_char) {
    let lines = unsafe { optional_str(lines) }.unwrap_or_default();
    native_events::emit(BackendEvent::DisplaysChanged(
        native_events::parse_displays(lines),
    ));
}
