//! The lyrics programs' HTTP clients behind one trait (D9). One
//! `reqwest::Client` per connection, reused (keep-alive saves the handshake
//! on every section), with a short timeout: a lyric that arrives late is
//! worse than none.

mod freeshow;
mod holyrics;
mod openlp;
mod propresenter;

use std::time::{Duration, Instant};

use async_trait::async_trait;
use libretracks_core::LyricsSoftware;
use serde::Serialize;
use serde_json::Value;

pub use freeshow::FreeShowClient;
pub use holyrics::HolyricsClient;
pub use openlp::OpenLpClient;
pub use propresenter::ProPresenterClient;

use crate::plan::LyricsCommand;
use crate::structure::LyricsStructure;
use crate::LyricsError;

/// Per request. Generous for a LAN, short enough that a dead program never
/// queues orders behind it.
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(800);
/// Connecting gives up a little earlier, so "nothing answers there" is told
/// apart from "it answered too slowly".
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(700);
/// A slide picture is rendered by the program: it may take longer than an
/// order, and nothing live waits for it (only the section editor).
pub const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    /// What the program says it is ("ProPresenter 7.16", "Holyrics 2.30").
    pub version: String,
    /// Presentations found in its library.
    pub presentations: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSlide {
    pub presentation_id: Option<String>,
    pub label: Option<String>,
    pub index: Option<u32>,
}

#[async_trait]
pub trait LyricsClient: Send + Sync {
    fn software(&self) -> LyricsSoftware;
    /// Is it there, and is it allowed (Holyrics' permissions)?
    async fn probe(&self) -> Result<ProbeInfo, LyricsError>;
    async fn list_presentations(&self) -> Result<Vec<Presentation>, LyricsError>;
    async fn structure(&self, presentation_id: &str) -> Result<LyricsStructure, LyricsError>;
    /// Send one order; returns how long the program took.
    async fn send(&self, command: &LyricsCommand) -> Result<Duration, LyricsError>;
    async fn current(&self) -> Result<Option<CurrentSlide>, LyricsError>;
    /// The song is starting now, so reading a presentation may take the
    /// program's screen (OpenLP, which only shows the live item's slides).
    /// Off again once the song's plan is resolved.
    fn set_may_take_screen(&self, _allowed: bool) {}
    /// What identifies this state of a presentation for its kept pictures:
    /// it changes when the presentation is edited. `None` = do not keep them
    /// (the program makes them fast, or cannot tell).
    async fn thumbnail_version(&self, _presentation_id: &str) -> Option<String> {
        None
    }

    /// A picture of each slide (program indexes) as a `data:` URL, for the
    /// section editor; `None` where the program gives none (Holyrics).
    async fn thumbnails(
        &self,
        _presentation_id: &str,
        indexes: &[u32],
    ) -> Result<Vec<Option<String>>, LyricsError> {
        Ok(vec![None; indexes.len()])
    }
}

/// Raw bytes as a `data:` URL.
pub(crate) fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Where the program is and how to authenticate.
#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub host: String,
    pub port: u16,
    /// Holyrics token, FreeShow key or OpenLP `user:password`; `None` when
    /// not set.
    pub token: Option<String>,
}

impl Connection {
    pub fn base_url(&self) -> String {
        let host = self.host.trim();
        // A bare IPv6 address needs brackets in a URL.
        if host.contains(':') && !host.starts_with('[') {
            format!("http://[{host}]:{}", self.port)
        } else {
            format!("http://{host}:{}", self.port)
        }
    }
}

/// The client for a program.
pub fn client_for(
    software: LyricsSoftware,
    connection: Connection,
) -> Result<Box<dyn LyricsClient>, LyricsError> {
    let http = Http::new(connection)?;
    Ok(match software {
        LyricsSoftware::ProPresenter => Box::new(ProPresenterClient::new(http)),
        LyricsSoftware::FreeShow => Box::new(FreeShowClient::new(http)),
        LyricsSoftware::Holyrics => Box::new(HolyricsClient::new(http)),
        LyricsSoftware::OpenLp => Box::new(OpenLpClient::new(http)),
        LyricsSoftware::Unknown => {
            return Err(LyricsError::unexpected("programa de letras no admitido"))
        }
    })
}

/// The shared HTTP plumbing.
#[derive(Clone)]
pub(crate) struct Http {
    client: reqwest::Client,
    pub(crate) connection: Connection,
}

pub(crate) struct Reply {
    pub status: u16,
    pub body: Value,
    pub elapsed: Duration,
}

impl Http {
    pub(crate) fn new(connection: Connection) -> Result<Self, LyricsError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(60))
            .no_proxy()
            .build()
            .map_err(|error| LyricsError::unexpected(error.to_string()))?;
        Ok(Self { client, connection })
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.connection.base_url())
    }

    pub(crate) async fn execute(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<Reply, LyricsError> {
        let started = Instant::now();
        let exchange = async {
            let response = request.send().await.map_err(map_error)?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(map_error)?;
            Ok::<_, LyricsError>((status, bytes))
        };
        let (status, bytes) = tokio::time::timeout(REQUEST_TIMEOUT, exchange)
            .await
            .map_err(|_| LyricsError::Timeout)??;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Ok(Reply {
            status,
            body,
            elapsed: started.elapsed(),
        })
    }

    /// The raw answer (an image), with the thumbnail timeout.
    pub(crate) async fn execute_bytes(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<(u16, Option<String>, Vec<u8>), LyricsError> {
        let exchange = async {
            let response = request.send().await.map_err(map_error)?;
            let status = response.status().as_u16();
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let bytes = response.bytes().await.map_err(map_error)?;
            Ok::<_, LyricsError>((status, mime, bytes.to_vec()))
        };
        tokio::time::timeout(THUMBNAIL_TIMEOUT, exchange)
            .await
            .map_err(|_| LyricsError::Timeout)?
    }

    pub(crate) fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(self.url(path))
    }

    pub(crate) fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.post(self.url(path))
    }

    pub(crate) fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client.request(method, self.url(path))
    }
}

fn map_error(error: reqwest::Error) -> LyricsError {
    // A connect timeout is also a timeout, but to the user it is "nothing
    // answers there" (Windows retries a refused localhost port for ~2 s).
    if error.is_connect() {
        LyricsError::Unreachable {
            detail: error.to_string(),
        }
    } else if error.is_timeout() {
        LyricsError::Timeout
    } else if error.is_request() {
        LyricsError::Unreachable {
            detail: error.to_string(),
        }
    } else {
        LyricsError::unexpected(error.to_string())
    }
}

/// `{"id": {...}}` or the object itself: ProPresenter's spec and versions
/// disagree on whether ids come wrapped.
pub(crate) fn id_block(value: &Value) -> &Value {
    value.get("id").filter(|id| id.is_object()).unwrap_or(value)
}

pub(crate) fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Percent-encode one path segment (`Verse 1` → `Verse%201`, `Pré-Coro` →
/// `Pr%C3%A9-Coro`).
pub(crate) fn encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}
