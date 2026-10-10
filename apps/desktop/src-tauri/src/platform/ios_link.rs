//! Network sessions on iOS: keep-awake and Bonjour through
//! `NetworkSessionBridge.swift` (in the `ios-folder-picker` plugin's Swift
//! package, like the video bridge). Plain C calls; Swift copies the
//! arguments and hops to the main queue, so none of these waits. Discovery
//! events come back through `lt_link_ios_discovery`, which Swift declares
//! with `@_silgen_name`.

#![cfg(target_os = "ios")]

use std::ffi::{c_char, CStr, CString};

extern "C" {
    fn lt_keep_awake_set(reason: *const c_char, on: bool);
    fn lt_link_bonjour_advertise(
        name: *const c_char,
        service_type: *const c_char,
        port: i32,
        txt_json: *const c_char,
    );
    fn lt_link_bonjour_stop_advertise();
    fn lt_link_bonjour_browse(service_type: *const c_char);
    fn lt_link_bonjour_stop_browse();
}

fn c(text: &str) -> CString {
    CString::new(text.replace('\0', "")).unwrap_or_default()
}

pub fn keep_awake(reason: &str, on: bool) {
    let reason = c(reason);
    unsafe { lt_keep_awake_set(reason.as_ptr(), on) };
}

pub fn advertise(name: &str, service_type: &str, port: u16, txt_json: &str) {
    let (name, service_type, txt) = (c(name), c(service_type), c(txt_json));
    unsafe {
        lt_link_bonjour_advertise(
            name.as_ptr(),
            service_type.as_ptr(),
            port as i32,
            txt.as_ptr(),
        )
    };
}

pub fn stop_advertising() {
    unsafe { lt_link_bonjour_stop_advertise() };
}

pub fn browse(service_type: &str) {
    let service_type = c(service_type);
    unsafe { lt_link_bonjour_browse(service_type.as_ptr()) };
}

pub fn stop_browsing() {
    unsafe { lt_link_bonjour_stop_browse() };
}

unsafe fn optional_str(pointer: *const c_char) -> Option<String> {
    (!pointer.is_null()).then(|| CStr::from_ptr(pointer).to_string_lossy().into_owned())
}

/// kind 1 = resolved (`json` = `{ips, port, txt}`), 2 = removed.
#[no_mangle]
pub extern "C" fn lt_link_ios_discovery(kind: i32, key: *const c_char, json: *const c_char) {
    let key = unsafe { optional_str(key) }.unwrap_or_default();
    let json = unsafe { optional_str(json) };
    crate::link::discovery::on_native_event(kind, key, json);
}
