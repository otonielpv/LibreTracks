//! What redundancy reads from the session (docs/plans/redundancy). Kept out
//! of `state/mod.rs`: only cheap clones taken under the session lock, the
//! work happens after it is released.

use std::path::PathBuf;

use libretracks_core::automation::AutomationCue;
use libretracks_core::Song;

use super::DesktopSession;

/// What the session fingerprint is computed from, cloned so the caller can
/// drop the lock before hashing.
pub struct FingerprintSource {
    pub song: Song,
    pub song_dir: Option<PathBuf>,
    pub automation_cues: Vec<AutomationCue>,
}

impl DesktopSession {
    pub fn fingerprint_source(&self) -> Option<FingerprintSource> {
        Some(FingerprintSource {
            song: self.engine.song()?.clone(),
            song_dir: self.song_dir.clone(),
            automation_cues: self.automation.cues.clone(),
        })
    }
}
