//! Holyrics API Server (File › Settings › API Server › Local, port 8091):
//! `POST /api/{Action}?token=T` with a JSON body. Answers
//! `{"status":"ok","data":…}` or `{"status":"error","error":"…"}`. Each
//! action needs its permission ticked for the token.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use serde_json::{json, Value};

use super::{encode_segment, text, CurrentSlide, Http, LyricsClient, Presentation, ProbeInfo};
use crate::plan::LyricsCommand;
use crate::structure::{parse_holyrics, LyricsStructure, HOLYRICS_FIRST_LYRIC};
use libretracks_core::section_vocab::normalize_title;
use crate::LyricsError;

/// Every action LibreTracks uses, for `CheckPermissions`.
pub const REQUIRED_ACTIONS: &[&str] = &[
    "GetSongs",
    "GetLyrics",
    "ShowLyrics",
    "ActionGoToIndex",
    "ActionNext",
    "SetF8",
    "GetCurrentPresentation",
    "GetSlideDescriptions",
];
// «Clear the text» uses SetF9 when the token allows it; it is not in the
// list above on purpose: without it that order falls back to F8, so tokens
// made before keep working.

/// Whether each Holyrics (by address) shows a title slide before the lyrics.
/// It is a Holyrics setting no API reads: learned from what it actually
/// shows after each `ShowLyrics`, and kept for the session (clients are
/// short-lived). Unknown = assume it does (Holyrics' default).
fn title_slides() -> &'static Mutex<HashMap<String, bool>> {
    static SEEN: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// LibreTracks' index (title = 0, lyrics from 1) as Holyrics' own:
/// `None` = the title slide was asked for but Holyrics shows none.
pub fn holyrics_index(ours: u32, title_slide: bool) -> Option<u32> {
    if title_slide {
        Some(ours)
    } else {
        ours.checked_sub(HOLYRICS_FIRST_LYRIC)
    }
}

/// Whether what Holyrics shows (`GetCurrentPresentation` with slides) opens
/// with a title slide: no description and the song's name as its text.
pub fn shows_title_slide(current: &Value) -> Option<bool> {
    let first = current.get("slides")?.as_array()?.first()?;
    let name = text(current.get("name")).unwrap_or_default();
    let description = text(first.get("slide_description")).unwrap_or_default();
    let body = text(first.get("text")).unwrap_or_default();
    Some(description.trim().is_empty() && !name.is_empty() && normalize_title(&body) == normalize_title(&name))
}

pub struct HolyricsClient {
    http: Http,
    /// Whether we blanked the screen with F8 (it has to be lifted before
    /// showing lyrics again).
    blanked: AtomicBool,
    /// Whether we hid the text with F9 (lifted before showing lyrics again).
    text_hidden: AtomicBool,
}

impl HolyricsClient {
    pub(crate) fn new(http: Http) -> Self {
        Self {
            http,
            blanked: AtomicBool::new(false),
            text_hidden: AtomicBool::new(false),
        }
    }

    async fn call(&self, action: &str, body: Value) -> Result<(Value, Duration), LyricsError> {
        let token = self.http.connection.token.clone().unwrap_or_default();
        let path = format!("/api/{action}?token={}", encode_segment(&token));
        let reply = self.http.execute(self.http.post(&path).json(&body)).await?;
        if reply.status == 401 || reply.status == 403 {
            return Err(LyricsError::Unauthorized {
                missing: vec![action.to_string()],
            });
        }
        if !(200..=299).contains(&reply.status) {
            return Err(LyricsError::unexpected(format!(
                "Holyrics respondió {} a {action}",
                reply.status
            )));
        }
        match reply.body.get("status").and_then(Value::as_str) {
            Some("ok") => Ok((
                reply.body.get("data").cloned().unwrap_or(Value::Null),
                reply.elapsed,
            )),
            Some("error") => Err(classify_error(
                action,
                &text(reply.body.get("error")).unwrap_or_default(),
            )),
            _ => Err(LyricsError::unexpected(format!(
                "Holyrics: respuesta inesperada a {action}"
            ))),
        }
    }

    fn title_slide(&self) -> bool {
        title_slides()
            .lock()
            .ok()
            .and_then(|seen| seen.get(&self.http.connection.base_url()).copied())
            .unwrap_or(true)
    }

    fn learn_title_slide(&self, shown: bool) {
        if let Ok(mut seen) = title_slides().lock() {
            seen.insert(self.http.connection.base_url(), shown);
        }
    }

    /// After `ShowLyrics`: see whether Holyrics put a title slide first and,
    /// if that is not what the index assumed, go to the slide meant.
    async fn verify_show(&self, presentation_id: &str, ours: u32, assumed: bool) -> Result<Duration, LyricsError> {
        let Ok((current, elapsed)) = self
            .call("GetCurrentPresentation", json!({ "include_slides": true }))
            .await
        else {
            return Ok(Duration::ZERO);
        };
        let same_song = [current.get("song_id"), current.get("reference_id")]
            .into_iter()
            .any(|id| text(id).as_deref() == Some(presentation_id));
        let Some(shown) = shows_title_slide(&current).filter(|_| same_song) else {
            return Ok(elapsed);
        };
        if shown == assumed {
            return Ok(elapsed);
        }
        self.learn_title_slide(shown);
        let fix = match holyrics_index(ours, shown) {
            Some(index) => self.call("ActionGoToIndex", json!({ "index": index })).await?.1,
            None => {
                let took = self.call("SetF8", json!({ "enable": true })).await?.1;
                self.blanked.store(true, Ordering::Relaxed);
                took
            }
        };
        Ok(elapsed + fix)
    }

    /// The actions the token may not use.
    async fn missing_permissions(&self) -> Result<Vec<String>, LyricsError> {
        let (data, _) = self
            .call(
                "CheckPermissions",
                json!({ "actions": REQUIRED_ACTIONS.join(",") }),
            )
            .await?;
        Ok(list(data.get("unauthorized_actions")))
    }
}

/// `["A","B"]` or `"A,B"`.
fn list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(|item| text(Some(item))).collect(),
        Some(Value::String(joined)) => joined
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn classify_error(action: &str, message: &str) -> LyricsError {
    let lower = message.to_lowercase();
    if lower.contains("token") {
        LyricsError::Unauthorized { missing: vec![] }
    } else if lower.contains("unauthorized")
        || lower.contains("permission")
        || lower.contains("permiss")
        || lower.contains("not allowed")
    {
        // Holyrics answers «unauthorized action» to an action the token
        // may not use (seen on 2.30).
        LyricsError::Unauthorized {
            missing: vec![action.to_string()],
        }
    } else if lower.contains("not found") || lower.contains("invalid id") {
        LyricsError::NotFound {
            what: message.to_string(),
        }
    } else {
        LyricsError::unexpected(format!("Holyrics: {message}"))
    }
}

#[async_trait]
impl LyricsClient for HolyricsClient {
    fn software(&self) -> LyricsSoftware {
        LyricsSoftware::Holyrics
    }

    async fn probe(&self) -> Result<ProbeInfo, LyricsError> {
        let (info, _) = self.call("GetTokenInfo", json!({})).await?;
        let missing = self.missing_permissions().await?;
        if !missing.is_empty() {
            return Err(LyricsError::Unauthorized { missing });
        }
        let version = text(info.get("version"))
            .map(|version| format!("Holyrics {version}"))
            .unwrap_or_else(|| "Holyrics".into());
        let presentations = self.list_presentations().await?.len();
        Ok(ProbeInfo {
            version,
            presentations,
        })
    }

    async fn list_presentations(&self) -> Result<Vec<Presentation>, LyricsError> {
        let (songs, _) = self.call("GetSongs", json!({ "fields": "id,title" })).await?;
        let songs = songs
            .as_array()
            .ok_or_else(|| LyricsError::unexpected("Holyrics: lista de canciones inesperada"))?;
        Ok(songs
            .iter()
            .filter_map(|song| {
                Some(Presentation {
                    id: text(song.get("id"))?,
                    name: text(song.get("title"))?,
                })
            })
            .collect())
    }

    async fn structure(&self, presentation_id: &str) -> Result<LyricsStructure, LyricsError> {
        let (lyrics, _) = self
            .call("GetLyrics", json!({ "id": presentation_id }))
            .await?;
        if lyrics.is_null() {
            return Err(LyricsError::NotFound {
                what: presentation_id.to_string(),
            });
        }
        // The user's slide descriptions add aliases; without the permission
        // the structure still works on the names alone.
        let descriptions = self
            .call("GetSlideDescriptions", json!({}))
            .await
            .ok()
            .map(|(data, _)| data);
        let mut structure = parse_holyrics(&lyrics, descriptions.as_ref())?;
        if !self.title_slide() {
            structure.slides.retain(|slide| !slide.title);
        }
        Ok(structure)
    }

    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError> {
        let mut total = Duration::ZERO;
        let showing = matches!(
            command,
            LyricsCommand::Section { .. } | LyricsCommand::Slide { .. } | LyricsCommand::Step { .. }
        );
        // «Clear the text» also needs the song's background, so it lifts F8.
        if (showing || matches!(command, LyricsCommand::ClearText)) && self.blanked.load(Ordering::Relaxed) {
            total += self.call("SetF8", json!({ "enable": false })).await?.1;
            self.blanked.store(false, Ordering::Relaxed);
        }
        if showing && self.text_hidden.load(Ordering::Relaxed) {
            total += self.call("SetF9", json!({ "enable": false })).await?.1;
            self.text_hidden.store(false, Ordering::Relaxed);
        }
        if matches!(command, LyricsCommand::ClearText) {
            return match self.call("SetF9", json!({ "enable": true })).await {
                Ok((_, took)) => {
                    self.text_hidden.store(true, Ordering::Relaxed);
                    Ok(total + took)
                }
                // The token may not use F9: blank the screen as before rather
                // than leave the lyrics up.
                Err(LyricsError::Unauthorized { .. }) => {
                    let took = self.call("SetF8", json!({ "enable": true })).await?.1;
                    self.blanked.store(true, Ordering::Relaxed);
                    Ok(total + took)
                }
                Err(error) => Err(error),
            };
        }
        let title = self.title_slide();
        let blank = || ("SetF8", json!({ "enable": true }));
        let mut shown_song: Option<(&str, u32)> = None;
        let (action, body) = match command {
            // Holyrics has no "prepare without showing": nothing to do.
            LyricsCommand::Prepare { .. } => return Ok(total),
            // Absolute (D7): the song and the slide, whatever is on screen.
            // Indexes are LibreTracks' (title = 0): made Holyrics' here.
            LyricsCommand::Section {
                presentation_id,
                index,
                ..
            }
            | LyricsCommand::Slide {
                presentation_id,
                index,
            } => match holyrics_index(*index, title) {
                Some(real) => {
                    shown_song = Some((presentation_id.as_str(), *index));
                    ("ShowLyrics", json!({ "id": presentation_id, "initial_index": real }))
                }
                None => blank(),
            },
            LyricsCommand::Step {
                index: Some(index), ..
            } => match holyrics_index(*index, title) {
                Some(real) => ("ActionGoToIndex", json!({ "index": real })),
                None => blank(),
            },
            LyricsCommand::Step { index: None, .. } => ("ActionNext", json!({})),
            LyricsCommand::Clear | LyricsCommand::ClearText => blank(),
        };
        total += self.call(action, body.clone()).await?.1;
        if action == "SetF8" {
            self.blanked.store(true, Ordering::Relaxed);
        }
        if let Some((presentation_id, ours)) = shown_song {
            total += self.verify_show(presentation_id, ours, title).await?;
        }
        Ok(total)
    }

    async fn current(&self) -> Result<Option<CurrentSlide>, LyricsError> {
        let (data, _) = self
            .call("GetCurrentPresentation", json!({ "include_slides": false }))
            .await?;
        if data.is_null() {
            return Ok(None);
        }
        Ok(Some(CurrentSlide {
            presentation_id: text(data.get("id")),
            label: text(data.get("slide_description")),
            index: data
                .get("slide_number")
                .and_then(Value::as_u64)
                .and_then(|number| number.checked_sub(1))
                .map(|index| index as u32),
        }))
    }
}
