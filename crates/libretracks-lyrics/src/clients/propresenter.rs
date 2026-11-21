//! ProPresenter 7.9+ network API (Settings › Network › Enable Network). No
//! authentication; the port is the one ProPresenter shows. Triggers are GETs
//! answering 204, 404 when the target does not exist.

use std::time::Duration;

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use serde_json::Value;

use super::{
    encode_segment, id_block, text, CurrentSlide, Http, LyricsClient, Presentation, ProbeInfo,
    Reply,
};
use crate::plan::LyricsCommand;
use crate::structure::{parse_propresenter, LyricsStructure};
use crate::LyricsError;

pub struct ProPresenterClient {
    http: Http,
}

impl ProPresenterClient {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }

    async fn get(&self, path: &str) -> Result<Reply, LyricsError> {
        let reply = self.http.execute(self.http.get(path)).await?;
        match reply.status {
            200..=299 => Ok(reply),
            404 => Err(LyricsError::NotFound {
                what: path.to_string(),
            }),
            status => Err(LyricsError::unexpected(format!(
                "ProPresenter respondió {status} a {path}"
            ))),
        }
    }
}

#[async_trait]
impl LyricsClient for ProPresenterClient {
    fn software(&self) -> LyricsSoftware {
        LyricsSoftware::ProPresenter
    }

    async fn probe(&self) -> Result<ProbeInfo, LyricsError> {
        let reply = self.get("/version").await?;
        let version = text(reply.body.get("host_description"))
            .or_else(|| text(reply.body.get("name")))
            .unwrap_or_else(|| "ProPresenter".into());
        let presentations = self.list_presentations().await?.len();
        Ok(ProbeInfo {
            version,
            presentations,
        })
    }

    async fn list_presentations(&self) -> Result<Vec<Presentation>, LyricsError> {
        let libraries = self.get("/v1/libraries").await?.body;
        let libraries = libraries
            .as_array()
            .ok_or_else(|| LyricsError::unexpected("ProPresenter: lista de bibliotecas inesperada"))?;
        let mut presentations = Vec::new();
        for library in libraries {
            let id = id_block(library);
            let Some(key) = text(id.get("uuid")).or_else(|| text(id.get("name"))) else {
                continue;
            };
            let items = self
                .get(&format!("/v1/library/{}", encode_segment(&key)))
                .await?
                .body;
            let list = items
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in list {
                let id = id_block(&item);
                if let (Some(uuid), Some(name)) = (text(id.get("uuid")), text(id.get("name"))) {
                    presentations.push(Presentation { id: uuid, name });
                }
            }
        }
        Ok(presentations)
    }

    async fn structure(&self, presentation_id: &str) -> Result<LyricsStructure, LyricsError> {
        let reply = self
            .get(&format!("/v1/presentation/{}", encode_segment(presentation_id)))
            .await?;
        parse_propresenter(&reply.body)
    }

    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError> {
        let path = match command {
            LyricsCommand::Prepare { presentation_id } => {
                format!("/v1/presentation/{}/focus", encode_segment(presentation_id))
            }
            LyricsCommand::Section {
                presentation_id,
                group_label,
                ..
            } => format!(
                "/v1/presentation/{}/group/{}/trigger",
                encode_segment(presentation_id),
                encode_segment(group_label)
            ),
            LyricsCommand::Slide {
                presentation_id,
                index,
            }
            | LyricsCommand::Step {
                presentation_id,
                index: Some(index),
            } => format!(
                "/v1/presentation/{}/{index}/trigger",
                encode_segment(presentation_id)
            ),
            LyricsCommand::Step {
                presentation_id,
                index: None,
            } => format!(
                "/v1/presentation/{}/next/trigger",
                encode_segment(presentation_id)
            ),
            LyricsCommand::Clear => "/v1/clear/layer/slide".to_string(),
        };
        Ok(self.get(&path).await?.elapsed)
    }

    async fn thumbnails(
        &self,
        presentation_id: &str,
        indexes: &[u32],
    ) -> Result<Vec<Option<String>>, LyricsError> {
        let mut pictures = Vec::with_capacity(indexes.len());
        for index in indexes {
            let path = format!(
                "/v1/presentation/{}/thumbnail/{index}?quality=320",
                encode_segment(presentation_id)
            );
            let picture = match self.http.execute_bytes(self.http.get(&path)).await {
                Ok((200..=299, mime, bytes)) if !bytes.is_empty() => Some(super::data_url(
                    mime.as_deref().unwrap_or("image/jpeg"),
                    &bytes,
                )),
                _ => None,
            };
            pictures.push(picture);
        }
        Ok(pictures)
    }

    async fn current(&self) -> Result<Option<CurrentSlide>, LyricsError> {
        let reply = self.get("/v1/presentation/slide_index").await?;
        let Some(current) = reply.body.get("presentation_index").filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        Ok(Some(CurrentSlide {
            presentation_id: text(
                current
                    .get("presentation_id")
                    .map(id_block)
                    .and_then(|id| id.get("uuid")),
            ),
            label: None,
            index: current
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| index as u32),
        }))
    }
}
