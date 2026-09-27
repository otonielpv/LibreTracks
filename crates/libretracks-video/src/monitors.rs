//! Which connected monitor the saved output display is, and where the output
//! surface goes. Pure, so the cases that bite on stage (a replug that renames
//! screens, two identical projectors, a resolution change) are tested.

use serde::{Deserialize, Serialize};

use crate::settings::{DisplayId, VideoOutputMode};

/// A monitor as the OS reports it now (Tauri's `available_monitors()`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub is_primary: bool,
}

impl MonitorInfo {
    pub fn id(&self) -> DisplayId {
        DisplayId {
            name: self.name.clone(),
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
        }
    }
}

/// Positions within this many pixels count as the same place (a DPI change
/// or a driver can nudge the origin).
const POSITION_TOLERANCE_PX: i32 = 16;

fn score(saved: &DisplayId, monitor: &MonitorInfo) -> u32 {
    let mut score = 0;
    if saved.name == monitor.name {
        score += 4;
    }
    if (saved.x - monitor.x).abs() <= POSITION_TOLERANCE_PX
        && (saved.y - monitor.y).abs() <= POSITION_TOLERANCE_PX
    {
        score += 2;
    }
    if saved.width == monitor.width && saved.height == monitor.height {
        score += 1;
    }
    score
}

/// The connected monitor that is the saved display, if any.
///
/// The OS name weighs most; position and resolution confirm it or, when the
/// name changed (screens renumbered after a replug), identify it on their own.
/// A position-only resemblance is not enough: a different screen that happens
/// to sit where the old one was must not receive the show.
pub fn match_display<'a>(saved: &DisplayId, monitors: &'a [MonitorInfo]) -> Option<&'a MonitorInfo> {
    const MIN_SCORE: u32 = 3;
    let mut best: Option<(&MonitorInfo, u32)> = None;
    for monitor in monitors {
        let candidate = score(saved, monitor);
        if candidate < MIN_SCORE {
            continue;
        }
        match best {
            Some((_, best_score)) if best_score >= candidate => {}
            _ => best = Some((monitor, candidate)),
        }
    }
    best.map(|(monitor, _)| monitor)
}

/// Where the output surface goes, in virtual-desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfacePlan {
    pub rect: SurfaceRect,
    pub fullscreen: bool,
    /// OS name of the monitor, for surfaces that pick it by name (mpv's own
    /// window on Linux).
    pub monitor_name: String,
    /// The chosen display is the one the app window is on: forced to window
    /// mode so the output does not cover the app, and the UI warns.
    pub shares_app_display: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementOutcome {
    Place(SurfacePlan),
    /// A display is configured but not connected.
    DisplayLost,
    /// No display configured yet (the wizard of paso 10 sets one).
    NoDisplay,
}

/// Decide where the surface goes for `saved` and `mode`, given the monitors
/// now connected and the one the main window is on.
pub fn plan_surface(
    saved: Option<&DisplayId>,
    mode: VideoOutputMode,
    monitors: &[MonitorInfo],
    app_monitor_name: Option<&str>,
) -> PlacementOutcome {
    let Some(saved) = saved else {
        return PlacementOutcome::NoDisplay;
    };
    let Some(monitor) = match_display(saved, monitors) else {
        return PlacementOutcome::DisplayLost;
    };
    let shares_app_display = app_monitor_name == Some(monitor.name.as_str());
    let fullscreen = mode == VideoOutputMode::Fullscreen && !shares_app_display;
    let rect = if fullscreen {
        SurfaceRect {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        }
    } else {
        // Window mode: half the monitor, centred on it.
        let width = (monitor.width / 2).max(320);
        let height = (monitor.height / 2).max(180);
        SurfaceRect {
            x: monitor.x + (monitor.width as i32 - width as i32) / 2,
            y: monitor.y + (monitor.height as i32 - height as i32) / 2,
            width,
            height,
        }
    };
    PlacementOutcome::Place(SurfacePlan {
        rect,
        fullscreen,
        monitor_name: monitor.name.clone(),
        shares_app_display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(name: &str, x: i32, y: i32, width: u32, height: u32) -> MonitorInfo {
        MonitorInfo {
            name: name.into(),
            width,
            height,
            x,
            y,
            is_primary: x == 0 && y == 0,
        }
    }

    fn saved(name: &str, x: i32, y: i32, width: u32, height: u32) -> DisplayId {
        monitor(name, x, y, width, height).id()
    }

    #[test]
    fn same_name_somewhere_else_is_still_the_display() {
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY2", 1920, 0, 1920, 1080),
        ];
        // It was on the left, the user moved it to the right in Windows.
        let found = match_display(&saved("\\\\.\\DISPLAY2", -1920, 0, 1920, 1080), &monitors);
        assert_eq!(found.map(|m| m.name.as_str()), Some("\\\\.\\DISPLAY2"));
    }

    #[test]
    fn two_identical_projectors_are_told_apart() {
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY2", 1920, 0, 1280, 720),
            monitor("\\\\.\\DISPLAY3", 3200, 0, 1280, 720),
        ];
        let found = match_display(&saved("\\\\.\\DISPLAY3", 3200, 0, 1280, 720), &monitors);
        assert_eq!(found.map(|m| m.name.as_str()), Some("\\\\.\\DISPLAY3"));
    }

    #[test]
    fn renumbered_after_a_replug_is_found_by_place_and_size() {
        // The projector came back as DISPLAY3 in the same place.
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY3", 1920, 0, 1280, 720),
        ];
        let found = match_display(&saved("\\\\.\\DISPLAY2", 1920, 0, 1280, 720), &monitors);
        assert_eq!(found.map(|m| m.name.as_str()), Some("\\\\.\\DISPLAY3"));
    }

    #[test]
    fn a_resolution_change_keeps_the_display() {
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY2", 1920, 0, 1024, 768),
        ];
        let found = match_display(&saved("\\\\.\\DISPLAY2", 1920, 0, 1920, 1080), &monitors);
        assert_eq!(found.map(|m| m.name.as_str()), Some("\\\\.\\DISPLAY2"));
    }

    #[test]
    fn a_different_screen_in_the_old_place_is_not_taken() {
        // Only the position matches: a new name AND a new resolution.
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY5", 1920, 0, 3840, 2160),
        ];
        assert_eq!(match_display(&saved("\\\\.\\DISPLAY2", 1920, 0, 1280, 720), &monitors), None);
    }

    #[test]
    fn an_unplugged_display_is_lost_and_nothing_configured_is_no_display() {
        let monitors = [monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080)];
        assert_eq!(
            plan_surface(
                Some(&saved("\\\\.\\DISPLAY2", 1920, 0, 1280, 720)),
                VideoOutputMode::Fullscreen,
                &monitors,
                Some("\\\\.\\DISPLAY1"),
            ),
            PlacementOutcome::DisplayLost
        );
        assert_eq!(
            plan_surface(None, VideoOutputMode::Fullscreen, &monitors, None),
            PlacementOutcome::NoDisplay
        );
    }

    #[test]
    fn fullscreen_covers_the_monitor() {
        let monitors = [
            monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            monitor("\\\\.\\DISPLAY2", -1920, 0, 1920, 1080),
        ];
        let PlacementOutcome::Place(plan) = plan_surface(
            Some(&monitors[1].id()),
            VideoOutputMode::Fullscreen,
            &monitors,
            Some("\\\\.\\DISPLAY1"),
        ) else {
            panic!("should place");
        };
        assert!(plan.fullscreen);
        assert_eq!(plan.rect, SurfaceRect { x: -1920, y: 0, width: 1920, height: 1080 });
        assert!(!plan.shares_app_display);
    }

    #[test]
    fn the_app_display_gets_a_window_instead_of_being_covered() {
        let monitors = [monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080)];
        let PlacementOutcome::Place(plan) = plan_surface(
            Some(&monitors[0].id()),
            VideoOutputMode::Fullscreen,
            &monitors,
            Some("\\\\.\\DISPLAY1"),
        ) else {
            panic!("should place");
        };
        assert!(!plan.fullscreen);
        assert!(plan.shares_app_display);
        assert_eq!(plan.rect, SurfaceRect { x: 480, y: 270, width: 960, height: 540 });
    }
}
