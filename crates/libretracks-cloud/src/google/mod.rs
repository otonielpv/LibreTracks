//! Google Drive backend.
//!
//! Uses the `drive.file` scope only. That scope grants access to the files this
//! app itself creates and nothing else — the rest of the user's Drive is
//! invisible to LibreTracks, enforced by Google rather than by our good
//! behaviour. It is also the reason the whole feature has no review gate:
//! `drive.file` is classified non-sensitive, so it needs neither OAuth
//! verification nor the paid CASA audit that the full `drive` scope triggers.
//!
//! Never widen this. Adding any second scope moves the app into the sensitive
//! tier and brings all of that back.

pub mod client_config;
pub mod drive;
pub mod oauth;

/// The one scope this app requests. See the module note before changing it.
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// Google's authorization endpoint (where the user's browser goes).
pub const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";

/// Where an authorization code is exchanged for tokens.
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

/// Where a token is revoked, for "Disconnect account".
///
/// Calling this is what makes disconnecting real rather than cosmetic: it tells
/// Google to drop the grant instead of merely forgetting the token locally.
/// App Store guideline 5.1.1(v) expects an in-app way to cut that access.
pub const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
