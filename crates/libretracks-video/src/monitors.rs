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
    /// The output is a window on the display the app window is on (forced
    /// there so it does not cover the app, unless the user asked for
    /// fullscreen with a double-click), and the UI warns.
    pub shares_app_display: bool,
    /// Above every other window. Only ever for fullscreen.
    pub on_top: bool,
}

/// What the user asked for beyond the display and the mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PlanOptions {
    /// `VideoOutputSettings::fullscreen_on_top`.
    pub on_top: bool,
    /// Fullscreen even on the app's display: a double-click on the output
    /// window asked for it, so covering the app is what the user wants.
    pub cover_app_display: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementOutcome {
    Place(SurfacePlan),
    /// A display is configured but not connected.
    DisplayLost,
    /// No display configured yet (the wizard of paso 10 sets one).
    NoDisplay,
}

/// Where the output goes on a phone or tablet (plan video-mobile, paso 06
/// §2), where the list only ever holds *external* displays, all at (0, 0),
/// and there is usually one or none.
///
/// - Nothing pinned: the first external display that appears, without asking.
/// - A display pinned in the settings (AirPlay and a cable at once): that
///   one and only that one, recognised **by name**. Position means nothing
///   here (every display sits at the origin) and two projectors share a
///   resolution, so the desktop's geometric match would hand the show to
///   whichever screen is plugged in. If the pinned one is gone, the plan
///   reads "display lost" even when another is connected, as on the desktop.
///
/// Always fullscreen: there is no window on a projector driven by a phone.
pub fn plan_mobile_surface(pinned: Option<&DisplayId>, monitors: &[MonitorInfo]) -> PlacementOutcome {
    let monitor = match pinned {
        Some(pinned) => monitors.iter().find(|monitor| monitor.name == pinned.name),
        None => monitors.first(),
    };
    let Some(monitor) = monitor else {
        return if pinned.is_some() {
            PlacementOutcome::DisplayLost
        } else {
            PlacementOutcome::NoDisplay
        };
    };
    PlacementOutcome::Place(SurfacePlan {
        rect: SurfaceRect {
            x: 0,
            y: 0,
            width: monitor.width,
            height: monitor.height,
        },
        fullscreen: true,
        monitor_name: monitor.name.clone(),
        shares_app_display: false,
        on_top: false,
    })
}

/// Decide where the surface goes for `saved` and `mode`, given the monitors
/// now connected and the one the main window is on.
pub fn plan_surface(
    saved: Option<&DisplayId>,
    mode: VideoOutputMode,
    options: PlanOptions,
    monitors: &[MonitorInfo],
    app_monitor_name: Option<&str>,
) -> PlacementOutcome {
    let Some(saved) = saved else {
        return PlacementOutcome::NoDisplay;
    };
    let Some(monitor) = match_display(saved, monitors) else {
        return PlacementOutcome::DisplayLost;
    };
    let on_app_display = app_monitor_name == Some(monitor.name.as_str());
    let fullscreen =
        mode == VideoOutputMode::Fullscreen && (!on_app_display || options.cover_app_display);
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
        shares_app_display: on_app_display && !fullscreen,
        on_top: fullscreen && options.on_top,
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

    fn external(name: &str) -> MonitorInfo {
        MonitorInfo {
            name: name.into(),
            width: 1920,
            height: 1080,
            x: 0,
            y: 0,
            is_primary: false,
        }
    }

    fn mobile_outcome(pinned: Option<&DisplayId>, monitors: &[MonitorInfo]) -> PlacementOutcome {
        plan_mobile_surface(pinned, monitors)
    }

    fn placed_on(outcome: &PlacementOutcome) -> Option<&str> {
        match outcome {
            PlacementOutcome::Place(plan) => Some(plan.monitor_name.as_str()),
            _ => None,
        }
    }

    /// Paso 06 C1, the five cases of the mobile display choice.
    #[test]
    fn on_a_phone_with_no_external_display_there_is_nothing_to_open() {
        assert_eq!(mobile_outcome(None, &[]), PlacementOutcome::NoDisplay);
    }

    #[test]
    fn on_a_phone_the_only_external_display_is_used_without_asking() {
        let outcome = mobile_outcome(None, &[external("HDMI")]);
        assert_eq!(placed_on(&outcome), Some("HDMI"));
        let PlacementOutcome::Place(plan) = outcome else { unreachable!() };
        assert!(plan.fullscreen && !plan.shares_app_display);
    }

    #[test]
    fn on_a_phone_with_two_displays_the_first_one_wins() {
        let monitors = [external("HDMI"), external("AirPlay: Salón")];
        assert_eq!(placed_on(&mobile_outcome(None, &monitors)), Some("HDMI"));
    }

    #[test]
    fn on_a_phone_a_pinned_display_beats_the_first_one() {
        let monitors = [external("HDMI"), external("AirPlay: Salón")];
        let pinned = external("AirPlay: Salón").id();
        assert_eq!(
            placed_on(&mobile_outcome(Some(&pinned), &monitors)),
            Some("AirPlay: Salón")
        );
    }

    #[test]
    fn on_a_phone_a_pinned_display_that_is_gone_is_lost_even_with_another_present() {
        let pinned = external("AirPlay: Salón").id();
        assert_eq!(
            mobile_outcome(Some(&pinned), &[external("HDMI")]),
            PlacementOutcome::DisplayLost
        );
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
                PlanOptions::default(),
                &monitors,
                Some("\\\\.\\DISPLAY1"),
            ),
            PlacementOutcome::DisplayLost
        );
        assert_eq!(
            plan_surface(None, VideoOutputMode::Fullscreen, PlanOptions::default(), &monitors, None),
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
            PlanOptions { on_top: true, cover_app_display: false },
            &monitors,
            Some("\\\\.\\DISPLAY1"),
        ) else {
            panic!("should place");
        };
        assert!(plan.fullscreen);
        assert!(plan.on_top);
        assert_eq!(plan.rect, SurfaceRect { x: -1920, y: 0, width: 1920, height: 1080 });
        assert!(!plan.shares_app_display);
    }

    #[test]
    fn the_app_display_gets_a_window_instead_of_being_covered() {
        let monitors = [monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080)];
        let PlacementOutcome::Place(plan) = plan_surface(
            Some(&monitors[0].id()),
            VideoOutputMode::Fullscreen,
            PlanOptions { on_top: true, cover_app_display: false },
            &monitors,
            Some("\\\\.\\DISPLAY1"),
        ) else {
            panic!("should place");
        };
        assert!(!plan.fullscreen);
        assert!(plan.shares_app_display);
        // A window is never on top, whatever the setting says.
        assert!(!plan.on_top);
        assert_eq!(plan.rect, SurfaceRect { x: 480, y: 270, width: 960, height: 540 });
    }

    #[test]
    fn a_double_click_can_cover_the_app_display_and_on_top_is_optional() {
        let monitors = [monitor("\\\\.\\DISPLAY1", 0, 0, 1920, 1080)];
        let PlacementOutcome::Place(plan) = plan_surface(
            Some(&monitors[0].id()),
            VideoOutputMode::Fullscreen,
            PlanOptions { on_top: false, cover_app_display: true },
            &monitors,
            Some("\\\\.\\DISPLAY1"),
        ) else {
            panic!("should place");
        };
        assert!(plan.fullscreen);
        assert!(!plan.on_top);
        // Covering it on purpose: nothing to warn about.
        assert!(!plan.shares_app_display);
        assert_eq!(plan.rect, SurfaceRect { x: 0, y: 0, width: 1920, height: 1080 });
    }
}
