//! The read-only calls the chart import makes to Planning Center Services.
//!
//! Few and small on purpose (D17): a title search, the arrangements of one
//! song, the upcoming plans and the items of one. Never the whole catalogue,
//! never a write. The base URL is injectable so the tests run against
//! `libretracks-test-http` with the answers recorded in step 01.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use libretracks_cloud::token::TokenManager;
use libretracks_cloud::{AccessTokens, CloudError};
use serde::de::DeserializeOwned;
use url::Url;

use crate::error::{short_detail, PcoError};
use crate::model::*;

pub const API_BASE: &str = "https://api.planningcenteronline.com/services/v2";
/// Longest `Retry-After` the client waits for, once.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(10);
/// No list is read past this many pages.
pub const MAX_PAGES: usize = 4;
const SEARCH_PAGE_SIZE: u32 = 25;

/// Access tokens, and a way to replace one the API refused before its expiry.
#[async_trait]
pub trait PcoTokens: Send + Sync {
    async fn access_token(&self) -> Result<String, CloudError>;
    async fn refresh_rejected(&self, rejected: &str) -> Result<String, CloudError>;
}

#[async_trait]
impl PcoTokens for TokenManager {
    async fn access_token(&self) -> Result<String, CloudError> {
        AccessTokens::access_token(self).await
    }

    async fn refresh_rejected(&self, rejected: &str) -> Result<String, CloudError> {
        TokenManager::refresh_rejected(self, rejected).await
    }
}

pub struct PcoClient {
    http: reqwest::Client,
    base: Url,
    tokens: Arc<dyn PcoTokens>,
}

impl PcoClient {
    pub fn new(tokens: Arc<dyn PcoTokens>) -> Result<Self, PcoError> {
        Self::with_base(API_BASE, tokens)
    }

    /// Against another server (tests).
    pub fn with_base(base: &str, tokens: Arc<dyn PcoTokens>) -> Result<Self, PcoError> {
        let base = Url::parse(&format!("{}/", base.trim_end_matches('/'))).map_err(|error| PcoError::Unexpected {
            message: error.to_string(),
        })?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| PcoError::Network {
                message: error.to_string(),
            })?;
        Ok(Self { http, base, tokens })
    }

    /// `path` relative to the base ("songs?where[title]=x"), or a `links.next`
    /// URL, of which only the path under the base and the query are kept: a
    /// link never takes the client to another host.
    fn url(&self, path: &str) -> Result<Url, PcoError> {
        let relative = match Url::parse(path) {
            Ok(absolute) => {
                let full = absolute.path().trim_start_matches('/');
                let under = full
                    .strip_prefix(self.base.path().trim_start_matches('/'))
                    .unwrap_or(full);
                match absolute.query() {
                    Some(query) => format!("{under}?{query}"),
                    None => under.to_string(),
                }
            }
            Err(_) => path.trim_start_matches('/').to_string(),
        };
        self.base.join(&relative).map_err(|error| PcoError::Unexpected {
            message: error.to_string(),
        })
    }

    /// One GET, with the two retries that are worth it: a token refused
    /// before its expiry is refreshed once; a 429 waits `Retry-After` (at most
    /// ten seconds) once.
    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, PcoError> {
        self.request(reqwest::Method::GET, path, None).await
    }

    /// One request, with the two retries that are worth it (see `get`). A
    /// write refused with 403 is a missing permission to edit songs, not a
    /// missing access to Services.
    async fn request<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<T, PcoError> {
        let url = self.url(path)?;
        let writing = method != reqwest::Method::GET;
        let mut token = self.tokens.access_token().await?;
        let mut refreshed = false;
        let mut waited = false;
        loop {
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .bearer_auth(&token)
                .header("Accept", "application/json");
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request
                .send()
                .await
                .map_err(|error| PcoError::Network {
                    // Without the URL: it can carry a song title.
                    message: error.without_url().to_string(),
                })?;
            let status = response.status().as_u16();
            match status {
                200..=299 => {
                    let body = response.bytes().await.map_err(|error| PcoError::Network {
                        message: error.without_url().to_string(),
                    })?;
                    return serde_json::from_slice(&body).map_err(|error| PcoError::Unexpected {
                        message: error.to_string(),
                    });
                }
                401 if !refreshed => {
                    refreshed = true;
                    token = self.tokens.refresh_rejected(&token).await?;
                }
                401 => return Err(PcoError::SignedOut),
                429 => {
                    let retry_after = response
                        .headers()
                        .get("retry-after")
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.trim().parse::<u64>().ok())
                        .unwrap_or(1);
                    if waited {
                        return Err(PcoError::RateLimited {
                            retry_after_secs: retry_after,
                        });
                    }
                    waited = true;
                    tokio::time::sleep(Duration::from_secs(retry_after).min(MAX_RETRY_WAIT)).await;
                }
                _ => {
                    let detail = short_detail(&response.text().await.unwrap_or_default());
                    return Err(match status {
                        403 if writing => PcoError::NoEditPermission,
                        403 => PcoError::NoServicesAccess,
                        404 => PcoError::NotFound,
                        _ => PcoError::Provider { status, detail },
                    });
                }
            }
        }
    }

    /// A list, following `links.next` up to `max_pages`.
    async fn get_all<A>(&self, path: &str, max_pages: usize) -> Result<Vec<Resource<A>>, PcoError>
    where
        A: DeserializeOwned + Default,
    {
        let mut items = Vec::new();
        let mut next = Some(path.to_string());
        let mut pages = 0;
        while let Some(path) = next.take() {
            if pages == max_pages {
                break;
            }
            let document: Document<Vec<Resource<A>>> = self.get(&path).await?;
            pages += 1;
            items.extend(document.data);
            next = document.links.next;
        }
        Ok(items)
    }

    /// Who is signed in, and where: "Ana Ejemplo · Iglesia".
    pub async fn me(&self) -> Result<PcoAccount, PcoError> {
        let person: Document<Resource<PersonAttributes>> = self.get("me").await?;
        let organization: Document<Resource<OrganizationAttributes>> = self.get("").await?;
        let attributes = person.data.attributes;
        let name = attributes.full_name.filter(|name| !name.trim().is_empty()).unwrap_or_else(|| {
            [attributes.first_name, attributes.last_name]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
        });
        Ok(PcoAccount {
            name,
            organization: organization.data.attributes.name.unwrap_or_default(),
        })
    }

    /// Songs whose title contains `query`, a page of 25 (`page` from 0).
    pub async fn search_songs(&self, query: &str, page: u32) -> Result<Page<PcoSong>, PcoError> {
        let mut url = self.url("songs")?;
        url.query_pairs_mut()
            .append_pair("where[title]", query.trim())
            .append_pair("order", "title")
            .append_pair("per_page", &SEARCH_PAGE_SIZE.to_string())
            .append_pair("offset", &(page * SEARCH_PAGE_SIZE).to_string());
        let document: Document<Vec<Resource<SongAttributes>>> = self.get(url.as_str()).await?;
        let has_more = document.links.next.is_some();
        Ok(Page {
            items: document
                .data
                .into_iter()
                .map(|song| PcoSong {
                    id: song.id,
                    title: song.attributes.title.unwrap_or_default(),
                    author: song.attributes.author,
                    ccli_number: song.attributes.ccli_number,
                    last_scheduled_at: song.attributes.last_scheduled_at,
                })
                .collect(),
            page,
            has_more,
            total: document.meta.total_count,
        })
    }

    pub async fn arrangements(&self, song_id: &str) -> Result<Vec<PcoArrangement>, PcoError> {
        let resources = self
            .get_all::<ArrangementAttributes>(&format!("songs/{}/arrangements", segment(song_id)), MAX_PAGES)
            .await?;
        Ok(resources
            .into_iter()
            .map(|resource| with_song(PcoArrangement::from(resource), song_id))
            .collect())
    }

    /// One arrangement with its chart. Never `/sections` (not reliable).
    pub async fn arrangement(&self, song_id: &str, arrangement_id: &str) -> Result<PcoArrangement, PcoError> {
        let document: Document<Resource<ArrangementAttributes>> = self
            .get(&format!(
                "songs/{}/arrangements/{}",
                segment(song_id),
                segment(arrangement_id)
            ))
            .await?;
        Ok(with_song(PcoArrangement::from(document.data), song_id))
    }

    pub async fn service_types(&self) -> Result<Vec<PcoServiceType>, PcoError> {
        let resources = self
            .get_all::<NamedAttributes>("service_types?per_page=50", MAX_PAGES)
            .await?;
        Ok(resources
            .into_iter()
            .map(|resource| PcoServiceType {
                id: resource.id,
                name: resource.attributes.name.unwrap_or_default(),
            })
            .collect())
    }

    /// The next plans of a service type, soonest first (one page).
    pub async fn upcoming_plans(&self, service_type_id: &str) -> Result<Vec<PcoPlan>, PcoError> {
        let resources = self
            .get_all::<PlanAttributes>(
                &format!(
                    "service_types/{}/plans?filter=future&order=sort_date&per_page=25",
                    segment(service_type_id)
                ),
                1,
            )
            .await?;
        Ok(resources
            .into_iter()
            .map(|resource| PcoPlan {
                id: resource.id,
                title: resource.attributes.title,
                dates: resource.attributes.dates,
                sort_date: resource.attributes.sort_date,
                series_title: resource.attributes.series_title,
            })
            .collect())
    }

    /// The song items of a plan, in order, with their arrangement, the
    /// service's key and their own sequence.
    pub async fn plan_items(&self, service_type_id: &str, plan_id: &str) -> Result<Vec<PcoPlanItem>, PcoError> {
        let resources = self
            .get_all::<ItemAttributes>(
                &format!(
                    "service_types/{}/plans/{}/items?include=song,arrangement,key&per_page=100",
                    segment(service_type_id),
                    segment(plan_id)
                ),
                MAX_PAGES,
            )
            .await?;
        let mut items: Vec<PcoPlanItem> = resources
            .into_iter()
            .filter(|resource| resource.attributes.item_type.as_deref() == Some("song"))
            .map(|resource| {
                let song_id = resource.related_id("song");
                let arrangement_id = resource.related_id("arrangement");
                let attributes = resource.attributes;
                PcoPlanItem {
                    id: resource.id,
                    title: attributes.title,
                    sequence: attributes.sequence.unwrap_or(0),
                    song_id,
                    arrangement_id,
                    key_name: attributes.key_name.filter(|key| !key.trim().is_empty()),
                    custom_arrangement_sequence: attributes.custom_arrangement_sequence,
                    custom_arrangement_sequence_full: attributes.custom_arrangement_sequence_full,
                }
            })
            .collect();
        items.sort_by_key(|item| item.sequence);
        Ok(items)
    }
}

impl PcoClient {
    /// A new arrangement in the song, with the chart, its key and the
    /// sequence (Planning Center requires the key with a chart).
    pub async fn create_arrangement(&self, song_id: &str, write: &ArrangementWrite) -> Result<PcoArrangement, PcoError> {
        let document: Document<Resource<ArrangementAttributes>> = self
            .request(
                reqwest::Method::POST,
                &format!("songs/{}/arrangements", segment(song_id)),
                Some(&write.body()),
            )
            .await?;
        Ok(with_song(PcoArrangement::from(document.data), song_id))
    }

    /// Replaces an arrangement's chart, key and sequence. Only on the user's
    /// explicit choice: other people use that arrangement.
    pub async fn update_arrangement(
        &self,
        song_id: &str,
        arrangement_id: &str,
        write: &ArrangementWrite,
    ) -> Result<PcoArrangement, PcoError> {
        let document: Document<Resource<ArrangementAttributes>> = self
            .request(
                reqwest::Method::PATCH,
                &format!("songs/{}/arrangements/{}", segment(song_id), segment(arrangement_id)),
                Some(&write.body()),
            )
            .await?;
        Ok(with_song(PcoArrangement::from(document.data), song_id))
    }

    /// The arrangement has a Key in `key` (named after it, like "D"), so
    /// Planning Center shows the chord chart in that key beside the lyrics.
    /// An existing Key that starts in it is left as it is.
    pub async fn ensure_key(&self, song_id: &str, arrangement_id: &str, key: &str) -> Result<(), PcoError> {
        let Some(key) = crate::model::pco_key(key) else {
            return Ok(());
        };
        let path = format!("songs/{}/arrangements/{}/keys", segment(song_id), segment(arrangement_id));
        let existing = self.get_all::<KeyAttributes>(&path, MAX_PAGES).await?;
        if existing
            .iter()
            .any(|resource| resource.attributes.starting_key.as_deref() == Some(key.as_str()))
        {
            return Ok(());
        }
        let body = serde_json::json!({
            "data": { "type": "Key", "attributes": { "name": key, "starting_key": key } }
        });
        let _: Document<Resource<KeyAttributes>> = self.request(reqwest::Method::POST, &path, Some(&body)).await?;
        Ok(())
    }
}

fn with_song(mut arrangement: PcoArrangement, song_id: &str) -> PcoArrangement {
    if arrangement.song_id.is_empty() {
        arrangement.song_id = song_id.to_string();
    }
    arrangement
}

/// An id as one path segment: ids are digits, anything else is escaped.
fn segment(id: &str) -> String {
    url::form_urlencoded::byte_serialize(id.as_bytes()).collect()
}
