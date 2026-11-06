//! Pilot tone switch (redundancy steps 07-08): only a healthy main emits
//! it, and never by itself after an unclean exit (R4). Step 08 drives the
//! engine's oscillator from here.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static ARMED: AtomicBool = AtomicBool::new(false);

pub fn is_armed() -> bool {
    ARMED.load(Ordering::Relaxed)
}

pub fn set_armed(app: &AppHandle, armed: bool) {
    ARMED.store(armed, Ordering::Relaxed);
    super::role::publish_status(app, |status| status.pilot_tone_on = armed);
}
