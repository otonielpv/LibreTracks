//! Cross-cutting infrastructure: the desktop `DesktopError` type (`error`), the
//! dedicated application error log + panic hook (`error_log`), and the persisted
//! application settings model (`settings`).

pub mod error;
pub mod error_log;
pub mod settings;
