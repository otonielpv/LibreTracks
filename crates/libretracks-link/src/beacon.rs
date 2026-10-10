//! A second way to be found: a small UDP broadcast every second.
//!
//! mDNS is multicast, and many home routers drop multicast between Wi-Fi and
//! Ethernet (IGMP snooping), or Android's Wi-Fi filters it: a tablet on the
//! Wi-Fi then never sees a PC on a cable, though plain TCP between them works
//! (seen 2026-10-10, SM-T500 on Wi-Fi ↔ Windows PC on Ethernet). Broadcast
//! crosses that bridge. Both run together; the host registry merges them by
//! host id, so a host found both ways shows once.
//!
//! Not on iOS: sending or receiving broadcast there needs the same multicast
//! entitlement as raw mDNS. iOS uses Bonjour, and is still reachable by IP.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};

use crate::discovery::{parse_record, Advertisement, DiscoveredHost, DiscoveryEvent};

pub const BEACON_PORT: u16 = 3047;
pub const BEACON_INTERVAL_MS: u64 = 1_000;
/// A host not heard for this long is gone (several missed beacons).
pub const BEACON_EXPIRY_MS: u64 = 4_000;
const MAGIC: &str = "libretracks-link";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Beacon {
    app: String,
    id: String,
    name: String,
    port: u16,
    proto: String,
    ver: String,
    pin: String,
}

pub fn encode(ad: &Advertisement) -> Vec<u8> {
    let txt: HashMap<String, String> = ad.txt().into_iter().collect();
    let field = |key: &str| txt.get(key).cloned().unwrap_or_default();
    serde_json::to_vec(&Beacon {
        app: MAGIC.into(),
        id: field("id"),
        name: field("name"),
        port: ad.port,
        proto: field("proto"),
        ver: field("ver"),
        pin: field("pin"),
    })
    .unwrap_or_default()
}

/// A beacon received from `source`. The address to join is where it came
/// from: that is the interface that actually reaches this device.
pub fn decode(bytes: &[u8], source: IpAddr) -> Option<DiscoveredHost> {
    let beacon: Beacon = serde_json::from_slice(bytes).ok()?;
    if beacon.app != MAGIC {
        return None;
    }
    let lookup = |key: &str| -> Option<String> {
        Some(match key {
            "id" => beacon.id.clone(),
            "name" => beacon.name.clone(),
            "proto" => beacon.proto.clone(),
            "ver" => beacon.ver.clone(),
            "pin" => beacon.pin.clone(),
            _ => return None,
        })
    };
    parse_record(lookup, &[source], beacon.port)
}

/// The directed broadcast of a /24, the usual home and venue network. Sent
/// besides 255.255.255.255, which some systems only put on one interface.
pub fn subnet_broadcast(ip: Ipv4Addr) -> Ipv4Addr {
    let [a, b, c, _] = ip.octets();
    Ipv4Addr::new(a, b, c, 255)
}

/// Turns received beacons into Found/Lost, by host id.
#[derive(Debug, Default)]
pub struct BeaconTracker {
    seen: HashMap<String, (u64, DiscoveredHost)>,
}

pub fn key_for(host_id: &str) -> String {
    format!("beacon:{host_id}")
}

impl BeaconTracker {
    /// A beacon arrived at `now_ms`. Found only when new or changed, so a
    /// host beaconing every second does not flood the UI.
    pub fn observe(&mut self, host: DiscoveredHost, now_ms: u64) -> Option<DiscoveryEvent> {
        let id = host.host_id.clone();
        let changed = self
            .seen
            .get(&id)
            .map_or(true, |(_, previous)| *previous != host);
        self.seen.insert(id.clone(), (now_ms, host.clone()));
        changed.then(|| DiscoveryEvent::Found {
            key: key_for(&id),
            host,
        })
    }

    pub fn expire(&mut self, now_ms: u64) -> Vec<DiscoveryEvent> {
        let gone: Vec<String> = self
            .seen
            .iter()
            .filter(|(_, (last, _))| now_ms.saturating_sub(*last) > BEACON_EXPIRY_MS)
            .map(|(id, _)| id.clone())
            .collect();
        gone.into_iter()
            .map(|id| {
                self.seen.remove(&id);
                DiscoveryEvent::Lost { key: key_for(&id) }
            })
            .collect()
    }
}

#[cfg(feature = "mdns")]
pub use runtime::{BeaconListener, BeaconSender};

#[cfg(feature = "mdns")]
mod runtime {
    use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::net::local_ip;

    /// Broadcasts the advertisement every second until dropped.
    pub struct BeaconSender {
        stop: Arc<AtomicBool>,
    }

    impl BeaconSender {
        pub fn start(ad: &Advertisement) -> Result<Self, String> {
            let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
            socket.set_broadcast(true).map_err(|e| e.to_string())?;
            let payload = encode(ad);
            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = stop.clone();
            std::thread::Builder::new()
                .name("lt-link-beacon".into())
                .spawn(move || {
                    while !stop_thread.load(Ordering::Relaxed) {
                        let mut targets = vec![Ipv4Addr::BROADCAST];
                        if let Some(IpAddr::V4(ip)) = local_ip() {
                            targets.push(subnet_broadcast(ip));
                        }
                        for target in targets {
                            let _ = socket.send_to(&payload, (target, BEACON_PORT));
                        }
                        std::thread::sleep(Duration::from_millis(BEACON_INTERVAL_MS));
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(Self { stop })
        }
    }

    impl Drop for BeaconSender {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Listens for beacons until dropped, reporting Found/Lost.
    pub struct BeaconListener {
        stop: Arc<AtomicBool>,
    }

    impl BeaconListener {
        pub fn start(on_event: Arc<dyn Fn(DiscoveryEvent) + Send + Sync>) -> Result<Self, String> {
            let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, BEACON_PORT)))
                .map_err(|e| e.to_string())?;
            socket
                .set_read_timeout(Some(Duration::from_millis(500)))
                .map_err(|e| e.to_string())?;
            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = stop.clone();
            std::thread::Builder::new()
                .name("lt-link-beacon-rx".into())
                .spawn(move || {
                    let started = Instant::now();
                    let now_ms = || started.elapsed().as_millis() as u64;
                    let mut tracker = BeaconTracker::default();
                    let mut buffer = [0u8; 2048];
                    while !stop_thread.load(Ordering::Relaxed) {
                        if let Ok((size, source)) = socket.recv_from(&mut buffer) {
                            if let Some(host) = decode(&buffer[..size], source.ip()) {
                                if let Some(event) = tracker.observe(host, now_ms()) {
                                    on_event(event);
                                }
                            }
                        }
                        for event in tracker.expire(now_ms()) {
                            on_event(event);
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(Self { stop })
        }
    }

    impl Drop for BeaconListener {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ad() -> Advertisement {
        Advertisement {
            host_id: "pc-1".into(),
            name: "PC del director".into(),
            port: 3040,
            app_version: "1.15.0".into(),
            requires_pin: false,
        }
    }

    const PC: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 38));

    #[test]
    fn a_beacon_round_trips_with_the_sender_address() {
        let host = decode(&encode(&ad()), PC).unwrap();
        assert_eq!(host.host_id, "pc-1");
        assert_eq!(host.name, "PC del director");
        assert_eq!(host.addresses, vec!["192.168.1.38:3040"]);
        assert!(host.compatible);
        assert!(!host.requires_pin);
    }

    #[test]
    fn foreign_datagrams_are_ignored() {
        assert!(decode(b"hello", PC).is_none());
        assert!(decode(
            br#"{"app":"other","id":"x","name":"n","port":1,"proto":"1","ver":"","pin":"0"}"#,
            PC
        )
        .is_none());
    }

    #[test]
    fn subnet_broadcast_of_a_slash_24() {
        assert_eq!(
            subnet_broadcast(Ipv4Addr::new(192, 168, 1, 38)),
            Ipv4Addr::new(192, 168, 1, 255)
        );
    }

    #[test]
    fn repeated_beacons_report_once_and_expire_after_silence() {
        let mut tracker = BeaconTracker::default();
        let host = decode(&encode(&ad()), PC).unwrap();
        assert!(tracker.observe(host.clone(), 0).is_some());
        assert!(tracker.observe(host.clone(), 1_000).is_none());
        assert!(tracker.expire(1_000 + BEACON_EXPIRY_MS).is_empty());
        let lost = tracker.expire(1_001 + BEACON_EXPIRY_MS);
        assert_eq!(
            lost,
            vec![DiscoveryEvent::Lost {
                key: key_for("pc-1")
            }]
        );
        // Back again: found again.
        assert!(tracker.observe(host, 9_000).is_some());
    }

    #[test]
    fn a_change_of_address_or_name_is_reported() {
        let mut tracker = BeaconTracker::default();
        let host = decode(&encode(&ad()), PC).unwrap();
        tracker.observe(host, 0);
        let moved = decode(&encode(&ad()), IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50))).unwrap();
        assert!(tracker.observe(moved, 500).is_some());
    }
}
