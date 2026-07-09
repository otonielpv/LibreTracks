//! Ambient-pad catalog, download, and configuration commands.
//!
//! Pads are large (~500 MB per pad: one ~15-minute audio file per musical
//! key), so they are never bundled with the app — they are downloaded on demand
//! from a host-agnostic manifest. `PADS_MANIFEST_URL` points at a small JSON
//! catalog; each entry carries its own `download_url`, so the host (a separate
//! GitHub repo, Cloudflare R2, S3, …) can change without recompiling the app —
//! only the manifest is edited.
//!
//! Downloaded pads live under `app_local_data_dir()/pads/<pad_id>/<key>.<ext>`,
//! mirroring how the voice-guide bank resolves its assets. The engine decodes
//! the currently selected key on demand (see `load_pad_clip`).

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::DesktopError;
use crate::settings::{save_app_settings, AppSettings, AppSettingsStore};
use crate::state::DesktopState;

/// Where the pad catalog lives. Host-agnostic: point this at a small JSON file
/// on any static host. Each pad entry inside carries its own `downloadUrl`, so
/// the actual .zip files can live anywhere (GitHub release asset, R2 bucket,
/// …) — moving them only means editing the manifest, never the app.
const PADS_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/otonielpv/libretracks-pads/main/manifest.json";

const PAD_DOWNLOAD_PROGRESS_EVENT: &str = "pad:download-progress";

/// The 12 filesystem-safe key stems, indexed 0..11 (C..B). Must match the C++
/// `key_stem` in pad_renderer.cpp — the sharp spelling avoids '#' in filenames.
const KEY_STEMS: [&str; 12] = [
    "C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B",
];

const PAD_KEY_EXTENSIONS: [&str; 6] = [".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"];

// ── Manifest / catalog shapes ────────────────────────────────────────────────

/// One pad entry as it appears in the remote manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPad {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    size_bytes: u64,
    download_url: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PadManifest {
    #[serde(default)]
    pads: Vec<ManifestPad>,
}

/// A catalog entry returned to the frontend: manifest info + install state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
    pub download_url: String,
    /// True when every one of the 12 keys is present on disk.
    pub installed: bool,
    /// Number of the 12 keys currently present (for a partial-install hint).
    pub keys_present: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadsCatalog {
    /// Pads offered by the manifest (may or may not be installed).
    pub pads: Vec<PadCatalogEntry>,
    /// Installed pad ids that are NOT in the manifest anymore (e.g. removed
    /// upstream). Still usable/removable locally.
    pub orphan_installed: Vec<String>,
    /// True when the manifest could not be fetched (offline). `pads` then holds
    /// only what is installed locally so the user can still use/remove them.
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PadDownloadProgressEvent {
    pad_id: String,
    percent: u8,
    message: String,
    /// Terminal event flag; carries `error` (Some) on failure.
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    emitted_at_unix_ms: u64,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

/// Base directory for installed pads: `app_local_data_dir()/pads`. Falls back
/// to `app_data_dir()`. Created on demand by the caller.
pub fn pads_install_dir(app: &AppHandle) -> Result<PathBuf, DesktopError> {
    let base = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| DesktopError::AudioCommand(format!("no app data dir: {error}")))?;
    Ok(base.join("pads"))
}

/// Count how many of the 12 keys are present for a pad on disk.
fn keys_present_for(pad_dir: &Path) -> u8 {
    let mut count = 0u8;
    for stem in KEY_STEMS {
        let present = PAD_KEY_EXTENSIONS
            .iter()
            .any(|ext| pad_dir.join(format!("{stem}{ext}")).is_file());
        if present {
            count += 1;
        }
    }
    count
}

/// List the pad ids currently installed on disk (a subdirectory of the pads
/// base dir counts as installed if it holds at least one key file).
fn installed_pad_states(app: &AppHandle) -> Vec<(String, u8)> {
    let Ok(base) = pads_install_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let present = keys_present_for(&path);
        if present > 0 {
            out.push((id, present));
        }
    }
    out
}

fn emit_pad_progress(
    app: &AppHandle,
    pad_id: &str,
    percent: u8,
    message: impl Into<String>,
    done: bool,
    error: Option<String>,
) {
    let emitted_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let payload = PadDownloadProgressEvent {
        pad_id: pad_id.to_string(),
        percent: percent.min(100),
        message: message.into(),
        done,
        error,
        emitted_at_unix_ms,
    };
    if let Err(error) = app.emit(PAD_DOWNLOAD_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-pads] failed to emit download progress: {error}");
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Fetch the remote pad catalog and cross-reference it with what's installed
/// locally. On a network failure the manifest is skipped and only locally
/// installed pads are returned (so offline users can still use/remove them).
#[tauri::command]
pub async fn get_pads_catalog(app: AppHandle) -> Result<PadsCatalog, String> {
    let installed = installed_pad_states(&app);
    let installed_ids: std::collections::HashMap<String, u8> = installed.iter().cloned().collect();

    let user_agent = format!("LibreTracks/{}", env!("CARGO_PKG_VERSION"));
    let manifest: Option<PadManifest> = match reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(client) => match client.get(PADS_MANIFEST_URL).send().await {
            Ok(resp) if resp.status().is_success() => resp.json::<PadManifest>().await.ok(),
            _ => None,
        },
        Err(_) => None,
    };

    let offline = manifest.is_none();
    let manifest = manifest.unwrap_or(PadManifest { pads: Vec::new() });

    let mut pads = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in manifest.pads {
        let present = installed_ids.get(&m.id).copied().unwrap_or(0);
        seen.insert(m.id.clone());
        pads.push(PadCatalogEntry {
            id: m.id,
            name: m.name,
            description: m.description,
            size_bytes: m.size_bytes,
            download_url: m.download_url,
            installed: present as usize == KEY_STEMS.len(),
            keys_present: present,
        });
    }

    // Installed pads that aren't in the manifest — still list them so the user
    // can use/remove them (no download_url; they're already on disk).
    let mut orphan_installed = Vec::new();
    for (id, present) in installed {
        if seen.contains(&id) {
            continue;
        }
        orphan_installed.push(id.clone());
        pads.push(PadCatalogEntry {
            id: id.clone(),
            name: id,
            description: String::new(),
            size_bytes: 0,
            download_url: String::new(),
            installed: present as usize == KEY_STEMS.len(),
            keys_present: present,
        });
    }

    Ok(PadsCatalog {
        pads,
        orphan_installed,
        offline,
    })
}

/// Download and install a pad by id. Streams the .zip with progress, unzips to
/// a temp dir OFF any session lock, then atomically moves it into place. Emits
/// `pad:download-progress` throughout (the frontend shows the same "preparing
/// audio"-style indicator). The download URL comes from the live manifest so a
/// stale frontend can't pin an outdated URL.
#[tauri::command]
pub async fn download_pad(app: AppHandle, pad_id: String) -> Result<(), String> {
    let result = download_pad_inner(&app, &pad_id).await;
    match &result {
        Ok(()) => emit_pad_progress(&app, &pad_id, 100, "Listo", true, None),
        Err(error) => emit_pad_progress(&app, &pad_id, 100, "Error", true, Some(error.clone())),
    }
    result
}

async fn download_pad_inner(app: &AppHandle, pad_id: &str) -> Result<(), String> {
    // Resolve the download URL from the live manifest (single source of truth).
    let user_agent = format!("LibreTracks/{}", env!("CARGO_PKG_VERSION"));
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;

    emit_pad_progress(app, pad_id, 0, "Consultando catálogo…", false, None);
    let manifest: PadManifest = client
        .get(PADS_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("manifest request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("manifest parse failed: {e}"))?;
    let entry = manifest
        .pads
        .into_iter()
        .find(|p| p.id == pad_id)
        .ok_or_else(|| format!("pad '{pad_id}' not found in manifest"))?;

    // Stream the .zip to a temp file, reporting download progress (0..70%).
    let base = pads_install_dir(app).map_err(|e| e.to_string())?;
    fs::create_dir_all(&base).map_err(|e| format!("create pads dir failed: {e}"))?;
    let tmp_dir = base.join(format!(".{pad_id}.tmp"));
    // Clean any leftover from a previous aborted run.
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("create temp dir failed: {e}"))?;
    let zip_path = tmp_dir.join("pad.zip");

    emit_pad_progress(app, pad_id, 0, "Descargando…", false, None);
    let resp = client
        .get(&entry.download_url)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download returned HTTP {}", resp.status()));
    }
    let total = resp
        .content_length()
        .filter(|&l| l > 0)
        .unwrap_or(entry.size_bytes.max(1));

    {
        let mut file =
            fs::File::create(&zip_path).map_err(|e| format!("create zip file failed: {e}"))?;
        use std::io::Write;
        let mut downloaded: u64 = 0;
        let mut last_pct: u8 = 255;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download stream error: {e}"))?;
            file.write_all(&chunk)
                .map_err(|e| format!("write zip failed: {e}"))?;
            downloaded += chunk.len() as u64;
            // Map download to the 0..70% band.
            let pct = ((downloaded.min(total) as f64 / total as f64) * 70.0) as u8;
            if pct != last_pct {
                last_pct = pct;
                emit_pad_progress(
                    app,
                    pad_id,
                    pct,
                    format!(
                        "Descargando… {} / {} MB",
                        downloaded / 1_000_000,
                        total / 1_000_000
                    ),
                    false,
                    None,
                );
            }
        }
        file.flush().map_err(|e| format!("flush zip failed: {e}"))?;
    }

    // Unzip into the temp dir (70..90%). Runs on a blocking task so the async
    // runtime isn't stalled; never holds any session lock.
    emit_pad_progress(app, pad_id, 70, "Descomprimiendo…", false, None);
    let extract_root = tmp_dir.join("extracted");
    fs::create_dir_all(&extract_root).map_err(|e| format!("create extract dir failed: {e}"))?;
    {
        let zip_path = zip_path.clone();
        let extract_root = extract_root.clone();
        let app = app.clone();
        let pad_id_owned = pad_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file = fs::File::open(&zip_path).map_err(|e| format!("open zip failed: {e}"))?;
            let mut archive =
                zip::ZipArchive::new(file).map_err(|e| format!("read zip failed: {e}"))?;
            let count = archive.len();
            for i in 0..count {
                let mut zf = archive
                    .by_index(i)
                    .map_err(|e| format!("zip entry {i} failed: {e}"))?;
                // Guard against zip-slip: only allow the safe enclosed name.
                let Some(enclosed) = zf.enclosed_name() else {
                    continue;
                };
                let out_path = extract_root.join(enclosed);
                if zf.is_dir() {
                    fs::create_dir_all(&out_path)
                        .map_err(|e| format!("mkdir failed: {e}"))?;
                } else {
                    if let Some(parent) = out_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("mkdir parent failed: {e}"))?;
                    }
                    let mut out = fs::File::create(&out_path)
                        .map_err(|e| format!("create extracted file failed: {e}"))?;
                    std::io::copy(&mut zf, &mut out)
                        .map_err(|e| format!("extract copy failed: {e}"))?;
                }
                if count > 0 {
                    let pct = 70 + ((i + 1) as f64 / count as f64 * 20.0) as u8;
                    emit_pad_progress(&app, &pad_id_owned, pct, "Descomprimiendo…", false, None);
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("unzip task panicked: {e}"))??;
    }

    // Locate the key files. The zip may wrap them in a top-level folder
    // (<pad_id>/C.mp3) or place them at the root (C.mp3); handle both.
    emit_pad_progress(app, pad_id, 90, "Instalando…", false, None);
    let source_dir = resolve_pad_key_source(&extract_root, pad_id)
        .ok_or_else(|| "no pad key files found in archive".to_string())?;

    // Move into the final location atomically-ish: write to pads/<id> via a
    // fresh dir, then swap. Remove any previous install first.
    let final_dir = base.join(pad_id);
    let _ = fs::remove_dir_all(&final_dir);
    fs::create_dir_all(&final_dir).map_err(|e| format!("create pad dir failed: {e}"))?;
    // Copy only recognised key files (skip stray archive extras).
    let mut copied = 0u32;
    for stem in KEY_STEMS {
        for ext in PAD_KEY_EXTENSIONS {
            let candidate = source_dir.join(format!("{stem}{ext}"));
            if candidate.is_file() {
                let dest = final_dir.join(format!("{stem}{ext}"));
                fs::copy(&candidate, &dest)
                    .map_err(|e| format!("copy key {stem}{ext} failed: {e}"))?;
                copied += 1;
                break;
            }
        }
    }
    // Best-effort cleanup of the temp working dir.
    let _ = fs::remove_dir_all(&tmp_dir);

    if copied == 0 {
        let _ = fs::remove_dir_all(&final_dir);
        return Err("archive contained no recognised pad keys".to_string());
    }
    Ok(())
}

/// Find the directory inside `extract_root` that actually holds the key files.
/// Accepts either the root itself or a single wrapping folder (commonly named
/// after the pad).
fn resolve_pad_key_source(extract_root: &Path, pad_id: &str) -> Option<PathBuf> {
    let has_keys = |dir: &Path| KEY_STEMS.iter().any(|stem| {
        PAD_KEY_EXTENSIONS
            .iter()
            .any(|ext| dir.join(format!("{stem}{ext}")).is_file())
    });
    if has_keys(extract_root) {
        return Some(extract_root.to_path_buf());
    }
    // Preferred: a folder named exactly like the pad id.
    let named = extract_root.join(pad_id);
    if named.is_dir() && has_keys(&named) {
        return Some(named);
    }
    // Otherwise probe first-level subdirectories.
    if let Ok(entries) = fs::read_dir(extract_root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && has_keys(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Delete an installed pad from disk (to free space). If it is the currently
/// selected pad, the selection is cleared and the pad disabled.
#[tauri::command]
pub fn delete_pad(
    app: AppHandle,
    pad_id: String,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let base = pads_install_dir(&app).map_err(|e| e.to_string())?;
    let dir = base.join(&pad_id);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("delete pad failed: {e}"))?;
    }

    let mut settings = settings_store.current().map_err(|e| e.to_string())?;
    if settings.pad_id == pad_id {
        settings.pad_id = String::new();
        settings.pad_enabled = false;
        // Clear the live pad in the engine.
        let _ = state.audio.set_pad_config_realtime(&settings);
        settings_store
            .set(settings.clone())
            .map_err(|e| e.to_string())?;
        save_app_settings(&app, &settings).map_err(|e| e.to_string())?;
    }
    Ok(settings)
}

/// Apply pad settings live (enabled/volume/route/key/pad_id): decode the
/// selected key for the current pad, hand it to the renderer, apply config, and
/// persist. Mirrors `set_voice_guide_config_realtime`.
#[tauri::command]
pub fn set_pad_config_realtime(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    // Load the selected key first so the renderer has audio before it's enabled.
    if !settings.pad_id.is_empty() {
        if let Ok(base) = pads_install_dir(&app) {
            if let Some(dir) = base.to_str() {
                let _ = state
                    .audio
                    .load_pad_clip(dir, &settings.pad_id, settings.pad_key);
            }
        }
    }
    state
        .audio
        .set_pad_config_realtime(&settings)
        .map_err(|e| e.to_string())?;
    state
        .audio
        .replace_settings(settings.clone())
        .map_err(|e| e.to_string())?;
    settings_store
        .set(settings.clone())
        .map_err(|e| e.to_string())?;
    save_app_settings(&app, &settings).map_err(|e| e.to_string())?;
    Ok(settings)
}
