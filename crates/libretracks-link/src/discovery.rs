//! Finding hosts on the LAN without typing addresses: DNS-SD / Bonjour
//! service `_libretracks-link._tcp`.
//!
//! The pure part (TXT record, the list of hosts seen) is here and tested.
//! Backends feed it: `MdnsDiscovery` (crate `mdns-sd`, feature `mdns`) on
//! Windows, macOS, Linux and Android; on iOS the app uses the system's
//! Bonjour from Swift, because raw multicast sockets there need an Apple
//! entitlement granted by hand (docs/plans/network-sessions/00-DISENO.md §6).

use std::collections::HashMap;

use serde::Serialize;

use crate::version::{negotiate, PROTOCOL_VERSION};

/// Without the trailing `local.` for Bonjour on iOS, with it for mdns-sd.
pub const SERVICE_TYPE_BARE: &str = "_libretracks-link._tcp";
pub const SERVICE_TYPE: &str = "_libretracks-link._tcp.local.";

/// What a host announces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertisement {
    pub host_id: String,
    pub name: String,
    pub port: u16,
    pub app_version: String,
    pub requires_pin: bool,
}

impl Advertisement {
    /// TXT keys are short on purpose: the whole record travels in every
    /// multicast answer.
    pub fn txt(&self) -> Vec<(String, String)> {
        vec![
            ("id".into(), self.host_id.clone()),
            ("name".into(), self.name.clone()),
            ("proto".into(), PROTOCOL_VERSION.to_string()),
            ("ver".into(), self.app_version.clone()),
            (
                "pin".into(),
                if self.requires_pin { "1" } else { "0" }.into(),
            ),
        ]
    }

    /// Instance names must be unique on the network; two musicians may well
    /// call their tablets the same, so the id goes in.
    pub fn instance_name(&self) -> String {
        let short: String = self.host_id.chars().take(6).collect();
        let name: String = self.name.chars().take(40).collect();
        format!("{name} ({short})")
    }
}

/// A host seen on the network, as the join list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub host_id: String,
    pub name: String,
    /// `ip:port`, IPv4 first (what a person would type), IPv6 bracketed.
    pub addresses: Vec<String>,
    pub protocol: u32,
    pub app_version: String,
    pub requires_pin: bool,
    /// False when this app cannot talk to it: shown as «needs updating», not
    /// hidden, so the musician knows why it does not connect.
    pub compatible: bool,
}

/// Build a host from a resolved record. `txt` looks a key up. None when the
/// record is not one of ours or lacks the essentials.
pub fn parse_record(
    txt: impl Fn(&str) -> Option<String>,
    ips: &[std::net::IpAddr],
    port: u16,
) -> Option<DiscoveredHost> {
    let host_id = txt("id").filter(|id| !id.trim().is_empty())?;
    let protocol: u32 = txt("proto")?.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let mut v4: Vec<String> = Vec::new();
    let mut v6: Vec<String> = Vec::new();
    for ip in ips {
        if ip.is_loopback() || ip.is_unspecified() {
            continue;
        }
        match ip {
            std::net::IpAddr::V4(v4ip) => v4.push(format!("{v4ip}:{port}")),
            std::net::IpAddr::V6(v6ip) => v6.push(format!("[{v6ip}]:{port}")),
        }
    }
    v4.sort();
    v6.sort();
    v4.extend(v6);
    if v4.is_empty() {
        return None;
    }
    Some(DiscoveredHost {
        name: txt("name").unwrap_or_else(|| host_id.clone()),
        host_id,
        addresses: v4,
        // A host accepts its version and the previous one: that we can talk
        // to it means it accepts OURS.
        compatible: negotiate(protocol, PROTOCOL_VERSION).is_ok(),
        protocol,
        app_version: txt("ver").unwrap_or_default(),
        requires_pin: txt("pin").as_deref() == Some("1"),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryEvent {
    /// `key` identifies the record (the DNS-SD full name) for its `Lost`.
    Found {
        key: String,
        host: DiscoveredHost,
    },
    Lost {
        key: String,
    },
}

/// The hosts currently visible. One entry per host id even when it answers
/// on several interfaces or under a stale record name; never this device.
#[derive(Debug, Default)]
pub struct HostRegistry {
    own_host_id: Option<String>,
    by_key: HashMap<String, DiscoveredHost>,
}

impl HostRegistry {
    pub fn new(own_host_id: Option<String>) -> Self {
        Self {
            own_host_id,
            by_key: HashMap::new(),
        }
    }

    /// Apply an event; returns whether the visible list changed.
    pub fn apply(&mut self, event: DiscoveryEvent) -> bool {
        let before = self.list();
        match event {
            DiscoveryEvent::Found { key, host } => {
                if self.own_host_id.as_deref() == Some(host.host_id.as_str()) {
                    return false;
                }
                self.by_key.insert(key, host);
            }
            DiscoveryEvent::Lost { key } => {
                self.by_key.remove(&key);
            }
        }
        self.list() != before
    }

    pub fn list(&self) -> Vec<DiscoveredHost> {
        let mut merged: HashMap<&str, DiscoveredHost> = HashMap::new();
        for host in self.by_key.values() {
            merged
                .entry(host.host_id.as_str())
                .and_modify(|existing| {
                    for address in &host.addresses {
                        if !existing.addresses.contains(address) {
                            existing.addresses.push(address.clone());
                        }
                    }
                })
                .or_insert_with(|| host.clone());
        }
        let mut list: Vec<DiscoveredHost> = merged.into_values().collect();
        for host in &mut list {
            // IPv4 before IPv6 after merging, as in `parse_record`.
            host.addresses
                .sort_by_key(|address| (address.starts_with('['), address.clone()));
        }
        list.sort_by(|a, b| a.name.cmp(&b.name).then(a.host_id.cmp(&b.host_id)));
        list
    }

    pub fn clear(&mut self) {
        self.by_key.clear();
    }
}

#[cfg(feature = "mdns")]
pub use mdns_backend::MdnsDiscovery;

#[cfg(feature = "mdns")]
mod mdns_backend {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

    use super::{parse_record, Advertisement, DiscoveryEvent, SERVICE_TYPE};
    use crate::beacon::{BeaconListener, BeaconSender};

    /// LAN discovery for desktop and Android: mDNS through the `mdns-sd`
    /// daemon (its own thread, no async runtime) plus the UDP broadcast
    /// beacon (`beacon.rs`), which gets through where routers drop
    /// multicast between Wi-Fi and Ethernet. Either may fail to start on a
    /// given machine; the other still works.
    pub struct MdnsDiscovery {
        daemon: Option<ServiceDaemon>,
        advertised: Mutex<Option<String>>,
        beacon_sender: Mutex<Option<BeaconSender>>,
        beacon_listener: Mutex<Option<BeaconListener>>,
    }

    impl MdnsDiscovery {
        pub fn new() -> Result<Self, String> {
            let daemon = match ServiceDaemon::new() {
                Ok(daemon) => Some(daemon),
                Err(error) => {
                    eprintln!("[libretracks-link] mDNS unavailable, beacon only: {error}");
                    None
                }
            };
            Ok(Self {
                daemon,
                advertised: Mutex::new(None),
                beacon_sender: Mutex::new(None),
                beacon_listener: Mutex::new(None),
            })
        }

        fn register_mdns(
            &self,
            daemon: &ServiceDaemon,
            ad: &Advertisement,
        ) -> Result<String, String> {
            let host_label: String = ad
                .host_id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(16)
                .collect();
            let properties: HashMap<String, String> = ad.txt().into_iter().collect();
            let info = ServiceInfo::new(
                SERVICE_TYPE,
                &ad.instance_name(),
                &format!("libretracks-{host_label}.local."),
                "",
                ad.port,
                properties,
            )
            .map_err(|error| error.to_string())?
            // Announce every interface's address, kept up to date when the
            // Wi-Fi changes.
            .enable_addr_auto();
            let fullname = info.get_fullname().to_string();
            daemon.register(info).map_err(|error| error.to_string())?;
            Ok(fullname)
        }

        /// Ok when at least one of the two ways is announcing.
        pub fn advertise(&self, ad: &Advertisement) -> Result<(), String> {
            self.stop_advertising();
            let mut errors = Vec::new();
            let mut working = 0;

            match BeaconSender::start(ad) {
                Ok(sender) => {
                    working += 1;
                    if let Ok(mut slot) = self.beacon_sender.lock() {
                        *slot = Some(sender);
                    }
                }
                Err(error) => errors.push(format!("beacon: {error}")),
            }
            if let Some(daemon) = &self.daemon {
                match self.register_mdns(daemon, ad) {
                    Ok(fullname) => {
                        working += 1;
                        if let Ok(mut advertised) = self.advertised.lock() {
                            *advertised = Some(fullname);
                        }
                    }
                    Err(error) => errors.push(format!("mdns: {error}")),
                }
            }
            if !errors.is_empty() {
                eprintln!("[libretracks-link] advertising: {}", errors.join("; "));
            }
            if working > 0 {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        pub fn stop_advertising(&self) {
            if let Ok(mut sender) = self.beacon_sender.lock() {
                sender.take();
            }
            let previous = self
                .advertised
                .lock()
                .ok()
                .and_then(|mut advertised| advertised.take());
            if let (Some(fullname), Some(daemon)) = (previous, &self.daemon) {
                let _ = daemon.unregister(&fullname);
            }
        }

        /// Start browsing; events arrive on `on_event` from background
        /// threads until `stop_browsing`. Ok when at least one way listens.
        pub fn browse(
            &self,
            on_event: impl Fn(DiscoveryEvent) + Send + Sync + 'static,
        ) -> Result<(), String> {
            let on_event: Arc<dyn Fn(DiscoveryEvent) + Send + Sync> = Arc::new(on_event);
            let mut errors = Vec::new();
            let mut working = 0;

            match BeaconListener::start(on_event.clone()) {
                Ok(listener) => {
                    working += 1;
                    if let Ok(mut slot) = self.beacon_listener.lock() {
                        *slot = Some(listener);
                    }
                }
                Err(error) => errors.push(format!("beacon: {error}")),
            }
            if let Some(daemon) = &self.daemon {
                match daemon.browse(SERVICE_TYPE) {
                    Ok(receiver) => {
                        let on_event = on_event.clone();
                        let spawned = std::thread::Builder::new()
                            .name("lt-link-browse".into())
                            .spawn(move || browse_loop(receiver, on_event));
                        match spawned {
                            Ok(_) => working += 1,
                            Err(error) => errors.push(format!("mdns thread: {error}")),
                        }
                    }
                    Err(error) => errors.push(format!("mdns: {error}")),
                }
            }
            if !errors.is_empty() {
                eprintln!("[libretracks-link] browsing: {}", errors.join("; "));
            }
            if working > 0 {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        pub fn stop_browsing(&self) {
            if let Ok(mut listener) = self.beacon_listener.lock() {
                listener.take();
            }
            if let Some(daemon) = &self.daemon {
                let _ = daemon.stop_browse(SERVICE_TYPE);
            }
        }
    }

    fn browse_loop(
        receiver: mdns_sd::Receiver<ServiceEvent>,
        on_event: Arc<dyn Fn(DiscoveryEvent) + Send + Sync>,
    ) {
        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::ServiceResolved(resolved) => {
                    let ips: Vec<std::net::IpAddr> = resolved
                        .addresses
                        .iter()
                        .map(|scoped| scoped.to_ip_addr())
                        .collect();
                    let host = parse_record(
                        |key| resolved.get_property_val_str(key).map(str::to_string),
                        &ips,
                        resolved.port,
                    );
                    if let Some(host) = host {
                        on_event(DiscoveryEvent::Found {
                            key: resolved.fullname.clone(),
                            host,
                        });
                    }
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    on_event(DiscoveryEvent::Lost { key: fullname });
                }
                ServiceEvent::SearchStopped(_) => return,
                _ => {}
            }
        }
    }

    impl Drop for MdnsDiscovery {
        fn drop(&mut self) {
            self.stop_advertising();
            self.stop_browsing();
            if let Some(daemon) = &self.daemon {
                let _ = daemon.shutdown();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn ad() -> Advertisement {
        Advertisement {
            host_id: "abcdef123456".into(),
            name: "PC del director".into(),
            port: 3040,
            app_version: "1.15.0".into(),
            requires_pin: true,
        }
    }

    fn txt_of(ad: &Advertisement) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = ad.txt().into_iter().collect();
        move |key| map.get(key).cloned()
    }

    fn host(id: &str, name: &str, address: &str) -> DiscoveredHost {
        DiscoveredHost {
            host_id: id.into(),
            name: name.into(),
            addresses: vec![address.into()],
            protocol: PROTOCOL_VERSION,
            app_version: "1".into(),
            requires_pin: false,
            compatible: true,
        }
    }

    #[test]
    fn a_record_round_trips() {
        let ips = [IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))];
        let parsed = parse_record(txt_of(&ad()), &ips, 3040).unwrap();
        assert_eq!(parsed.host_id, "abcdef123456");
        assert_eq!(parsed.name, "PC del director");
        assert_eq!(parsed.addresses, vec!["192.168.1.20:3040"]);
        assert!(parsed.requires_pin);
        assert!(parsed.compatible);
    }

    #[test]
    fn ipv4_comes_first_and_loopback_is_dropped() {
        let ips = [
            IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
        ];
        let parsed = parse_record(txt_of(&ad()), &ips, 3041).unwrap();
        assert_eq!(parsed.addresses, vec!["10.0.0.5:3041", "[fe80::1]:3041"]);
    }

    #[test]
    fn foreign_or_broken_records_are_ignored() {
        let ips = [IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))];
        assert!(parse_record(|_| None, &ips, 3040).is_none());
        assert!(parse_record(txt_of(&ad()), &[], 3040).is_none());
        assert!(parse_record(txt_of(&ad()), &ips, 0).is_none());
        let bad_proto = |key: &str| {
            (key == "id")
                .then(|| "x".to_string())
                .or_else(|| (key == "proto").then(|| "nope".into()))
        };
        assert!(parse_record(bad_proto, &ips, 3040).is_none());
    }

    #[test]
    fn incompatible_host_is_listed_as_such() {
        let ips = [IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))];
        let newer = |key: &str| match key {
            "id" => Some("h".to_string()),
            "proto" => Some((PROTOCOL_VERSION + 5).to_string()),
            _ => None,
        };
        let parsed = parse_record(newer, &ips, 3040).unwrap();
        assert!(!parsed.compatible);
    }

    #[test]
    fn instance_names_stay_unique_for_same_named_devices() {
        let mut other = ad();
        other.host_id = "999999zzz".into();
        assert_ne!(ad().instance_name(), other.instance_name());
        assert_eq!(ad().instance_name(), "PC del director (abcdef)");
    }

    #[test]
    fn registry_dedupes_by_host_and_merges_addresses() {
        let mut registry = HostRegistry::new(None);
        assert!(registry.apply(DiscoveryEvent::Found {
            key: "a._t".into(),
            host: host("h1", "Ana", "192.168.1.5:3040"),
        }));
        assert!(registry.apply(DiscoveryEvent::Found {
            key: "a-wired._t".into(),
            host: host("h1", "Ana", "10.0.0.5:3040"),
        }));
        let list = registry.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].addresses, vec!["10.0.0.5:3040", "192.168.1.5:3040"]);
    }

    #[test]
    fn registry_drops_lost_hosts_and_ignores_itself() {
        let mut registry = HostRegistry::new(Some("me".into()));
        assert!(!registry.apply(DiscoveryEvent::Found {
            key: "me._t".into(),
            host: host("me", "Yo", "1.1.1.1:1"),
        }));
        registry.apply(DiscoveryEvent::Found {
            key: "b._t".into(),
            host: host("h2", "Luis", "1.1.1.2:1"),
        });
        assert!(registry.apply(DiscoveryEvent::Lost { key: "b._t".into() }));
        assert!(registry.list().is_empty());
        // Losing something unknown changes nothing.
        assert!(!registry.apply(DiscoveryEvent::Lost { key: "zzz".into() }));
    }

    #[test]
    fn same_answer_twice_is_not_a_change() {
        let mut registry = HostRegistry::new(None);
        let event = DiscoveryEvent::Found {
            key: "a._t".into(),
            host: host("h1", "Ana", "1.1.1.1:1"),
        };
        assert!(registry.apply(event.clone()));
        assert!(!registry.apply(event));
    }
}

/// Real multicast on this machine: not for CI (depends on the network and
/// the firewall). Run by hand: `cargo test -p libretracks-link --features
/// mdns -- --ignored mdns_finds_itself`.
#[cfg(all(test, feature = "mdns"))]
mod real_network {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    #[ignore]
    fn mdns_finds_itself() {
        let discovery = MdnsDiscovery::new().unwrap();
        let ad = Advertisement {
            host_id: "selftest0001".into(),
            name: "Prueba".into(),
            port: 3999,
            app_version: "test".into(),
            requires_pin: false,
        };
        discovery.advertise(&ad).unwrap();
        let (tx, rx) = mpsc::channel();
        discovery
            .browse(move |event| {
                let _ = tx.send(event);
            })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if let Ok(DiscoveryEvent::Found { host, .. }) =
                rx.recv_timeout(Duration::from_millis(200))
            {
                if host.host_id == "selftest0001" {
                    println!("found {:?}", host.addresses);
                    return;
                }
            }
        }
        panic!("did not see its own advertisement");
    }
}
