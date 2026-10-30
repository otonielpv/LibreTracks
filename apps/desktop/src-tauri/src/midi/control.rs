//! Control-surface state for MIDI dispatch (plan midi-controllers, pasos 02-03).
//!
//! A fader sends dozens of messages per sweep, so nothing per message may
//! touch the disk or the session lock (D5). This module holds what dispatch
//! needs between messages:
//!
//! - the binding index, rebuilt only when the settings revision moves;
//! - soft-takeover state per target;
//! - the mix mirror: each track's volume/pan/mute/solo, the strip order and
//!   the active song's master, pushed by the UI (`midi_controller_sync`) and
//!   moved by the controls themselves, so a fader knows where its track is
//!   without the session lock;
//! - a worker thread that coalesces the slow side effects: one commit (one
//!   undo entry) per track once its controls have been quiet for
//!   [`QUIET_DELAY`], the settings JSON on the same delay, `midi:mix-changed`
//!   and `settings:updated` at most every [`UI_INTERVAL`] (D11), and a tempo
//!   knob's session lock at most every [`TEMPO_INTERVAL`];
//! - diagnostic counters, read by `get_midi_control_diagnostics`, to count
//!   (not eyeball) disk writes and lock takes per message.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use libretracks_core::midi_control::{
    Bank, Debounce, MidiBindingIndex, MixControl, SoftTakeover, Throttle, BANK_SIZE,
};
use serde::{Deserialize, Serialize};
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
const MIX_CHANGED_EVENT: &str = "midi:mix-changed";
const BANK_CHANGED_EVENT: &str = "midi:bank-changed";

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

/// One track as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMixSync {
    pub id: String,
    #[serde(flatten)]
    pub mix: TrackMix,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMasterSync {
    pub region_id: String,
    pub gain: f64,
}

/// What changed since the last `midi:mix-changed`, keyed by track id.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixPatch {
    pub tracks: BTreeMap<String, TrackMixPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song_master: Option<SongMasterSync>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMixPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
}

/// The tracks the strips drive right now, for the mixer's bank indicator.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BankState {
    pub offset: usize,
    pub size: usize,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Default)]
pub(crate) struct MixMirror {
    pub(crate) tracks: HashMap<String, TrackMix>,
    /// The visible tracks of the active mixer, in order (strips, paso 04).
    pub(crate) strip_order: Vec<String>,
    pub(crate) song_master: Option<SongMasterSync>,
    /// Which 8 of `strip_order` the strips drive (paso 04).
    pub(crate) bank: Bank,
    /// Fields moved by a control and not committed yet, per track. A sync
    /// from the UI must not overwrite them with its older values.
    pending: HashMap<String, Vec<MixControl>>,
    song_master_pending: bool,
    patch: MixPatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CommitKey {
    Track(String),
    SongMaster,
}

enum WorkerEvent {
    /// The settings changed in memory; write them once quiet.
    SettingsDirty,
    /// Apply this tempo (the latest wins).
    Tempo(f64),
    /// A control moved this track or the song master: commit once quiet and
    /// tell the UI.
    MixDirty(CommitKey),
}

pub(crate) struct MidiControl {
    index: Mutex<(u64, Arc<MidiBindingIndex>)>,
    takeover: Mutex<HashMap<String, SoftTakeover>>,
    pub(crate) mix: Mutex<MixMirror>,
    worker: Mutex<Option<Sender<WorkerEvent>>>,
    pub(crate) diagnostics: Diagnostics,
}

pub(crate) fn control() -> &'static MidiControl {
    static CONTROL: OnceLock<MidiControl> = OnceLock::new();
    CONTROL.get_or_init(|| MidiControl {
        index: Mutex::new((u64::MAX, Arc::new(MidiBindingIndex::default()))),
        takeover: Mutex::new(HashMap::new()),
        mix: Mutex::new(MixMirror::default()),
        worker: Mutex::new(None),
        diagnostics: Diagnostics::default(),
    })
}

impl MixMirror {
    /// Take the UI's view of the mix, except for what a control moved and
    /// has not committed yet.
    pub(crate) fn sync(
        &mut self,
        tracks: Vec<TrackMixSync>,
        strip_order: Vec<String>,
        song_master: Option<SongMasterSync>,
    ) {
        let mut next = HashMap::with_capacity(tracks.len());
        for TrackMixSync { id, mut mix } in tracks {
            if let (Some(fields), Some(ours)) = (self.pending.get(&id), self.tracks.get(&id)) {
                for field in fields {
                    match field {
                        MixControl::Volume => mix.volume = ours.volume,
                        MixControl::Pan => mix.pan = ours.pan,
                        MixControl::Mute => mix.muted = ours.muted,
                        MixControl::Solo => mix.solo = ours.solo,
                    }
                }
            }
            next.insert(id, mix);
        }
        self.pending.retain(|id, _| next.contains_key(id));
        self.tracks = next;
        self.strip_order = strip_order;
        self.bank.clamp(self.strip_order.len());
        let keep_ours = self.song_master_pending
            && matches!((&self.song_master, &song_master), (Some(ours), Some(theirs)) if ours.region_id == theirs.region_id);
        if !keep_ours {
            self.song_master = song_master;
            self.song_master_pending = false;
        }
    }

    pub(crate) fn bank_state(&self) -> BankState {
        BankState {
            offset: self.bank.offset,
            size: BANK_SIZE,
            track_ids: self.bank.tracks(&self.strip_order).to_vec(),
        }
    }

    /// A control moved one field of a track.
    pub(crate) fn set_track(&mut self, track_id: &str, control: MixControl, mix: TrackMix) {
        let fields = self.pending.entry(track_id.to_string()).or_default();
        if !fields.contains(&control) {
            fields.push(control);
        }
        let patch = self.patch.tracks.entry(track_id.to_string()).or_default();
        match control {
            MixControl::Volume => patch.volume = Some(mix.volume),
            MixControl::Pan => patch.pan = Some(mix.pan),
            MixControl::Mute => patch.muted = Some(mix.muted),
            MixControl::Solo => patch.solo = Some(mix.solo),
        }
        self.tracks.insert(track_id.to_string(), mix);
    }

    pub(crate) fn set_song_master(&mut self, master: SongMasterSync) {
        self.song_master_pending = true;
        self.patch.song_master = Some(master.clone());
        self.song_master = Some(master);
    }

    /// The fields to commit for a track, clearing them.
    fn take_pending(&mut self, track_id: &str) -> Option<(Vec<MixControl>, TrackMix)> {
        let fields = self.pending.remove(track_id)?;
        Some((fields, self.tracks.get(track_id)?.clone()))
    }

    fn take_patch(&mut self) -> MixPatch {
        std::mem::take(&mut self.patch)
    }
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
    pub(crate) fn with_takeover<R>(
        &self,
        target_key: &str,
        f: impl FnOnce(&mut SoftTakeover) -> R,
    ) -> R {
        let mut map = self.takeover.lock().unwrap_or_else(|e| e.into_inner());
        f(map.entry(target_key.to_string()).or_default())
    }

    pub(crate) fn with_mix<R>(&self, f: impl FnOnce(&mut MixMirror) -> R) -> R {
        let mut mix = self.mix.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut mix)
    }

    /// Strip controls must catch their new track again after a bank change.
    pub(crate) fn release_strip_takeovers(&self) {
        let mut map = self.takeover.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|key, _| !key.starts_with("strip:"));
    }

    /// Move the bank by `step`; tells the UI when it moved.
    pub(crate) fn step_bank(&self, app: &AppHandle, step: i32) {
        let moved = self.with_mix(|mix| {
            let len = mix.strip_order.len();
            mix.bank.step(len, step).then(|| mix.bank_state())
        });
        if let Some(state) = moved {
            self.release_strip_takeovers();
            let _ = app.emit(BANK_CHANGED_EVENT, state);
            // The strips' LEDs now belong to other tracks.
            super::feedback::refresh(app);
        }
    }

    pub(crate) fn settings_dirty(&self, app: &AppHandle) {
        self.send(app, WorkerEvent::SettingsDirty);
    }

    pub(crate) fn tempo(&self, app: &AppHandle, bpm: f64) {
        self.send(app, WorkerEvent::Tempo(bpm));
    }

    pub(crate) fn track_dirty(&self, app: &AppHandle, track_id: &str) {
        self.send(app, WorkerEvent::MixDirty(CommitKey::Track(track_id.to_string())));
    }

    pub(crate) fn song_master_dirty(&self, app: &AppHandle) {
        self.send(app, WorkerEvent::MixDirty(CommitKey::SongMaster));
    }

    fn send(&self, app: &AppHandle, event: WorkerEvent) {
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        let event = match worker.as_ref() {
            Some(sender) => match sender.send(event) {
                Ok(()) => return,
                // The worker died (panicked): start a new one below.
                Err(mpsc::SendError(event)) => event,
            },
            None => event,
        };
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
            let mut mix_commit = Debounce::<CommitKey>::new(QUIET_DELAY);
            let mut mix_emit = Throttle::new(UI_INTERVAL);
            let mut tempo_throttle = Throttle::new(TEMPO_INTERVAL);
            let mut pending_tempo: Option<f64> = None;
            loop {
                let next = [
                    settings_write.next_deadline(),
                    settings_emit.next_deadline(),
                    mix_commit.next_deadline(),
                    mix_emit.next_deadline(),
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
                    Ok(WorkerEvent::MixDirty(key)) => {
                        mix_commit.touch(key, now);
                        if mix_emit.hit(now) {
                            emit_mix(&app);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        commit_mix(&app, mix_commit.take_all());
                        if !settings_write.take_all().is_empty() {
                            write_settings(&app);
                        }
                        break;
                    }
                }
                if settings_emit.poll(now) {
                    emit_settings(&app);
                }
                if mix_emit.poll(now) {
                    emit_mix(&app);
                }
                if tempo_throttle.poll(now) {
                    apply_tempo(&app, pending_tempo.take());
                }
                let due = mix_commit.take_due(now);
                if !due.is_empty() {
                    commit_mix(&app, due);
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

fn emit_mix(app: &AppHandle) {
    let patch = control().with_mix(MixMirror::take_patch);
    if patch != MixPatch::default() {
        let _ = app.emit(MIX_CHANGED_EVENT, patch);
    }
}

fn write_settings(app: &AppHandle) {
    let Ok(settings) = app.state::<AppSettingsStore>().current() else {
        return;
    };
    // Realtime paths (aux faders) skipped the engine's settings cache.
    let _ = app
        .state::<DesktopState>()
        .audio
        .replace_settings(settings.clone());
    control()
        .diagnostics
        .settings_disk_writes
        .fetch_add(1, Ordering::Relaxed);
    if let Err(error) = save_app_settings(app, &settings) {
        eprintln!("[libretracks-midi] could not save settings: {error}");
    }
}

/// One commit per quiet track: the model, the undo entry and the snapshot
/// the UI refreshes from. The engine already has the values.
fn commit_mix(app: &AppHandle, keys: Vec<CommitKey>) {
    if keys.is_empty() {
        return;
    }
    let commits: Vec<_> = control().with_mix(|mix| {
        keys.iter()
            .filter_map(|key| match key {
                CommitKey::Track(track_id) => mix
                    .take_pending(track_id)
                    .map(|(fields, values)| (Some((track_id.clone(), fields, values)), None)),
                CommitKey::SongMaster => std::mem::take(&mut mix.song_master_pending)
                    .then(|| mix.song_master.clone().map(|master| (None, Some(master))))
                    .flatten(),
            })
            .collect()
    });
    if commits.is_empty() {
        return;
    }
    let state = app.state::<DesktopState>();
    control()
        .diagnostics
        .session_lock_takes
        .fetch_add(1, Ordering::Relaxed);
    let Ok(mut session) = state.session.lock() else {
        return;
    };
    let mut last_snapshot = None;
    for commit in commits {
        let result = match commit {
            (Some((track_id, fields, values)), _) => {
                control()
                    .diagnostics
                    .track_commits
                    .fetch_add(1, Ordering::Relaxed);
                let has = |field| fields.contains(&field);
                session.commit_track_mix_model_and_command(
                    &track_id,
                    has(MixControl::Volume).then_some(values.volume),
                    has(MixControl::Pan).then_some(values.pan),
                    has(MixControl::Mute).then_some(values.muted),
                    has(MixControl::Solo).then_some(values.solo),
                    None,
                    &state.audio,
                )
            }
            (None, Some(master)) => {
                session.update_song_region_master_gain(&master.region_id, master.gain, &state.audio)
            }
            _ => continue,
        };
        match result {
            Ok(snapshot) => last_snapshot = Some(snapshot),
            Err(error) => eprintln!("[libretracks-midi] mix commit failed: {error}"),
        }
    }
    drop(session);
    if let Some(snapshot) = last_snapshot {
        emit_transport_lifecycle_event(app, "sync", &snapshot);
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

/// The UI's view of the mix, pushed whenever the song or the visible mixer
/// changes (not per frame).
#[tauri::command]
pub fn midi_controller_sync(
    app: AppHandle,
    tracks: Vec<TrackMixSync>,
    strip_order: Vec<String>,
    song_master: Option<SongMasterSync>,
) {
    let control = control();
    let (before, after) = control.with_mix(|mix| {
        let before = mix.bank_state();
        mix.sync(tracks, strip_order, song_master);
        (before, mix.bank_state())
    });
    if before != after {
        control.release_strip_takeovers();
        let _ = app.emit(BANK_CHANGED_EVENT, after);
    }
    super::feedback::refresh(&app);
}

#[tauri::command]
pub fn get_midi_bank() -> BankState {
    control().with_mix(|mix| mix.bank_state())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, volume: f64) -> TrackMixSync {
        TrackMixSync {
            id: id.into(),
            mix: TrackMix {
                volume,
                pan: 0.0,
                muted: false,
                solo: false,
            },
        }
    }

    #[test]
    fn a_ui_sync_does_not_undo_an_uncommitted_fader_move() {
        let mut mirror = MixMirror::default();
        mirror.sync(vec![track("a", 1.0), track("b", 1.0)], vec![], None);
        let mut moved = mirror.tracks["a"].clone();
        moved.volume = 0.3;
        mirror.set_track("a", MixControl::Volume, moved);
        // The UI pushes its (older) song while the commit is pending.
        let mut stale_b = track("b", 0.5);
        stale_b.mix.muted = true;
        mirror.sync(vec![track("a", 1.0), stale_b], vec![], None);
        assert_eq!(mirror.tracks["a"].volume, 0.3, "ours wins until committed");
        assert_eq!(mirror.tracks["b"].volume, 0.5, "untouched tracks follow the UI");
        assert!(mirror.tracks["b"].muted);

        let (fields, values) = mirror.take_pending("a").expect("pending");
        assert_eq!(fields, [MixControl::Volume]);
        assert_eq!(values.volume, 0.3);
        mirror.sync(vec![track("a", 0.8)], vec![], None);
        assert_eq!(mirror.tracks["a"].volume, 0.8, "after the commit the UI leads");
        assert!(!mirror.tracks.contains_key("b"), "deleted tracks drop out");
    }

    #[test]
    fn the_patch_accumulates_until_taken() {
        let mut mirror = MixMirror::default();
        mirror.sync(vec![track("a", 1.0)], vec![], None);
        let mut mix = mirror.tracks["a"].clone();
        mix.volume = 0.5;
        mirror.set_track("a", MixControl::Volume, mix.clone());
        mix.muted = true;
        mirror.set_track("a", MixControl::Mute, mix);
        let patch = mirror.take_patch();
        assert_eq!(patch.tracks["a"].volume, Some(0.5));
        assert_eq!(patch.tracks["a"].muted, Some(true));
        assert_eq!(patch.tracks["a"].pan, None);
        assert_eq!(mirror.take_patch(), MixPatch::default());
    }

    #[test]
    fn song_master_keeps_ours_only_for_the_same_song() {
        let mut mirror = MixMirror::default();
        let master = |region: &str, gain: f64| SongMasterSync {
            region_id: region.into(),
            gain,
        };
        mirror.set_song_master(master("r1", 0.5));
        mirror.sync(vec![], vec![], Some(master("r1", 1.0)));
        assert_eq!(mirror.song_master, Some(master("r1", 0.5)));
        mirror.sync(vec![], vec![], Some(master("r2", 1.0)));
        assert_eq!(mirror.song_master, Some(master("r2", 1.0)), "the playhead moved on");
    }
}
