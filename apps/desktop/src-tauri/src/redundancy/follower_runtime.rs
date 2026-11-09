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

fn start_copy(
    app: &AppHandle,
    request_id: u64,
    name: &str,
    song_document: String,
    files: &[libretracks_link::redundancy::SessionFile],
    song: Option<&Song>,
) -> Result<(super::session_copy::CopyJob, super::session_copy::CopyStep), String> {
    let root = copies_root(app).ok_or("no data folder")?;
    let song_dir = app
        .state::<DesktopState>()
        .session
        .lock()
        .ok()
        .and_then(|session| session.song_dir.clone());
    let candidates = super::session_copy::local_candidates(song_dir.as_deref(), song);
    super::session_copy::CopyJob::start(
        request_id,
        files,
        song_document,
        super::session_copy::target_dir(&root, name),
        &candidates,
    )
}

fn handle_copy_step(
    app: &AppHandle,
    guest: &libretracks_link::GuestHandle,
    step: super::session_copy::CopyStep,
    copy: &mut Option<super::session_copy::CopyJob>,
    requested: &mut Option<u64>,
) {
    use super::session_copy::CopyStep;
    match step {
        CopyStep::Request(message) => {
            guest.send_redundancy(message);
        }
        CopyStep::Done(song_file) => {
            *copy = None;
            *requested = None;
            publish_status(app, |status| {
                status.copy = None;
                status.copy_error = None;
            });
            let _ = crate::commands::project::start_open_project_from_path(
                app.clone(),
                song_file.to_string_lossy().to_string(),
            );
        }
        CopyStep::Failed(error) => {
            *copy = None;
            *requested = None;
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
                        if copy_requested == Some(request_id) {
                            let step = start_copy(&app, request_id, &name, song_document, &files, song.as_ref())
                                .map(|(job, step)| {
                                    copy = Some(job);
                                    step
                                })
                                .unwrap_or_else(super::session_copy::CopyStep::Failed);
                            handle_copy_step(&app, &guest.handle, step, &mut copy, &mut copy_requested);
                        }
                    }
                    GuestEvent::Redundancy(RedundancyMessage::FileChunk { request_id, path, offset, data, error }) => {
                        if let Some(job) = copy.as_mut().filter(|job| job.request_id == request_id) {
                            let step = job.on_chunk(&path, offset, &data, error.as_deref());
                            handle_copy_step(&app, &guest.handle, step, &mut copy, &mut copy_requested);
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
                        guest.handle.send_redundancy(RedundancyMessage::SessionRequest { request_id: copy_ids });
                        publish_status(&app, |status| {
                            status.copy = Some(Default::default());
                            status.copy_error = None;
                        });
                    }
                    FollowerCommand::CancelCopy => {
                        copy = None;
                        copy_requested = None;
                        publish_status(&app, |status| status.copy = None);
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
                // No session here yet (or it was opened after connecting):
                // look again every second instead of waiting for a change.
                if !core.has_own_fingerprint() && refresh_due.is_none() {
                    refresh_due = Some(tokio::time::Instant::now() + Duration::from_secs(1));
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
            let copy_progress = copy.as_ref().map(|job| job.progress);
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
