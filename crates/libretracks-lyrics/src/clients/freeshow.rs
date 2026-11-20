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
            | LyricsCommand::Step {
                presentation_id,
                index: Some(index),
            } => json!({
                "action": "index_select_slide",
                "showId": presentation_id,
                "index": index,
            }),
            LyricsCommand::Step { index: None, .. } => json!({ "action": "next_slide" }),
            LyricsCommand::Clear => json!({ "action": "clear_slide" }),
        };
        Ok(self.action(body).await?.elapsed)
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
