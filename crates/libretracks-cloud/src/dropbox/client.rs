//! The Dropbox implementation of [`CloudStorage`].
//!
//! ```text
//! Dropbox/
//! └── Apps/LibreTracks/     (the app folder; paths below are relative to it)
//!     ├── Songs/      .ltpkg
//!     └── Sessions/   .ltset
//! ```
//!
//! # Upload sessions
//!
//! `upload_session/start` opens a session, `append_v2` adds bytes at an
//! offset, `finish` commits the file. A request may carry at most 150 MB. The
//! offset is ours to state on every append, and when it disagrees with what
//! Dropbox holds (a reply lost after the bytes arrived) Dropbox answers
//! `incorrect_offset` with the right one, which is the whole resume protocol.
//!
//! # The `Dropbox-API-Arg` header is ASCII only
//!
//! Content endpoints take their JSON argument in a header, and HTTP headers
//! are not UTF-8. Dropbox requires every non-ASCII character escaped as
//! `\uXXXX` inside that JSON. "Canción.ltpkg" sent raw fails with a 400 that
//! mentions neither the header nor the accent. See [`api_arg`].

use std::path::Path;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::transfer::{self, net, ChunkPolicy, UploadPacer, PLATFORM_MAX_CHUNK};
use crate::{
    AccessTokens, CancelFn, CloudError, CloudStorage, ProgressFn, Quota, RemoteFile, RemoteFolder,
};

const PROVIDER: &str = "Dropbox";
const API: &str = "https://api.dropboxapi.com/2";
const CONTENT: &str = "https://content.dropboxapi.com/2";

/// Dropbox recommends 4 MiB multiples, and requires them for concurrent
/// appends; a request may not exceed 150 MB.
const UNIT: u64 = 4 * 1024 * 1024;
const MAX_REQUEST: u64 = 150 * 1000 * 1000;

const CHUNKS: ChunkPolicy = ChunkPolicy {
    alignment: UNIT,
    min: UNIT,
    initial: UNIT * 2,
    max: ChunkPolicy::align_down(
        UNIT,
        if PLATFORM_MAX_CHUNK < MAX_REQUEST {
            PLATFORM_MAX_CHUNK
        } else {
            MAX_REQUEST
        },
    ),
};

/// Network failures tolerated in a row before an upload gives up.
const MAX_CONSECUTIVE_RETRIES: u32 = 6;

pub struct DropboxClient {
    http: reqwest::Client,
    tokens: Box<dyn AccessTokens>,
    /// RPC and content roots. Only tests point them elsewhere.
    api: String,
    content: String,
}

impl DropboxClient {
    pub fn new(tokens: Box<dyn AccessTokens>) -> Result<Self, CloudError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        Ok(Self {
            http,
            tokens,
            api: API.to_string(),
            content: CONTENT.to_string(),
        })
    }

    async fn auth(&self) -> Result<String, CloudError> {
        Ok(format!("Bearer {}", self.tokens.access_token().await?))
    }

    /// POST a JSON RPC call.
    async fn rpc(
        &self,
        route: &str,
        body: &serde_json::Value,
    ) -> Result<reqwest::Response, CloudError> {
        self.http
            .post(format!("{}/{route}", self.api))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .json(body)
            .send()
            .await
            .map_err(net)
    }

    /// A content-upload request with its argument in the header. The body is
    /// added by the caller.
    async fn content_request(
        &self,
        route: &str,
        arg: &serde_json::Value,
    ) -> Result<reqwest::RequestBuilder, CloudError> {
        Ok(self
            .http
            .post(format!("{}/{route}", self.content))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .header("Dropbox-API-Arg", api_arg(arg))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream"))
    }

    async fn start_session(&self) -> Result<String, CloudError> {
        let response = self
            .content_request("files/upload_session/start", &json!({ "close": false }))
            .await?
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await
            .map_err(net)?;
        let started: SessionStart = transfer::parse(PROVIDER, response).await?;
        Ok(started.session_id)
    }

    async fn finish_session(
        &self,
        session_id: &str,
        total: u64,
        path: &str,
    ) -> Result<reqwest::Response, CloudError> {
        let arg = json!({
            "cursor": { "session_id": session_id, "offset": total },
            // "add" + autorename keeps both copies, as Drive and OneDrive do:
            // exporting the same set twice never replaces the one a second
            // device relies on.
            "commit": { "path": path, "mode": "add", "autorename": true, "mute": true },
        });
        self.content_request("files/upload_session/finish", &arg)
            .await?
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await
            .map_err(net)
    }
}

#[async_trait]
impl CloudStorage for DropboxClient {
    fn provider_name(&self) -> &'static str {
        PROVIDER
    }

    async fn list(&self, folder: RemoteFolder) -> Result<Vec<RemoteFile>, CloudError> {
        let mut response = self
            .rpc(
                "files/list_folder",
                &json!({ "path": folder_path(folder), "limit": 2000 }),
            )
            .await?;
        let mut files = Vec::new();
        loop {
            if response.status() == 409 {
                let body = response.text().await.unwrap_or_default();
                // Songs/ only exists once the first song is uploaded.
                if is_not_found(&body) {
                    return Ok(Vec::new());
                }
                return Err(CloudError::Provider {
                    provider: PROVIDER,
                    status: 409,
                    body,
                });
            }
            let page: ListFolder = transfer::parse(PROVIDER, response).await?;
            files.extend(page.entries.into_iter().filter_map(Entry::into_remote_file));
            if !page.has_more {
                break;
            }
            response = self
                .rpc("files/list_folder/continue", &json!({ "cursor": page.cursor }))
                .await?;
        }
        files.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(files)
    }

    async fn quota(&self) -> Result<Quota, CloudError> {
        // An RPC with no argument still needs a JSON body: `null`.
        let response = self
            .http
            .post(format!("{}/users/get_space_usage", self.api))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("null")
            .send()
            .await
            .map_err(net)?;
        let usage: SpaceUsage = transfer::parse(PROVIDER, response).await?;
        Ok(usage.into())
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
        let quota = self.quota().await?;
        if !quota.fits(total) {
            return Err(CloudError::QuotaExceeded {
                needed: total,
                free: quota.free_bytes().unwrap_or(0),
            });
        }

        let path = format!(
            "{}/{}",
            folder_path(folder),
            transfer::portable_name(remote_name)
        );
        let session_id = self.start_session().await?;
        let mut pacer = UploadPacer::new(CHUNKS);
        let mut offset: u64 = 0;
        let mut failures: u32 = 0;
        progress(0, total);

        while offset < total {
            if cancelled() {
                return Err(CloudError::Cancelled);
            }
            let end = (offset + pacer.chunk_size()).min(total);
            let arg = json!({
                "cursor": { "session_id": session_id, "offset": offset },
                "close": false,
            });
            let request = self.content_request("files/upload_session/append_v2", &arg).await?;
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
                    200 => {
                        pacer.record(end - offset, elapsed);
                        offset = end;
                        failures = 0;
                        progress(offset, total);
                        continue;
                    }
                    409 => {
                        let body = response.text().await.unwrap_or_default();
                        // The server's offset is authoritative. Realigning to
                        // it is not a failure: it is the normal end of a
                        // retry whose first attempt actually arrived.
                        if let Some(correct) = correct_offset(&body) {
                            offset = correct;
                            progress(offset, total);
                            continue;
                        }
                        return Err(CloudError::Provider {
                            provider: PROVIDER,
                            status: 409,
                            body,
                        });
                    }
                    status if status == 429 || (status >= 500 && status != 507) => {
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

            // Retry the same offset: if the bytes did arrive, Dropbox says so
            // with incorrect_offset and the 409 branch above realigns.
            failures += 1;
            if failures > MAX_CONSECUTIVE_RETRIES {
                return Err(transient);
            }
            transfer::wait_before_retry(failures, cancelled).await?;
        }

        let response = self.finish_session(&session_id, total, &path).await?;
        let entry: Entry = transfer::parse(PROVIDER, response).await?;
        progress(total, total);
        entry
            .into_remote_file()
            .ok_or_else(|| CloudError::Network("Dropbox confirmed the upload as a folder".into()))
    }

    async fn download(
        &self,
        file_id: &str,
        dest_path: &Path,
        progress: &ProgressFn,
        cancelled: &CancelFn,
    ) -> Result<(), CloudError> {
        let request = self
            .http
            .post(format!("{}/files/download", self.content))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .header("Dropbox-API-Arg", api_arg(&json!({ "path": file_id })));
        let response = transfer::send_cancellable(request, cancelled).await?;
        if !response.status().is_success() {
            return Err(transfer::provider_error(PROVIDER, response).await);
        }
        transfer::stream_to_file(response, dest_path, progress, cancelled).await
    }

    async fn delete(&self, file_id: &str) -> Result<(), CloudError> {
        let response = self
            .rpc("files/delete_v2", &json!({ "path": file_id }))
            .await?;
        if response.status().is_success() {
            return Ok(());
        }
        if response.status() == 409 {
            let body = response.text().await.unwrap_or_default();
            // Already gone is what the user asked for.
            if is_not_found(&body) {
                return Ok(());
            }
            return Err(CloudError::Provider {
                provider: PROVIDER,
                status: 409,
                body,
            });
        }
        Err(transfer::provider_error(PROVIDER, response).await)
    }
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/// Path of a folder inside the app folder. The app folder itself is `""`.
fn folder_path(folder: RemoteFolder) -> String {
    format!("/{}", folder.folder_name())
}

/// Serialise a `Dropbox-API-Arg` value: JSON with every non-ASCII character
/// escaped as `\uXXXX` (UTF-16, surrogate pairs above the BMP), plus DEL,
/// which is ASCII but not allowed in a header either.
pub(crate) fn api_arg(value: &serde_json::Value) -> String {
    let raw = value.to_string();
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_ascii() && c != '\u{7f}' {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

/// Where Dropbox says an upload session really is, from an
/// `incorrect_offset` error.
///
/// `append_v2` puts it at `error.correct_offset`; `finish` nests it under
/// `error.lookup_failed.correct_offset`. Searched rather than addressed so
/// both shapes, and any future nesting, are covered.
pub(crate) fn correct_offset(body: &str) -> Option<u64> {
    fn find(value: &serde_json::Value) -> Option<u64> {
        match value {
            serde_json::Value::Object(map) => map
                .get("correct_offset")
                .and_then(|v| v.as_u64())
                .or_else(|| map.values().find_map(find)),
            _ => None,
        }
    }
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    if !json.get("error_summary")?.as_str()?.contains("incorrect_offset") {
        return None;
    }
    find(json.get("error")?)
}

/// Whether a 409 means "no such path", in any of the shapes the different
/// routes use (`path/not_found/`, `path_lookup/not_found/`).
fn is_not_found(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| json.get("error_summary")?.as_str().map(str::to_owned))
        .is_some_and(|summary| summary.contains("not_found"))
}

// ---------------------------------------------------------------------------
// Wire types.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SessionStart {
    session_id: String,
}

#[derive(Debug, Deserialize)]
struct ListFolder {
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    has_more: bool,
}

#[derive(Debug, Deserialize)]
struct Entry {
    #[serde(rename = ".tag", default)]
    tag: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    server_modified: Option<String>,
}

impl Entry {
    /// Files only. `list_folder` returns folders and deleted entries too, and
    /// `finish` returns file metadata without a tag at all.
    fn into_remote_file(self) -> Option<RemoteFile> {
        if self.tag.as_deref().is_some_and(|tag| tag != "file") {
            return None;
        }
        Some(RemoteFile {
            // `id:...`, accepted anywhere a path is, and stable across renames.
            id: self.id?,
            name: self.name,
            size_bytes: self.size.unwrap_or(0),
            modified: self.server_modified,
        })
    }
}

#[derive(Debug, Deserialize)]
struct SpaceUsage {
    #[serde(default)]
    used: u64,
    allocation: Allocation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = ".tag", rename_all = "snake_case")]
enum Allocation {
    Individual {
        allocated: u64,
    },
    /// Team accounts share one pool. A per-user cap, when the admin set one,
    /// is the number that actually limits this user.
    Team {
        allocated: u64,
        #[serde(default)]
        user_within_team_space_allocated: u64,
    },
    #[serde(other)]
    Other,
}

impl From<SpaceUsage> for Quota {
    fn from(usage: SpaceUsage) -> Self {
        let limit = match usage.allocation {
            Allocation::Individual { allocated } => Some(allocated),
            Allocation::Team {
                user_within_team_space_allocated,
                ..
            } if user_within_team_space_allocated > 0 => Some(user_within_team_space_allocated),
            Allocation::Team { allocated, .. } => Some(allocated),
            Allocation::Other => None,
        };
        Quota {
            used_bytes: usage.used,
            limit_bytes: limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_are_4_mib_multiples_under_150_mb() {
        for size in [CHUNKS.min, CHUNKS.initial, CHUNKS.max] {
            assert_eq!(size % UNIT, 0);
            assert!(size <= MAX_REQUEST);
        }
    }

    /// A backslash, `u` and `hex`, spelt out so no editor or tool along the way
    /// turns the expected escape back into the character it stands for.
    fn esc(hex: &str) -> String {
        format!("{}u{hex}", char::from(92u8))
    }

    /// The bug this exists for: an accented song name in a header.
    #[test]
    fn api_arg_escapes_everything_outside_ascii() {
        let arg = api_arg(&json!({ "path": "/Songs/Canción ñ.ltpkg" }));
        assert!(arg.is_ascii());
        assert_eq!(arg, format!(r#"{{"path":"/Songs/Canci{}n {}.ltpkg"}}"#, esc("00f3"), esc("00f1")));
        // And it still means the same thing to a JSON parser.
        let back: serde_json::Value = serde_json::from_str(&arg).unwrap();
        assert_eq!(back["path"], "/Songs/Canción ñ.ltpkg");
    }

    #[test]
    fn characters_above_the_bmp_become_surrogate_pairs() {
        let arg = api_arg(&json!({ "path": "/Sessions/🎸.ltset" }));
        assert_eq!(arg, format!(r#"{{"path":"/Sessions/{}{}.ltset"}}"#, esc("d83c"), esc("dfb8")));
    }

    #[test]
    fn correct_offset_is_found_in_append_and_finish_errors() {
        let append = r#"{"error_summary":"incorrect_offset/..","error":{".tag":"incorrect_offset","correct_offset":8388608}}"#;
        let finish = r#"{"error_summary":"lookup_failed/incorrect_offset/..","error":{".tag":"lookup_failed","lookup_failed":{".tag":"incorrect_offset","correct_offset":4194304}}}"#;
        assert_eq!(correct_offset(append), Some(8_388_608));
        assert_eq!(correct_offset(finish), Some(4_194_304));
    }

    #[test]
    fn other_conflicts_are_not_mistaken_for_an_offset() {
        let closed = r#"{"error_summary":"closed/..","error":{".tag":"closed"}}"#;
        assert_eq!(correct_offset(closed), None);
        assert_eq!(correct_offset("not json"), None);
    }

    #[test]
    fn a_missing_folder_reads_as_not_found() {
        assert!(is_not_found(
            r#"{"error_summary":"path/not_found/..","error":{".tag":"path","path":{".tag":"not_found"}}}"#
        ));
        assert!(is_not_found(r#"{"error_summary":"path_lookup/not_found/...","error":{}}"#));
        assert!(!is_not_found(r#"{"error_summary":"path/restricted_content/","error":{}}"#));
    }

    #[test]
    fn a_listing_keeps_files_and_drops_folders_and_deletions() {
        let page: ListFolder = serde_json::from_str(
            r#"{"entries":[
                {".tag":"file","name":"Set.ltset","id":"id:a1","size":2048,"server_modified":"2026-10-01T10:00:00Z"},
                {".tag":"folder","name":"old","id":"id:f1"},
                {".tag":"deleted","name":"gone.ltset"}
            ],"cursor":"c1","has_more":true}"#,
        )
        .unwrap();
        assert!(page.has_more);
        let files: Vec<_> = page.entries.into_iter().filter_map(Entry::into_remote_file).collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "id:a1");
        assert_eq!(files[0].size_bytes, 2048);
    }

    #[test]
    fn finish_metadata_without_a_tag_is_a_file() {
        let entry: Entry =
            serde_json::from_str(r#"{"name":"Set (1).ltset","id":"id:z","size":10}"#).unwrap();
        let file = entry.into_remote_file().unwrap();
        assert_eq!(file.name, "Set (1).ltset");
    }

    #[test]
    fn quota_for_individual_and_team_accounts() {
        let individual: SpaceUsage = serde_json::from_str(
            r#"{"used":100,"allocation":{".tag":"individual","allocated":2147483648}}"#,
        )
        .unwrap();
        assert_eq!(Quota::from(individual).limit_bytes, Some(2_147_483_648));

        let capped: SpaceUsage = serde_json::from_str(
            r#"{"used":100,"allocation":{".tag":"team","used":5,"allocated":5000,"user_within_team_space_allocated":300}}"#,
        )
        .unwrap();
        assert_eq!(Quota::from(capped).limit_bytes, Some(300));

        let pooled: SpaceUsage = serde_json::from_str(
            r#"{"used":100,"allocation":{".tag":"team","used":5,"allocated":5000,"user_within_team_space_allocated":0}}"#,
        )
        .unwrap();
        assert_eq!(Quota::from(pooled).limit_bytes, Some(5000));
    }

    // ── Upload against a fake Dropbox ───────────────────────────────────────

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

    /// Same acceptance criterion as OneDrive's: the reply to an append is lost
    /// after Dropbox stored the bytes. The retry at the old offset must be
    /// answered with incorrect_offset and realign, and the file must arrive
    /// with the same SHA-256 as the local one.
    #[tokio::test]
    async fn an_upload_cut_mid_way_resumes_and_arrives_intact() {
        let (local, original) = test_server::sample_file(3 * UNIT as usize + 777);
        let stored = Arc::new(Mutex::new(Vec::<u8>::new()));
        let appends = Arc::new(AtomicUsize::new(0));
        let committed_path = Arc::new(Mutex::new(String::new()));

        let base = {
            let stored = Arc::clone(&stored);
            let appends = Arc::clone(&appends);
            let committed_path = Arc::clone(&committed_path);
            let total = original.len();
            test_server::serve(move |req, _| {
                let held = stored.lock().unwrap().len();
                let arg: serde_json::Value = req
                    .headers
                    .get("dropbox-api-arg")
                    .map(|a| serde_json::from_str(a).unwrap())
                    .unwrap_or(serde_json::Value::Null);
                match req.target.as_str() {
                    "/api/users/get_space_usage" => Response::json(
                        200,
                        r#"{"used":0,"allocation":{".tag":"individual","allocated":2147483648}}"#,
                    ),
                    "/content/files/upload_session/start" => {
                        Response::json(200, r#"{"session_id":"s1"}"#)
                    }
                    "/content/files/upload_session/append_v2" => {
                        let offset = arg["cursor"]["offset"].as_u64().unwrap() as usize;
                        if offset != held {
                            return Response::json(
                                409,
                                format!(
                                    r#"{{"error_summary":"incorrect_offset/.","error":{{".tag":"incorrect_offset","correct_offset":{held}}}}}"#
                                ),
                            );
                        }
                        stored.lock().unwrap().extend_from_slice(&req.body);
                        if appends.fetch_add(1, Ordering::SeqCst) == 0 {
                            // Stored, but the reply never makes it back.
                            return None;
                        }
                        Response::json(200, "null")
                    }
                    "/content/files/upload_session/finish" => {
                        assert_eq!(arg["cursor"]["offset"].as_u64().unwrap() as usize, held);
                        *committed_path.lock().unwrap() =
                            arg["commit"]["path"].as_str().unwrap().to_string();
                        Response::json(
                            200,
                            format!(r#"{{"name":"Domingo.ltset","id":"id:done","size":{total}}}"#),
                        )
                    }
                    _ => Response::json(404, "{}"),
                }
            })
            .await
        };

        let mut client = DropboxClient::new(Box::new(FixedToken)).unwrap();
        client.api = format!("{base}/api");
        client.content = format!("{base}/content");
        let uploaded = client
            .upload(RemoteFolder::Sessions, &local.0, "Domingo.ltset", &|_, _| {}, &|| false)
            .await
            .unwrap();

        assert_eq!(uploaded.id, "id:done");
        assert!(appends.load(Ordering::SeqCst) >= 2, "the cut never happened");
        assert_eq!(*committed_path.lock().unwrap(), "/Sessions/Domingo.ltset");
        let stored = stored.lock().unwrap();
        assert_eq!(stored.len(), original.len());
        assert_eq!(Sha256::digest(&*stored), Sha256::digest(&original));
    }
}
