//! The follower's async loop (redundancy step 06): the connection to the
//! main, the 20 ms reconcile tick and the 250 ms status. The decisions are
//! in `follower.rs`; this only feeds them and applies the result.
//!
//! Session lock: never on a tick whose action is `None`/`Freewheel` (local
//! inputs come from the audio clock and the session feed); only to apply a
//! transport action, to flip the local-input lock, and to clone the song when
//! the session changes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use libretracks_core::redundancy::reconciler::PendingJump as CoreJump;
use libretracks_core::Song;
use libretracks_link::{connect_as_backup, GuestConfig, GuestEvent, GuestRuntime, GuestState};
use tauri::{AppHandle, Manager};

use super::follower::{tick, FollowerCore, LocalInputs, SessionTarget, STATUS_INTERVAL, TICK};
use crate::link::redundancy_config;
use crate::link::LinkState;
use crate::session_feed::SessionFeed;
use crate::state::{DesktopState, Forwarder};

/// Running follower, stopped (and the local transport unlocked) on drop.
pub struct FollowerTask {
    task: tauri::async_runtime::JoinHandle<()>,
    app: AppHandle,
    guest: libretracks_link::GuestHandle,
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
    if address.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) {
        format!("ws://{address}")
    } else {
        format!("ws://{address}:{}", libretracks_link::server::DEFAULT_LINK_PORT)
    }
}

pub fn spawn(app: &AppHandle, address: &str, pin: Option<String>) -> Result<FollowerTask, String> {
    let config = redundancy_config::load(app);
    let (device_id, device_name) = {
        let link = app.state::<LinkState>();
        let link_config = link.config.lock().map_err(|_| "state poisoned")?;
        (link_config.device_id.clone(), link_config.device_name.clone())
    };
    let url = main_url(address);
    let token = config.main_tokens.get(&url).cloned();
    let guest = connect_as_backup(GuestConfig {
        device_name,
        platform: std::env::consts::OS.into(),
        app_version: app.package_info().version.to_string(),
        pin,
        remember: true,
        token,
        ..GuestConfig::new(url.clone(), device_id)
    })?;
    let handle = guest.handle.clone();
    let task = tauri::async_runtime::spawn(run(app.clone(), guest, url));
    Ok(FollowerTask {
        task,
        app: app.clone(),
        guest: handle,
    })
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

async fn run(app: AppHandle, mut guest: GuestRuntime, url: String) {
    let config = redundancy_config::load(&app);
    let mut core = FollowerCore::new(
        Default::default(),
        config.manual_offset_ms / 1000.0,
    );
    let origin = guest.handle.clock_origin();
    let now_ns = || Instant::now().saturating_duration_since(origin).as_nanos() as u64;
    let mut song = refresh_session(&app, &mut core);
    let mut feed = app.state::<SessionFeed>().subscribe();
    let mut cache = FeedCache::default();
    let mut ticks = tokio::time::interval(TICK);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut status = tokio::time::interval(STATUS_INTERVAL);
    status.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut refresh_due: Option<tokio::time::Instant> = None;
    let mut fingerprint_unsent = true;
    let mut locked = false;
    let mut target = SessionTarget { app: app.clone() };

    loop {
        tokio::select! {
            event = guest.events.recv() => {
                let Some(event) = event else { break };
                match event {
                    GuestEvent::Redundancy(message) => {
                        let offset = guest.handle.host_offset_ms().map(|ms| ms * 1e6);
                        core.on_message(message, now_ns(), offset, song.as_ref());
                    }
                    GuestEvent::Welcome { token: Some(token), .. } => {
                        let mut config = redundancy_config::load(&app);
                        config.main_tokens.insert(url.clone(), token);
                        redundancy_config::save(&app, &config);
                    }
                    GuestEvent::State(GuestState::Connected) => fingerprint_unsent = true,
                    // Lost, rejected or closed: nothing to do here. The
                    // reconciler sees the silence and freewheels; the backup
                    // keeps playing (never stops for lack of network).
                    _ => {}
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
                    }
                    cache.revisions = Some(revisions);
                }
            }
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
