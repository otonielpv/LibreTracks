//! Network sessions: one LibreTracks app hosts, other LibreTracks apps join
//! it over the LAN with a role (viewer / controller / editor).
//!
//! This is deliberately NOT the remote (`libretracks-remote`, the browser
//! SPA). It has its own protocol, port and commands, and the two evolve
//! separately. Plan and design: `docs/plans/network-sessions/`.
//!
//! The host is the single source of truth: guests send [`LinkCommand`]s and
//! the host applies them with the same session functions its own UI uses.
//! Permissions are checked on the host for every incoming command
//! ([`permissions::is_allowed`]); the guest UI hiding buttons is a courtesy.

pub mod beacon;
pub mod client;
pub mod discovery;
pub mod net;
pub mod pairing;
pub mod permissions;
pub mod protocol;
pub mod server;
pub mod version;

/// WebSocket limits for both ends. tungstenite refuses frames over 16 MiB by
/// default and does not split what it sends, so a guest's first song view
/// WITH waveform peaks (tens of MB on a real session) dropped the connection
/// and the guest saw an empty session (iPhone, 2026-10-10).
pub fn websocket_config() -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(512 << 20);
    config.max_frame_size = Some(512 << 20);
    config
}

pub use client::{
    join, CommandError, GuestConfig, GuestEvent, GuestHandle, GuestRuntime, GuestState,
};
pub use pairing::TrustedDevice;
pub use permissions::{is_allowed, required_permission, Grants, Permission, Role};
pub use protocol::{
    ClientMessage, CommandRejection, LinkCommand, PeerInfo, RejectReason, ServerMessage,
};
pub use server::{
    random_hex, start_host, GuestSummary, HostConfig, HostHandle, HostRuntime, IncomingCommand,
};
pub use version::{negotiate, Incompatible, PROTOCOL_VERSION};
