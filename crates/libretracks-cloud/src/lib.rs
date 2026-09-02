//! Almacenamiento en la nube para mover sesiones entre los dispositivos de un
//! mismo usuario.
//!
//! # What this is, and what it deliberately is not
//!
//! LibreTracks never hosts anything. The files land in an account the *user*
//! owns (their Google Drive today), reached with a token that lives only on
//! their device. There is no LibreTracks account, no server of ours in the
//! path, and nothing of theirs on our infrastructure. That is a product
//! decision as much as a technical one: hosting third-party recordings turns a
//! side project into a service with moderation and takedown duties, and it was
//! ruled out on purpose.
//!
//! It is also **not a sync engine**. There is no background reconciliation, no
//! conflict resolution, no partial folder diffing. The user explicitly uploads
//! a package or explicitly downloads one, and always knows which. Bidirectional
//! sync is a project that never ends; two buttons are a feature that ships.
//!
//! # Why a crate instead of a module in the desktop app
//!
//! Two reasons. The provider is expected to change — Drive's 15 GB is shared
//! with Gmail, so a second backend (pCloud, or a generic S3-compatible one that
//! covers B2/R2/Wasabi at once) is a question of when, not if. And the desktop
//! crate cannot be unit-tested (`cargo test -p libretracks-desktop` fails to
//! link), so anything that wants tests has to live outside it.

pub mod google;
pub mod keychain;
pub mod loopback;
pub mod pkce;
pub mod token;

use std::path::Path;

use async_trait::async_trait;

/// A file as it exists in the user's cloud account.
///
/// Intentionally minimal: everything a provider cannot supply for free stays
/// out, so the shape survives the second and third implementations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// Provider-assigned identifier. Opaque — never parse it, never build one.
    pub id: String,
    /// File name as shown to the user, e.g. `Domingo 12.ltset`.
    pub name: String,
    pub size_bytes: u64,
    /// RFC 3339 timestamp of the last modification, when the provider reports
    /// one. Used only for ordering and display, never for merge decisions —
    /// this is not a sync engine and clock skew between devices is real.
    pub modified: Option<String>,
}

/// How full the user's account is.
///
/// Checked *before* an upload starts. A 2 GB `.ltset` over a phone connection
/// is a long, expensive operation, and discovering it does not fit after forty
/// minutes is the difference between a rough edge and an unusable feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quota {
    pub used_bytes: u64,
    /// `None` when the account has no enforced ceiling (some business plans).
    pub limit_bytes: Option<u64>,
}

impl Quota {
    /// Free space, or `None` for an unlimited account.
    pub fn free_bytes(&self) -> Option<u64> {
        self.limit_bytes
            .map(|limit| limit.saturating_sub(self.used_bytes))
    }

    /// Whether `needed` bytes fit. Unlimited accounts always fit.
    pub fn fits(&self, needed: u64) -> bool {
        self.free_bytes().is_none_or(|free| free >= needed)
    }
}

/// Which of the two package kinds a file is, and therefore where it lives.
///
/// The cloud layout mirrors the two package formats the app already has, so
/// nothing new has to be invented and a user browsing their Drive recognises
/// what they are looking at:
///
/// ```text
/// Drive/
/// └── LibreTracks/
///     ├── Songs/      .ltpkg  (one song)
///     └── Sessions/   .ltset  (a whole session)
/// ```
///
/// Templates (`.lttemplate`) are deliberately absent: they are kilobytes, and
/// mixing them into the session list makes that list harder to read for no
/// gain. Adding a third variant later is additive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteFolder {
    Songs,
    Sessions,
}

impl RemoteFolder {
    /// The single container everything lives under, so the user has one thing
    /// to find, move, or delete in their Drive rather than two loose folders.
    pub const ROOT_NAME: &'static str = "LibreTracks";

    pub fn folder_name(self) -> &'static str {
        match self {
            RemoteFolder::Songs => "Songs",
            RemoteFolder::Sessions => "Sessions",
        }
    }

    /// Extension of the packages kept here, including the dot.
    pub fn extension(self) -> &'static str {
        match self {
            RemoteFolder::Songs => ".ltpkg",
            RemoteFolder::Sessions => ".ltset",
        }
    }

    /// Which folder a local file belongs in, by extension.
    ///
    /// `None` for anything else: the upload paths refuse files they cannot
    /// place rather than guessing and filing a session under Songs.
    pub fn for_path(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_str()?.to_ascii_lowercase();
        if name.ends_with(".ltpkg") {
            Some(RemoteFolder::Songs)
        } else if name.ends_with(".ltset") {
            Some(RemoteFolder::Sessions)
        } else {
            None
        }
    }
}

/// Progress reporter for transfers: `(done_bytes, total_bytes)`.
///
/// Called from the transfer task, so it must be cheap and must not block. The
/// desktop app forwards these to a Tauri event, the same shape the ambient-pad
/// downloader already uses.
pub type ProgressFn = dyn Fn(u64, u64) + Send + Sync;
/// Returns true once the caller has asked the active transfer to stop.
pub type CancelFn = dyn Fn() -> bool + Send + Sync;

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    /// No usable token: never connected, the user revoked access, or the
    /// refresh token died (password change, six months unused). Callers must
    /// treat this as "ask the user to connect again", never as a hard failure —
    /// it is expected to happen occasionally over an install's lifetime.
    #[error("the account is not connected")]
    NotConnected,

    /// The upload does not fit in the account. Carries the numbers so the UI
    /// can say how much is missing instead of just refusing.
    #[error("not enough space: {needed} bytes needed, {free} free")]
    QuotaExceeded { needed: u64, free: u64 },

    #[error("network error: {0}")]
    Network(String),

    /// The provider answered, but with something we did not expect. Keeps the
    /// raw body: these are the failures that are impossible to diagnose from a
    /// user's bug report otherwise.
    #[error("{provider} returned HTTP {status}: {body}")]
    Provider {
        provider: &'static str,
        status: u16,
        body: String,
    },

    #[error("local file error: {0}")]
    Io(#[from] std::io::Error),

    #[error("the transfer was cancelled")]
    Cancelled,
}

/// One cloud provider.
///
/// Google Drive is the first implementation. The trait exists so the second one
/// is a new file rather than a rewrite — the same reasoning that made the
/// ambient-pad manifest host-agnostic.
#[async_trait]
pub trait CloudStorage: Send + Sync {
    /// Human name of the provider, for UI and error messages.
    fn provider_name(&self) -> &'static str;

    /// Packages this app has put in the account, newest first.
    ///
    /// Scoped to what LibreTracks itself created: with Drive's `drive.file`
    /// scope that is enforced by Google, not merely by convention, so the app
    /// cannot see the rest of the user's files even if it tried.
    async fn list(&self, folder: RemoteFolder) -> Result<Vec<RemoteFile>, CloudError>;

    async fn quota(&self) -> Result<Quota, CloudError>;

    /// Upload `local_path`, resuming across network interruptions.
    ///
    /// Resumability is not optional here: the files are `.ltset` packages that
    /// routinely reach a gigabyte, and the common case is a phone on mobile
    /// data. An upload that cannot resume is an upload that never finishes.
    async fn upload(
        &self,
        folder: RemoteFolder,
        local_path: &Path,
        remote_name: &str,
        progress: &ProgressFn,
        cancelled: &CancelFn,
    ) -> Result<RemoteFile, CloudError>;

    async fn download(
        &self,
        file_id: &str,
        dest_path: &Path,
        progress: &ProgressFn,
        cancelled: &CancelFn,
    ) -> Result<(), CloudError>;

    async fn delete(&self, file_id: &str) -> Result<(), CloudError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_reports_free_space() {
        let q = Quota {
            used_bytes: 6_000_000_000,
            limit_bytes: Some(15_000_000_000),
        };
        assert_eq!(q.free_bytes(), Some(9_000_000_000));
        assert!(q.fits(9_000_000_000));
        assert!(!q.fits(9_000_000_001));
    }

    #[test]
    fn overfull_account_reports_zero_not_underflow() {
        // Drive counts Gmail and Photos against the same 15 GB, so an account
        // can legitimately report more used than its limit. Saturating here
        // keeps that from wrapping into "almost unlimited free space".
        let q = Quota {
            used_bytes: 16_000_000_000,
            limit_bytes: Some(15_000_000_000),
        };
        assert_eq!(q.free_bytes(), Some(0));
        assert!(!q.fits(1));
    }

    #[test]
    fn unlimited_account_always_fits() {
        let q = Quota {
            used_bytes: 900_000_000_000,
            limit_bytes: None,
        };
        assert_eq!(q.free_bytes(), None);
        assert!(q.fits(u64::MAX));
    }

    #[test]
    fn folders_map_to_the_existing_package_formats() {
        assert_eq!(RemoteFolder::Songs.folder_name(), "Songs");
        assert_eq!(RemoteFolder::Songs.extension(), ".ltpkg");
        assert_eq!(RemoteFolder::Sessions.folder_name(), "Sessions");
        assert_eq!(RemoteFolder::Sessions.extension(), ".ltset");
    }

    #[test]
    fn a_local_file_is_routed_by_extension() {
        use std::path::PathBuf;
        assert_eq!(
            RemoteFolder::for_path(&PathBuf::from("/x/Domingo 12.ltset")),
            Some(RemoteFolder::Sessions)
        );
        assert_eq!(
            RemoteFolder::for_path(&PathBuf::from("/x/Cancion.ltpkg")),
            Some(RemoteFolder::Songs)
        );
    }

    #[test]
    fn routing_ignores_case_and_refuses_anything_else() {
        use std::path::PathBuf;
        // Windows and case-insensitive volumes hand back whatever case the
        // user typed, so an upper-case extension must not fall through to the
        // "cannot place this" branch.
        assert_eq!(
            RemoteFolder::for_path(&PathBuf::from("/x/SET.LTSET")),
            Some(RemoteFolder::Sessions)
        );
        assert_eq!(
            RemoteFolder::for_path(&PathBuf::from("/x/notes.txt")),
            None
        );
        assert_eq!(
            RemoteFolder::for_path(&PathBuf::from("/x/plantilla.lttemplate")),
            None
        );
    }
}
