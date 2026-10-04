//! MIDI hot-plug: notice ports appearing and disappearing, and reconnect.
//!
//! On stage a phone's OTG cable or camera adapter gets knocked loose far more
//! often than a laptop's USB cable. Without this, a pulled cable left the
//! input listener dead until the user pressed "Refresh" in Settings.
//!
//! Two ways to learn about changes:
//! - the transport pushes them (Android's `MidiManager.DeviceCallback`): each
//!   notification runs one check on a short-lived thread, no polling at all;
//! - otherwise (`midir` exposes no notifications) a low-priority thread lists
//!   ports every 2 s, **only while there is something to watch**: a selected
//!   port or an open per-track port. With no MIDI configured no thread runs.
//!
//! Each check hands the lists to `MidiManager::on_devices_changed` and
//! `MidiOutputManager::on_devices_changed`, which hold the actual state
//! machine (tested in `reconnect_tests.rs`), and emits `midi:devices_changed`
//! so Settings and the topbar badge refresh without a button.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::transport::platform_transport;
use crate::state::DesktopState;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const DEVICES_CHANGED_EVENT: &str = "midi:devices_changed";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The transport notifies changes itself; never poll.
static PUSHES: AtomicBool = AtomicBool::new(false);
/// The polling thread is alive.
static POLLING: AtomicBool = AtomicBool::new(false);
/// One check at a time; also remembers the last lists to emit only changes.
static LAST: Mutex<Option<MidiDevicesStatus>> = Mutex::new(None);

/// Payload of `midi:devices_changed` and of the `get_midi_status` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDevicesStatus {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    /// The selected input is open.
    pub input_connected: bool,
    /// An input is selected but its device is missing.
    pub input_waiting: bool,
    pub output_connected: bool,
    pub output_waiting: bool,
}

/// Start watching. Called once from app setup, after the ports were opened.
pub(crate) fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let pushes = platform_transport().watch(Box::new(notify_changed));
    PUSHES.store(pushes, Ordering::Release);
    ensure_running();
}

/// Make sure something is watching if there is anything to watch. Cheap and
/// idempotent; a no-op before `init` (and in unit tests).
pub(crate) fn ensure_running() {
    let Some(app) = APP.get() else {
        return;
    };
    if PUSHES.load(Ordering::Acquire) {
        // No thread to start, but the selection may just have changed: one
        // check refreshes the waiting state the topbar shows.
        notify_changed();
        return;
    }
    // Nothing to watch: a running thread notices on its next tick, after a
    // last check that clears the topbar badge.
    if !needed(app) {
        return;
    }
    if POLLING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("libretracks-midi-watch".into())
        .spawn(move || {
            crate::platform::thread_priority::lower_current_thread_priority();
            loop {
                thread::sleep(POLL_INTERVAL);
                check_once(&app);
                if !needed(&app) {
                    POLLING.store(false, Ordering::Release);
                    // Something may have asked for watching between the
                    // check and the store; take the thread back if so.
                    if needed(&app) && !POLLING.swap(true, Ordering::AcqRel) {
                        continue;
                    }
                    break;
                }
            }
        });
    if spawned.is_err() {
        POLLING.store(false, Ordering::Release);
    }
}

/// The device list may have changed (transport callback, app back in the
/// foreground). Runs one check off the caller's thread: on Android the caller
/// is the Handler thread that `openDevice` answers on, so reopening a port
/// from it would deadlock.
pub(crate) fn notify_changed() {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let _ = thread::Builder::new()
        .name("libretracks-midi-recheck".into())
        .spawn(move || check_once(&app));
}

fn needed(app: &AppHandle) -> bool {
    let state = app.state::<DesktopState>();
    state.midi.wants_port() || state.midi_output.wants_ports()
}

/// Current lists and connection state.
pub(crate) fn current_status(app: &AppHandle) -> Result<MidiDevicesStatus, String> {
    let transport = platform_transport();
    let inputs = transport.input_names()?;
    let outputs = transport.output_names()?;
    let state = app.state::<DesktopState>();
    Ok(MidiDevicesStatus {
        inputs,
        outputs,
        input_connected: state.midi.is_connected(),
        input_waiting: state.midi.is_waiting(),
        output_connected: state.midi_output.is_default_port_open(),
        output_waiting: state.midi_output.is_waiting(),
    })
}

fn check_once(app: &AppHandle) {
    let Ok(mut last) = LAST.lock() else {
        return;
    };
    let transport = platform_transport();
    // A listing error must not read as "every device is gone": skip the
    // check instead of closing ports that may be fine.
    let (Ok(inputs), Ok(outputs)) = (transport.input_names(), transport.output_names()) else {
        return;
    };
    let state = app.state::<DesktopState>();
    state.midi.on_devices_changed(&inputs);
    state.midi_output.on_devices_changed(&outputs);

    let status = MidiDevicesStatus {
        inputs,
        outputs,
        input_connected: state.midi.is_connected(),
        input_waiting: state.midi.is_waiting(),
        output_connected: state.midi_output.is_default_port_open(),
        output_waiting: state.midi_output.is_waiting(),
    };
    if last.as_ref() != Some(&status) {
        let _ = app.emit(DEVICES_CHANGED_EVENT, status.clone());
        *last = Some(status);
    }
}
