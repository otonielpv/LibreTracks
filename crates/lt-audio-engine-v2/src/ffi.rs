//! Raw C ABI declarations — mirrors include/lt_engine/lt_engine.h.
//!
//! Under the `no-link` feature the extern block is replaced by stubs so
//! `cargo test --features no-link` compiles without the C++ shared library.
//!
//! On Android, build.rs emits `lt_engine_android_link` when the NDK-built
//! engine (`native/audio-engine-v2/build-android-<abi>/liblt_audio_engine_v2.so`)
//! exists, linking it like any other platform. Without that build the stubs
//! take over and the app runs with a silent no-op engine — so a checkout
//! that never ran the NDK cmake build still compiles.

use std::ffi::c_char;

pub type LtResult = i32;

pub const LT_OK: LtResult = 0;
pub const LT_ERR_INVALID_HANDLE: LtResult = 1;
pub const LT_ERR_ALREADY_INIT: LtResult = 2;
pub const LT_ERR_NOT_INIT: LtResult = 3;
pub const LT_ERR_INVALID_COMMAND: LtResult = 4;
pub const LT_ERR_DEVICE: LtResult = 5;
#[allow(dead_code)]
pub const LT_ERR_INTERNAL: LtResult = 99;

#[repr(C)]
pub struct LtEngine {
    _private: [u8; 0],
}

// ── Real FFI (C++ library present) ─────────────────────────────────────────
#[cfg(not(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
)))]
#[link(name = "lt_audio_engine_v2")]
extern "C" {
    pub fn lt_audio_engine_create() -> *mut LtEngine;
    pub fn lt_audio_engine_destroy(engine: *mut LtEngine);
    pub fn lt_audio_engine_initialize(engine: *mut LtEngine) -> LtResult;
    pub fn lt_audio_engine_shutdown(engine: *mut LtEngine) -> LtResult;
    pub fn lt_audio_engine_get_version(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_get_diagnostics(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_send_command(
        engine: *mut LtEngine,
        command_json: *const c_char,
    ) -> LtResult;
    pub fn lt_audio_engine_service_control_thread(engine: *mut LtEngine);
    pub fn lt_audio_engine_poll_event(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_get_snapshot(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_list_devices(
        engine: *mut LtEngine,
        force_rescan: i32,
    ) -> *const c_char;
    pub fn lt_audio_engine_get_source_peaks(
        engine: *mut LtEngine,
        source_id: *const c_char,
        resolution_frames: i32,
    ) -> *const c_char;
    pub fn lt_audio_engine_analyze_file_peaks(
        file_path: *const c_char,
        resolution_frames: i32,
    ) -> *const c_char;
    pub fn lt_audio_engine_load_pad_clip(
        engine: *mut LtEngine,
        pads_dir: *const c_char,
        pad_id: *const c_char,
        key: i32,
        sample_rate: i32,
    );
    pub fn lt_audio_engine_source_cache_dir() -> *const c_char;
    pub fn lt_audio_engine_source_cache_size_bytes() -> u64;
    pub fn lt_audio_engine_purge_source_cache() -> u64;
}

// ── Stubs (no-link feature — tests only) ───────────────────────────────────
//
// These make the engine behave as an in-memory no-op so the Rust-side logic
// tests (session/state management in libretracks-desktop) run without the
// compiled C++ library or any audio hardware. They are NOT a simulation of
// the DSP — the real engine behaviour is covered by the C++ doctest suite
// (see docs/testing-engine-v2.md). Contract held here:
//   * create() returns a valid non-null handle that is never dereferenced.
//   * initialize()/shutdown()/send_command() succeed (LT_OK).
//   * snapshot()/diagnostics()/list_devices() return well-formed JSON so the
//     safe wrapper deserializes cleanly.

// A non-null, properly-aligned address used as the opaque handle. The handle
// is opaque (`LtEngine` is a zero-sized `[u8; 0]`) and every stub ignores it,
// so this pointer is never read or written — it only has to be non-null so
// `Engine::new()` treats creation as successful.
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
static STUB_ENGINE_HANDLE: u8 = 0;

#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_create() -> *mut LtEngine {
    (&STUB_ENGINE_HANDLE as *const u8 as *mut u8).cast::<LtEngine>()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_destroy(_: *mut LtEngine) {}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_initialize(_: *mut LtEngine) -> LtResult {
    LT_OK
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_shutdown(_: *mut LtEngine) -> LtResult {
    LT_OK
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_get_version(_: *mut LtEngine) -> *const c_char {
    b"0.0.0\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_get_diagnostics(_: *mut LtEngine) -> *const c_char {
    b"{}\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_send_command(_: *mut LtEngine, _: *const c_char) -> LtResult {
    LT_OK
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_service_control_thread(_: *mut LtEngine) {}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_poll_event(_: *mut LtEngine) -> *const c_char {
    std::ptr::null()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_get_snapshot(_: *mut LtEngine) -> *const c_char {
    // The safe wrapper deserializes this into EngineSnapshot, which has a few
    // non-defaulted fields (current_frame, device, cpu, meters…). Returning a
    // bare "{}" fails to deserialize, so emit a fully-defaulted snapshot. The
    // CString is cached per thread so the returned pointer stays valid for the
    // duration of the call (the wrapper copies it immediately).
    use std::cell::RefCell;
    use std::ffi::CString;
    thread_local! {
        static SNAPSHOT_JSON: RefCell<Option<CString>> = const { RefCell::new(None) };
    }
    SNAPSHOT_JSON.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let json = serde_json::to_string(&crate::snapshot::EngineSnapshot::default())
                .unwrap_or_else(|_| "{}".to_string());
            *slot = Some(CString::new(json).unwrap_or_default());
        }
        slot.as_ref()
            .map(|s| s.as_ptr())
            .unwrap_or(std::ptr::null())
    })
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_list_devices(_: *mut LtEngine, _force_rescan: i32) -> *const c_char {
    b"[]\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_get_source_peaks(
    _: *mut LtEngine,
    _: *const c_char,
    _: i32,
) -> *const c_char {
    b"{\"ok\":false,\"error\":\"no-link\"}\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_analyze_file_peaks(_: *const c_char, _: i32) -> *const c_char {
    b"{\"ok\":false,\"error\":\"no-link\"}\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_load_pad_clip(
    _: *mut LtEngine,
    _: *const c_char,
    _: *const c_char,
    _: i32,
    _: i32,
) {
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_source_cache_dir() -> *const c_char {
    b"\0".as_ptr().cast()
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_source_cache_size_bytes() -> u64 {
    0
}
#[cfg(any(
    feature = "no-link",
    all(target_os = "android", not(lt_engine_android_link))
))]
pub unsafe fn lt_audio_engine_purge_source_cache() -> u64 {
    0
}
