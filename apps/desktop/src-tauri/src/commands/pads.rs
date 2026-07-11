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
            // Map download to the 0..55% band (decode is the heavy tail).
            let pct = ((downloaded.min(total) as f64 / total as f64) * 55.0) as u8;
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

    // Unzip into the temp dir (55..65%). Runs on a blocking task so the async
    // runtime isn't stalled; never holds any session lock.
    emit_pad_progress(app, pad_id, 55, "Descomprimiendo…", false, None);
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
                    let pct = 55 + ((i + 1) as f64 / count as f64 * 10.0) as u8;
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
    emit_pad_progress(app, pad_id, 65, "Preparando pads…", false, None);
    let source_dir = resolve_pad_key_source(&extract_root, pad_id)
        .ok_or_else(|| "no pad key files found in archive".to_string())?;

    // Install into pads/<id>. Each key is PRE-DECODED to a 16-bit WAV here (the
    // "Preparando pads…" phase, 65..99%), so switching key at play time reads
    // ready PCM instead of decoding a ~15-min MP3 live. A source that is already
    // a .wav is copied as-is. The decode is CPU-heavy (12 files), so it runs on
    // a blocking task off the async runtime; it never holds the engine lock.
    let final_dir = base.join(pad_id);
    let _ = fs::remove_dir_all(&final_dir);
    fs::create_dir_all(&final_dir).map_err(|e| format!("create pad dir failed: {e}"))?;

    let copied = {
        let source_dir = source_dir.clone();
        let final_dir = final_dir.clone();
        let app = app.clone();
        let pad_id_owned = pad_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<u32, String> {
            let mut done = 0u32;
            let total = KEY_STEMS.len() as u32;
            for (i, stem) in KEY_STEMS.iter().enumerate() {
                // Find the source file for this key (any accepted extension).
                let mut src_path: Option<PathBuf> = None;
                for ext in PAD_KEY_EXTENSIONS {
                    let candidate = source_dir.join(format!("{stem}{ext}"));
                    if candidate.is_file() {
                        src_path = Some(candidate);
                        break;
                    }
                }
                let Some(src) = src_path else { continue };
                let dst = final_dir.join(format!("{stem}.wav"));
                if src.extension().and_then(|e| e.to_str()) == Some("wav") {
                    fs::copy(&src, &dst).map_err(|e| format!("copy {stem}.wav: {e}"))?;
                } else {
                    decode_to_wav16(&src, &dst)?;
                }
                done += 1;
                let pct = 65 + ((i as f64 + 1.0) / total as f64 * 34.0) as u8;
                emit_pad_progress(&app, &pad_id_owned, pct, "Preparando pads…", false, None);
            }
            Ok(done)
        })
        .await
        .map_err(|e| format!("prepare task panicked: {e}"))??
    };

    // Best-effort cleanup of the temp working dir (removes the source MP3s too).
    let _ = fs::remove_dir_all(&tmp_dir);

    if copied == 0 {
        let _ = fs::remove_dir_all(&final_dir);
        return Err("archive contained no recognised pad keys".to_string());
    }
    Ok(())
}

/// Decode a compressed audio file (MP3/…) to a 16-bit PCM WAV at its native
/// sample rate, mirroring the engine's normal decoding-cache format (Ableton
/// style: WAV int16, half the size of float32). Pre-decoding at download time
/// means switching pad key later reads ready PCM instead of decoding a ~15-min
/// MP3 live. Uses `symphonia` (the Rust side's decoder — FFmpeg lives only in
/// the native engine), consistent with how the app decodes waveforms/imports.
fn decode_to_wav16(src: &Path, dst: &Path) -> Result<(), String> {
    use symphonia::core::audio::{AudioBufferRef, Signal};
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = fs::File::open(src).map_err(|e| format!("open {src:?}: {e}"))?;
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|v| v.to_str()) {
        hint.with_extension(ext);
    }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe {src:?}: {e}"))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| format!("no audio track in {src:?}"))?;
    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| format!("missing sample rate in {src:?}"))?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2)
        .max(1)
        .min(2);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params.clone(), &DecoderOptions::default())
        .map_err(|e| format!("make decoder {src:?}: {e}"))?;

    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(dst, spec).map_err(|e| format!("create wav {dst:?}: {e}"))?;

    let to_i16 = |s: f32| -> i16 {
        (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
    };

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean EOF: symphonia surfaces it as an IoError(UnexpectedEof).
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(format!("decode {src:?}: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue, // skip bad frame
            Err(e) => return Err(format!("decode packet {src:?}: {e}")),
        };
        // Interleave to the WAV writer. Downmix/upmix to `channels` (1 or 2).
        macro_rules! write_buf {
            ($buf:expr) => {{
                let b = $buf;
                let frames = b.frames();
                let src_ch = b.spec().channels.count();
                for f in 0..frames {
                    for c in 0..channels as usize {
                        let sc = c.min(src_ch - 1);
                        let v = b.chan(sc)[f];
                        writer
                            .write_sample(to_i16(v as f32))
                            .map_err(|e| format!("write sample: {e}"))?;
                    }
                }
            }};
        }
        match decoded {
            AudioBufferRef::F32(buf) => write_buf!(buf.as_ref()),
            AudioBufferRef::S16(buf) => {
                let b = buf.as_ref();
                let frames = b.frames();
                let src_ch = b.spec().channels.count();
                for f in 0..frames {
                    for c in 0..channels as usize {
                        let sc = c.min(src_ch - 1);
                        writer
                            .write_sample(b.chan(sc)[f])
                            .map_err(|e| format!("write sample: {e}"))?;
                    }
                }
            }
            AudioBufferRef::S32(buf) => {
                let b = buf.as_ref();
                let frames = b.frames();
                let src_ch = b.spec().channels.count();
                for f in 0..frames {
                    for c in 0..channels as usize {
                        let sc = c.min(src_ch - 1);
                        let v = b.chan(sc)[f] as f32 / i32::MAX as f32;
                        writer
                            .write_sample(to_i16(v))
                            .map_err(|e| format!("write sample: {e}"))?;
                    }
                }
            }
            other => {
                // Fallback: copy into an f32 buffer via the generic path.
                let spec = *other.spec();
                let capacity = other.capacity() as u64;
                let src_ch = spec.channels.count();
                let mut sample_buf =
                    symphonia::core::audio::SampleBuffer::<f32>::new(capacity, spec);
                sample_buf.copy_interleaved_ref(other);
                let samples = sample_buf.samples();
                let frames = samples.len() / src_ch.max(1);
                for f in 0..frames {
                    for c in 0..channels as usize {
                        let sc = c.min(src_ch - 1);
                        writer
                            .write_sample(to_i16(samples[f * src_ch + sc]))
                            .map_err(|e| format!("write sample: {e}"))?;
                    }
                }
            }
        }
    }
    writer.finalize().map_err(|e| format!("finalize wav {dst:?}: {e}"))?;
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

/// Apply pad settings live (enabled/volume/route/key/pad_id) WITHOUT decoding.
/// This is the hot path for the volume fader, the on/off toggle and the routing
/// selector — it only pushes cheap atomics to the renderer and persists. It
/// must never touch the disk decoder: decoding a ~15-minute MP3 here is what
/// froze playback on every fader tick / toggle. Selecting a new key or pad is a
/// separate call (`load_pad_key`) that decodes off the command path.
#[tauri::command]
pub fn set_pad_config_realtime(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
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

/// Decode the selected key of the current pad and swap it into the renderer.
/// Runs the slow MP3 decode on a blocking task so neither the audio thread nor
/// the UI stalls; the renderer crossfades the swap so there is no click. Call
/// this ONLY when the pad id or key actually changes — not for volume/enable/
/// routing. Also (re)applies config so a freshly-selected key is audible.
#[tauri::command]
pub async fn load_pad_key(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    if !settings.pad_id.is_empty() {
        if let Ok(base) = pads_install_dir(&app) {
            if let Some(dir) = base.to_str() {
                let dir = dir.to_string();
                let pad_id = settings.pad_id.clone();
                let key = settings.pad_key;
                let audio = state.audio.clone();
                // The engine command that carries this is itself dispatched to
                // the engine's command thread (which owns the decode); we still
                // hop onto a blocking task so awaiting it never parks the async
                // runtime under the fader.
                let _ = tokio::task::spawn_blocking(move || {
                    audio.load_pad_clip(&dir, &pad_id, key)
                })
                .await;
            }
        }
    }
    // Re-push config so the newly loaded key plays at the right level/route.
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

#[cfg(test)]
mod tests {
    use super::*;

    // Converts a real MP3 to WAV16 and validates the result. Skipped unless a
    // sample MP3 is present (env LT_PAD_TEST_MP3), so CI without the audio asset
    // still passes.
    #[test]
    fn decode_to_wav16_produces_valid_wav() {
        let src = std::env::var("LT_PAD_TEST_MP3").unwrap_or_default();
        let src = PathBuf::from(src);
        if !src.is_file() {
            eprintln!("skipping decode_to_wav16 test: set LT_PAD_TEST_MP3 to a sample MP3");
            return;
        }

        let dir = std::env::temp_dir().join("lt_pad_wav_test");
        let _ = fs::create_dir_all(&dir);
        let dst = dir.join("out.wav");
        let _ = fs::remove_file(&dst);

        decode_to_wav16(&src, &dst).expect("conversion should succeed");

        let reader = hound::WavReader::open(&dst).expect("output should be a valid WAV");
        let spec = reader.spec();
        assert_eq!(spec.bits_per_sample, 16);
        assert!(spec.channels >= 1 && spec.channels <= 2);
        assert!(spec.sample_rate >= 8000);
        assert!(reader.len() > 0, "WAV should contain samples");

        let _ = fs::remove_file(&dst);
    }
}
