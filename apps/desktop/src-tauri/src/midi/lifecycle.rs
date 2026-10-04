//! MIDI and the app going to the background and back (plan mobile-midi,
//! paso 08). Mobile only: desktop windows don't get suspended.
//!
//! - **Leaving the screen with the transport stopped or paused**: All Notes
//!   Off on every open output, so nothing keeps ringing on the receiving
//!   device while the app sleeps (iOS suspends a paused app in the
//!   background).
//! - **"Keep MIDI active in the background" off** (on by default): the input
//!   is also closed until the app comes back, so a pedal can't start the
//!   show from a pocket. On Android the foreground service keeps the process
//!   alive for the whole run, so with the setting on a pedal keeps working
//!   with the screen off; that costs nothing extra, because the listener
//!   threads only wake when bytes arrive or every 100 ms to check a flag.
//! - **Back on screen**: every port is revalidated as if the device list had
//!   changed (reuses the paso 04 state machine): the input listener is
//!   reopened from scratch, Android reopens its remembered Bluetooth devices,
//!   and a check re-lists everything.
//!
//! Both run on their own short thread: the callers are the Android UI thread
//! (`onStart`/`onStop`) and a Tauri command, and this takes the session lock.

use std::thread;

use libretracks_audio::PlaybackState;
use tauri::{AppHandle, Manager};

use crate::{infra::settings::AppSettingsStore, state::DesktopState};

/// The app became visible (`true`) or went to the background (`false`).
pub(crate) fn visibility_changed(visible: bool) {
    let Some(app) = super::watch::app_handle() else {
        return;
    };
    let _ = thread::Builder::new()
        .name("libretracks-midi-lifecycle".into())
        .spawn(move || {
            if visible {
                on_foreground(&app);
            } else {
                on_background(&app);
            }
        });
}

fn on_background(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let playing = state
        .session
        .lock()
        .map(|session| session.engine.playback_state() == PlaybackState::Playing)
        .unwrap_or(false);
    if playing {
        // The show goes on in the background; its MIDI too.
        return;
    }
    state.midi_output.panic();
    let keep_input = app
        .state::<AppSettingsStore>()
        .current()
        .map(|settings| settings.keep_midi_in_background)
        .unwrap_or(true);
    if !keep_input && state.midi.suspend() {
        eprintln!("[libretracks-midi] input closed while in the background");
    }
}

fn on_foreground(app: &AppHandle) {
    app.state::<DesktopState>().midi.revalidate();
    super::bluetooth::reopen_remembered(app);
    super::watch::notify_changed();
}
