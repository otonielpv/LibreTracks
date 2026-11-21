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
    fn lt_device_name() -> *mut c_char;
    fn lt_lyrics_bonjour_browse(service_type: *const c_char);
    fn lt_lyrics_bonjour_stop();
}

/// `UIDevice.name`: "iPhone" / "iPad", or the user's own name once the app
/// holds Apple's user-assigned-device-name entitlement.
pub fn device_name() -> Option<String> {
    let pointer = unsafe { lt_device_name() };
    if pointer.is_null() {
        return None;
    }
    let name = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .trim()
        .to_string();
    unsafe { libc::free(pointer.cast()) };
    (!name.is_empty()).then_some(name)
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

/// What the lyrics browse resolved while it runs; `None` = not browsing.
static LYRICS_FOUND: std::sync::Mutex<Option<Vec<(std::net::IpAddr, u16)>>> =
    std::sync::Mutex::new(None);

/// `{"ips": [...], "port": n}` → addresses. Link-local IPv6 comes with a
/// zone (`fe80::1%en0`), stripped; the sweep and the HTTP check want the
/// address alone.
fn parse_lyrics_record(json: &str) -> Vec<(std::net::IpAddr, u16)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(port) = value["port"].as_u64().and_then(|port| u16::try_from(port).ok()) else {
        return Vec::new();
    };
    value["ips"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|ip| ip.as_str())
        .filter_map(|ip| ip.split('%').next()?.parse().ok())
        .map(|ip| (ip, port))
        .collect()
}

#[no_mangle]
pub extern "C" fn lt_lyrics_ios_found(json: *const c_char) {
    let Some(json) = (unsafe { optional_str(json) }) else {
        return;
    };
    if let Ok(mut slot) = LYRICS_FOUND.lock() {
        if let Some(found) = slot.as_mut() {
            for entry in parse_lyrics_record(&json) {
                if !found.contains(&entry) {
                    found.push(entry);
                }
            }
        }
    }
}

/// Browse `service_type` (bare, `_x._tcp`) through the system's Bonjour
/// for `wait` and return what resolved. Blocking: call it off the async
/// runtime. Needs the type in `NSBonjourServices` (Info.ios.plist).
pub fn lyrics_browse_once(service_type: &str, wait: std::time::Duration) -> Vec<(std::net::IpAddr, u16)> {
    if let Ok(mut slot) = LYRICS_FOUND.lock() {
        *slot = Some(Vec::new());
    }
    let service_type = c(service_type);
    unsafe { lt_lyrics_bonjour_browse(service_type.as_ptr()) };
    std::thread::sleep(wait);
    unsafe { lt_lyrics_bonjour_stop() };
    LYRICS_FOUND
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .unwrap_or_default()
}
