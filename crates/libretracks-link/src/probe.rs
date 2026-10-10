//! A third way to be found, for where neither mDNS nor the broadcast beacon
//! get through: the guest asks every address of its /24 directly ("is there
//! a LibreTracks host here?") and hosts answer to the sender.
//!
//! Why it exists: on iOS, sending or receiving multicast OR broadcast needs
//! `com.apple.developer.networking.multicast`, an entitlement Apple grants by
//! hand. Plain unicast only needs the Local Network permission the app
//! already asks for. And the home network of the first test (iPhone on
//! Wi-Fi, PC on Ethernet, 2026-10-10) drops multicast between the two, so
//! Bonjour alone never found the PC.
//!
//! Cheap: 253 datagrams of 15 bytes every couple of seconds while the Join
//! tab is open, and a reply only from actual hosts. Std-only, no feature
//! flag: every platform runs it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::beacon::{decode, encode, BeaconTracker};
use crate::discovery::{Advertisement, DiscoveryEvent};
use crate::net::local_ip;

pub const PROBE_PORT: u16 = 3048;
pub const PROBE_REQUEST: &[u8] = b"lt-link-probe-1";
pub const SWEEP_INTERVAL_MS: u64 = 2_000;

/// Every other address of `ip`'s /24 (1–254), the usual home and venue LAN.
pub fn sweep_targets(ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    let [a, b, c, own] = ip.octets();
    (1..=254u8)
        .filter(|host| *host != own)
        .map(|host| Ipv4Addr::new(a, b, c, host))
        .collect()
}

pub fn probe_key(host_id: &str) -> String {
    format!("probe:{host_id}")
}

/// Host side: answers probes with the advertisement, until dropped.
pub struct ProbeResponder {
    stop: Arc<AtomicBool>,
}

impl ProbeResponder {
    pub fn start(ad: &Advertisement) -> Result<Self, String> {
        let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, PROBE_PORT)))
            .map_err(|error| format!("probe port {PROBE_PORT}: {error}"))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(500)))
            .map_err(|error| error.to_string())?;
        let reply = encode(ad);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        std::thread::Builder::new()
            .name("lt-link-probe-rx".into())
            .spawn(move || {
                let mut buffer = [0u8; 64];
                while !stop_thread.load(Ordering::Relaxed) {
                    if let Ok((size, from)) = socket.recv_from(&mut buffer) {
                        if &buffer[..size] == PROBE_REQUEST {
                            let _ = socket.send_to(&reply, from);
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { stop })
    }
}

impl Drop for ProbeResponder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Guest side: sweeps the /24 every couple of seconds and reports the hosts
/// that answer (Found when new or changed, Lost after silence), until
/// dropped.
pub struct ProbeSweeper {
    stop: Arc<AtomicBool>,
}

impl ProbeSweeper {
    pub fn start(on_event: Arc<dyn Fn(DiscoveryEvent) + Send + Sync>) -> Result<Self, String> {
        Self::start_with(on_event, None)
    }

    /// `targets`: who to ask instead of the /24 (tests use loopback).
    pub fn start_with(
        on_event: Arc<dyn Fn(DiscoveryEvent) + Send + Sync>,
        targets: Option<Vec<SocketAddr>>,
    ) -> Result<Self, String> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_millis(200)))
            .map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        std::thread::Builder::new()
            .name("lt-link-probe-sweep".into())
            .spawn(move || {
                let started = Instant::now();
                let now_ms = || started.elapsed().as_millis() as u64;
                let mut tracker = BeaconTracker::default();
                let mut next_sweep = Instant::now();
                let mut buffer = [0u8; 2048];
                while !stop_thread.load(Ordering::Relaxed) {
                    if Instant::now() >= next_sweep {
                        let list: Vec<SocketAddr> = match &targets {
                            Some(list) => list.clone(),
                            None => match local_ip() {
                                Some(IpAddr::V4(ip)) => sweep_targets(ip)
                                    .into_iter()
                                    .map(|ip| SocketAddr::from((ip, PROBE_PORT)))
                                    .collect(),
                                _ => Vec::new(),
                            },
                        };
                        for target in list {
                            let _ = socket.send_to(PROBE_REQUEST, target);
                        }
                        next_sweep = Instant::now() + Duration::from_millis(SWEEP_INTERVAL_MS);
                    }
                    if let Ok((size, from)) = socket.recv_from(&mut buffer) {
                        if let Some(host) = decode(&buffer[..size], from.ip()) {
                            if let Some(event) = tracker.observe(host, now_ms()) {
                                on_event(rekey(event));
                            }
                        }
                    }
                    for event in tracker.expire(now_ms()) {
                        on_event(rekey(event));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { stop })
    }
}

impl Drop for ProbeSweeper {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The tracker keys by `beacon:<id>`; probe results get their own key so a
/// host seen both ways stays listed until both go silent.
fn rekey(event: DiscoveryEvent) -> DiscoveryEvent {
    let probe = |key: String| key.replacen("beacon:", "probe:", 1);
    match event {
        DiscoveryEvent::Found { key, host } => DiscoveryEvent::Found {
            key: probe(key),
            host,
        },
        DiscoveryEvent::Lost { key } => DiscoveryEvent::Lost { key: probe(key) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn sweeps_the_slash_24_but_not_itself() {
        let targets = sweep_targets(Ipv4Addr::new(192, 168, 1, 44));
        assert_eq!(targets.len(), 253);
        assert!(!targets.contains(&Ipv4Addr::new(192, 168, 1, 44)));
        assert!(targets.contains(&Ipv4Addr::new(192, 168, 1, 38)));
        assert!(!targets.contains(&Ipv4Addr::new(192, 168, 1, 0)));
        assert!(!targets.contains(&Ipv4Addr::new(192, 168, 1, 255)));
    }

    #[test]
    fn a_probed_host_answers_and_is_found() {
        // This machine's LAN address (loopback is filtered out of results on
        // purpose), on the real probe port: skip quietly without a network or
        // if a running LibreTracks host already holds the port.
        let Some(IpAddr::V4(own)) = local_ip() else {
            eprintln!("no LAN address; skipped");
            return;
        };
        let ad = Advertisement {
            host_id: "probe-test".into(),
            name: "PC".into(),
            port: 3040,
            app_version: "t".into(),
            requires_pin: false,
        };
        let Ok(_responder) = ProbeResponder::start(&ad) else {
            eprintln!("probe port busy; skipped");
            return;
        };
        let (tx, rx) = mpsc::channel();
        let _sweeper = ProbeSweeper::start_with(
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
            Some(vec![SocketAddr::from((own, PROBE_PORT))]),
        )
        .unwrap();
        let event = rx.recv_timeout(Duration::from_secs(5)).expect("found");
        match event {
            DiscoveryEvent::Found { key, host } => {
                assert_eq!(key, probe_key("probe-test"));
                assert_eq!(host.addresses, vec![format!("{own}:3040")]);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
