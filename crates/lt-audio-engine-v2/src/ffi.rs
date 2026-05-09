//! Raw C ABI declarations — mirrors include/lt_engine/lt_engine.h.

use std::ffi::c_char;

pub type LtResult = i32;

pub const LT_OK:                  LtResult = 0;
pub const LT_ERR_INVALID_HANDLE:  LtResult = 1;
pub const LT_ERR_ALREADY_INIT:    LtResult = 2;
pub const LT_ERR_NOT_INIT:        LtResult = 3;
pub const LT_ERR_INVALID_COMMAND: LtResult = 4;
pub const LT_ERR_DEVICE:          LtResult = 5;
pub const LT_ERR_INTERNAL:        LtResult = 99;

#[repr(C)]
pub struct LtEngine {
    _private: [u8; 0],
}

#[link(name = "lt_audio_engine_v2")]
extern "C" {
    pub fn lt_audio_engine_create() -> *mut LtEngine;
    pub fn lt_audio_engine_destroy(engine: *mut LtEngine);
    pub fn lt_audio_engine_initialize(engine: *mut LtEngine) -> LtResult;
    pub fn lt_audio_engine_shutdown(engine: *mut LtEngine) -> LtResult;
    pub fn lt_audio_engine_get_version(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_get_diagnostics(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_send_command(engine: *mut LtEngine, command_json: *const c_char) -> LtResult;
    pub fn lt_audio_engine_poll_event(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_get_snapshot(engine: *mut LtEngine) -> *const c_char;
    pub fn lt_audio_engine_list_devices(engine: *mut LtEngine) -> *const c_char;
}
