//! Control-surface state for MIDI dispatch (plan midi-controllers, paso 02).
//!
//! A fader sends dozens of messages per sweep, so nothing per message may
//! touch the disk or the session lock (D5). This module holds what dispatch
//! needs between messages:
//!
//! - the binding index, rebuilt only when the settings revision moves;
//! - soft-takeover state per target;
//! - a worker thread that coalesces the slow side effects: the settings JSON
//!   is written once the controls have been quiet for [`QUIET_DELAY`],
//!   `settings:updated` goes out at most every [`UI_INTERVAL`], and a tempo
//!   knob takes the session lock at most every [`TEMPO_INTERVAL`];
//! - diagnostic counters, read by `get_midi_control_diagnostics`, to count
//!   (not eyeball) disk writes and lock takes per message.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use libretracks_core::midi_control::{Debounce, MidiBindingIndex, SoftTakeover, Throttle};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    commands::events::emit_transport_lifecycle_event,
    infra::settings::{save_app_settings, AppSettingsStore},
    state::DesktopState,
};

/// How long the controls must be still before the gesture is committed.
pub(crate) const QUIET_DELAY: Duration = Duration::from_millis(300);
/// ~30 Hz: how often the UI hears about a control being moved (D11).
pub(crate) const UI_INTERVAL: Duration = Duration::from_millis(33);
const TEMPO_INTERVAL: Duration = Duration::from_millis(50);
const SETTINGS_UPDATED_EVENT: &str = "settings:updated";

#[derive(Debug, Default)]
pub(crate) struct Diagnostics {
    pub(crate) messages: AtomicU64,
    pub(crate) settings_disk_writes: AtomicU64,
    /// Session lock takes caused by continuous controls (faders, knobs).
    pub(crate) session_lock_takes: AtomicU64,
    pub(crate) track_commits: AtomicU64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiControlDiagnostics {
    pub messages: u64,
    pub settings_disk_writes: u64,
    pub session_lock_takes: u64,
    pub track_commits: u64,
}

enum WorkerEvent {
    /// The settings changed in memory; write them once quiet.
    SettingsDirty,
    /// Apply this tempo (the latest wins).
    Tempo(f64),
}

pub(crate) struct MidiControl {
    index: Mutex<(u64, Arc<MidiBindingIndex>)>,
    takeover: Mutex<HashMap<String, SoftTakeover>>,
    worker: Mutex<Option<Sender<WorkerEvent>>>,
    pub(crate) diagnostics: Diagnostics,
}

pub(crate) fn control() -> &'static MidiControl {
    static CONTROL: OnceLock<MidiControl> = OnceLock::new();
    CONTROL.get_or_init(|| MidiControl {
        index: Mutex::new((u64::MAX, Arc::new(MidiBindingIndex::default()))),
        takeover: Mutex::new(HashMap::new()),
        worker: Mutex::new(None),
        diagnostics: Diagnostics::default(),
    })
}

impl MidiControl {
    /// The index for the current settings. Rebuilt (one clone of the
    /// mappings) only when the settings revision moved since the last call.
    pub(crate) fn index(&self, settings: &AppSettingsStore) -> Arc<MidiBindingIndex> {
        let mut cached = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if cached.0 == settings.revision() {
            return Arc::clone(&cached.1);
        }
        if let Ok((index, revision)) =
            settings.read(|settings| MidiBindingIndex::build(settings.midi_mappings.iter()))
        {
            *cached = (revision, Arc::new(index));
        }
        Arc::clone(&cached.1)
    }

    /// Run `f` with the takeover state of `target_key`.
    pub(crate) fn with_takeover<R>(&self, target_key: &str, f: impl FnOnce(&mut SoftTakeover) -> R) -> R {
        let mut map = self.takeover.lock().unwrap_or_else(|e| e.into_inner());
        f(map.entry(target_key.to_string()).or_default())
    }

    pub(crate) fn settings_dirty(&self, app: &AppHandle) {
        self.send(app, WorkerEvent::SettingsDirty);
    }

    pub(crate) fn tempo(&self, app: &AppHandle, bpm: f64) {
        self.send(app, WorkerEvent::Tempo(bpm));
    }

    fn send(&self, app: &AppHandle, event: WorkerEvent) {
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = worker.as_ref() {
            match sender.send(event) {
                Ok(()) => return,
                Err(mpsc::SendError(event)) => {
                    // The worker died (panicked); start a new one below.
                    *worker = None;
                    let sender = spawn_worker(app.clone());
                    let _ = sender.send(event);
                    *worker = Some(sender);
                    return;
                }
            }
        }
        let sender = spawn_worker(app.clone());
        let _ = sender.send(event);
        *worker = Some(sender);
    }

    pub(crate) fn snapshot(&self) -> MidiControlDiagnostics {
        let d = &self.diagnostics;
        MidiControlDiagnostics {
            messages: d.messages.load(Ordering::Relaxed),
            settings_disk_writes: d.settings_disk_writes.load(Ordering::Relaxed),
            session_lock_takes: d.session_lock_takes.load(Ordering::Relaxed),
            track_commits: d.track_commits.load(Ordering::Relaxed),
        }
    }
}

fn spawn_worker(app: AppHandle) -> Sender<WorkerEvent> {
    let (sender, receiver) = mpsc::channel::<WorkerEvent>();
    let spawned = thread::Builder::new()
        .name("lt-midi-control".into())
        .spawn(move || {
            let mut settings_write = Debounce::<()>::new(QUIET_DELAY);
            let mut settings_emit = Throttle::new(UI_INTERVAL);
            let mut tempo_throttle = Throttle::new(TEMPO_INTERVAL);
            let mut pending_tempo: Option<f64> = None;
            loop {
                let next = [
                    settings_write.next_deadline(),
                    settings_emit.next_deadline(),
                    tempo_throttle.next_deadline(),
                ]
                .into_iter()
                .flatten()
                .min();
                let timeout = next
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or(Duration::from_secs(3600));
                let event = receiver.recv_timeout(timeout);
                let now = Instant::now();
                match event {
                    Ok(WorkerEvent::SettingsDirty) => {
                        settings_write.touch((), now);
                        if settings_emit.hit(now) {
                            emit_settings(&app);
                        }
                    }
                    Ok(WorkerEvent::Tempo(bpm)) => {
                        pending_tempo = Some(bpm);
                        if tempo_throttle.hit(now) {
                            apply_tempo(&app, pending_tempo.take());
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        if !settings_write.take_all().is_empty() {
                            write_settings(&app);
                        }
                        break;
                    }
                }
                if settings_emit.poll(now) {
                    emit_settings(&app);
                }
                if tempo_throttle.poll(now) {
                    apply_tempo(&app, pending_tempo.take());
                }
                if !settings_write.take_due(now).is_empty() {
                    write_settings(&app);
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("[libretracks-midi] could not start the control worker: {error}");
    }
    sender
}

fn emit_settings(app: &AppHandle) {
    if let Ok(settings) = app.state::<AppSettingsStore>().current() {
        let _ = app.emit(SETTINGS_UPDATED_EVENT, settings);
    }
}

fn write_settings(app: &AppHandle) {
    let Ok(settings) = app.state::<AppSettingsStore>().current() else {
        return;
    };
    control()
        .diagnostics
        .settings_disk_writes
        .fetch_add(1, Ordering::Relaxed);
    if let Err(error) = save_app_settings(app, &settings) {
        eprintln!("[libretracks-midi] could not save settings: {error}");
    }
}

fn apply_tempo(app: &AppHandle, bpm: Option<f64>) {
    let Some(bpm) = bpm else {
        return;
    };
    let state = app.state::<DesktopState>();
    control()
        .diagnostics
        .session_lock_takes
        .fetch_add(1, Ordering::Relaxed);
    let Ok(mut session) = state.session.lock() else {
        return;
    };
    match session.update_song_tempo(bpm, &state.audio) {
        Ok(snapshot) => emit_transport_lifecycle_event(app, "sync", &snapshot),
        Err(error) => eprintln!("[libretracks-midi] tempo from MIDI failed: {error}"),
    }
}

#[tauri::command]
pub fn get_midi_control_diagnostics() -> MidiControlDiagnostics {
    control().snapshot()
}
