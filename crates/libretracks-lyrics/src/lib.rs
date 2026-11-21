//! Lyrics sync with ProPresenter, FreeShow and Holyrics over their local
//! HTTP APIs (plan `lyrics-sync`, docs/plans/lyrics-sync/00-DISENO.md).
//!
//! - [`structure`]: each program's presentation read as one shape.
//! - [`plan`]: a song's concrete orders, built once, never resolved live.
//! - [`gate`]: who sends (main, backup, guest).
//! - [`worker`]: events → orders, coalesced, off the MIDI thread.
//! - [`clients`]: the three HTTP clients behind [`clients::LyricsClient`].
//!
//! No Tauri here: the tests run in CI. The desktop runtime owns the worker.

pub mod clients;
pub mod gate;
pub mod plan;
pub mod report;
pub mod scan;
pub mod structure;
pub mod thumbs;
pub mod worker;

use serde::Serialize;

/// Why an order or a query to the lyrics program failed, in terms the UI can
/// explain.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LyricsError {
    /// Nothing answers at that address (program closed, wrong IP or port,
    /// firewall).
    #[error("no se puede conectar: {detail}")]
    Unreachable { detail: String },
    /// It took longer than the timeout.
    #[error("el programa no respondió a tiempo")]
    Timeout,
    /// The token is wrong or lacks permissions; `missing` lists the actions
    /// to allow (Holyrics).
    #[error("sin permiso: {missing:?}")]
    Unauthorized { missing: Vec<String> },
    /// The presentation or group does not exist there.
    #[error("no encontrado: {what}")]
    NotFound { what: String },
    #[error("{detail}")]
    Unexpected { detail: String },
}

impl LyricsError {
    pub(crate) fn unexpected(detail: impl Into<String>) -> Self {
        Self::Unexpected {
            detail: detail.into(),
        }
    }
}
