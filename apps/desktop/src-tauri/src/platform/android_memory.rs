//! Reacting to Android's memory-pressure warnings.
//!
//! Android tells an app that memory is short before it kills it. LibreTracks
//! used to ignore that: during the import of a 2 GB `.ltset` on an Oppo
//! CPH1931, the system killed ~40 other processes to keep us alive and then
//! restarted `system_server`. We were never asked politely — we were, and we
//! didn't answer. See docs/plans/android-low-end/00-DIAGNOSTICO.md.
//!
//! The Kotlin side (`MainActivity.onTrimMemory`) calls straight into
//! [`Java_com_libretracks_desktop_MainActivity_nativeOnTrimMemory`] via JNI.
//! Deliberately NOT routed through the WebView: under real pressure the
//! WebView process is itself a kill candidate, and a warning we cannot receive
//! is worse than useless.
//!
//! **The one rule: never stop playback.** A performer on stage would rather
//! hear a glitch than silence, so the block cache always keeps each source's
//! read-ahead window (see `BlockCache::release_unprotected`).

#![cfg(target_os = "android")]

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the system recently told us memory was short.
///
/// Exposed for diagnostics and for future callers that want to defer optional
/// work. It deliberately does NOT gate the engine's in-flight preparation
/// queue: suspending `SourcePreparationQueue`'s workers is a change to the
/// decode hot path and deserves its own measurement, not a rider on a
/// memory-pressure fix. The cache release below is what actually hands memory
/// back, and it is measurable today.

/// Levels from android.content.ComponentCallbacks2.
const TRIM_MEMORY_COMPLETE: i32 = 80;
const TRIM_MEMORY_MODERATE: i32 = 60;
const TRIM_MEMORY_BACKGROUND: i32 = 40;
const TRIM_MEMORY_UI_HIDDEN: i32 = 20;
const TRIM_MEMORY_RUNNING_CRITICAL: i32 = 15;
const TRIM_MEMORY_RUNNING_LOW: i32 = 10;
const TRIM_MEMORY_RUNNING_MODERATE: i32 = 5;

/// Set while the engine should hold off on preparing sources it has not been
/// asked for yet. Read by the preparation path; cleared when pressure eases.
static PREPARATION_PAUSED: AtomicBool = AtomicBool::new(false);

#[allow(dead_code)] // diagnostics + future deferral points
pub fn under_memory_pressure() -> bool {
    PREPARATION_PAUSED.load(Ordering::Relaxed)
}

/// Clear the flag once pressure has passed, so a session opened after a
/// warning does not stay marked as pressured forever.
pub fn resume_preparation_after_pressure() {
    PREPARATION_PAUSED.store(false, Ordering::Relaxed);
}

/// What to do about a given trim level.
///
/// Split from the JNI entry point so the policy is testable without a JVM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrimResponse {
    /// Blocks to keep per source. `None` means "do nothing at all".
    pub keep_per_source: Option<u32>,
    pub pause_preparation: bool,
}

pub fn plan_trim_response(level: i32, playing: bool) -> TrimResponse {
    // While the transport runs we always keep a read-ahead window, whatever
    // the system is asking for: going silent mid-song is not a trade we make.
    let floor = if playing { 16 } else { 0 };

    // Order matters and the constants are NOT ordered by severity: MODERATE is
    // 60, above BACKGROUND's 40, but it is the *milder* warning of the two
    // (the 40/60/80 family describes how deep in the LRU we sit while
    // backgrounded, while 5/10/15 are the running-app warnings). Match the
    // exact levels first; only then fall back to a range.
    match level {
        // Running-app warnings, mildest first.
        //
        // A mild hint is noted but not acted on: flushing a cache we would
        // immediately pay to refill costs more than it saves.
        TRIM_MEMORY_RUNNING_MODERATE => TrimResponse {
            keep_per_source: None,
            pause_preparation: false,
        },
        TRIM_MEMORY_RUNNING_LOW => TrimResponse {
            keep_per_source: Some(floor.max(32)),
            pause_preparation: false,
        },
        // "Release what you can or you're next." Everything but the window.
        TRIM_MEMORY_RUNNING_CRITICAL => TrimResponse {
            keep_per_source: Some(floor.max(8)),
            pause_preparation: true,
        },

        // Backgrounded warnings. The UI is gone, so the cache only still earns
        // its keep if the transport is running — which it can be, with the
        // screen off, via the foreground service.
        TRIM_MEMORY_UI_HIDDEN => TrimResponse {
            keep_per_source: Some(floor.max(8)),
            pause_preparation: true,
        },
        TRIM_MEMORY_MODERATE => TrimResponse {
            keep_per_source: Some(floor.max(8)),
            pause_preparation: true,
        },
        // BACKGROUND (40) and COMPLETE (80): we are a kill candidate. Hand back
        // everything that is not keeping a performance alive.
        l if l == TRIM_MEMORY_BACKGROUND || l == TRIM_MEMORY_COMPLETE => TrimResponse {
            keep_per_source: Some(floor),
            pause_preparation: true,
        },

        // Unknown level: a future Android may add more, and guessing at what
        // they mean is worse than ignoring them.
        _ => TrimResponse {
            keep_per_source: None,
            pause_preparation: false,
        },
    }
}

fn level_name(level: i32) -> &'static str {
    match level {
        TRIM_MEMORY_COMPLETE => "COMPLETE",
        TRIM_MEMORY_MODERATE => "MODERATE",
        TRIM_MEMORY_BACKGROUND => "BACKGROUND",
        TRIM_MEMORY_UI_HIDDEN => "UI_HIDDEN",
        TRIM_MEMORY_RUNNING_CRITICAL => "RUNNING_CRITICAL",
        TRIM_MEMORY_RUNNING_LOW => "RUNNING_LOW",
        TRIM_MEMORY_RUNNING_MODERATE => "RUNNING_MODERATE",
        _ => "UNKNOWN",
    }
}

/// JNI entry point. Called from `MainActivity.onTrimMemory` on the UI thread,
/// so it must return promptly: freeing blocks is a map walk plus deallocation
/// outside the audio lock, not I/O.
///
/// # Safety
/// Called by the JVM with valid `JNIEnv`/`jobject` pointers, which we ignore.
#[no_mangle]
pub extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnTrimMemory(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    level: i32,
) -> i64 {
    // Assume playback when the controller is momentarily unreachable: keeping
    // a read-ahead window we did not need costs a few MB, dropping one we did
    // costs the performance.
    let playing = crate::audio::engine::transport_is_running_global().unwrap_or(true);
    let plan = plan_trim_response(level, playing);
    PREPARATION_PAUSED.store(plan.pause_preparation, Ordering::Relaxed);

    let Some(keep) = plan.keep_per_source else {
        log_pressure(level, 0, plan.pause_preparation);
        return 0;
    };

    let freed = crate::audio::engine::release_cached_audio_global(keep);
    log_pressure(level, freed, plan.pause_preparation);
    freed as i64
}

fn log_pressure(level: i32, freed: u64, paused: bool) {
    eprintln!(
        "[LT_MEMPRESSURE] level={} freed={}MB queue={}",
        level_name(level),
        freed / (1024 * 1024),
        if paused { "paused" } else { "running" }
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_pressure_frees_memory_but_never_silences_playback() {
        // Playing: a read-ahead window survives no matter how loud the system
        // shouts. This is the invariant the whole module exists to protect.
        let playing = plan_trim_response(TRIM_MEMORY_RUNNING_CRITICAL, true);
        assert!(playing.keep_per_source.expect("should free") >= 16);
        assert!(playing.pause_preparation);

        // Idle: nothing to protect, so hand back as much as possible.
        let idle = plan_trim_response(TRIM_MEMORY_RUNNING_CRITICAL, false);
        assert!(idle.keep_per_source.expect("should free") < 16);
    }

    #[test]
    fn background_levels_release_the_most() {
        for level in [TRIM_MEMORY_BACKGROUND, TRIM_MEMORY_COMPLETE] {
            let idle = plan_trim_response(level, false);
            assert_eq!(idle.keep_per_source, Some(0), "level {level} should free all");
            assert!(idle.pause_preparation);

            // ...but a background level while the transport runs (screen off,
            // foreground service) still keeps the window.
            let playing = plan_trim_response(level, true);
            assert!(playing.keep_per_source.expect("should free") >= 16);
        }
    }

    #[test]
    fn a_mild_running_hint_does_not_flush_a_cache_we_would_pay_to_refill() {
        let response = plan_trim_response(TRIM_MEMORY_RUNNING_MODERATE, false);
        assert_eq!(response.keep_per_source, None, "RUNNING_MODERATE should be a no-op");
        assert!(!response.pause_preparation);
    }

    #[test]
    fn the_level_constants_are_not_ordered_by_severity() {
        // The trap this module walked into once: MODERATE (60) is numerically
        // ABOVE BACKGROUND (40) but is a milder warning, so a `level >=
        // BACKGROUND` arm silently swallows it. These two must not collapse
        // into the same response by accident.
        assert!(TRIM_MEMORY_MODERATE > TRIM_MEMORY_BACKGROUND);

        // RUNNING_MODERATE (5) is the mild one and does nothing; MODERATE (60)
        // means we are backgrounded and deep in the LRU, so it releases.
        assert_eq!(
            plan_trim_response(TRIM_MEMORY_RUNNING_MODERATE, false).keep_per_source,
            None
        );
        assert!(plan_trim_response(TRIM_MEMORY_MODERATE, false)
            .keep_per_source
            .is_some());
    }

    #[test]
    fn pressure_is_graduated_not_all_or_nothing() {
        // LOW keeps strictly more than CRITICAL: the response has to scale with
        // the warning, or there is no point in Android sending two of them.
        let low = plan_trim_response(TRIM_MEMORY_RUNNING_LOW, true)
            .keep_per_source
            .expect("low frees");
        let critical = plan_trim_response(TRIM_MEMORY_RUNNING_CRITICAL, true)
            .keep_per_source
            .expect("critical frees");
        assert!(
            low > critical,
            "RUNNING_LOW ({low}) should keep more than RUNNING_CRITICAL ({critical})"
        );
    }

    #[test]
    fn an_unknown_level_does_nothing() {
        // Future Android versions may add levels; guessing at them is worse
        // than ignoring them.
        assert_eq!(plan_trim_response(-1, false).keep_per_source, None);
        assert_eq!(plan_trim_response(999, true).keep_per_source, None);
    }
}
