//! Redundancy: a main LibreTracks and a backup that follows it
//! (docs/plans/redundancy). Desktop adapters around the pure pieces in
//! `libretracks-core` and the channel in `libretracks-link`.

pub mod failover;
pub mod fingerprint;
pub mod follower;
pub mod follower_runtime;
pub mod main_monitor;
pub mod mix;
pub mod pilot;
pub mod publisher;
pub mod remote_failover;
pub mod role;
pub mod settings;
pub mod status;
