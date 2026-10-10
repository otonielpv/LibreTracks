//! Prints raw mDNS events for the network-session service type. Manual
//! diagnosis only: `cargo run -p libretracks-link --features mdns --example
//! mdns_probe [advertise]`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceInfo};

fn main() {
    let daemon = ServiceDaemon::new().expect("daemon");
    if std::env::args().any(|arg| arg == "advertise") {
        let mut props = HashMap::new();
        props.insert("id".to_string(), "probe123".to_string());
        props.insert("proto".to_string(), "1".to_string());
        let info = ServiceInfo::new(
            libretracks_link::discovery::SERVICE_TYPE,
            "Probe",
            "libretracks-probe.local.",
            "",
            3999,
            props,
        )
        .expect("info")
        .enable_addr_auto();
        daemon.register(info).expect("register");
        println!("advertising");
    }
    let receiver = daemon
        .browse(libretracks_link::discovery::SERVICE_TYPE)
        .expect("browse");
    let end = Instant::now() + Duration::from_secs(8);
    while Instant::now() < end {
        if let Ok(event) = receiver.recv_timeout(Duration::from_millis(250)) {
            println!("{event:?}");
        }
    }
}
