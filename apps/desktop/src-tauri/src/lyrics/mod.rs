//! Lyrics sync with ProPresenter, FreeShow and Holyrics (plan lyrics-sync).
//!
//! The worker (`libretracks_lyrics::worker`) runs on Tauri's async runtime
//! for the whole life of the app; lyrics off is `Configure(None)`. The MIDI
//! thread pushes events to it through `DesktopSession::lyrics`. Settings live
//! in `lyrics.json`; the token in the OS keychain.

pub mod config;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use libretracks_cloud::token::{StoredToken, TokenStore};
use libretracks_core::lyrics_config::{uses_token, LyricsConfig};
use libretracks_core::{LyricsLink, LyricsSoftware, RegionLyrics};
use libretracks_lyrics::clients::Connection;
use libretracks_lyrics::worker::{
    LyricsStatus, LyricsWorker, WorkerConfig, WorkerHost, WorkerInput,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::state::DesktopState;

pub const LYRICS_STATUS_EVENT: &str = "lyrics:status";
/// A song's link changed behind the user's back (found by name): the UI
/// re-reads the song view.
pub const LYRICS_LINK_EVENT: &str = "lyrics:link";

pub struct LyricsService {
    pub config: Mutex<LyricsConfig>,
    sender: UnboundedSender<WorkerInput>,
    pub status: Arc<Mutex<LyricsStatus>>,
    slide_counts: Arc<Mutex<HashMap<String, u32>>>,
}

struct TauriHost {
    app: AppHandle,
    status: Arc<Mutex<LyricsStatus>>,
    slide_counts: Arc<Mutex<HashMap<String, u32>>>,
}

impl WorkerHost for TauriHost {
    fn status(&self, status: &LyricsStatus) {
        if let Ok(mut slot) = self.status.lock() {
            *slot = status.clone();
        }
        let _ = self.app.emit(LYRICS_STATUS_EVENT, status);
    }

    fn link_resolved(&self, region_id: &str, link: LyricsLink) {
        let state = self.app.state::<DesktopState>();
        let Ok(mut session) = state.session.lock() else {
            return;
        };
        if session
            .store_lyrics_link_silently(region_id, link, &state.audio)
            .is_ok()
        {
            let _ = self.app.emit(LYRICS_LINK_EVENT, region_id);
        }
    }

    fn slide_counts(&self, counts: HashMap<String, u32>) {
        if let Ok(mut slot) = self.slide_counts.lock() {
            *slot = counts;
        }
    }
}

/// Keychain entry name of a program's token.
fn token_key(software: LyricsSoftware) -> String {
    format!(
        "lyrics-{}",
        match software {
            LyricsSoftware::ProPresenter => "propresenter",
            LyricsSoftware::FreeShow => "freeshow",
            LyricsSoftware::Holyrics => "holyrics",
            LyricsSoftware::Unknown => "unknown",
        }
    )
}

fn token_store(app: &AppHandle, software: LyricsSoftware) -> Result<Box<dyn TokenStore>, String> {
    let key = token_key(software);
    let _ = app;
    #[cfg(target_os = "android")]
    {
        Ok(Box::new(
            crate::platform::android_token_store::AndroidTokenStore::new(&key),
        ))
    }
    #[cfg(target_os = "ios")]
    {
        Ok(Box::new(crate::platform::ios_token_store::IosTokenStore::new(
            app.clone(),
            &key,
        )))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        libretracks_cloud::keychain::KeychainTokenStore::new(&key)
            .map(|store| Box::new(store) as Box<dyn TokenStore>)
            .map_err(|error| error.to_string())
    }
}

/// The program's token from the keychain (never from `lyrics.json`).
pub fn load_token(app: &AppHandle, software: LyricsSoftware) -> Option<String> {
    let store = token_store(app, software).ok()?;
    store
        .load()
        .ok()
        .flatten()
        .map(|token| token.refresh_token)
        .filter(|token| !token.is_empty())
}

/// Store (or with an empty value, forget) a program's token.
pub fn save_token(app: &AppHandle, software: LyricsSoftware, token: &str) -> Result<(), String> {
    let store = token_store(app, software)?;
    if token.trim().is_empty() {
        return store.clear().map_err(|error| error.to_string());
    }
    store
        .save(&StoredToken {
            refresh_token: token.trim().to_string(),
            access_token: String::new(),
            expires_at_unix: 0,
        })
        .map_err(|error| error.to_string())
}

/// The connection the config describes, with the token from the keychain.
pub fn connection_for(app: &AppHandle, config: &LyricsConfig) -> Option<(LyricsSoftware, Connection)> {
    let software = config.software?;
    let port = config.effective_port()?;
    let token = uses_token(software)
        .then(|| load_token(app, software))
        .flatten();
    Some((
        software,
        Connection {
            host: config.host.trim().to_string(),
            port,
            token,
        },
    ))
}

impl LyricsService {
    /// Push the config to the worker and to the MIDI thread's side.
    pub fn apply(&self, app: &AppHandle) {
        let config = self.config.lock().map(|config| config.clone()).unwrap_or_default();
        let worker_config = if config.enabled {
            connection_for(app, &config).map(|(software, connection)| WorkerConfig {
                software,
                connection,
                clear_on_song_end: config.clear_on_song_end,
                clear_on_stop: config.clear_on_stop,
            })
        } else {
            None
        };
        let on = worker_config.is_some();
        let _ = self.sender.send(WorkerInput::Configure(worker_config));
        let _ = self.sender.send(WorkerInput::Paused(config.paused));
        let state = app.state::<DesktopState>();
        let locked = state.session.lock();
        if let Ok(mut session) = locked {
            session.lyrics.sender = on.then(|| self.sender.clone());
            session.lyrics.lead = config.lead;
            session.lyrics.paused = config.paused;
            session.lyrics.slide_counts = Arc::clone(&self.slide_counts);
            session.lyrics.reset();
            if let Some(song) = session.engine.song() {
                let _ = self.sender.send(WorkerInput::Song(Arc::new(song.clone())));
            }
        }
    }

    pub fn send(&self, input: WorkerInput) {
        let _ = self.sender.send(input);
    }
}

/// Start the worker and apply the saved config. Called once from setup.
pub fn initialize(app: &AppHandle) {
    let (sender, inbox) = unbounded_channel();
    let status = Arc::new(Mutex::new(LyricsStatus::default()));
    let slide_counts = Arc::new(Mutex::new(HashMap::new()));
    let host = Arc::new(TauriHost {
        app: app.clone(),
        status: Arc::clone(&status),
        slide_counts: Arc::clone(&slide_counts),
    });
    tauri::async_runtime::spawn(LyricsWorker::new(host).run(inbox));
    let service = LyricsService {
        config: Mutex::new(config::load(app)),
        sender,
        status,
        slide_counts,
    };
    app.manage(service);
    app.state::<LyricsService>().apply(app);
}

/// A region's lyrics with `link` stored for its program (replacing the old
/// one), created if the song had none.
pub fn with_link(current: Option<RegionLyrics>, link: LyricsLink) -> RegionLyrics {
    let mut lyrics = current.unwrap_or_default();
    match lyrics.link_for_mut(link.software) {
        Some(existing) => {
            existing.presentation_id = link.presentation_id;
            existing.presentation_name = link.presentation_name;
        }
        None => lyrics.links.push(link),
    }
    lyrics
}
