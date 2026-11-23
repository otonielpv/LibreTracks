//! Planning Center Services, the first source of the smart chart import.
//!
//! What this crate does, and only this: sign the user in to their own
//! Planning Center account (OAuth 2 with PKCE, no client secret, through
//! `libretracks-cloud`), read songs, arrangements and plans, and, only when
//! the user presses "Save to Planning Center", create an arrangement or
//! replace one's chart and sequence. It returns the raw attributes: turning a
//! `chord_chart` into ChordPro and matching it to the song's markers happens
//! in `@libretracks/shared/charts`, so every source shares it.
//!
//! `/arrangements/{id}/sections` is never used: the real API merges sections
//! and drops the played ones (see `docs/plans/smart-chart-import/spike-results.md`).

pub mod client;
pub mod error;
pub mod model;
pub mod oauth;

pub use client::{PcoClient, PcoTokens};
pub use error::PcoError;
pub use model::*;
pub use oauth::{is_configured, PlanningCenterOAuth};
