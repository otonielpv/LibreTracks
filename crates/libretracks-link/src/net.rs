//! Small network helpers shared by host and guest.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// The address other devices on the LAN most likely reach this one at: the
/// source address the OS would use to leave the machine. Nothing is sent
/// (UDP `connect` only picks a route). None when there is no network.
pub fn local_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket
        .connect((Ipv4Addr::new(192, 168, 255, 255), 9))
        .ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Turn what the user typed or scanned into the `ws://` URL to join and the
/// `host:port` it names: `192.168.1.5`, `192.168.1.5:3041`, `[fe80::1]:3040`,
/// `ws://…`, or the QR's `libretracks://join?host=IP:PORT&name=…`. A missing
/// port means the default one. None for anything else.
pub fn parse_join_target(input: &str, default_port: u16) -> Option<(String, String)> {
    let input = input.trim();
    let address = if let Some(rest) = input.strip_prefix("libretracks://join?") {
        rest.split('&')
            .find_map(|pair| pair.strip_prefix("host="))?
            .to_string()
    } else if let Some(rest) = input.strip_prefix("ws://") {
        rest.trim_end_matches('/').to_string()
    } else {
        input.to_string()
    };
    if address.is_empty() || address.contains(char::is_whitespace) {
        return None;
    }

    let (host, port) = if let Some(rest) = address.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None if after.is_empty() => default_port,
            None => return None,
        };
        host.parse::<std::net::Ipv6Addr>().ok()?;
        (format!("[{host}]"), port)
    } else {
        match address.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.parse().ok()?),
            None => (address.clone(), default_port),
        }
    };
    if host.is_empty() || port == 0 {
        return None;
    }
    if !host.starts_with('[') && host.parse::<IpAddr>().is_err() {
        // Names are allowed (`pc-estudio.local`), but only sane ones.
        let valid = host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
        if !valid {
            return None;
        }
    }
    let host_port = format!("{host}:{port}");
    Some((format!("ws://{host_port}"), host_port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Option<String> {
        parse_join_target(input, 3040).map(|(url, _)| url)
    }

    #[test]
    fn plain_ipv4_with_and_without_port() {
        assert_eq!(parse("192.168.1.5"), Some("ws://192.168.1.5:3040".into()));
        assert_eq!(
            parse(" 192.168.1.5:3041 "),
            Some("ws://192.168.1.5:3041".into())
        );
    }

    #[test]
    fn ipv6_needs_brackets_for_a_port() {
        assert_eq!(parse("[fe80::1]:3042"), Some("ws://[fe80::1]:3042".into()));
        assert_eq!(parse("[fe80::1]"), Some("ws://[fe80::1]:3040".into()));
        assert_eq!(parse("[nope]:1"), None);
    }

    #[test]
    fn qr_link_and_ws_url() {
        assert_eq!(
            parse("libretracks://join?host=10.0.0.2:3040&name=PC%20Ana"),
            Some("ws://10.0.0.2:3040".into())
        );
        assert_eq!(
            parse("ws://10.0.0.2:3045/"),
            Some("ws://10.0.0.2:3045".into())
        );
    }

    #[test]
    fn host_names_are_allowed() {
        assert_eq!(
            parse("pc-estudio.local"),
            Some("ws://pc-estudio.local:3040".into())
        );
    }

    #[test]
    fn garbage_is_rejected() {
        for input in [
            "",
            "   ",
            "http://x y",
            "1.2.3.4:notaport",
            "1.2.3.4:0",
            "a b",
            "libretracks://join?name=x",
            "x/../y",
        ] {
            assert_eq!(parse(input), None, "{input}");
        }
    }
}
