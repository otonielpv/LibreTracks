//! FreeShow REST API (Settings › Connections): `POST /` with
//! `{"action": …}`. Only `get_*` actions answer data; the rest answer 204.
//! Optional key as `Authorization: Bearer`. Layout indices start at 1.

use std::time::Duration;

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use serde_json::{json, Value};

use super::{text, CurrentSlide, Http, LyricsClient, Presentation, ProbeInfo, Reply};
use crate::plan::LyricsCommand;
use crate::structure::{parse_freeshow, LyricsStructure};
use crate::LyricsError;

/// FNV-1a: a stable hash (std's changes between Rust versions), enough to
/// tell one state of a show from another.
fn content_hash(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

pub struct FreeShowClient {
    http: Http,
}

impl FreeShowClient {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }

    async fn action(&self, body: Value) -> Result<Reply, LyricsError> {
        let mut request = self.http.post("/").json(&body);
        if let Some(key) = self.http.connection.token.as_deref().filter(|key| !key.is_empty()) {
            request = request.bearer_auth(key);
        }
        let reply = self.http.execute(request).await?;
        match reply.status {
            200..=299 => Ok(reply),
            401 | 403 => Err(LyricsError::Unauthorized { missing: vec![] }),
            404 => Err(LyricsError::NotFound {
                what: body["action"].as_str().unwrap_or_default().to_string(),
            }),
            status => Err(LyricsError::unexpected(format!("FreeShow respondió {status}"))),
        }
    }

    /// One slide captured by FreeShow (`get_slide_thumbnail`, rendered at
    /// half the output size). FreeShow answers base64, with or without the
    /// `data:` prefix; "" when it has no output to render with.
    async fn slide_thumbnail(&self, show_id: &str, layout_id: Option<&str>, index: u32) -> Option<String> {
        let body = json!({
            "action": "get_slide_thumbnail",
            "showId": show_id,
            "layoutId": layout_id,
            "index": index,
        });
        let mut request = self
            .http
            .post("/")
            .json(&body)
            .timeout(super::THUMBNAIL_TIMEOUT);
        if let Some(key) = self.http.connection.token.as_deref().filter(|key| !key.is_empty()) {
            request = request.bearer_auth(key);
        }
        let (status, _, bytes) = self.http.execute_bytes(request).await.ok()?;
        if !(200..300).contains(&status) {
            return None;
        }
        let reply: Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        let image = reply.get("data").unwrap_or(&reply).as_str()?.trim().to_string();
        if image.is_empty() {
            None
        } else if image.starts_with("data:") {
            Some(image)
        } else {
            Some(format!("data:image/png;base64,{image}"))
        }
    }

    async fn data(&self, body: Value) -> Result<Value, LyricsError> {
        let reply = self.action(body).await?;
        Ok(reply.body.get("data").cloned().unwrap_or(reply.body))
    }
}

#[async_trait]
impl LyricsClient for FreeShowClient {
    fn software(&self) -> LyricsSoftware {
        LyricsSoftware::FreeShow
    }

    async fn probe(&self) -> Result<ProbeInfo, LyricsError> {
        let presentations = self.list_presentations().await?.len();
        Ok(ProbeInfo {
            version: "FreeShow".into(),
            presentations,
        })
    }

    async fn list_presentations(&self) -> Result<Vec<Presentation>, LyricsError> {
        let shows = self.data(json!({ "action": "get_shows" })).await?;
        let shows = shows
            .as_object()
            .ok_or_else(|| LyricsError::unexpected("FreeShow: lista de canciones inesperada"))?;
        Ok(shows
            .iter()
            .filter_map(|(id, show)| {
                Some(Presentation {
                    id: id.clone(),
                    name: text(show.get("name"))?,
                })
            })
            .collect())
    }

    async fn structure(&self, presentation_id: &str) -> Result<LyricsStructure, LyricsError> {
        let show = self
            .data(json!({ "action": "get_show", "id": presentation_id }))
            .await?;
        if show.is_null() {
            return Err(LyricsError::NotFound {
                what: presentation_id.to_string(),
            });
        }
        let layout = self
            .data(json!({ "action": "get_show_layout", "id": presentation_id }))
            .await?;
        parse_freeshow(presentation_id, &show, &layout)
    }

    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError> {
        let body = match command {
            LyricsCommand::Prepare { presentation_id } => {
                json!({ "action": "id_select_show", "id": presentation_id })
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
            } => json!({
                "action": "index_select_slide",
                "showId": presentation_id,
                "index": index,
            }),
            LyricsCommand::Step { index: None, .. } => json!({ "action": "next_slide" }),
            // The text only; the background layer stays.
            LyricsCommand::ClearText => json!({ "action": "clear_slide" }),
            // The whole screen: the text, then the background.
            LyricsCommand::Clear => {
                let text = self.action(json!({ "action": "clear_slide" })).await?.elapsed;
                return Ok(text + self.action(json!({ "action": "clear_background" })).await?.elapsed);
            }
        };
        Ok(self.action(body).await?.elapsed)
    }

    async fn thumbnail_version(&self, presentation_id: &str) -> Option<String> {
        let mut show = self
            .data(json!({ "action": "get_show", "id": presentation_id }))
            .await
            .ok()?;
        if !show.is_object() {
            return None;
        }
        // `timestamps.modified` also moves when the show is merely projected
        // (it equals `used`): the content itself is what the pictures show.
        if let Some(object) = show.as_object_mut() {
            object.remove("timestamps");
        }
        Some(format!("{:016x}", content_hash(&show.to_string())))
    }

    async fn thumbnails(
        &self,
        presentation_id: &str,
        indexes: &[u32],
    ) -> Result<Vec<Option<String>>, LyricsError> {
        // The layout the structure was read from: the show's active one.
        let show = self
            .data(json!({ "action": "get_show", "id": presentation_id }))
            .await?;
        let layout = show
            .get("settings")
            .and_then(|settings| settings.get("activeLayout"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut pictures = Vec::with_capacity(indexes.len());
        for index in indexes {
            pictures.push(
                self.slide_thumbnail(presentation_id, layout.as_deref(), *index)
                    .await,
            );
        }
        Ok(pictures)
    }

    async fn current(&self) -> Result<Option<CurrentSlide>, LyricsError> {
        let name = self
            .data(json!({ "action": "get_output_group_name" }))
            .await?;
        Ok(text(Some(&name)).map(|label| CurrentSlide {
            presentation_id: None,
            label: Some(label),
            index: None,
        }))
    }
}
