//! "Bring the videos too?" (plan `video-mobile`, paso 08): the question a
//! phone asks before writing gigabytes of video, and its default answer.
//!
//! The question is asked from the worker thread that is about to extract a
//! package or copy picked videos — never from the UI thread. It emits
//! `video:import-question` and waits for `answer_video_import_question`. With
//! no answer (no window listening, or the user gone for ten minutes), the
//! default applies: bring them only if they fit with a margin.
//!
//! The decision and the waiting are here, compiled everywhere and tested; the
//! texts are the frontend's (`videoImportQuestion.ts`).

// Used by the phone builds; compiled everywhere so the desktop tests cover it.
#![cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

/// Free space that must remain after the videos (paso 08 §1).
pub const VIDEO_IMPORT_MARGIN_BYTES: u64 = 1024 * 1024 * 1024;

/// How long the worker waits for the user before applying the default.
pub const QUESTION_TIMEOUT: Duration = Duration::from_secs(600);

/// Why the question is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoImportSource {
    /// A `.ltset` / `.ltpkg` (also what a Drive download ends in).
    Package,
    /// Videos picked on the device, to copy into the session.
    Device,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoImportQuestion {
    pub request_id: u64,
    pub source: VideoImportSource,
    pub count: usize,
    pub bytes: u64,
    /// `None` when the system would not say.
    pub free_bytes: Option<u64>,
    /// They fit with the margin; when false the frontend disables "bring".
    pub fits: bool,
    pub default_include: bool,
}

/// Whether `bytes` of video fit in `free_bytes` with the margin. Unknown
/// free space counts as fitting: the extraction itself still refuses a set
/// that does not fit (`check_space_for_extraction`).
pub fn videos_fit(bytes: u64, free_bytes: Option<u64>) -> bool {
    free_bytes.is_none_or(|free| free >= bytes.saturating_add(VIDEO_IMPORT_MARGIN_BYTES))
}

pub fn question(
    request_id: u64,
    source: VideoImportSource,
    count: usize,
    bytes: u64,
    free_bytes: Option<u64>,
) -> VideoImportQuestion {
    let fits = videos_fit(bytes, free_bytes);
    VideoImportQuestion {
        request_id,
        source,
        count,
        bytes,
        free_bytes,
        fits,
        default_include: fits,
    }
}

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static PENDING: OnceLock<Mutex<Option<(u64, Sender<bool>)>>> = OnceLock::new();

fn pending() -> &'static Mutex<Option<(u64, Sender<bool>)>> {
    PENDING.get_or_init(|| Mutex::new(None))
}

/// Ask and wait. `emit` shows the question (the Tauri event); returns
/// whether to bring the videos. Never brings what does not fit, whatever the
/// answer says.
pub fn ask(
    source: VideoImportSource,
    count: usize,
    bytes: u64,
    free_bytes: Option<u64>,
    timeout: Duration,
    emit: impl FnOnce(&VideoImportQuestion) -> bool,
) -> bool {
    let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let asked = question(request_id, source, count, bytes, free_bytes);
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut slot) = pending().lock() {
        *slot = Some((request_id, sender));
    }
    let answer = if emit(&asked) {
        receiver.recv_timeout(timeout).ok()
    } else {
        None
    };
    if let Ok(mut slot) = pending().lock() {
        if slot.as_ref().is_some_and(|(id, _)| *id == request_id) {
            *slot = None;
        }
    }
    answer.unwrap_or(asked.default_include) && asked.fits
}

/// [`ask`] through the app: the question goes out as `video:import-question`.
pub fn ask_from_app(
    app: &tauri::AppHandle,
    source: VideoImportSource,
    count: usize,
    bytes: u64,
    free_bytes: Option<u64>,
) -> bool {
    use tauri::Emitter;
    ask(
        source,
        count,
        bytes,
        free_bytes,
        QUESTION_TIMEOUT,
        |question| app.emit("video:import-question", question).is_ok(),
    )
}

/// The user's answer to `request_id`. False if nothing is waiting for it.
pub fn answer(request_id: u64, include: bool) -> bool {
    let Ok(mut slot) = pending().lock() else {
        return false;
    };
    match slot.take() {
        Some((id, sender)) if id == request_id => sender.send(include).is_ok(),
        other => {
            *slot = other;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    /// The pending question is process-wide: the tests that ask take turns.
    static ASKING: Mutex<()> = Mutex::new(());

    /// Paso 08 C2 (the Rust half; the texts are tested in the frontend).
    #[test]
    fn videos_that_fit_with_a_margin_are_brought_by_default() {
        let asked = question(1, VideoImportSource::Package, 3, 2 * GB, Some(11 * GB));
        assert!(asked.fits && asked.default_include);
    }

    #[test]
    fn videos_that_do_not_fit_with_the_margin_are_left_out_and_cannot_be_chosen() {
        // 2.4 GB of video and 3 GB free: fits on disk, not with 1 GB spare.
        let asked = question(
            1,
            VideoImportSource::Package,
            3,
            2 * GB + GB / 2,
            Some(3 * GB),
        );
        assert!(!asked.fits && !asked.default_include);
    }

    #[test]
    fn unknown_free_space_does_not_block_the_videos() {
        assert!(videos_fit(5 * GB, None));
    }

    #[test]
    fn the_answer_reaches_the_waiting_import() {
        let _turn = ASKING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // `emit` runs once the question is registered: it hands the id over,
        // so the answer can never race the registration.
        let (asked, ids) = std::sync::mpsc::channel();
        let include = std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                ask(
                    VideoImportSource::Package,
                    1,
                    10,
                    Some(10 * GB),
                    Duration::from_secs(30),
                    |question| asked.send(question.request_id).is_ok(),
                )
            });
            let id = ids.recv().expect("the question was asked");
            assert!(answer(id, false));
            worker.join().unwrap()
        });
        assert!(!include, "the user said no");
    }

    #[test]
    fn without_a_window_to_ask_the_default_applies() {
        let _turn = ASKING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(ask(
            VideoImportSource::Device,
            1,
            10,
            Some(10 * GB),
            Duration::ZERO,
            |_| false
        ));
        assert!(!ask(
            VideoImportSource::Device,
            1,
            10 * GB,
            Some(10 * GB),
            Duration::ZERO,
            |_| false
        ));
    }

    #[test]
    fn a_stale_answer_is_ignored() {
        let _turn = ASKING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!answer(u64::MAX, true));
    }
}
