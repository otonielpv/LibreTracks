//! Recovery when WebKit's web content process dies (iOS and macOS).
//!
//! The UI runs in a separate WebKit process. When the system kills it for
//! memory (or it crashes), the WKWebView stays on screen but blank, and
//! nothing reloaded it: the performer saw an empty window while the audio
//! engine, which lives in our process, kept going. Same root cause as the
//! Android report of 2026-11-17 (a big setlist outgrew the renderer); there the
//! renderer's death aborted the whole app, see `RendererGoneGuard.kt`.
//!
//! The vendored `tauri-runtime-wry` (vendor/tauri-runtime-wry,
//! `LIBRETRACKS PATCH`) wires wry's termination handler to a reload and asks
//! [`install`]'s hook first. Reloading is cheap here: the Rust side keeps the
//! open session, so the fresh UI picks it up as it does on any start.
//!
//! The budget is compiled on every system so the desktop test run covers it;
//! only the hook itself is Darwin-only.

use std::time::{Duration, Instant};

/// Reloads allowed inside [`WINDOW`]. A session whose UI dies again right
/// after each reload would otherwise reload forever, burning the battery and
/// fighting the performer; past the budget the window stays blank and the
/// error log says why.
const MAX_RELOADS: usize = 3;
const WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct ReloadBudget {
    recent: Vec<Instant>,
}

impl ReloadBudget {
    /// Whether a reload at `now` is within budget; records it when it is.
    pub fn allow(&mut self, now: Instant) -> bool {
        self.recent
            .retain(|at| now.saturating_duration_since(*at) < WINDOW);
        if self.recent.len() >= MAX_RELOADS {
            return false;
        }
        self.recent.push(now);
        true
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn install() {
    use std::sync::Mutex;

    let budget = Mutex::new(ReloadBudget::default());
    let _ = tauri_runtime_wry::WEB_CONTENT_TERMINATED_HOOK.set(Box::new(move |label: &str| {
        let reload = budget
            .lock()
            .map(|mut budget| budget.allow(Instant::now()))
            .unwrap_or(true);
        crate::infra::error_log::write_error(&format!(
            "webview content process terminated (webview={label}); reloading={reload}"
        ));
        reload
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_up_to_the_budget_then_stops() {
        let mut budget = ReloadBudget::default();
        let start = Instant::now();
        for i in 0..MAX_RELOADS {
            assert!(budget.allow(start + Duration::from_secs(i as u64)), "reload {i}");
        }
        assert!(!budget.allow(start + Duration::from_secs(10)));
    }

    #[test]
    fn the_budget_refills_once_old_reloads_leave_the_window() {
        let mut budget = ReloadBudget::default();
        let start = Instant::now();
        for _ in 0..MAX_RELOADS {
            assert!(budget.allow(start));
        }
        assert!(!budget.allow(start + WINDOW - Duration::from_secs(1)));
        assert!(budget.allow(start + WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn a_refused_reload_does_not_use_up_the_budget() {
        let mut budget = ReloadBudget::default();
        let start = Instant::now();
        for _ in 0..MAX_RELOADS {
            budget.allow(start);
        }
        for s in 1..20 {
            assert!(!budget.allow(start + Duration::from_secs(s)));
        }
        assert!(budget.allow(start + WINDOW + Duration::from_millis(1)));
    }
}
