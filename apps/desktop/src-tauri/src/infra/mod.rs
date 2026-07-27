//! Cross-cutting infrastructure: the desktop `DesktopError` type (`error`), the
//! dedicated application error log + panic hook (`error_log`), the persisted
//! application settings model (`settings`), and opt-in timing instrumentation
//! for the waveform request path (`waveform_diag`).

pub mod error;
pub mod error_log;
pub mod settings;
pub mod waveform_diag;
