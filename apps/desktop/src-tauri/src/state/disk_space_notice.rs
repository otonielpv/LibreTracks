//! «No queda espacio en disco para preparar el audio».
//!
//! When the PCM cache volume cannot take a conversion, the engine fails that
//! source with an error tagged `LT_DISK_FULL needs_mb=N free_mb=M` (see
//! `disk_shortfall_message` in source_manager). Those tracks play silence; the
//! only trace used to be a line per track in errors.log. The audio preparation
//! loops call [`emit_disk_space_notice_once`] so the user hears about it once,
//! with how much space it takes.

use lt_audio_engine_v2::SourcePreparationInfo;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) const DISK_SPACE_LOW_EVENT: &str = "audio:disk-space-low";
const DISK_FULL_TAG: &str = "LT_DISK_FULL";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiskSpaceLowPayload {
    /// Sources that could not be prepared for lack of space.
    pub failed_sources: usize,
    /// What those conversions would take, added up.
    pub needed_mb: u64,
    /// Free space on the cache volume, as last measured by the engine.
    pub free_mb: u64,
}

fn field(message: &str, key: &str) -> Option<u64> {
    message
        .split_whitespace()
        .find_map(|word| word.trim_end_matches(':').strip_prefix(key))
        .and_then(|value| value.parse().ok())
}

/// The sources that failed for lack of disk space, summed up; `None` if none.
pub(crate) fn disk_space_shortfall(states: &[SourcePreparationInfo]) -> Option<DiskSpaceLowPayload> {
    let mut payload = DiskSpaceLowPayload {
        failed_sources: 0,
        needed_mb: 0,
        free_mb: u64::MAX,
    };
    for source in states {
        if source.status != "failed" || !source.error_message.starts_with(DISK_FULL_TAG) {
            continue;
        }
        payload.failed_sources += 1;
        payload.needed_mb += field(&source.error_message, "needs_mb=").unwrap_or(0);
        if let Some(free) = field(&source.error_message, "free_mb=") {
            payload.free_mb = payload.free_mb.min(free);
        }
    }
    if payload.failed_sources == 0 {
        return None;
    }
    if payload.free_mb == u64::MAX {
        payload.free_mb = 0;
    }
    Some(payload)
}

/// Emit the warning the first time a preparation loop sees such a failure.
/// `sent` lives in the loop, so each open or import warns at most once.
pub(crate) fn emit_disk_space_notice_once(
    app: &AppHandle,
    states: &[SourcePreparationInfo],
    sent: &mut bool,
) {
    if *sent {
        return;
    }
    if let Some(payload) = disk_space_shortfall(states) {
        *sent = true;
        let _ = app.emit(DISK_SPACE_LOW_EVENT, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(status: &str, error: &str) -> SourcePreparationInfo {
        SourcePreparationInfo {
            source_id: "s".into(),
            status: status.into(),
            error_message: error.into(),
            ..Default::default()
        }
    }

    #[test]
    fn adds_up_the_sources_that_failed_for_lack_of_space() {
        let states = [
            source("ready", ""),
            source("failed", "LT_DISK_FULL needs_mb=300 free_mb=700: not enough disk space"),
            source("failed", "LT_DISK_FULL needs_mb=250 free_mb=650: not enough disk space"),
            source("failed", "sndfile: System error"),
        ];
        assert_eq!(
            disk_space_shortfall(&states),
            Some(DiskSpaceLowPayload {
                failed_sources: 2,
                needed_mb: 550,
                free_mb: 650,
            })
        );
    }

    #[test]
    fn other_failures_do_not_warn_about_the_disk() {
        let states = [
            source("failed", "sndfile: System error : El sistema no puede encontrar la ruta"),
            source("loading", ""),
        ];
        assert_eq!(disk_space_shortfall(&states), None);
    }
}
