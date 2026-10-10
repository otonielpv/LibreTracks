//! Finding hosts and being found (plan network-sessions, paso 04).
//!
//! One backend per platform behind the same three operations (advertise,
//! browse, stop): `mdns-sd` on desktop and Android, the system's Bonjour on
//! iOS. What was seen goes through `HostRegistry` (pure, in the crate) and
//! the UI gets the whole list on `link://discovered` whenever it changes.
//!
//! Global state, not managed Tauri state, because the iOS events arrive from
//! Swift through a C function with no `AppHandle` at hand. Nothing starts at
//! launch: the mDNS daemon is created the first time it is needed.

use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};

use libretracks_link::discovery::{
    parse_record, Advertisement, DiscoveredHost, DiscoveryEvent, HostRegistry,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const DISCOVERED_EVENT: &str = "link://discovered";

struct State {
    app: Option<AppHandle>,
    registry: HostRegistry,
    browsing: bool,
    advertising: bool,
    #[cfg(not(target_os = "ios"))]
    mdns: Option<libretracks_link::discovery::MdnsDiscovery>,
    /// Unicast sweep of the /24 (every platform; the only way that works on
    /// iOS where multicast and broadcast need an Apple entitlement).
    probe_responder: Option<libretracks_link::probe::ProbeResponder>,
    probe_sweeper: Option<libretracks_link::probe::ProbeSweeper>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            app: None,
            registry: HostRegistry::new(None),
            browsing: false,
            advertising: false,
            #[cfg(not(target_os = "ios"))]
            mdns: None,
            probe_responder: None,
            probe_sweeper: None,
        })
    })
}

/// Called once at startup with this device's id, so it never lists itself.
pub fn init(app: &AppHandle, own_host_id: &str) {
    if let Ok(mut state) = state().lock() {
        state.app = Some(app.clone());
        state.registry = HostRegistry::new(Some(own_host_id.to_string()));
    }
}

#[cfg(not(target_os = "ios"))]
fn mdns(state: &mut State) -> Option<&libretracks_link::discovery::MdnsDiscovery> {
    if state.mdns.is_none() {
        match libretracks_link::discovery::MdnsDiscovery::new() {
            Ok(daemon) => state.mdns = Some(daemon),
            Err(error) => {
                eprintln!("[libretracks-link] mDNS unavailable: {error}");
                return None;
            }
        }
    }
    state.mdns.as_ref()
}

fn update_multicast_lock(state: &State) {
    #[cfg(target_os = "android")]
    crate::platform::android_multicast::set_multicast_lock(state.browsing || state.advertising);
    #[cfg(not(target_os = "android"))]
    let _ = state;
}

pub fn advertise(ad: &Advertisement) {
    let Ok(mut state) = state().lock() else {
        return;
    };
    state.advertising = true;
    update_multicast_lock(&state);
    match libretracks_link::probe::ProbeResponder::start(ad) {
        Ok(responder) => state.probe_responder = Some(responder),
        Err(error) => eprintln!("[libretracks-link] probe responder: {error}"),
    }
    #[cfg(target_os = "ios")]
    {
        let txt: serde_json::Map<String, Value> = ad
            .txt()
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect();
        crate::platform::ios_link::advertise(
            &ad.instance_name(),
            libretracks_link::discovery::SERVICE_TYPE_BARE,
            ad.port,
            &Value::Object(txt).to_string(),
        );
    }
    #[cfg(not(target_os = "ios"))]
    if let Some(daemon) = mdns(&mut state) {
        if let Err(error) = daemon.advertise(ad) {
            eprintln!("[libretracks-link] could not advertise: {error}");
        }
    }
}

pub fn stop_advertising() {
    let Ok(mut state) = state().lock() else {
        return;
    };
    if !state.advertising {
        return;
    }
    state.advertising = false;
    state.probe_responder = None;
    update_multicast_lock(&state);
    #[cfg(target_os = "ios")]
    crate::platform::ios_link::stop_advertising();
    #[cfg(not(target_os = "ios"))]
    if let Some(daemon) = state.mdns.as_ref() {
        daemon.stop_advertising();
    }
}

pub fn start_browsing() -> Vec<DiscoveredHost> {
    let Ok(mut state) = state().lock() else {
        return Vec::new();
    };
    if state.browsing {
        return state.registry.list();
    }
    state.browsing = true;
    state.registry.clear();
    update_multicast_lock(&state);
    match libretracks_link::probe::ProbeSweeper::start(std::sync::Arc::new(apply)) {
        Ok(sweeper) => state.probe_sweeper = Some(sweeper),
        Err(error) => eprintln!("[libretracks-link] probe sweep: {error}"),
    }
    #[cfg(target_os = "ios")]
    crate::platform::ios_link::browse(libretracks_link::discovery::SERVICE_TYPE_BARE);
    #[cfg(not(target_os = "ios"))]
    if let Some(daemon) = mdns(&mut state) {
        if let Err(error) = daemon.browse(apply) {
            eprintln!("[libretracks-link] could not browse: {error}");
        }
    }
    state.registry.list()
}

pub fn stop_browsing() {
    let Ok(mut state) = state().lock() else {
        return;
    };
    if !state.browsing {
        return;
    }
    state.browsing = false;
    state.probe_sweeper = None;
    state.registry.clear();
    update_multicast_lock(&state);
    #[cfg(target_os = "ios")]
    crate::platform::ios_link::stop_browsing();
    #[cfg(not(target_os = "ios"))]
    if let Some(daemon) = state.mdns.as_ref() {
        daemon.stop_browsing();
    }
}

fn apply(event: DiscoveryEvent) {
    let emit = {
        let Ok(mut state) = state().lock() else {
            return;
        };
        if !state.browsing || !state.registry.apply(event) {
            return;
        }
        state.app.clone().map(|app| (app, state.registry.list()))
    };
    if let Some((app, list)) = emit {
        let _ = app.emit(DISCOVERED_EVENT, list);
    }
}

/// A resolved Bonjour record from iOS: `{"ips": [...], "port": n, "txt": {}}`.
pub fn parse_native_record(json: &str) -> Option<DiscoveredHost> {
    let value: Value = serde_json::from_str(json).ok()?;
    let port = u16::try_from(value["port"].as_u64()?).ok()?;
    let ips: Vec<IpAddr> = value["ips"]
        .as_array()?
        .iter()
        .filter_map(|ip| ip.as_str())
        // Link-local IPv6 comes with a zone (`fe80::1%en0`); the address
        // itself is what the parser wants.
        .filter_map(|ip| ip.split('%').next()?.parse().ok())
        .collect();
    let txt = &value["txt"];
    parse_record(|key| txt[key].as_str().map(str::to_string), &ips, port)
}

/// iOS discovery events (`platform::ios_link`): 1 resolved, 2 removed.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn on_native_event(kind: i32, key: String, json: Option<String>) {
    match kind {
        1 => {
            if let Some(host) = json.as_deref().and_then(parse_native_record) {
                apply(DiscoveryEvent::Found { key, host });
            }
        }
        2 => apply(DiscoveryEvent::Lost { key }),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_record_parses_with_zoned_ipv6() {
        let host = parse_native_record(
            r#"{"ips":["fe80::1%en0","192.168.1.30"],"port":3040,
                "txt":{"id":"ipad-1","name":"iPad de Ana","proto":"1","ver":"1.15.0","pin":"1"}}"#,
        )
        .unwrap();
        assert_eq!(host.host_id, "ipad-1");
        assert_eq!(
            host.addresses,
            vec![
                "192.168.1.30:3040".to_string(),
                "[fe80::1]:3040".to_string()
            ]
        );
        assert!(host.requires_pin);
    }

    #[test]
    fn broken_ios_record_is_ignored() {
        assert!(parse_native_record("{nope").is_none());
        assert!(
            parse_native_record(r#"{"ips":[],"port":3040,"txt":{"id":"x","proto":"1"}}"#).is_none()
        );
        assert!(parse_native_record(
            r#"{"ips":["1.2.3.4"],"port":99999,"txt":{"id":"x","proto":"1"}}"#
        )
        .is_none());
    }
}
