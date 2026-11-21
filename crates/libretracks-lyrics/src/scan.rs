//! «Buscar en la red»: find the lyrics program on the LAN so nobody has to
//! read IPs off another computer.
//!
//! Network sessions find hosts with mDNS plus a unicast UDP sweep of the /24
//! (`libretracks_link::probe`); those answer because they are LibreTracks.
//! ProPresenter, FreeShow and Holyrics do not speak that, so the equivalent
//! here is a TCP sweep of the same /24 (and this computer) on the program's
//! port, then one cheap HTTP request to each open port to tell whether it is
//! really that program. Plain unicast: works wherever the probe sweep works,
//! iOS included. Callers may add addresses found by other means (mDNS for
//! ProPresenter, whose port is not fixed) through `extra`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use libretracks_core::LyricsSoftware;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// A LAN host answers a connect in a few ms; past this, nothing is there.
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(600);
/// The identifying request (the program may be busy rendering).
pub const IDENTIFY_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Connects in flight at once. Desktop: one /24 per round on one port.
/// iOS starts an app with a soft limit of 256 open files (audio, the
/// session's sockets and the WebView already hold some), so mobile sweeps
/// in smaller rounds: about 4 × the connect timeout per port, still a few
/// seconds.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PARALLEL_CONNECTS: usize = 256;
#[cfg(any(target_os = "ios", target_os = "android"))]
const PARALLEL_CONNECTS: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundProgram {
    pub software: LyricsSoftware,
    /// What to type in «Equipo (IP)».
    pub host: String,
    pub port: u16,
    /// What it says it is ("ProPresenter 7.16"), or the program's name.
    pub label: String,
    /// It answered but wants the token (Holyrics) or the key (FreeShow).
    pub needs_token: bool,
    /// Running on this computer (reached through 127.0.0.1).
    pub this_device: bool,
}

/// Where to look: this computer first, then every address of `own`'s /24
/// (own included: a program bound only to the LAN address still shows up,
/// and the dedupe keeps the loopback entry).
pub fn sweep_hosts(own: Option<Ipv4Addr>) -> Vec<IpAddr> {
    let mut hosts = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    if let Some(own) = own {
        let [a, b, c, _] = own.octets();
        hosts.extend((1..=254u8).map(|host| IpAddr::V4(Ipv4Addr::new(a, b, c, host))));
    }
    hosts
}

/// The ports worth sweeping for a program: the one the user set, then the
/// program's out-of-the-box one, without repeats.
pub fn sweep_ports(software: LyricsSoftware, configured: Option<u16>) -> Vec<u16> {
    let mut ports = Vec::new();
    for port in [configured, default_sweep_port(software)].into_iter().flatten() {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

/// FreeShow and Holyrics have a fixed default. ProPresenter lets the user
/// pick one; 50001 is what the setup form suggests, so it is a good guess.
fn default_sweep_port(software: LyricsSoftware) -> Option<u16> {
    match software {
        LyricsSoftware::ProPresenter => Some(50001),
        other => libretracks_core::lyrics_config::default_port(other),
    }
}

/// Is this answer the program? `Some((label, needs_token))` if it is.
/// The request per program is in `identify`.
pub fn classify(software: LyricsSoftware, status: u16, body: &Value) -> Option<(String, bool)> {
    match software {
        // GET /version → {"name", "host_description", "api_version", …}.
        LyricsSoftware::ProPresenter => {
            if status != 200 {
                return None;
            }
            let object = body.as_object()?;
            if !object.contains_key("host_description") && !object.contains_key("api_version") {
                return None;
            }
            let label = object
                .get("host_description")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .unwrap_or("ProPresenter");
            Some((label.trim().to_string(), false))
        }
        // POST / {"action":"get_shows"} → the shows object, or 401/403
        // when a key is set.
        LyricsSoftware::FreeShow => match status {
            200..=299 if body.is_object() => Some(("FreeShow".into(), false)),
            401 | 403 => Some(("FreeShow".into(), true)),
            _ => None,
        },
        // POST /api/GetTokenInfo?token= → {"status":"ok"|"error", …}. With
        // no token it is an error, which still says "Holyrics is here".
        LyricsSoftware::Holyrics => {
            let state = body.get("status").and_then(Value::as_str);
            match (status, state) {
                (200..=299, Some("ok")) => {
                    let version = body
                        .pointer("/data/version")
                        .and_then(Value::as_str)
                        .map(|version| format!("Holyrics {version}"))
                        .unwrap_or_else(|| "Holyrics".into());
                    Some((version, false))
                }
                (_, Some("error")) | (401 | 403, _) => Some(("Holyrics".into(), true)),
                _ => None,
            }
        }
        LyricsSoftware::Unknown => None,
    }
}

fn url_host(host: IpAddr) -> String {
    match host {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    }
}

/// Ask one open port whether it is `software`.
pub async fn identify(
    client: &reqwest::Client,
    software: LyricsSoftware,
    host: IpAddr,
    port: u16,
) -> Option<FoundProgram> {
    let base = format!("http://{}:{port}", url_host(host));
    let request = match software {
        LyricsSoftware::ProPresenter => client.get(format!("{base}/version")),
        LyricsSoftware::FreeShow => client
            .post(format!("{base}/"))
            .json(&json!({ "action": "get_shows" })),
        LyricsSoftware::Holyrics => client
            .post(format!("{base}/api/GetTokenInfo?token="))
            .json(&json!({})),
        LyricsSoftware::Unknown => return None,
    };
    let exchange = async {
        let response = request.send().await.ok()?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.ok()?;
        Some((status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)))
    };
    let (status, body) = tokio::time::timeout(IDENTIFY_TIMEOUT, exchange).await.ok()??;
    let (label, needs_token) = classify(software, status, &body)?;
    Some(FoundProgram {
        software,
        host: host.to_string(),
        port,
        label,
        needs_token,
        this_device: host.is_loopback(),
    })
}

async fn is_open(address: SocketAddr) -> bool {
    matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await,
        Ok(Ok(_))
    )
}

/// Same program reached twice (127.0.0.1 and this computer's LAN address,
/// or by the sweep and by mDNS): keep one, this computer's loopback first,
/// then sort by address.
pub fn tidy(mut found: Vec<FoundProgram>, own: Option<IpAddr>) -> Vec<FoundProgram> {
    let own = own.map(|ip| ip.to_string());
    for entry in &mut found {
        if own.as_deref() == Some(entry.host.as_str()) {
            entry.this_device = true;
        }
    }
    found.sort_by(|a, b| {
        let ip = |entry: &FoundProgram| entry.host.parse::<IpAddr>().ok();
        b.this_device
            .cmp(&a.this_device)
            .then_with(|| {
                let a_loop = ip(a).is_some_and(|ip| ip.is_loopback());
                let b_loop = ip(b).is_some_and(|ip| ip.is_loopback());
                b_loop.cmp(&a_loop)
            })
            .then_with(|| ip(a).cmp(&ip(b)))
            .then_with(|| a.port.cmp(&b.port))
    });
    let mut kept: Vec<FoundProgram> = Vec::new();
    for entry in found {
        let duplicate = kept.iter().any(|seen| {
            seen.port == entry.port
                && (seen.host == entry.host || (seen.this_device && entry.this_device))
        });
        if !duplicate {
            kept.push(entry);
        }
    }
    kept
}

/// Sweep `hosts` × `ports`, plus the `extra` addresses, and return what
/// turned out to be `software`. Takes about one connect timeout per port
/// and per 256 addresses.
pub async fn scan(
    software: LyricsSoftware,
    hosts: Vec<IpAddr>,
    ports: Vec<u16>,
    extra: Vec<(IpAddr, u16)>,
    own: Option<IpAddr>,
) -> Vec<FoundProgram> {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .no_proxy()
        .build()
    else {
        return Vec::new();
    };
    let mut targets: Vec<(IpAddr, u16)> = Vec::new();
    for port in &ports {
        for host in &hosts {
            targets.push((*host, *port));
        }
    }
    for target in extra {
        if !targets.contains(&target) {
            targets.push(target);
        }
    }

    let gate = Arc::new(Semaphore::new(PARALLEL_CONNECTS));
    let mut tasks = JoinSet::new();
    for (host, port) in targets {
        let gate = Arc::clone(&gate);
        let client = client.clone();
        tasks.spawn(async move {
            let open = {
                let _permit = gate.acquire_owned().await.ok()?;
                is_open(SocketAddr::new(host, port)).await
            };
            if !open {
                return None;
            }
            identify(&client, software, host, port).await
        });
    }
    let mut found = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(Some(program)) = result {
            found.push(program);
        }
    }
    tidy(found, own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweeps_this_computer_first_then_the_whole_slash_24() {
        let hosts = sweep_hosts(Some(Ipv4Addr::new(192, 168, 1, 37)));
        assert_eq!(hosts[0], IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(hosts.len(), 255);
        assert!(hosts.contains(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 37))));
        assert!(hosts.contains(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 254))));
        assert!(!hosts.contains(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 0))));
        assert_eq!(sweep_hosts(None), vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
    }

    #[test]
    fn ports_are_the_configured_one_then_the_default() {
        assert_eq!(sweep_ports(LyricsSoftware::FreeShow, None), vec![5506]);
        assert_eq!(sweep_ports(LyricsSoftware::Holyrics, Some(8091)), vec![8091]);
        assert_eq!(sweep_ports(LyricsSoftware::Holyrics, Some(9000)), vec![9000, 8091]);
        assert_eq!(sweep_ports(LyricsSoftware::ProPresenter, Some(1025)), vec![1025, 50001]);
    }

    #[test]
    fn propresenter_is_told_by_its_version_document() {
        let body = json!({"name": "FOH", "host_description": "ProPresenter 7.16", "api_version": "v1"});
        assert_eq!(
            classify(LyricsSoftware::ProPresenter, 200, &body),
            Some(("ProPresenter 7.16".into(), false))
        );
        // Some other web server on that port.
        assert_eq!(classify(LyricsSoftware::ProPresenter, 200, &json!({"ok": true})), None);
        assert_eq!(classify(LyricsSoftware::ProPresenter, 404, &body), None);
        assert_eq!(classify(LyricsSoftware::ProPresenter, 200, &Value::Null), None);
    }

    #[test]
    fn freeshow_with_a_key_still_counts() {
        assert_eq!(
            classify(LyricsSoftware::FreeShow, 200, &json!({"abc": {"name": "Song"}})),
            Some(("FreeShow".into(), false))
        );
        assert_eq!(
            classify(LyricsSoftware::FreeShow, 401, &Value::Null),
            Some(("FreeShow".into(), true))
        );
        assert_eq!(classify(LyricsSoftware::FreeShow, 200, &Value::String("<html>".into())), None);
        assert_eq!(classify(LyricsSoftware::FreeShow, 500, &json!({})), None);
    }

    #[test]
    fn holyrics_without_a_token_answers_an_error_and_counts() {
        assert_eq!(
            classify(LyricsSoftware::Holyrics, 200, &json!({"status": "error", "error": "invalid token"})),
            Some(("Holyrics".into(), true))
        );
        assert_eq!(
            classify(LyricsSoftware::Holyrics, 200, &json!({"status": "ok", "data": {"version": "2.30.0"}})),
            Some(("Holyrics 2.30.0".into(), false))
        );
        assert_eq!(classify(LyricsSoftware::Holyrics, 200, &json!({"other": 1})), None);
    }

    fn found(host: &str, port: u16) -> FoundProgram {
        FoundProgram {
            software: LyricsSoftware::FreeShow,
            host: host.into(),
            port,
            label: "FreeShow".into(),
            needs_token: false,
            this_device: host == "127.0.0.1",
        }
    }

    #[test]
    fn this_computer_reached_twice_is_listed_once_as_loopback_first() {
        let own: IpAddr = "192.168.1.37".parse().unwrap();
        let list = tidy(
            vec![found("192.168.1.50", 5506), found("192.168.1.37", 5506), found("127.0.0.1", 5506), found("192.168.1.9", 5506)],
            Some(own),
        );
        let hosts: Vec<&str> = list.iter().map(|entry| entry.host.as_str()).collect();
        assert_eq!(hosts, vec!["127.0.0.1", "192.168.1.9", "192.168.1.50"]);
        assert!(list[0].this_device);
        assert!(!list[1].this_device);
    }
}
