//! The Google Drive implementation of [`CloudStorage`].
//!
//! # Everything here is scoped to `drive.file`
//!
//! Which means every query below only ever sees files this app created. That is
//! not a filter we apply — Google simply does not return the rest — so there is
//! no risk of a wrong query exposing the user's other files, and equally no way
//! to find a file the user dropped into the folder by hand. See the module note
//! in [`super`].
//!
//! # Why the upload is a state machine and not one POST
//!
//! The files are `.ltset` packages that routinely pass a gigabyte, and the
//! common case is a phone on mobile data. A single PUT that dies at 80% and
//! starts over is not a slow feature, it is an unusable one. Drive's resumable
//! protocol lets a broken transfer ask "how much did you get?" and carry on
//! from there, which is the only reason this works outside a desk.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};

use crate::{CloudError, CloudStorage, ProgressFn, Quota, RemoteFile, RemoteFolder};

const FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files";
const ABOUT_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/about";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

/// Bytes per resumable chunk.
///
/// Drive requires a multiple of 256 KiB for every chunk but the last, and every
/// chunk costs a full round trip *plus* server-side commit work before the next
/// may start — that cost is per chunk, not per byte, so small chunks make a
/// large upload dramatically slower than the connection warrants. 16 MiB keeps
/// a 115 MB package to 8 commits instead of 15, and a dropped connection still
/// only redoes seconds of transfer.
const CHUNK_SIZE: u64 = 16 * 1024 * 1024;

/// Folder ids resolved this run, so a folder is looked up at most once.
///
/// # Why a cache is required, not an optimisation
///
/// Drive listings are eventually consistent: a folder that was just created
/// does not show up in a search for a short while. Without this, a second
/// caller in that window searches, finds nothing, and creates a SECOND
/// `LibreTracks` folder — which is exactly what happened when the panel
/// refreshed both folder listings in parallel.
///
/// The mutex is held across the whole resolution on purpose. Serialising
/// concurrent resolvers is the point: the second one must wait and then find
/// the id in the cache rather than race the first to create a duplicate.
static FOLDER_IDS: OnceLock<tokio::sync::Mutex<HashMap<String, String>>> = OnceLock::new();

fn folder_cache() -> &'static tokio::sync::Mutex<HashMap<String, String>> {
    FOLDER_IDS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Drop every cached id.
///
/// Must be called when the account changes: folder ids belong to the Drive they
/// came from, and reusing one against a different account writes into a folder
/// that is not there, or fails outright.
pub async fn forget_cached_folders() {
    folder_cache().lock().await.clear();
}

/// Where the caller gets a valid access token from.
///
/// Kept as a trait so this file knows nothing about keychains, refresh tokens
/// or platform storage: the desktop app supplies an implementation that reads
/// the OS credential store and refreshes when the hour is up.
#[async_trait]
pub trait AccessTokens: Send + Sync {
    /// A token that is valid *now*. Implementations refresh as needed and
    /// return [`CloudError::NotConnected`] when the user must sign in again.
    async fn access_token(&self) -> Result<String, CloudError>;
}

pub struct DriveClient {
    http: reqwest::Client,
    tokens: Box<dyn AccessTokens>,
}

impl DriveClient {
    pub fn new(tokens: Box<dyn AccessTokens>) -> Result<Self, CloudError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        Ok(Self { http, tokens })
    }

    async fn auth(&self) -> Result<String, CloudError> {
        Ok(format!("Bearer {}", self.tokens.access_token().await?))
    }

    /// Resolve `LibreTracks/<folder>`, creating either level if missing.
    ///
    /// Always searches before creating. The second device to connect must find
    /// the folder the first one made rather than starting its own — that is the
    /// whole point of the feature, and it works because a `drive.file` grant
    /// belongs to the OAuth client and user, not to an installation.
    ///
    /// Folders are addressed by id from here on. The user is free to rename or
    /// move `LibreTracks` in their Drive and everything keeps working; only
    /// trashing it forces a fresh one.
    pub async fn folder_id(&self, folder: RemoteFolder) -> Result<String, CloudError> {
        let key = folder.folder_name();
        let mut cache = folder_cache().lock().await;
        if let Some(id) = cache.get(key) {
            return Ok(id.clone());
        }

        let root = match cache.get(RemoteFolder::ROOT_NAME) {
            Some(id) => id.clone(),
            None => {
                let id = self
                    .find_or_create_folder(RemoteFolder::ROOT_NAME, None)
                    .await?;
                cache.insert(RemoteFolder::ROOT_NAME.to_string(), id.clone());
                id
            }
        };

        let id = self.find_or_create_folder(key, Some(&root)).await?;
        cache.insert(key.to_string(), id.clone());
        Ok(id)
    }

    async fn find_or_create_folder(
        &self,
        name: &str,
        parent: Option<&str>,
    ) -> Result<String, CloudError> {
        if let Some(found) = self.find_folder(name, parent).await? {
            return Ok(found);
        }
        self.create_folder(name, parent).await
    }

    async fn find_folder(
        &self,
        name: &str,
        parent: Option<&str>,
    ) -> Result<Option<String>, CloudError> {
        let response = self
            .http
            .get(FILES_ENDPOINT)
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .query(&[
                ("q", folder_search_query(name, parent)),
                ("fields", "files(id,createdTime)".to_string()),
                ("orderBy", "createdTime".to_string()),
                ("pageSize", "10".to_string()),
            ])
            .send()
            .await
            .map_err(net)?;

        let listing: FileListing = parse(response).await?;
        // Oldest first, so two devices that raced and each made a folder still
        // converge on the same one instead of ping-ponging between them.
        Ok(listing.files.into_iter().next().map(|f| f.id))
    }

    async fn create_folder(&self, name: &str, parent: Option<&str>) -> Result<String, CloudError> {
        let mut body = serde_json::json!({ "name": name, "mimeType": FOLDER_MIME });
        if let Some(parent) = parent {
            body["parents"] = serde_json::json!([parent]);
        }

        let response = self
            .http
            .post(FILES_ENDPOINT)
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .query(&[("fields", "id")])
            .json(&body)
            .send()
            .await
            .map_err(net)?;

        let created: FileEntry = parse(response).await?;
        Ok(created.id)
    }

    /// Open a resumable session and return the URI its chunks go to.
    async fn begin_upload(
        &self,
        folder_id: &str,
        remote_name: &str,
        total: u64,
    ) -> Result<String, CloudError> {
        let body = serde_json::json!({ "name": remote_name, "parents": [folder_id] });

        let response = self
            .http
            .post(UPLOAD_ENDPOINT)
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .header("X-Upload-Content-Length", total.to_string())
            .query(&[("uploadType", "resumable")])
            .json(&body)
            .send()
            .await
            .map_err(net)?;

        if !response.status().is_success() {
            return Err(provider_error(response).await);
        }
        response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| {
                CloudError::Network("Drive opened an upload session with no Location".into())
            })
    }
}

#[async_trait]
impl CloudStorage for DriveClient {
    fn provider_name(&self) -> &'static str {
        "Google Drive"
    }

    async fn list(&self, folder: RemoteFolder) -> Result<Vec<RemoteFile>, CloudError> {
        let folder_id = self.folder_id(folder).await?;
        let response = self
            .http
            .get(FILES_ENDPOINT)
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .query(&[
                ("q", children_query(&folder_id)),
                (
                    "fields",
                    "files(id,name,size,modifiedTime)".to_string(),
                ),
                ("orderBy", "modifiedTime desc".to_string()),
                ("pageSize", "200".to_string()),
            ])
            .send()
            .await
            .map_err(net)?;

        let listing: FileListing = parse(response).await?;
        Ok(listing
            .files
            .into_iter()
            .map(|f| RemoteFile {
                id: f.id,
                name: f.name.unwrap_or_default(),
                // Drive reports size as a string, and omits it entirely for
                // folders and Google-native documents. Neither belongs here,
                // but defaulting to 0 keeps one odd entry from failing a list.
                size_bytes: f.size.and_then(|s| s.parse().ok()).unwrap_or(0),
                modified: f.modified_time,
            })
            .collect())
    }

    async fn quota(&self) -> Result<Quota, CloudError> {
        let response = self
            .http
            .get(ABOUT_ENDPOINT)
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .query(&[("fields", "storageQuota")])
            .send()
            .await
            .map_err(net)?;

        let about: AboutResponse = parse(response).await?;
        Ok(Quota {
            used_bytes: about.storage_quota.usage.and_then(|s| s.parse().ok()).unwrap_or(0),
            // Absent means an unlimited account; Drive omits the field rather
            // than sending a sentinel.
            limit_bytes: about.storage_quota.limit.and_then(|s| s.parse().ok()),
        })
    }

    async fn upload(
        &self,
        folder: RemoteFolder,
        local_path: &Path,
        remote_name: &str,
        progress: &ProgressFn,
    ) -> Result<RemoteFile, CloudError> {
        let total = tokio::fs::metadata(local_path).await?.len();

        // Ask before spending an hour uploading. Drive counts Gmail and Photos
        // against the same allowance, so "it did not fit" is a routine answer
        // and the user deserves it up front rather than at 97%.
        let quota = self.quota().await?;
        if !quota.fits(total) {
            return Err(CloudError::QuotaExceeded {
                needed: total,
                free: quota.free_bytes().unwrap_or(0),
            });
        }

        let folder_id = self.folder_id(folder).await?;
        let session_uri = self.begin_upload(&folder_id, remote_name, total).await?;

        let mut file = tokio::fs::File::open(local_path).await?;
        let mut offset: u64 = 0;
        progress(0, total);

        loop {
            let end = (offset + CHUNK_SIZE).min(total);
            let len = (end - offset) as usize;
            let mut buf = vec![0u8; len];
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            tokio::io::AsyncReadExt::read_exact(&mut file, &mut buf).await?;

            let response = self
                .http
                .put(&session_uri)
                .header(
                    reqwest::header::CONTENT_RANGE,
                    content_range(offset, end, total),
                )
                .body(buf)
                .send()
                .await
                .map_err(net)?;

            let status = response.status().as_u16();
            match status {
                // 308: Drive has the chunk and wants the next one. It reports
                // how much it actually holds, which is authoritative — trusting
                // our own counter here is how a resumed upload silently
                // corrupts a file.
                308 => {
                    offset = resume_offset(
                        response
                            .headers()
                            .get(reqwest::header::RANGE)
                            .and_then(|v| v.to_str().ok()),
                    )
                    .unwrap_or(end);
                    progress(offset, total);
                }
                200 | 201 => {
                    progress(total, total);
                    let done: FileEntry = parse(response).await?;
                    return Ok(RemoteFile {
                        id: done.id,
                        name: remote_name.to_string(),
                        size_bytes: total,
                        modified: done.modified_time,
                    });
                }
                _ => return Err(provider_error(response).await),
            }

            if offset >= total {
                // Every byte is up but Drive never answered 200. Rather than
                // loop forever, let the caller retry the whole upload.
                return Err(CloudError::Network(
                    "the upload finished without Drive confirming the file".into(),
                ));
            }
        }
    }

    async fn download(
        &self,
        file_id: &str,
        dest_path: &Path,
        progress: &ProgressFn,
    ) -> Result<(), CloudError> {
        let response = self
            .http
            .get(format!("{FILES_ENDPOINT}/{file_id}"))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .query(&[("alt", "media")])
            .send()
            .await
            .map_err(net)?;

        if !response.status().is_success() {
            return Err(provider_error(response).await);
        }

        let total = response.content_length().unwrap_or(0);
        // Written to a sibling temp file and renamed at the end, so an
        // interrupted download never leaves something that looks like a
        // complete package for the importer to choke on.
        let staging = dest_path.with_extension("part");
        // Buffered, and generously. Every write on a `tokio::fs::File` is
        // dispatched to the blocking pool, while `bytes_stream` hands back
        // chunks of a few kilobytes: writing them straight through meant tens
        // of thousands of pool round trips for one download, which is most of
        // why a large fetch crawled regardless of the connection.
        let mut out = BufWriter::with_capacity(
            1024 * 1024,
            tokio::fs::File::create(&staging).await?,
        );
        let mut done: u64 = 0;
        let mut last_reported_percent = u64::MAX;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(net)?;
            out.write_all(&chunk).await?;
            done += chunk.len() as u64;

            // Reported only when the whole-percent figure moves. The stream
            // yields chunks of a few kilobytes, so a gigabyte download would
            // otherwise push tens of thousands of events at the UI thread to
            // redraw a number that did not change.
            let denominator = total.max(done);
            let percent = if denominator == 0 {
                0
            } else {
                done * 100 / denominator
            };
            if percent != last_reported_percent {
                last_reported_percent = percent;
                progress(done, denominator);
            }
        }
        // shutdown() flushes the buffer AND the file underneath. A bare
        // flush() would leave the last partial buffer unwritten and rename a
        // truncated package into place.
        tokio::io::AsyncWriteExt::shutdown(&mut out).await?;
        drop(out);
        tokio::fs::rename(&staging, dest_path).await?;
        Ok(())
    }

    async fn delete(&self, file_id: &str) -> Result<(), CloudError> {
        let response = self
            .http
            .delete(format!("{FILES_ENDPOINT}/{file_id}"))
            .header(reqwest::header::AUTHORIZATION, self.auth().await?)
            .send()
            .await
            .map_err(net)?;

        if response.status().is_success() {
            Ok(())
        } else {
            Err(provider_error(response).await)
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers. Kept free of I/O so the fiddly parts are unit-testable: a
// malformed query or an off-by-one in a Content-Range is invisible until it
// corrupts a gigabyte upload.
// ---------------------------------------------------------------------------

/// Escape a value for Drive's query language, which delimits strings with
/// single quotes and escapes them with a backslash.
///
/// The folder names this crate uses contain nothing exotic, but a query built
/// by concatenation is a bug waiting for the first user-supplied name.
pub(crate) fn escape_query_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Search for a folder by name, optionally within a parent.
pub(crate) fn folder_search_query(name: &str, parent: Option<&str>) -> String {
    let mut q = format!(
        "name = '{}' and mimeType = '{}' and trashed = false",
        escape_query_value(name),
        FOLDER_MIME
    );
    if let Some(parent) = parent {
        q.push_str(&format!(" and '{}' in parents", escape_query_value(parent)));
    }
    q
}

/// Everything inside a folder that has not been trashed.
pub(crate) fn children_query(folder_id: &str) -> String {
    format!(
        "'{}' in parents and trashed = false",
        escape_query_value(folder_id)
    )
}

/// `Content-Range` for a chunk covering `[start, end)` of `total` bytes.
///
/// The header is inclusive on both ends, so the last byte is `end - 1`. Getting
/// this wrong shifts every subsequent chunk and produces a file that uploads
/// "successfully" and is corrupt.
pub(crate) fn content_range(start: u64, end: u64, total: u64) -> String {
    format!("bytes {}-{}/{}", start, end - 1, total)
}

/// Read Drive's `Range: bytes=0-N` acknowledgement into the next write offset.
///
/// `N` is the last byte *stored*, so the next chunk starts at `N + 1`. A
/// missing or unparsable header yields `None` and the caller falls back to its
/// own position.
pub(crate) fn resume_offset(range_header: Option<&str>) -> Option<u64> {
    let raw = range_header?;
    let last = raw.rsplit('-').next()?.trim();
    last.parse::<u64>().ok().map(|n| n + 1)
}

fn net(e: reqwest::Error) -> CloudError {
    CloudError::Network(e.to_string())
}

async fn provider_error(response: reqwest::Response) -> CloudError {
    let status = response.status().as_u16();
    // 401 survives token refresh only when the grant itself is gone: the user
    // revoked access, or the refresh token expired. That is a "sign in again",
    // never a hard error.
    if status == 401 {
        return CloudError::NotConnected;
    }
    let body = response.text().await.unwrap_or_default();
    CloudError::Provider {
        provider: "Google Drive",
        status,
        body,
    }
}

async fn parse<T: for<'de> Deserialize<'de>>(response: reqwest::Response) -> Result<T, CloudError> {
    if !response.status().is_success() {
        return Err(provider_error(response).await);
    }
    response.json::<T>().await.map_err(net)
}

#[derive(Debug, Deserialize)]
struct FileListing {
    #[serde(default)]
    files: Vec<FileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    modified_time: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AboutResponse {
    storage_quota: StorageQuota,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageQuota {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    usage: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_size_is_a_multiple_of_256_kib() {
        // Drive rejects any non-final chunk that is not, and the rejection is a
        // generic 400 that says nothing about why.
        assert_eq!(CHUNK_SIZE % (256 * 1024), 0);
    }

    #[test]
    fn content_range_is_inclusive_at_both_ends() {
        assert_eq!(content_range(0, 8_388_608, 20_000_000), "bytes 0-8388607/20000000");
        assert_eq!(
            content_range(8_388_608, 16_777_216, 20_000_000),
            "bytes 8388608-16777215/20000000"
        );
    }

    #[test]
    fn the_last_chunk_reaches_the_final_byte() {
        let total = 20_000_000;
        assert_eq!(content_range(16_777_216, total, total), "bytes 16777216-19999999/20000000");
    }

    #[test]
    fn a_single_byte_file_is_a_valid_range() {
        assert_eq!(content_range(0, 1, 1), "bytes 0-0/1");
    }

    #[test]
    fn resume_offset_is_the_byte_after_the_last_one_stored() {
        assert_eq!(resume_offset(Some("bytes=0-8388607")), Some(8_388_608));
        assert_eq!(resume_offset(Some("0-42")), Some(43));
    }

    #[test]
    fn a_missing_or_junk_range_header_yields_nothing() {
        assert_eq!(resume_offset(None), None);
        assert_eq!(resume_offset(Some("bytes=*/20000000")), None);
        assert_eq!(resume_offset(Some("")), None);
    }

    #[test]
    fn folder_search_scopes_to_folders_and_skips_the_trash() {
        let q = folder_search_query("LibreTracks", None);
        assert!(q.contains("name = 'LibreTracks'"));
        assert!(q.contains("mimeType = 'application/vnd.google-apps.folder'"));
        assert!(q.contains("trashed = false"));
        assert!(!q.contains("in parents"));
    }

    #[test]
    fn a_child_folder_search_is_scoped_to_its_parent() {
        let q = folder_search_query("Sessions", Some("root-id"));
        assert!(q.contains("name = 'Sessions'"));
        assert!(q.contains("'root-id' in parents"));
    }

    /// A quote in a name would otherwise close the string early and turn the
    /// rest into syntax, which Drive answers with an opaque 400.
    #[test]
    fn quotes_and_backslashes_are_escaped() {
        assert_eq!(escape_query_value("Rock'n'Roll"), "Rock\\'n\\'Roll");
        assert_eq!(escape_query_value("a\\b"), "a\\\\b");
        let q = folder_search_query("Rock'n'Roll", None);
        assert!(q.contains("name = 'Rock\\'n\\'Roll'"));
    }

    #[test]
    fn children_query_lists_only_live_files() {
        let q = children_query("folder-123");
        assert_eq!(q, "'folder-123' in parents and trashed = false");
    }

    /// Drive sends numbers as strings and omits `size` for folders. Both shapes
    /// have to survive, or one stray entry fails a whole listing.
    #[test]
    fn drive_string_numbers_and_absent_fields_parse() {
        let listing: FileListing = serde_json::from_str(
            r#"{"files":[
                {"id":"a","name":"Set.ltset","size":"1048576","modifiedTime":"2026-09-02T10:00:00Z"},
                {"id":"b","name":"Carpeta"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(listing.files.len(), 2);
        assert_eq!(listing.files[0].size.as_deref(), Some("1048576"));
        assert!(listing.files[1].size.is_none());
        assert!(listing.files[1].modified_time.is_none());
    }

    #[test]
    fn an_unlimited_account_has_no_limit_field() {
        let about: AboutResponse =
            serde_json::from_str(r#"{"storageQuota":{"usage":"12345"}}"#).unwrap();
        assert_eq!(about.storage_quota.usage.as_deref(), Some("12345"));
        assert!(about.storage_quota.limit.is_none());
    }
}
