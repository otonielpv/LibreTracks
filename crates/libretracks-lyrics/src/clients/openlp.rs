//! OpenLP 3 remote API (Settings › Remote, port 4316): JSON over HTTP under
//! `/api/v2/`, plus a WebSocket that pushes the screen's state.
//!
//! OpenLP only gives the slides of the LIVE item: the service list and the
//! song search carry titles and ids, nothing else. So a presentation is
//! read when it is live, or by putting it live for a moment while the
//! screen shows no text (blank, theme or desktop, or nothing live), then
//! putting back what was there; and when a song starts, which is when
//! LibreTracks takes the screen anyway. What was read is kept, so a busy
//! screen later on still has the plan.
//!
//! Presentations are the items of the open service (`service/items`), by
//! their uuid. Auth, when enabled in OpenLP: `POST core/login` with the
//! user and password gives a token, sent as the bare `Authorization` header.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use reqwest::Method;
use serde_json::{json, Value};

use super::{text, CurrentSlide, Http, LyricsClient, Presentation, ProbeInfo, Reply};
use crate::plan::LyricsCommand;
use crate::structure::{parse_openlp, LyricsStructure};
use crate::LyricsError;

/// User OpenLP proposes when the login is turned on.
const DEFAULT_USER: &str = "openlp";
/// After `service/show` the live controller changes in OpenLP's UI thread:
/// how long to wait for `live-items` to show the new item.
const GO_LIVE_POLLS: u32 = 12;
const GO_LIVE_POLL: Duration = Duration::from_millis(50);

/// From black (or theme) to a slide: the slide changes under the black
/// screen, and the black goes once its transition is over (Reveal's normal
/// speed, what OpenLP themes use by default). Lifting it at once showed the
/// transition half done.
const UNBLANK_AFTER: Duration = Duration::from_millis(800);

/// The service item kinds that carry lyrics.
const TEXT_PLUGINS: &[&str] = &["songs", "custom"];

/// What the screen shows, from the WebSocket state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScreenState {
    /// Blank, theme only or desktop: no text on the screen.
    pub no_text: bool,
    /// The `core/display` mode that puts the screen back as it is.
    pub mode: &'static str,
}

/// The HTTP calls with OpenLP's login: cloneable, for the delayed unblank.
#[derive(Clone)]
struct Api {
    http: Http,
    /// From `core/login`; `None` until OpenLP asks for one.
    token: Arc<Mutex<Option<String>>>,
}

pub struct OpenLpClient {
    api: Api,
    /// Structures read while their item was live, by item uuid.
    cache: Mutex<HashMap<String, LyricsStructure>>,
    /// LibreTracks hid the text (theme or blank): the next slide shows the
    /// screen again. Starts true so the first slide always shows it.
    text_hidden: AtomicBool,
    /// Counts every time the text is hidden: a delayed unblank only goes
    /// out if nothing hid the text again while it waited.
    hides: Arc<AtomicU64>,
    /// The item LibreTracks put live last.
    live: Mutex<Option<String>>,
    may_take_screen: AtomicBool,
}

impl Api {
    /// `user:password`, or a bare password for OpenLP's default user.
    fn credentials(&self) -> Option<(String, String)> {
        let secret = self.http.connection.token.as_deref()?.trim();
        if secret.is_empty() {
            return None;
        }
        Some(match secret.split_once(':') {
            Some((user, password)) if !user.trim().is_empty() => {
                (user.trim().to_string(), password.to_string())
            }
            _ => (DEFAULT_USER.to_string(), secret.to_string()),
        })
    }

    async fn login(&self) -> Result<(), LyricsError> {
        let Some((username, password)) = self.credentials() else {
            return Err(LyricsError::Unauthorized { missing: vec![] });
        };
        let request = self
            .http
            .post("/api/v2/core/login")
            .json(&json!({ "username": username, "password": password }));
        let reply = self.http.execute(request).await?;
        let token = match reply.status {
            200..=299 => text(reply.body.get("token")),
            _ => None,
        };
        match token {
            Some(token) => {
                *self.token.lock().unwrap() = Some(token);
                Ok(())
            }
            None => Err(LyricsError::Unauthorized { missing: vec![] }),
        }
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Reply, LyricsError> {
        let mut logged_in = false;
        loop {
            let mut request = self.http.request(method.clone(), &format!("/api/v2/{path}"));
            if let Some(body) = &body {
                request = request.json(body);
            }
            if let Some(token) = self.token.lock().unwrap().clone() {
                request = request.header(reqwest::header::AUTHORIZATION, token);
            }
            let reply = self.http.execute(request).await?;
            match reply.status {
                200..=299 => return Ok(reply),
                // The token is missing or old (OpenLP restarted): log in once.
                401 | 403 if !logged_in => {
                    self.login().await?;
                    logged_in = true;
                }
                401 | 403 => return Err(LyricsError::Unauthorized { missing: vec![] }),
                404 => {
                    return Err(LyricsError::NotFound {
                        what: path.to_string(),
                    })
                }
                status => {
                    return Err(LyricsError::unexpected(format!(
                        "OpenLP respondió {status} a {path}"
                    )))
                }
            }
        }
    }

    async fn get(&self, path: &str) -> Result<Value, LyricsError> {
        Ok(self.call(Method::GET, path, None).await?.body)
    }

    async fn post(&self, path: &str, body: Value) -> Result<Duration, LyricsError> {
        Ok(self.call(Method::POST, path, Some(body)).await?.elapsed)
    }

    async fn display(&self, mode: &str) -> Result<Duration, LyricsError> {
        self.post("core/display", json!({ "display": mode })).await
    }
}

impl OpenLpClient {
    pub(crate) fn new(http: Http) -> Self {
        Self {
            api: Api {
                http,
                token: Arc::new(Mutex::new(None)),
            },
            cache: Mutex::new(HashMap::new()),
            text_hidden: AtomicBool::new(true),
            hides: Arc::new(AtomicU64::new(0)),
            live: Mutex::new(None),
            may_take_screen: AtomicBool::new(false),
        }
    }

    async fn get(&self, path: &str) -> Result<Value, LyricsError> {
        self.api.get(path).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Duration, LyricsError> {
        self.api.post(path, body).await
    }

    async fn display(&self, mode: &str) -> Result<Duration, LyricsError> {
        self.api.display(mode).await
    }

    async fn login(&self) -> Result<(), LyricsError> {
        self.api.login().await
    }

    /// The text is off the screen (theme, blank): the next slide lifts it.
    fn mark_hidden(&self) {
        self.hides.fetch_add(1, Ordering::SeqCst);
        self.text_hidden.store(true, Ordering::SeqCst);
    }

    /// The live item with all its slides; `Null` when nothing is live
    /// (OpenLP answers `{}`).
    async fn live_item(&self) -> Result<Value, LyricsError> {
        let item = self.get("controller/live-items").await?;
        Ok(if item.get("id").and_then(|id| text(Some(id))).is_some() {
            item
        } else {
            Value::Null
        })
    }

    async fn service_items(&self) -> Result<Vec<Value>, LyricsError> {
        let items = self.get("service/items").await?;
        Ok(items.as_array().cloned().unwrap_or_default())
    }

    fn remember(&self, structure: &LyricsStructure) {
        self.cache
            .lock()
            .unwrap()
            .insert(structure.presentation_id.clone(), structure.clone());
    }

    /// The screen's state from OpenLP's WebSocket (its first message on
    /// connecting). `None` when it cannot be read.
    async fn screen_state(&self) -> Option<ScreenState> {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;

        let system = self.get("core/system").await.ok()?;
        let port = system.get("websocket_port").and_then(Value::as_u64)?;
        let base = self.api.http.connection.base_url();
        let host = base.trim_start_matches("http://").rsplit_once(':')?.0.to_string();
        let url = format!("ws://{host}:{port}/state");
        let read = async {
            let (mut socket, _) = tokio_tungstenite::connect_async(url).await.ok()?;
            while let Some(message) = socket.next().await {
                if let Message::Text(body) = message.ok()? {
                    let _ = socket.close(None).await;
                    return serde_json::from_str::<Value>(&body).ok();
                }
            }
            None
        };
        let state = tokio::time::timeout(super::REQUEST_TIMEOUT, read).await.ok()??;
        Some(screen_state_from(&state))
    }

    /// Put `id` live, read it and leave the screen as it was. `live` is what
    /// was live before (`Null` = nothing); `screen` its display mode, when
    /// known.
    async fn borrow(
        &self,
        id: &str,
        live: &Value,
        screen: Option<ScreenState>,
        take: bool,
    ) -> Result<LyricsStructure, LyricsError> {
        let previous = live.get("id").and_then(|id| text(Some(id)));
        let previous_slide = selected_slide(live);
        // A starting song keeps the screen; otherwise it is only borrowed
        // when no text shows, so hiding the text changes nothing visible.
        self.display("theme").await?;
        self.mark_hidden();
        self.post("service/show", json!({ "id": id })).await?;
        *self.live.lock().unwrap() = Some(id.to_string());
        let mut read = None;
        for _ in 0..GO_LIVE_POLLS {
            let item = self.live_item().await?;
            if item.get("id").and_then(|id| text(Some(id))).as_deref() == Some(id) {
                read = Some(parse_openlp(&item)?);
                break;
            }
            tokio::time::sleep(GO_LIVE_POLL).await;
        }
        if !take {
            // Back to what was live (on the slide it was on), or nothing.
            let restored = match &previous {
                Some(previous) => self
                    .post("service/show", json!({ "id": previous }))
                    .await
                    .is_ok(),
                None => false,
            };
            if restored {
                if let Some(slide) = previous_slide {
                    let _ = self.post("controller/show", json!({ "id": slide })).await;
                }
            } else {
                let _ = self.post("controller/clear/live", json!({})).await;
            }
            // The display as it was. Unknown only when nothing was live:
            // showing it shows nothing.
            let mode = screen.map_or("show", |screen| screen.mode);
            if mode != "theme" {
                let _ = self.display(mode).await;
            }
            if mode == "show" {
                self.text_hidden.store(false, Ordering::SeqCst);
            } else {
                self.mark_hidden();
            }
            *self.live.lock().unwrap() = previous;
        }
        let structure = read.ok_or_else(|| {
            LyricsError::unexpected("OpenLP no puso la canción en vivo a tiempo")
        })?;
        self.remember(&structure);
        Ok(structure)
    }

    /// Make sure `id` is the live item before changing its slide.
    async fn ensure_live(&self, id: &str) -> Result<Duration, LyricsError> {
        if self.live.lock().unwrap().as_deref() == Some(id) {
            return Ok(Duration::ZERO);
        }
        let elapsed = self.post("service/show", json!({ "id": id })).await?;
        *self.live.lock().unwrap() = Some(id.to_string());
        Ok(elapsed)
    }

    async fn show_slide(&self, id: &str, body: (&str, Value)) -> Result<Duration, LyricsError> {
        let mut elapsed = self.ensure_live(id).await?;
        elapsed += self.post(body.0, body.1).await?;
        // The slide first, then the screen once its transition is over, in
        // the background so the next orders do not wait. Hiding the text
        // again meanwhile (a short section, a stop) cancels it.
        if self.text_hidden.swap(false, Ordering::SeqCst) {
            let api = self.api.clone();
            let hides = Arc::clone(&self.hides);
            let at = hides.load(Ordering::SeqCst);
            tokio::spawn(async move {
                tokio::time::sleep(UNBLANK_AFTER).await;
                if hides.load(Ordering::SeqCst) == at {
                    let _ = api.display("show").await;
                }
            });
        }
        Ok(elapsed)
    }
}

/// The WebSocket state: `{"results": {"blank", "theme", "display", …}}`
/// (`display` is "desktop shown", despite its name).
pub(crate) fn screen_state_from(state: &Value) -> ScreenState {
    let results = state.get("results").unwrap_or(state);
    let flag = |key: &str| results.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mode = if flag("blank") {
        "blank"
    } else if flag("theme") {
        "theme"
    } else if flag("display") {
        "desktop"
    } else {
        "show"
    };
    ScreenState {
        no_text: mode != "show",
        mode,
    }
}

/// The 0-based position of the selected slide of a `live-items` answer.
fn selected_slide(item: &Value) -> Option<u32> {
    item.get("slides")?
        .as_array()?
        .iter()
        .position(|slide| slide.get("selected").and_then(Value::as_bool) == Some(true))
        .map(|position| position as u32)
}

#[async_trait]
impl LyricsClient for OpenLpClient {
    fn software(&self) -> LyricsSoftware {
        LyricsSoftware::OpenLp
    }

    async fn probe(&self) -> Result<ProbeInfo, LyricsError> {
        let system = self.get("core/system").await?;
        let revision = system.get("api_revision").and_then(Value::as_u64);
        if system.get("login_required").and_then(Value::as_bool) == Some(true)
            && self.api.token.lock().unwrap().is_none()
        {
            self.login().await?;
        }
        let presentations = self.list_presentations().await?.len();
        Ok(ProbeInfo {
            version: match revision {
                Some(revision) => format!("OpenLP (API 2.{revision})"),
                None => "OpenLP".into(),
            },
            presentations,
        })
    }

    async fn list_presentations(&self) -> Result<Vec<Presentation>, LyricsError> {
        Ok(self
            .service_items()
            .await?
            .iter()
            .filter(|item| {
                item.get("plugin")
                    .and_then(Value::as_str)
                    .is_none_or(|plugin| TEXT_PLUGINS.contains(&plugin))
            })
            .filter_map(|item| {
                Some(Presentation {
                    id: text(item.get("id"))?,
                    name: text(item.get("title"))?,
                })
            })
            .collect())
    }

    async fn structure(&self, presentation_id: &str) -> Result<LyricsStructure, LyricsError> {
        let in_service = self
            .service_items()
            .await?
            .iter()
            .any(|item| text(item.get("id")).as_deref() == Some(presentation_id));
        if !in_service {
            return Err(LyricsError::NotFound {
                what: presentation_id.to_string(),
            });
        }
        let live = self.live_item().await?;
        if live.get("id").and_then(|id| text(Some(id))).as_deref() == Some(presentation_id) {
            let structure = parse_openlp(&live)?;
            self.remember(&structure);
            return Ok(structure);
        }
        let take = self.may_take_screen.load(Ordering::SeqCst);
        if !take {
            if let Some(cached) = self.cache.lock().unwrap().get(presentation_id) {
                return Ok(cached.clone());
            }
        }
        let screen = if take { None } else { self.screen_state().await };
        let free = take || live.is_null() || screen.is_some_and(|state| state.no_text);
        if !free {
            if let Some(cached) = self.cache.lock().unwrap().get(presentation_id) {
                return Ok(cached.clone());
            }
            return Err(LyricsError::Busy {
                detail: "OpenLP está proyectando otra cosa: la canción se leerá cuando la pantalla quede sin texto".into(),
            });
        }
        self.borrow(presentation_id, &live, screen, take).await
    }

    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError> {
        match command {
            LyricsCommand::Prepare { presentation_id } => {
                if self.live.lock().unwrap().as_deref() == Some(presentation_id.as_str()) {
                    return Ok(Duration::ZERO);
                }
                // Live with its background, no text yet: the first section
                // shows it.
                let mut elapsed = self.display("theme").await?;
                self.mark_hidden();
                elapsed += self
                    .post("service/show", json!({ "id": presentation_id }))
                    .await?;
                *self.live.lock().unwrap() = Some(presentation_id.clone());
                Ok(elapsed)
            }
            LyricsCommand::Section {
                presentation_id,
                index,
                ..
            }
            | LyricsCommand::Slide {
                presentation_id,
                index,
            }
            | LyricsCommand::Step {
                presentation_id,
                index: Some(index),
            } => {
                self.show_slide(presentation_id, ("controller/show", json!({ "id": index })))
                    .await
            }
            LyricsCommand::Step {
                presentation_id,
                index: None,
            } => {
                self.show_slide(
                    presentation_id,
                    ("controller/progress", json!({ "action": "next" })),
                )
                .await
            }
            // The text only: the theme's background stays.
            LyricsCommand::ClearText => {
                let elapsed = self.display("theme").await?;
                self.mark_hidden();
                Ok(elapsed)
            }
            // The whole screen.
            LyricsCommand::Clear => {
                let elapsed = self.display("blank").await?;
                self.mark_hidden();
                Ok(elapsed)
            }
        }
    }

    async fn current(&self) -> Result<Option<CurrentSlide>, LyricsError> {
        let live = self.live_item().await?;
        if live.is_null() {
            return Ok(None);
        }
        let index = selected_slide(&live);
        let label = index.and_then(|index| {
            live.get("slides")?
                .get(index as usize)?
                .get("tag")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        Ok(Some(CurrentSlide {
            presentation_id: text(live.get("id")),
            label,
            index,
        }))
    }

    fn set_may_take_screen(&self, allowed: bool) {
        self.may_take_screen.store(allowed, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_screen_has_no_text_when_blank_theme_or_desktop() {
        let state = |extra: Value| {
            let mut results = json!({"blank": false, "theme": false, "display": false, "item": "x"});
            results.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            screen_state_from(&json!({ "results": results }))
        };
        assert!(!state(json!({})).no_text);
        assert!(state(json!({"blank": true})).no_text);
        assert!(state(json!({"theme": true})).no_text);
        assert!(state(json!({"display": true})).no_text);
    }

    #[test]
    fn the_selected_slide_is_its_position() {
        let item = json!({"slides": [{"selected": false}, {"selected": true}, {}]});
        assert_eq!(selected_slide(&item), Some(1));
        assert_eq!(selected_slide(&json!({"slides": []})), None);
    }
}
