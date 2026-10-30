//! The OneDrive implementation of [`CloudStorage`], over Microsoft Graph.
//!
//! ```text
//! OneDrive/
//! └── Apps/LibreTracks/     (Graph's "approot", created on first use)
//!     ├── Songs/      .ltpkg
//!     └── Sessions/   .ltset
//! ```
//!
//! There is no extra `LibreTracks/` level as in Drive: the app folder already
//! carries the app's name, and nesting another one inside it would only make
//! the user dig.
//!
//! # Upload sessions
//!
//! Large files go through `createUploadSession`: one POST returns an upload URL
//! valid for days, and the bytes go there in ranges. Every range but the last
//! must be a multiple of 320 KiB and under 60 MiB. After a dropped connection
//! a GET on the same URL says which bytes the server holds, and the upload
//! carries on from there instead of starting over.

use std::path::Path;

use async_trait::async_trait;
use serde::Deserialize;
use url::Url;

use crate::transfer::{self, net, ChunkPolicy, UploadPacer, PLATFORM_MAX_CHUNK};
use crate::{
    AccessTokens, CancelFn, CloudError, CloudStorage, ProgressFn, Quota, RemoteFile, RemoteFolder,
};

const PROVIDER: &str = "OneDrive";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";

/// Graph's fragment unit. A range that is not a multiple of it is rejected
/// with a 400 that does not say why.
const FRAGMENT_UNIT: u64 = 320 * 1024;
/// "Less than 60 MiB" per request, strictly.
const MAX_FRAGMENT: u64 = 60 * 1024 * 1024 - 1;

const CHUNKS: ChunkPolicy = ChunkPolicy {
    alignment: FRAGMENT_UNIT,
    min: FRAGMENT_UNIT * 10,
    initial: FRAGMENT_UNIT * 32,
    max: ChunkPolicy::align_down(
        FRAGMENT_UNIT,
        if PLATFORM_MAX_CHUNK < MAX_FRAGMENT {
            PLATFORM_MAX_CHUNK
        } else {
            MAX_FRAGMENT
        },
    ),
};

/// Network failures tolerated in a row before an upload gives up. Each one is
/// followed by asking the server where it stands, so a retry never resends
/// what already arrived.
const MAX_CONSECUTIVE_RETRIES: u32 = 6;

pub struct OneDriveClient {
    http: reqwest::Client,
    tokens: Box<dyn AccessTokens>,
    /// Graph's root. Only tests point it elsewhere.
    base: String,
}

impl OneDriveClient {
    pub fn new(tokens: Box<dyn AccessTokens>) -> Result<Self, CloudError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        Ok(Self {
            http,
            tokens,
            base: GRAPH.to_string(),
        })
    }

    async fn auth(&self) -> Result<String, CloudError> {
        Ok(format!("Bearer {}", self.tokens.access_token().await?))
    }

    async fn create_upload_session(
        &self,
        folder: RemoteFolder,
        remote_name: &str,
    ) -> Result<String, CloudError> {
        let body = serde_json::json!({
            // Keep both, like Drive does: exporting the same set twice must
            // never silently replace the copy a second device relies on.
            "item": { "@microsoft.graph.conflictBehavior": "rename" }
        });
        let response = self
            .http
            .post(create_session_url(&self.base, folder, remote_name))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .json(&body)
            .send()
            .await
            .map_err(net)?;
        let session: UploadSession = transfer::parse(PROVIDER, response).await?;
        Ok(session.upload_url)
    }

    /// Where the server stands on an upload session, after a failure.
    async fn upload_offset(&self, upload_url: &str) -> Result<Option<u64>, CloudError> {
        // The upload URL is pre-authenticated. Sending the bearer token to it
        // is documented as a cause of 401s, so no Authorization header here.
        let response = self.http.get(upload_url).send().await.map_err(net)?;
        let status: UploadStatus = transfer::parse(PROVIDER, response).await?;
        Ok(next_offset(&status.next_expected_ranges))
    }
}

#[async_trait]
impl CloudStorage for OneDriveClient {
    fn provider_name(&self) -> &'static str {
        PROVIDER
    }

    async fn list(&self, folder: RemoteFolder) -> Result<Vec<RemoteFile>, CloudError> {
        let mut next = Some(children_url(&self.base, folder));
        let mut files = Vec::new();
        while let Some(url) = next.take() {
            let response = self
                .http
                .get(url)
                .header(reqwest::header::AUTHORIZATION, self.auth().await?)
                .send()
                .await
                .map_err(net)?;
            // A folder that does not exist yet is simply empty: Songs/ appears
            // with the first song uploaded, not when the account connects.
            if response.status() == 404 {
                return Ok(Vec::new());
            }
            let page: Children = transfer::parse(PROVIDER, response).await?;
            files.extend(page.value.into_iter().filter_map(DriveItem::into_remote_file));
            next = page.next_link;
        }
        sort_newest_first(&mut files);
        Ok(files)
    }

    /// Quota of the whole OneDrive.
    ///
    /// With only `Files.ReadWrite.AppFolder` granted, Graph answers 403 to
    /// `/me/drive` until the app folder exists, and fine afterwards. Confirmed
    /// against a real account on 2026-10-30: right after the first consent the
    /// quota was refused, and after one upload created the folder it was
    /// readable. A fresh account opening the panel is exactly that first
    /// moment, so on 403 the folder is provisioned (a GET on approot creates
    /// it) and the quota asked once more.
    async fn quota(&self) -> Result<Quota, CloudError> {
        let ask = || async {
            self.http
                .get(format!("{}/me/drive", self.base))
                .header(reqwest::header::AUTHORIZATION, self.auth().await?)
                .query(&[("$select", "quota")])
                .send()
                .await
                .map_err(net)
        };
        let mut response = ask().await?;
        if response.status() == 403 {
            let provisioned = self
                .http
                .get(format!("{}/me/drive/special/approot", self.base))
                .header(reqwest::header::AUTHORIZATION, self.auth().await?)
                .send()
                .await
                .map_err(net)?;
            if !provisioned.status().is_success() {
                return Err(transfer::provider_error(PROVIDER, provisioned).await);
            }
            response = ask().await?;
        }
        let drive: DriveResponse = transfer::parse(PROVIDER, response).await?;
        Ok(drive.quota.unwrap_or_default().into())
    }

    async fn upload(
        &self,
        folder: RemoteFolder,
        local_path: &Path,
        remote_name: &str,
        progress: &ProgressFn,
        cancelled: &CancelFn,
    ) -> Result<RemoteFile, CloudError> {
        if cancelled() {
            return Err(CloudError::Cancelled);
        }
        let total = tokio::fs::metadata(local_path).await?.len();

        // Checked up front, as with Drive. A failure to READ the quota is not
        // a reason to refuse: OneDrive answers 507 itself if the file does not
        // fit, and an account type that hides its quota should still upload.
        match self.quota().await {
            Ok(quota) if !quota.fits(total) => {
                return Err(CloudError::QuotaExceeded {
                    needed: total,
                    free: quota.free_bytes().unwrap_or(0),
                })
            }
            Err(CloudError::NotConnected) => return Err(CloudError::NotConnected),
            _ => {}
        }

        let upload_url = self
            .create_upload_session(folder, &transfer::portable_name(remote_name))
            .await?;
        let mut pacer = UploadPacer::new(CHUNKS);
        let mut offset: u64 = 0;
        let mut failures: u32 = 0;
        progress(0, total);

        loop {
            if cancelled() {
                return Err(CloudError::Cancelled);
            }
            let end = (offset + pacer.chunk_size()).min(total);
            let request = self.http.put(&upload_url).header(
                reqwest::header::CONTENT_RANGE,
                content_range(offset, end, total),
            );
            let outcome = transfer::send_chunk(
                request,
                local_path,
                offset,
                end - offset,
                total,
                &pacer,
                progress,
                cancelled,
            )
            .await;

            let transient = match outcome {
                Ok((response, elapsed)) => match response.status().as_u16() {
                    202 => {
                        let status: UploadStatus = transfer::parse(PROVIDER, response).await?;
                        // The server's word on what it holds is authoritative;
                        // trusting our own counter is how a resumed upload
                        // silently corrupts a file.
                        let next = next_offset(&status.next_expected_ranges).unwrap_or(end);
                        pacer.record(next.saturating_sub(offset), elapsed);
                        offset = next;
                        failures = 0;
                        progress(offset, total);
                        continue;
                    }
                    200 | 201 => {
                        progress(total, total);
                        let item: DriveItem = transfer::parse(PROVIDER, response).await?;
                        return item.into_remote_file().ok_or_else(|| {
                            CloudError::Network("OneDrive confirmed the upload as a folder".into())
                        });
                    }
                    // 416: the range overlaps what the server already has,
                    // typically after a reply was lost. Ask and realign.
                    status if status == 416 || is_transient_status(status) => {
                        CloudError::Provider {
                            provider: PROVIDER,
                            status,
                            body: response.text().await.unwrap_or_default(),
                        }
                    }
                    _ => return Err(transfer::provider_error(PROVIDER, response).await),
                },
                Err(error @ CloudError::Network(_)) => error,
                Err(other) => return Err(other),
            };

            failures += 1;
            if failures > MAX_CONSECUTIVE_RETRIES {
                return Err(transient);
            }
            transfer::wait_before_retry(failures, cancelled).await?;
            // If even the status query fails, keep the position and let the
            // next attempt (and its own failure count) decide.
            if let Ok(Some(server_offset)) = self.upload_offset(&upload_url).await {
                offset = server_offset;
                progress(offset, total);
            }
            if offset >= total {
                // Every byte arrived but the reply that carried the new item
                // was lost. The file is probably there; let the user refresh
                // the list rather than re-upload a gigabyte on a guess.
                return Err(CloudError::Network(
                    "the upload finished without OneDrive confirming the file".into(),
                ));
            }
        }
    }

    async fn download(
        &self,
        file_id: &str,
        dest_path: &Path,
        progress: &ProgressFn,
        cancelled: &CancelFn,
    ) -> Result<(), CloudError> {
        // Graph answers with a 302 to a pre-authenticated download URL on
        // another host. reqwest follows it and drops the Authorization header
        // on the way, which is exactly right: that host must not see it.
        let request = self
            .http
            .get(item_url(&self.base, file_id, Some("content")))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?);
        let response = transfer::send_cancellable(request, cancelled).await?;
        if !response.status().is_success() {
            return Err(transfer::provider_error(PROVIDER, response).await);
        }
        transfer::stream_to_file(response, dest_path, progress, cancelled).await
    }

    async fn delete(&self, file_id: &str) -> Result<(), CloudError> {
        let response = self
            .http
            .delete(item_url(&self.base, file_id, None))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .send()
            .await
            .map_err(net)?;
        // 404 is already the end state the user asked for.
        if response.status().is_success() || response.status() == 404 {
            Ok(())
        } else {
            Err(transfer::provider_error(PROVIDER, response).await)
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/// `.../approot:/<folder>:/children`, with the fields the list needs.
fn children_url(base: &str, folder: RemoteFolder) -> String {
    let mut url = Url::parse(base).expect("the Graph base is a valid URL");
    url.path_segments_mut()
        .expect("the Graph base can be a base")
        .extend([
            "me",
            "drive",
            "special",
            "approot:",
            &format!("{}:", folder.folder_name()),
            "children",
        ]);
    url.query_pairs_mut()
        .append_pair("$select", "id,name,size,lastModifiedDateTime,folder")
        .append_pair("$top", "200");
    url.to_string()
}

/// `.../approot:/<folder>/<name>:/createUploadSession`.
///
/// Built segment by segment so a name with spaces, `#` or `%` is
/// percent-encoded instead of truncating the path or turning into a fragment.
/// Missing parent folders are created by Graph as part of the session.
fn create_session_url(base: &str, folder: RemoteFolder, name: &str) -> String {
    let mut url = Url::parse(base).expect("the Graph base is a valid URL");
    url.path_segments_mut()
        .expect("the Graph base can be a base")
        .extend([
            "me",
            "drive",
            "special",
            "approot:",
            folder.folder_name(),
            &format!("{name}:"),
            "createUploadSession",
        ]);
    url.to_string()
}

fn item_url(base: &str, id: &str, action: Option<&str>) -> String {
    let mut url = Url::parse(base).expect("the Graph base is a valid URL");
    {
        let mut segments = url.path_segments_mut().expect("the Graph base can be a base");
        segments.extend(["me", "drive", "items", id]);
        if let Some(action) = action {
            segments.push(action);
        }
    }
    url.to_string()
}

/// Inclusive byte range, as Graph wants it: `bytes 0-327679/1000000`.
fn content_range(start: u64, end: u64, total: u64) -> String {
    format!("bytes {}-{}/{}", start, end - 1, total)
}

/// The first byte the server still wants, from `nextExpectedRanges`.
///
/// Entries look like `"26214400-"` or `"0-327679"`; the first one's start is
/// where to continue. An empty list means nothing is missing.
pub(crate) fn next_offset(ranges: &[String]) -> Option<u64> {
    ranges.first()?.split('-').next()?.trim().parse().ok()
}

/// Throttling and server hiccups. 507 is excluded: "insufficient storage"
/// will not fix itself by waiting.
fn is_transient_status(status: u16) -> bool {
    status == 429 || ((500..600).contains(&status) && status != 507)
}

fn sort_newest_first(files: &mut [RemoteFile]) {
    // RFC 3339 in UTC, as Graph sends it, sorts correctly as text.
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
}

// ---------------------------------------------------------------------------
// Wire types.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveItem {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    last_modified_date_time: Option<String>,
    /// Present only on folders. Its content is irrelevant.
    #[serde(default)]
    folder: Option<serde_json::Value>,
}

impl DriveItem {
    fn into_remote_file(self) -> Option<RemoteFile> {
        if self.folder.is_some() {
            return None;
        }
        Some(RemoteFile {
            id: self.id,
            name: self.name.unwrap_or_default(),
            size_bytes: self.size.unwrap_or(0),
            modified: self.last_modified_date_time,
        })
    }
}

#[derive(Debug, Deserialize)]
struct Children {
    #[serde(default)]
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink", default)]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    upload_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadStatus {
    #[serde(default)]
    next_expected_ranges: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct DriveResponse {
    #[serde(default)]
    quota: Option<GraphQuota>,
}

#[derive(Debug, Default, Deserialize)]
struct GraphQuota {
    #[serde(default)]
    used: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
}

impl From<GraphQuota> for Quota {
    fn from(q: GraphQuota) -> Self {
        Quota {
            used_bytes: q.used.unwrap_or(0),
            limit_bytes: q.total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_obey_graph_rules() {
        for size in [CHUNKS.min, CHUNKS.initial, CHUNKS.max] {
            assert_eq!(size % FRAGMENT_UNIT, 0, "{size} is not a multiple of 320 KiB");
            assert!(size < 60 * 1024 * 1024, "{size} is not under 60 MiB");
        }
        let (min, initial, max) = (CHUNKS.min, CHUNKS.initial, CHUNKS.max);
        assert!(min <= initial && initial <= max);
    }

    #[test]
    fn content_range_is_inclusive() {
        assert_eq!(content_range(0, 327_680, 1_000_000), "bytes 0-327679/1000000");
        assert_eq!(content_range(983_040, 1_000_000, 1_000_000), "bytes 983040-999999/1000000");
    }

    /// The resume point after a dropped connection. Off by one here corrupts
    /// the file while reporting success.
    #[test]
    fn next_offset_is_the_start_of_the_first_missing_range() {
        assert_eq!(next_offset(&["26214400-".into()]), Some(26_214_400));
        assert_eq!(next_offset(&["0-327679".into(), "655360-".into()]), Some(0));
        assert_eq!(next_offset(&[]), None);
        assert_eq!(next_offset(&["junk".into()]), None);
    }

    #[test]
    fn upload_status_parses_from_graph_json() {
        let status: UploadStatus = serde_json::from_str(
            r#"{"expirationDateTime":"2026-11-02T10:00:00Z","nextExpectedRanges":["12345-"]}"#,
        )
        .unwrap();
        assert_eq!(next_offset(&status.next_expected_ranges), Some(12_345));
    }

    #[test]
    fn names_with_spaces_and_hashes_are_percent_encoded_in_the_path() {
        let url = create_session_url(GRAPH, RemoteFolder::Sessions, "Domingo #12 100%.ltset");
        assert_eq!(
            url,
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/Sessions/Domingo%20%2312%20100%25.ltset:/createUploadSession"
        );
    }

    #[test]
    fn non_ascii_names_survive_the_path() {
        let url = create_session_url(GRAPH, RemoteFolder::Songs, "Canción.ltpkg");
        assert!(url.contains("/approot:/Songs/Canci%C3%B3n.ltpkg:/createUploadSession"));
    }

    #[test]
    fn the_children_url_targets_the_folder_inside_the_app_folder() {
        let url = children_url(GRAPH, RemoteFolder::Songs);
        assert!(url.starts_with(
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/Songs:/children?"
        ));
        assert!(url.contains("%24top=200"));
    }

    #[test]
    fn item_urls_address_by_id() {
        assert_eq!(
            item_url(GRAPH, "ABC123!456", Some("content")),
            "https://graph.microsoft.com/v1.0/me/drive/items/ABC123!456/content"
        );
        assert_eq!(
            item_url(GRAPH, "ABC123!456", None),
            "https://graph.microsoft.com/v1.0/me/drive/items/ABC123!456"
        );
    }

    #[test]
    fn a_listing_skips_folders_and_follows_the_next_link() {
        let page: Children = serde_json::from_str(
            r#"{"value":[
                {"id":"1","name":"Set.ltset","size":1048576,"lastModifiedDateTime":"2026-10-01T10:00:00Z","file":{}},
                {"id":"2","name":"Sub","folder":{"childCount":0}}
            ],"@odata.nextLink":"https://graph.microsoft.com/v1.0/next"}"#,
        )
        .unwrap();
        assert_eq!(page.next_link.as_deref(), Some("https://graph.microsoft.com/v1.0/next"));
        let files: Vec<_> = page
            .value
            .into_iter()
            .filter_map(DriveItem::into_remote_file)
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].size_bytes, 1_048_576);
    }

    #[test]
    fn listings_are_newest_first() {
        let file = |id: &str, modified: &str| RemoteFile {
            id: id.into(),
            name: id.into(),
            size_bytes: 0,
            modified: Some(modified.into()),
        };
        let mut files = vec![
            file("old", "2026-01-01T00:00:00Z"),
            file("new", "2026-10-01T00:00:00Z"),
        ];
        sort_newest_first(&mut files);
        assert_eq!(files[0].id, "new");
    }

    #[test]
    fn quota_maps_used_and_total() {
        let drive: DriveResponse = serde_json::from_str(
            r#"{"quota":{"used":1000,"total":5368709120,"remaining":5368708120,"state":"normal"}}"#,
        )
        .unwrap();
        let quota: Quota = drive.quota.unwrap().into();
        assert_eq!(quota.used_bytes, 1000);
        assert_eq!(quota.limit_bytes, Some(5_368_709_120));
    }

    // ── Upload against a fake Graph ─────────────────────────────────────────

    use crate::test_server::{self, Response};
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct FixedToken;

    #[async_trait]
    impl AccessTokens for FixedToken {
        async fn access_token(&self) -> Result<String, CloudError> {
            Ok("token".into())
        }
    }

    /// The acceptance criterion of the plan: a connection that dies in the
    /// middle of an upload, AFTER the server stored the chunk but before the
    /// client heard back, must end in a file byte-for-byte identical to the
    /// local one. That is the case where trusting our own offset either
    /// duplicates or skips a chunk.
    #[tokio::test]
    async fn an_upload_cut_mid_way_resumes_and_arrives_intact() {
        let (local, original) = test_server::sample_file(16 * 1024 * 1024 + 12_345);
        let stored = Arc::new(Mutex::new(Vec::<u8>::new()));
        let puts = Arc::new(AtomicUsize::new(0));
        let saw_auth_on_upload = Arc::new(Mutex::new(false));

        let base = {
            let stored = Arc::clone(&stored);
            let puts = Arc::clone(&puts);
            let saw_auth = Arc::clone(&saw_auth_on_upload);
            let total = original.len();
            test_server::serve(move |req, base| {
                let held = stored.lock().unwrap().len();
                match (req.method.as_str(), req.target.as_str()) {
                    ("GET", t) if t.starts_with("/me/drive?") => {
                        Response::json(200, r#"{"quota":{"used":0,"total":1099511627776}}"#)
                    }
                    ("POST", t) if t.ends_with(":/createUploadSession") => Response::json(
                        200,
                        format!(r#"{{"uploadUrl":"{base}/upload/abc"}}"#),
                    ),
                    ("GET", "/upload/abc") => Response::json(
                        200,
                        format!(r#"{{"nextExpectedRanges":["{held}-"]}}"#),
                    ),
                    ("PUT", "/upload/abc") => {
                        if req.headers.contains_key("authorization") {
                            *saw_auth.lock().unwrap() = true;
                        }
                        let start: usize = req.headers["content-range"]
                            .trim_start_matches("bytes ")
                            .split('-')
                            .next()
                            .unwrap()
                            .parse()
                            .unwrap();
                        if start != held {
                            return Response::json(416, "{}");
                        }
                        stored.lock().unwrap().extend_from_slice(&req.body);
                        if puts.fetch_add(1, Ordering::SeqCst) == 0 {
                            // The first chunk (of two: 10 MiB initial, then
                            // the rest) is stored, but the reply never makes
                            // it back.
                            return None;
                        }
                        let held = stored.lock().unwrap().len();
                        if held == total {
                            Response::json(
                                201,
                                format!(r#"{{"id":"item-1","name":"Set.ltset","size":{total}}}"#),
                            )
                        } else {
                            Response::json(202, format!(r#"{{"nextExpectedRanges":["{held}-"]}}"#))
                        }
                    }
                    _ => Response::json(404, "{}"),
                }
            })
            .await
        };

        let mut client = OneDriveClient::new(Box::new(FixedToken)).unwrap();
        client.base = base;
        let uploaded = client
            .upload(RemoteFolder::Sessions, &local.0, "Set.ltset", &|_, _| {}, &|| false)
            .await
            .unwrap();

        assert_eq!(uploaded.id, "item-1");
        assert!(puts.load(Ordering::SeqCst) >= 2, "the cut never happened");
        let stored = stored.lock().unwrap();
        assert_eq!(stored.len(), original.len());
        assert_eq!(Sha256::digest(&*stored), Sha256::digest(&original));
        assert!(
            !*saw_auth_on_upload.lock().unwrap(),
            "the bearer token was sent to the pre-authenticated upload URL"
        );
    }

    /// A brand-new account: the quota is refused until the app folder exists.
    /// The panel must still show it on first open.
    #[tokio::test]
    async fn the_quota_provisions_the_app_folder_on_a_fresh_account() {
        let provisioned = Arc::new(Mutex::new(false));
        let base = {
            let provisioned = Arc::clone(&provisioned);
            test_server::serve(move |req, _| match req.target.as_str() {
                "/me/drive/special/approot" => {
                    *provisioned.lock().unwrap() = true;
                    Response::json(200, r#"{"id":"root","name":"LibreTracks","folder":{}}"#)
                }
                t if t.starts_with("/me/drive?") => {
                    if *provisioned.lock().unwrap() {
                        Response::json(200, r#"{"quota":{"used":10,"total":5368709120}}"#)
                    } else {
                        Response::json(403, r#"{"error":{"code":"accessDenied"}}"#)
                    }
                }
                _ => Response::json(404, "{}"),
            })
            .await
        };
        let mut client = OneDriveClient::new(Box::new(FixedToken)).unwrap();
        client.base = base;

        let quota = client.quota().await.unwrap();
        assert_eq!(quota.limit_bytes, Some(5_368_709_120));
        assert!(*provisioned.lock().unwrap());
    }

    #[test]
    fn only_throttling_and_server_errors_are_retried() {
        assert!(is_transient_status(429));
        assert!(is_transient_status(503));
        assert!(!is_transient_status(400));
        assert!(!is_transient_status(404));
        assert!(!is_transient_status(507));
    }
}
