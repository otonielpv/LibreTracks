//! Monitors as Tauri sees them, in the output's terms.
//!
//! On Windows Tauri's monitor `name` is the GDI device name (`\\.\DISPLAYn`),
//! which is also what the surface is placed by (its rectangle, really: paso 01
//! showed mpv cannot pick a monitor by name on Windows, so the surface is our
//! own window put on the monitor's rectangle).

use libretracks_video::monitors::MonitorInfo;
use tauri::{AppHandle, Manager, Runtime};

fn info(monitor: &tauri::Monitor, primary_name: Option<&str>) -> MonitorInfo {
    let name = monitor.name().cloned().unwrap_or_default();
    let size = monitor.size();
    let position = monitor.position();
    MonitorInfo {
        is_primary: primary_name == Some(name.as_str()),
        name,
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    }
}

/// Connected monitors and the name of the one the main window is on.
pub fn connected_monitors<R: Runtime>(app: &AppHandle<R>) -> (Vec<MonitorInfo>, Option<String>) {
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    let monitors = app
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| info(monitor, primary.as_deref()))
                .collect()
        })
        .unwrap_or_default();
    let app_monitor = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .and_then(|window| window.current_monitor().ok().flatten())
        .and_then(|monitor| monitor.name().cloned());
    (monitors, app_monitor)
}
