//! The follower's async loop (redundancy steps 06-07): the connection to
//! the main, the 20 ms reconcile tick, the 250 ms status to the main, the
//! lifecycle commands and the `redundancy:status` events. The decisions are
//! in `follower.rs` and `libretracks_core::redundancy`; this only feeds them
//! and applies the result.
//!
//! Session lock: never on a tick whose action is `None`/`Freewheel` (local
//! inputs come from the audio clock and the session feed); only to apply a
//! transport action, to flip the local-input lock, and to clone the song when
//! the session changes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use libretracks_core::redundancy::lifecycle::{BackupState, StatusThrottle};
use libretracks_core::redundancy::reconciler::PendingJump as CoreJump;
use libretracks_core::Song;
use libretracks_link::redundancy::RedundancyMessage;
use libretracks_link::{connect_as_backup, GuestConfig, GuestEvent, GuestRuntime, GuestState};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, mpsc};

use super::follower::{tick, FollowerCore, LocalInputs, SessionTarget, STATUS_INTERVAL, TICK};
use super::mix::{self, MixSnapshot};
use super::role::publish_status;
use super::status::{backup_state_name, main_lost_midi};
use crate::link::redundancy_config::{self, RedundancyConfig};
use crate::link::LinkState;
use crate::session_feed::SessionFeed;
use crate::state::{DesktopState, Forwarder, IntentOrigin, OriginatedIntent};

/// What the UI asks the running follower.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowerCommand {
    /// «Ahora mando yo».
    TakeCommand,
    FollowAgain,
    /// Copy the main's session here (step 18).
    CopySession,
    CancelCopy,
    /// Use the main's timing settings here (they are per machine, not per
    /// session, and a mismatch keeps the backup from arming).
    AdoptMainTiming,
    /// Ask the main for its song and list what differs, field by field.
    ExplainDiffs,
}

/// Running follower, stopped (and the local transport unlocked) on drop.
pub struct FollowerTask {
    task: tauri::async_runtime::JoinHandle<()>,
    app: AppHandle,
    guest: libretracks_link::GuestHandle,
    commands: mpsc::UnboundedSender<FollowerCommand>,
}

impl FollowerTask {
    pub fn send(&self, command: FollowerCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "follower stopped".to_string())
    }
}

impl Drop for FollowerTask {
    fn drop(&mut self) {
        self.task.abort();
        self.guest.leave();
        set_locked(&self.app, false, None);
    }
}

fn set_locked(app: &AppHandle, locked: bool, forwarder: Option<Forwarder>) {
    let state = app.state::<DesktopState>();
    if let Ok(mut session) = state.session.lock() {
        session.set_transport_locked(locked, forwarder);
    };
}

/// `host:port` or `host` (default link port) → `ws://…`.
pub fn main_url(address: &str) -> String {
    let address = address.trim();
    let address = address
        .strip_prefix("ws://")
        .unwrap_or(address)
        .trim_end_matches('/');
    if address
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
    {
        format!("ws://{address}")
    } else {
        format!("ws://{address}:{}", libretracks_link::server::DEFAULT_LINK_PORT)
    }
}

fn device_identity(app: &AppHandle) -> Result<(String, String), String> {
    let link = app.state::<LinkState>();
    let link_config = link.config.lock().map_err(|_| "state poisoned")?;
    Ok((link_config.device_id.clone(), link_config.device_name.clone()))
}

fn backup_client(
    app: &AppHandle,
    url: &str,
    pin: Option<String>,
    config: &RedundancyConfig,
) -> Result<GuestRuntime, String> {
    let (device_id, device_name) = device_identity(app)?;
    connect_as_backup(GuestConfig {
        device_name,
        platform: std::env::consts::OS.into(),
        app_version: app.package_info().version.to_string(),
        pin,
        remember: true,
        token: config.main_tokens.get(url).cloned(),
        ..GuestConfig::new(url.to_string(), device_id)
    })
}

pub fn spawn(app: &AppHandle, address: &str, pin: Option<String>) -> Result<FollowerTask, String> {
    let config = redundancy_config::load(app);
    let url = main_url(address);
    let guest = backup_client(app, &url, pin, &config)?;
    let handle = guest.handle.clone();
    let (commands, commands_rx) = mpsc::unbounded_channel();
    let intents = app
        .state::<DesktopState>()
        .session
        .lock()
        .map_err(|_| "state poisoned")?
        .subscribe_intents();
    let task = tauri::async_runtime::spawn(run(app.clone(), guest, url, commands_rx, intents));
    Ok(FollowerTask {
        task,
        app: app.clone(),
        guest: handle,
        commands,
    })
}

/// This machine became the main: tell the old one (when it is reachable)
/// that it can become our backup. Connects as a backup only to deliver the
/// offer, then leaves.
pub fn offer_role_change(app: &AppHandle, old_main_address: &str) {
    let config = redundancy_config::load(app);
    let url = main_url(old_main_address);
    let Ok(mut guest) = backup_client(app, &url, None, &config) else {
        return;
    };
    let (_, name) = device_identity(app).unwrap_or_default();
    let address = local_address_hint(app);
    tauri::async_runtime::spawn(async move {
        // The old main may still be down: keep trying for a while.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(5), guest.events.recv()).await {
                Ok(Some(GuestEvent::State(GuestState::Connected))) => {
                    guest.handle.send_redundancy(RedundancyMessage::RoleChange {
                        new_main_name: name.clone(),
                        new_main_address: address.clone(),
                    });
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    break;
                }
                Ok(Some(GuestEvent::State(GuestState::Rejected { .. }))) | Ok(None) => break,
                _ => {}
            }
        }
        guest.handle.leave();
    });
}

/// Why the backup cannot reach its main, for the UI. None while still
/// trying normally.
pub fn connection_error(state: &GuestState) -> Option<String> {
    match state {
        GuestState::Rejected { reason, .. } => serde_json::to_value(reason)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string)),
        // A few failed attempts in a row: the address is wrong, a firewall
        // blocks it, or LibreTracks is not the main over there.
        GuestState::Connecting { attempt } if *attempt >= 3 => Some("unreachable".into()),
        _ => None,
    }
}

/// Where copied sessions live on this machine.
fn copies_root(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("redundancy-sessions"))
}

type CopyReady = (u64, Result<(super::session_copy::CopyJob, super::session_copy::CopyStep), String>);

/// Prepare a copy off the connection's loop: the local copies of files this
/// machine already has can take long, and the loop must keep answering
/// heartbeats meanwhile (or the copy looks like a lost connection).
fn spawn_copy_start(
    app: &AppHandle,
    request_id: u64,
    name: String,
    song_document: String,
    files: Vec<libretracks_link::redundancy::SessionFile>,
    song: Option<Song>,
    progress: Arc<std::sync::Mutex<Option<super::session_copy::CopyProgress>>>,
    ready: mpsc::UnboundedSender<CopyReady>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = |value| {
            if let Ok(mut slot) = progress.lock() {
                *slot = Some(value);
            }
        };
        let result = start_copy(&app, request_id, &name, song_document, &files, song.as_ref(), &report);
        let _ = ready.send((request_id, result));
    });
}

fn start_copy(
    app: &AppHandle,
    request_id: u64,
    name: &str,
    song_document: String,
    files: &[libretracks_link::redundancy::SessionFile],
    song: Option<&Song>,
    report: &dyn Fn(super::session_copy::CopyProgress),
) -> Result<(super::session_copy::CopyJob, super::session_copy::CopyStep), String> {
    let root = copies_root(app).ok_or("no data folder")?;
    let (song_dir, song_file_name) = app
        .state::<DesktopState>()
        .session
        .lock()
        .ok()
        .map(|session| (session.song_dir.clone(), session.song_file_name()))
        .unwrap_or_default();
    let candidates = super::session_copy::local_candidates(song_dir.as_deref(), song);
    // With a session open here, the copy updates it in place (only what
    // differs travels, the document is replaced): it is what the user
    // reopens later. Without one, it goes to its own folder.
    let (target, file_name) = match (song_dir, song_file_name) {
        (Some(dir), Some(file)) => (dir, file),
        _ => (
            super::session_copy::target_dir(&root, name),
            libretracks_project::SONG_FILE_NAME.to_string(),
        ),
    };
    super::session_copy::CopyJob::start_with_progress(
        request_id,
        files,
        song_document,
        target,
        &file_name,
        &candidates,
        report,
    )
}

/// The last copy request sent, to send it again when no answer comes (a
/// message can be dropped when a queue is full; the copy must not hang).
pub struct CopyWatch {
    message: RedundancyMessage,
    sent_at: Instant,
    retries: u32,
}

/// No answer for this long: ask again.
const COPY_RETRY_AFTER: Duration = Duration::from_secs(4);
/// Asked this many times without an answer: the copy fails.
const COPY_MAX_RETRIES: u32 = 5;

impl CopyWatch {
    pub fn new(message: RedundancyMessage) -> Self {
        Self {
            message,
            sent_at: Instant::now(),
            retries: 0,
        }
    }

    /// What to send again now, or Err when it gave up.
    pub fn due(&mut self, now: Instant) -> Result<Option<RedundancyMessage>, ()> {
        if now.duration_since(self.sent_at) < COPY_RETRY_AFTER {
            return Ok(None);
        }
        if self.retries >= COPY_MAX_RETRIES {
            return Err(());
        }
        self.retries += 1;
        self.sent_at = now;
        Ok(Some(self.message.clone()))
    }
}

fn handle_copy_step(
    app: &AppHandle,
    guest: &libretracks_link::GuestHandle,
    step: super::session_copy::CopyStep,
    copy: &mut Option<super::session_copy::CopyJob>,
    requested: &mut Option<u64>,
    watch: &mut Option<CopyWatch>,
) {
    use super::session_copy::CopyStep;
    match step {
        CopyStep::Request(message) => {
            guest.send_redundancy(message.clone());
            *watch = Some(CopyWatch::new(message));
        }
        CopyStep::Done(song_file) => {
            *copy = None;
            *requested = None;
            *watch = None;
            let name = song_file
                .parent()
                .and_then(|dir| dir.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            // Opening saves the current session first: if it is the folder
            // just updated, that save would write the old song over the
            // copied one. Detach it so nothing is saved on the way.
            let detached = app
                .state::<DesktopState>()
                .session
                .lock()
                .ok()
                .and_then(|mut session| session.detach_if_in(song_file.parent()));
            let opened = crate::commands::project::start_open_project_from_path(
                app.clone(),
                song_file.to_string_lossy().to_string(),
            );
            if opened.is_err() {
                if let (Some(dir), Ok(mut session)) = (detached, app.state::<DesktopState>().session.lock()) {
                    session.reattach(dir);
                }
            }
            publish_status(app, |status| {
                status.copy = None;
                match opened {
                    Ok(_) => {
                        status.copy_error = None;
                        status.copy_done = Some(name);
                    }
                    Err(error) => status.copy_error = Some(error),
                }
            });
        }
        CopyStep::Failed(error) => {
            *copy = None;
            *requested = None;
            *watch = None;
            publish_status(app, |status| {
                status.copy = None;
                status.copy_error = Some(error);
            });
        }
    }
}

/// What the main is told when this backup takes over.
pub fn handover_message(app: &AppHandle) -> RedundancyMessage {
    let (_, name) = device_identity(app).unwrap_or_default();
    RedundancyMessage::Handover {
        new_main_name: name,
        new_main_address: local_address_hint(app),
        remote_url: local_remote_url(app),
    }
}

/// This machine's remote (browser) address, when it runs one.
pub fn local_remote_url(app: &AppHandle) -> Option<String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::Manager;
        let state = app.try_state::<crate::remote::RemoteServiceState>()?;
        let origin = state.handle.info().origin.clone();
        return (!origin.is_empty()).then_some(origin);
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        None
    }
}

/// `ip:port` other machines can reach this one at, best effort.
fn local_address_hint(app: &AppHandle) -> Option<String> {
    let port = crate::link::host::with_handle(app, |handle| handle.port())
        .unwrap_or(libretracks_link::server::DEFAULT_LINK_PORT);
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(format!("{}:{port}", socket.local_addr().ok()?.ip()))
}

fn local_inputs(app: &AppHandle, origin: Instant, feed: &FeedCache) -> LocalInputs {
    let state = app.state::<DesktopState>();
    let clock = state.audio.audio_clock_reading().and_then(|reading| {
        libretracks_core::audio_clock::AudioClockSample::from_engine(
            reading.frame,
            reading.sample_rate,
            reading.callback_age_ns,
            Instant::now().saturating_duration_since(origin).as_nanos() as u64,
            reading.moving,
            reading.output_latency_samples,
        )
    });
    LocalInputs {
        clock,
        vamp: feed.vamp,
        pending_jump: feed.pending_jump.clone(),
    }
}

/// What the latest session-feed frame says about the backup's own session.
#[derive(Default)]
struct FeedCache {
    vamp: bool,
    pending_jump: Option<CoreJump>,
    revisions: Option<(u64, u64, u64)>,
}

/// Song + fingerprint, cloned under the lock, hashed after.
fn refresh_session(app: &AppHandle, core: &mut FollowerCore) -> Option<Song> {
    let state = app.state::<DesktopState>();
    let source = state.session.lock().ok()?.fingerprint_source()?;
    let settings = state.audio.current_settings().ok()?;
    core.set_own_fingerprint(super::fingerprint::compute(&source, &settings));
    Some(source.song)
}

/// The main's song document against this machine's song, field by field.
fn explain_differences(app: &AppHandle, song_document: &str) -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct Document {
        song: Song,
    }
    let main = match serde_json::from_str::<Document>(song_document) {
        Ok(document) => document.song,
        Err(error) => return vec![format!("No se pudo leer la canción del principal: {error}")],
    };
    let Some(own) = app
        .state::<DesktopState>()
        .session
        .lock()
        .ok()
        .and_then(|session| session.engine.song().cloned())
    else {
        return vec!["No hay sesión abierta en este equipo.".into()];
    };
    let mut lines = libretracks_core::session_fingerprint::explain_song_differences(&main, &own, 60);
    if lines.is_empty() {
        lines.push("Las canciones coinciden; si siguen saliendo distintas, la diferencia está en las automatizaciones o en el tamaño de los audios.".into());
    }
    lines
}

/// Write the main's timing settings into this machine's settings.
fn adopt_timing(app: &AppHandle, timing: &std::collections::BTreeMap<String, String>) {
    let state = app.state::<DesktopState>();
    let store = app.state::<crate::infra::settings::AppSettingsStore>();
    let Ok(mut settings) = store.current() else {
        return;
    };
    if !super::fingerprint::apply_timing(&mut settings, timing) {
        return;
    }
    let Ok(mut session) = state.session.lock() else {
        return;
    };
    if let Ok(saved) = session.update_audio_settings(settings, &state.audio) {
        drop(session);
        let _ = store.set(saved.clone());
        let _ = crate::infra::settings::save_app_settings(app, &saved);
        let _ = tauri::Emitter::emit(app, "settings:updated", saved);
    }
}

/// Apply the main's mix messages to this session (step 09). Live changes go
/// to the engine; a whole snapshot is committed (model and settings) where
/// it differs. Never touches the transport. Returns the main's last whole
/// mix when one arrived.
fn apply_mix(
    app: &AppHandle,
    batches: Vec<(bool, Vec<libretracks_link::redundancy::MixControl>)>,
) -> Option<MixSnapshot> {
    use libretracks_link::redundancy::MixControl;
    let state = app.state::<DesktopState>();
    let store = app.state::<crate::infra::settings::AppSettingsStore>();
    let mut latest_full = None;
    let mut session = state.session.lock().ok()?;
    for (full, controls) in batches {
        let mut settings = store.current().ok()?;
        let mut settings_changed = false;
        for control in &controls {
            match control {
                MixControl::Track { .. } | MixControl::SongMaster { .. } => {
                    let _ = mix::apply_to_session(&mut session, &state.audio, control, full);
                }
                MixControl::Metronome { enabled, volume } if !full => {
                    if let Some(enabled) = enabled {
                        let _ = state.audio.set_metronome_enabled_realtime(*enabled);
                    }
                    if let Some(volume) = volume {
                        let _ = state.audio.set_metronome_volume_realtime(*volume);
                    }
                }
                MixControl::VoiceGuide { volume, .. } if !full => {
                    if let Some(volume) = volume {
                        let _ = state.audio.set_voice_guide_volume_realtime(*volume);
                    }
                }
                _ => settings_changed |= mix::apply_to_settings(&mut settings, control),
            }
        }
        if settings_changed {
            if let Ok(saved) = session.update_audio_settings(settings, &state.audio) {
                let _ = store.set(saved.clone());
                let _ = crate::infra::settings::save_app_settings(app, &saved);
                let _ = tauri::Emitter::emit(app, "settings:updated", saved);
            }
        }
        if full {
            latest_full = Some(MixSnapshot::from_controls(&controls));
        }
    }
    latest_full
}

/// Whether this session's mix differs from the main's last whole mix.
fn local_mix_diverged(app: &AppHandle, main_mix: &MixSnapshot) -> bool {
    let state = app.state::<DesktopState>();
    let Some(song) = state
        .session
        .lock()
        .ok()
        .and_then(|session| session.engine.song().cloned())
    else {
        return false;
    };
    let Ok(settings) = app.state::<crate::infra::settings::AppSettingsStore>().current() else {
        return false;
    };
    !MixSnapshot::from_song(&song, &settings).matches(main_mix)
}

fn engine_sample_rate(app: &AppHandle) -> u32 {
    app.state::<DesktopState>()
        .audio
        .audio_clock_reading()
        .map_or(0, |reading| reading.sample_rate)
}

async fn run(
    app: AppHandle,
    mut guest: GuestRuntime,
    url: String,
    mut commands: mpsc::UnboundedReceiver<FollowerCommand>,
    mut intents: broadcast::Receiver<OriginatedIntent>,
) {
    let config = redundancy_config::load(&app);
    let policy = libretracks_core::redundancy::reconciler::Policy {
        correction_threshold_seconds: config
            .correction_threshold_ms
            .unwrap_or(super::settings::DEFAULT_CORRECTION_THRESHOLD_MS)
            / 1000.0,
        ..Default::default()
    };
    let mut core = FollowerCore::new(policy, config.manual_offset_ms / 1000.0);
    if config.heartbeat_timeout_ms > 0 {
        core.set_heartbeat_timeout_ms(config.heartbeat_timeout_ms);
    }
    let origin = guest.handle.clock_origin();
    let now_ns = || Instant::now().saturating_duration_since(origin).as_nanos() as u64;
    let mut song = refresh_session(&app, &mut core);
    let mut feed = app.state::<SessionFeed>().subscribe();
    let mut cache = FeedCache::default();
    let mut ticks = tokio::time::interval(TICK);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut status = tokio::time::interval(STATUS_INTERVAL);
    status.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut throttle = StatusThrottle::four_hz();
    let mut refresh_due: Option<tokio::time::Instant> = None;
    let mut fingerprint_unsent = true;
    let mut locked = false;
    let mut target = SessionTarget { app: app.clone() };
    let mut main_mix: Option<MixSnapshot> = None;
    let mut copy: Option<super::session_copy::CopyJob> = None;
    let mut copy_requested: Option<u64> = None;
    let mut copy_ids = 0u64;
    let preparing: Arc<std::sync::Mutex<Option<super::session_copy::CopyProgress>>> = Arc::default();
    let (ready_tx, mut ready_rx) = mpsc::unbounded_channel::<CopyReady>();
    let mut copy_watch: Option<CopyWatch> = None;
    let mut explain_requested: Option<u64> = None;

    loop {
        let mut state_changed = false;
        tokio::select! {
            event = guest.events.recv() => {
                let Some(event) = event else { break };
                match event {
                    GuestEvent::Redundancy(RedundancyMessage::GuestAccess { control_pin, edit_pin, trusted }) => {
                        super::failover::store_replicated_access(&app, super::failover::GuestAccess {
                            control_pin,
                            edit_pin,
                            trusted,
                        });
                    }
                    GuestEvent::Redundancy(RedundancyMessage::SessionManifest { request_id, name, song_document, files }) => {
                        if explain_requested == Some(request_id) {
                            explain_requested = None;
                            let lines = explain_differences(&app, &song_document);
                            publish_status(&app, |status| status.diff_details = Some(lines));
                        } else if copy_requested == Some(request_id) && copy.is_none() && copy_watch.is_some() {
                            // Preparing now: a repeated manifest is ignored.
                            copy_watch = None;
                            spawn_copy_start(
                                &app,
                                request_id,
                                name,
                                song_document,
                                files,
                                song.clone(),
                                preparing.clone(),
                                ready_tx.clone(),
                            );
                        }
                    }
                    GuestEvent::Redundancy(RedundancyMessage::FileChunk { request_id, path, offset, data, error }) => {
                        if let Some(job) = copy
                            .as_mut()
                            .filter(|job| job.request_id == request_id && job.expects(&path, offset))
                        {
                            let step = job.on_chunk(&path, offset, &data, error.as_deref());
                            handle_copy_step(&app, &guest.handle, step, &mut copy, &mut copy_requested, &mut copy_watch);
                        }
                    }
                    GuestEvent::Redundancy(message) => {
                        let offset = guest.handle.host_offset_ms().map(|ms| ms * 1e6);
                        core.on_message(message, now_ns(), offset, song.as_ref());
                    }
                    GuestEvent::Welcome { token: Some(token), .. } => {
                        let mut config = redundancy_config::load(&app);
                        config.main_tokens.insert(url.clone(), token);
                        redundancy_config::save(&app, &config);
                    }
                    GuestEvent::State(GuestState::Connected) => {
                        fingerprint_unsent = true;
                        core.set_connected(true);
                        publish_status(&app, |status| status.connection_error = None);
                        // Where the main's clients can find this machine (step 16-17).
                        guest.handle.send_redundancy(RedundancyMessage::BackupInfo {
                            link_address: local_address_hint(&app),
                            remote_url: local_remote_url(&app),
                        });
                    }
                    // Lost, rejected or closed: the lifecycle sees the silence
                    // and the reconciler freewheels. The backup keeps playing
                    // (never stops for lack of network). A copy in progress
                    // stops here; nothing half-copied is opened.
                    GuestEvent::State(state) => {
                        core.set_connected(false);
                        if let Some(error) = connection_error(&state) {
                            publish_status(&app, |status| status.connection_error = Some(error));
                        }
                        copy_watch = None;
                        if copy.take().is_some() || copy_requested.take().is_some() {
                            publish_status(&app, |status| {
                                status.copy = None;
                                status.copy_error = Some("connectionLost".into());
                            });
                        }
                    }
                    _ => {}
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break };
                match command {
                    FollowerCommand::TakeCommand => {
                        // Lost main or planned handover: tell the main if it
                        // still hears us (it turns its tone off and sends its
                        // clients here, step 15).
                        if core.take_command().is_some() {
                            guest.handle.send_redundancy(handover_message(&app));
                        }
                    }
                    FollowerCommand::FollowAgain => { core.follow_again(); }
                    FollowerCommand::CopySession => {
                        copy_ids += 1;
                        copy = None;
                        copy_requested = Some(copy_ids);
                        let request = RedundancyMessage::SessionRequest { request_id: copy_ids };
                        guest.handle.send_redundancy(request.clone());
                        copy_watch = Some(CopyWatch::new(request));
                        publish_status(&app, |status| {
                            status.copy = Some(Default::default());
                            status.copy_error = None;
                            status.copy_done = None;
                        });
                    }
                    FollowerCommand::CancelCopy => {
                        copy = None;
                        copy_requested = None;
                        copy_watch = None;
                        publish_status(&app, |status| status.copy = None);
                    }
                    FollowerCommand::ExplainDiffs => {
                        copy_ids += 1;
                        explain_requested = Some(copy_ids);
                        guest.handle.send_redundancy(RedundancyMessage::SessionRequest { request_id: copy_ids });
                        publish_status(&app, |status| status.diff_details = Some(Vec::new()));
                    }
                    FollowerCommand::AdoptMainTiming => {
                        if let Some(timing) = core.main_timing() {
                            adopt_timing(&app, &timing);
                            song = refresh_session(&app, &mut core).or(song);
                            fingerprint_unsent = true;
                        }
                    }
                }
            }
            intent = intents.recv() => {
                // The operator moved the transport while it was unlocked
                // (main lost): following again is no longer automatic.
                if let Ok(intent) = intent {
                    if intent.origin != IntentOrigin::Follower {
                        core.local_order();
                    }
                }
            }
            _ = ticks.tick() => {
                let local = local_inputs(&app, origin, &cache);
                tick(&mut core, &mut target, now_ns(), &local, song.as_ref());
                let should_lock = core.locks_local_inputs();
                if should_lock != locked {
                    locked = should_lock;
                    let forwarder = (config.forward_local_inputs_to_main && core.main_may_forward)
                        .then(|| forwarder(guest.handle.clone()));
                    set_locked(&app, locked, forwarder);
                }
                if refresh_due.is_some_and(|due| tokio::time::Instant::now() >= due) {
                    refresh_due = None;
                    song = refresh_session(&app, &mut core).or(song);
                    fingerprint_unsent = true;
                }
                if let Some(watch) = copy_watch.as_mut() {
                    match watch.due(Instant::now()) {
                        Ok(Some(message)) => {
                            guest.handle.send_redundancy(message);
                        }
                        Ok(None) => {}
                        Err(()) => {
                            copy_watch = None;
                            copy = None;
                            copy_requested = None;
                            publish_status(&app, |status| {
                                status.copy = None;
                                status.copy_error = Some("noAnswer".into());
                            });
                        }
                    }
                }
                // No session here yet (or it was opened after connecting):
                // look again every second instead of waiting for a change.
                if !core.has_own_fingerprint() && refresh_due.is_none() {
                    refresh_due = Some(tokio::time::Instant::now() + Duration::from_secs(1));
                }
            }
            Some((request_id, result)) = ready_rx.recv() => {
                if let Ok(mut slot) = preparing.lock() {
                    *slot = None;
                }
                if copy_requested == Some(request_id) {
                    let step = result
                        .map(|(job, step)| {
                            copy = Some(job);
                            step
                        })
                        .unwrap_or_else(super::session_copy::CopyStep::Failed);
                    handle_copy_step(&app, &guest.handle, step, &mut copy, &mut copy_requested, &mut copy_watch);
                }
            }
            _ = status.tick() => {
                if guest.handle.send_redundancy(core.status(fingerprint_unsent)) {
                    fingerprint_unsent = false;
                }
            }
            changed = feed.changed() => {
                if changed.is_err() { continue }
                let frame = feed.borrow_and_update().clone();
                if let Some(snapshot) = frame.snapshot.as_deref() {
                    cache.vamp = snapshot.active_vamp.is_some();
                    cache.pending_jump = snapshot.pending_marker_jump.as_ref().map(|jump| CoreJump {
                        target: format!("marker:{}", jump.target_marker_id),
                        trigger: jump.trigger.clone(),
                        bars: None,
                        transition: Some(jump.transition.clone()),
                        duration_seconds: None,
                        execute_at_seconds: Some(song.as_ref().map_or(jump.execute_at_seconds, |song| {
                            libretracks_core::warp::source_seconds_at_view(song, jump.execute_at_seconds)
                        })),
                        target_seconds: None,
                    });
                    let revisions = (snapshot.project_revision, snapshot.mix_revision, frame.settings_seq);
                    if cache.revisions.is_some_and(|last| last != revisions) {
                        refresh_due = Some(tokio::time::Instant::now() + Duration::from_secs(1));
                        // A local mix change shows as a divergence until the
                        // main's next whole mix overwrites it.
                        if let Some(main_mix) = &main_mix {
                            core.set_mix_diverged(local_mix_diverged(&app, main_mix));
                        }
                    }
                    cache.revisions = Some(revisions);
                }
            }
        }

        let batches = core.take_mix();
        if !batches.is_empty() {
            if let Some(full) = apply_mix(&app, batches) {
                core.set_mix_diverged(local_mix_diverged(&app, &full));
                main_mix = Some(full);
            }
        }
        if let Some(transition) = core.take_transition() {
            state_changed = true;
            if super::failover::hosts_for_failover(transition.to)
                && !super::failover::hosts_for_failover(transition.from)
            {
                super::failover::start_hosting_for_failover(&app);
            }
            if let Some(message) = main_lost_midi(&transition, &config.on_main_lost_midi) {
                app.state::<DesktopState>().midi_output.send(&[message]);
            }
            if matches!(transition.to, BackupState::MainLost { .. }) {
                crate::infra::crash_report::breadcrumb("redundancy: main lost");
            }
        }
        if throttle.should_emit(now_ns(), state_changed) {
            let copy_progress = copy.as_ref().map(|job| job.progress).or_else(|| {
                copy_requested.and_then(|_| preparing.lock().ok().and_then(|slot| *slot))
            });
            let main_rate = core.main_sample_rate();
            let own_rate = engine_sample_rate(&app);
            publish_status(&app, |status| {
                status.state = backup_state_name(core.lifecycle_state()).into();
                status.offset_ms = core.last_offset_seconds().map(|offset| offset * 1000.0);
                status.corrections = core.corrections;
                status.other_name = core.main_name().map(str::to_string);
                status.diffs = core.diffs().to_vec();
                status.reason = core.last_reason().into();
                status.sample_rate_differs = main_rate > 0 && own_rate > 0 && main_rate != own_rate;
                status.waiting_for = core.waiting_for().map(str::to_string);
                if copy_progress.is_some() {
                    status.copy = copy_progress;
                }
            });
        }
    }
}

/// Send a local order to the main (the main applies it as a link command
/// and it comes back as an intent).
fn forwarder(guest: libretracks_link::GuestHandle) -> Forwarder {
    Arc::new(move |command| {
        let guest = guest.clone();
        tauri::async_runtime::spawn(async move {
            let _ = guest.send_command(command, None).await;
        });
    })
}
