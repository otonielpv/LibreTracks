//! Holyrics API Server (File › Settings › API Server › Local, port 8091):
//! `POST /api/{Action}?token=T` with a JSON body. Answers
//! `{"status":"ok","data":…}` or `{"status":"error","error":"…"}`. Each
//! action needs its permission ticked for the token.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use serde_json::{json, Value};

use super::{encode_segment, text, CurrentSlide, Http, LyricsClient, Presentation, ProbeInfo};
use crate::plan::LyricsCommand;
use crate::structure::{parse_holyrics, LyricsStructure};
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

pub struct HolyricsClient {
    http: Http,
    /// Whether we blanked the screen with F8 (it has to be lifted before
    /// showing lyrics again).
    blanked: AtomicBool,
}

impl HolyricsClient {
    pub(crate) fn new(http: Http) -> Self {
        Self {
            http,
            blanked: AtomicBool::new(false),
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
    } else if lower.contains("permission") || lower.contains("permiss") || lower.contains("not allowed") {
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
        parse_holyrics(&lyrics, descriptions.as_ref())
    }

    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError> {
        let mut total = Duration::ZERO;
        let showing = matches!(
            command,
            LyricsCommand::Section { .. } | LyricsCommand::Step { .. }
        );
        if showing && self.blanked.load(Ordering::Relaxed) {
            total += self.call("SetF8", json!({ "enable": false })).await?.1;
            self.blanked.store(false, Ordering::Relaxed);
        }
        let (action, body) = match command {
            // Holyrics has no "prepare without showing": nothing to do.
            LyricsCommand::Prepare { .. } => return Ok(total),
            // Absolute (D7): the song and the slide, whatever is on screen.
            LyricsCommand::Section {
                presentation_id,
                index,
                ..
            } => (
                "ShowLyrics",
                json!({ "id": presentation_id, "initial_index": index }),
            ),
            LyricsCommand::Step {
                index: Some(index), ..
            } => ("ActionGoToIndex", json!({ "index": index })),
            LyricsCommand::Step { index: None, .. } => ("ActionNext", json!({})),
            LyricsCommand::Clear => ("SetF8", json!({ "enable": true })),
        };
        total += self.call(action, body).await?.1;
        if matches!(command, LyricsCommand::Clear) {
            self.blanked.store(true, Ordering::Relaxed);
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
