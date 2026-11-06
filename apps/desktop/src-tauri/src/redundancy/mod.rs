//! Redundancy: a main LibreTracks and a backup that follows it
//! (docs/plans/redundancy). Desktop adapters around the pure pieces in
//! `libretracks-core` and the channel in `libretracks-link`.

pub mod fingerprint;
pub mod follower;
pub mod follower_runtime;
pub mod publisher;
pub mod role;
