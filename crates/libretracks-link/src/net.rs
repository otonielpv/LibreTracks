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
