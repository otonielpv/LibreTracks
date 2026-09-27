//! Video clip editing commands. Every command is `(async)` for the reason
//! `commands/timeline.rs` documents: they take the session lock, and inline
//! they would run on the main thread.

use tauri::State;

use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::{DesktopState, VideoClipProps};

fn with_session<T>(
    state: &State<'_, DesktopState>,
    edit: impl FnOnce(
        &mut crate::state::DesktopSession,
        &crate::audio::engine::AudioController,
    ) -> Result<T, DesktopError>,
) -> Result<T, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    edit(&mut session, &state.audio).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn create_video_clip(
    track_id: String,
    file_path: String,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.create_video_clip(
            &track_id,
            &file_path,
            timeline_start_seconds,
            source_start_seconds,
            duration_seconds,
            audio,
        )
    })
}

#[tauri::command(async)]
pub fn update_video_clip(
    clip_id: String,
    props: VideoClipProps,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.update_video_clip(&clip_id, props, audio)
    })
}

#[tauri::command(async)]
pub fn move_video_clip(
    clip_id: String,
    timeline_start_seconds: f64,
    target_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.move_video_clip(
            &clip_id,
            timeline_start_seconds,
            target_track_id.as_deref(),
            audio,
        )
    })
}

#[tauri::command(async)]
pub fn trim_video_clip(
    clip_id: String,
    start_seconds: f64,
    end_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.trim_video_clip(&clip_id, start_seconds, end_seconds, audio)
    })
}

#[tauri::command(async)]
pub fn split_video_clips(
    clip_ids: Vec<String>,
    split_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.split_video_clips(&clip_ids, split_seconds, audio)
    })
}

#[tauri::command(async)]
pub fn duplicate_video_clips(
    clip_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.duplicate_video_clips(&clip_ids, audio)
    })
}

#[tauri::command(async)]
pub fn delete_video_clips(
    clip_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.delete_video_clips(&clip_ids, audio)
    })
}

// ---------------------------------------------------------------------------
// Media: availability, import, library and thumbnails (paso 04).
//
// The analysis and the thumbnails open files with libmpv, which can take
// seconds. None of it runs under the session lock: the lock is taken only to
// read the song folder and, at the end, to write `library.json` — the same
// rule that fixed the waveform and the .ltpkg import freezes.
// ---------------------------------------------------------------------------

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

use crate::models::view::SkippedImport;
use crate::state::VideoAssetSummary;
use crate::video::thumbnail_queue::ThumbnailJob;
use crate::video::VideoLibraryStatus;

#[tauri::command(async)]
pub fn video_media_status(state: State<'_, DesktopState>) -> VideoLibraryStatus {
    state.video.status()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoImportResult {
    pub assets: Vec<VideoAssetSummary>,
    pub skipped: Vec<SkippedImport>,
}

fn file_name_for(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Analyse and register video files. Unreadable files and unsupported codecs
/// end up in `skipped` with the reason; the rest still import.
#[tauri::command(async)]
pub fn import_video_files(
    file_paths: Vec<String>,
    folder_path: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<VideoImportResult, String> {
    let libmpv = state.video.libmpv()?;
    let mut analysed = Vec::new();
    let mut skipped = Vec::new();
    for file_path in file_paths {
        let skip = |reason: String| SkippedImport {
            file_name: file_name_for(&file_path),
            source_path: file_path.clone(),
            reason,
        };
        if !libretracks_core::is_video_file_path(&file_path) {
            skipped.push(skip("no es un fichero de vídeo".into()));
            continue;
        }
        match libretracks_video::extract::probe(&libmpv, std::path::Path::new(&file_path)) {
            Ok(info) => analysed.push((file_path, info)),
            Err(error) => skipped.push(skip(error.to_string())),
        }
    }

    let assets = if analysed.is_empty() {
        Vec::new()
    } else {
        with_session(&state, |session, _| {
            session.register_video_assets(analysed, folder_path.as_deref())
        })?
    };
    state.video.thumbnails.request(
        assets
            .iter()
            .map(|asset| ThumbnailJob {
                key: asset.file_path.clone(),
                source: std::path::PathBuf::from(&asset.file_path),
                duration_seconds: asset.info.duration_seconds,
            })
            .collect(),
        false,
    );
    Ok(VideoImportResult { assets, skipped })
}

#[tauri::command(async)]
pub fn list_video_assets(state: State<'_, DesktopState>) -> Result<Vec<VideoAssetSummary>, String> {
    with_session(&state, |session, _| session.list_video_assets())
}

/// Resolve a stored path (absolute, or relative to the session folder when it
/// came inside a package) and the duration the library knows for it.
fn thumbnail_job_for(state: &State<'_, DesktopState>, file_path: &str) -> Option<ThumbnailJob> {
    let session = state.session.lock().ok()?;
    let source = match session.song_dir.as_deref() {
        Some(dir) => crate::state::resolve_audio_file_path(dir, file_path),
        None => std::path::PathBuf::from(file_path),
    };
    let duration_seconds = session
        .video_asset_info(file_path)
        .map(|info| info.duration_seconds)
        .unwrap_or(0.0);
    Some(ThumbnailJob {
        key: file_path.to_string(),
        source,
        duration_seconds,
    })
}

/// Queue thumbnail strips. `urgent` for the videos the timeline shows now.
#[tauri::command(async)]
pub fn request_video_thumbnails(
    file_paths: Vec<String>,
    urgent: bool,
    state: State<'_, DesktopState>,
) {
    let jobs = file_paths
        .iter()
        .filter_map(|path| thumbnail_job_for(&state, path))
        .collect();
    state.video.thumbnails.request(jobs, urgent);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoThumbnailStripDto {
    pub file_path: String,
    pub interval_seconds: f64,
    pub width: u32,
    pub height: u32,
    /// Base64 JPEGs, one per `interval_seconds` from media time 0.
    pub frames: Vec<String>,
}

/// The cached strip for a video, or `None` if it is not made yet — in which
/// case it is queued as urgent and `video:thumbnails-ready` fires when done.
#[tauri::command(async)]
pub fn get_video_thumbnails(
    file_path: String,
    state: State<'_, DesktopState>,
) -> Option<VideoThumbnailStripDto> {
    let job = thumbnail_job_for(&state, &file_path)?;
    let cache_root = crate::state::decoding_cache_root();
    match libretracks_video::thumbs::read_cached(&cache_root, &job.source) {
        Some(strip) => Some(VideoThumbnailStripDto {
            file_path,
            interval_seconds: strip.interval_seconds,
            width: strip.width,
            height: strip.height,
            frames: strip
                .frames
                .iter()
                .map(|jpeg| STANDARD.encode(jpeg))
                .collect(),
        }),
        None => {
            state.video.thumbnails.request(vec![job], true);
            None
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPlacement {
    pub file_path: String,
    pub duration_seconds: f64,
}

/// Place library videos on the timeline back to back (one undo step). They go
/// on `target_track_id` if it is a video track, else on a new video track.
#[tauri::command(async)]
pub fn place_video_clips(
    items: Vec<VideoPlacement>,
    timeline_start_seconds: f64,
    target_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let items: Vec<(String, f64)> = items
        .into_iter()
        .map(|item| (item.file_path, item.duration_seconds))
        .collect();
    with_session(&state, |session, audio| {
        session.place_video_clips(
            &items,
            timeline_start_seconds,
            target_track_id.as_deref(),
            audio,
        )
    })
}

// ---------------------------------------------------------------------------
// Output (paso 06): displays, settings, status, identify, test pattern.
// ---------------------------------------------------------------------------

use libretracks_video::output::{OutputCommand, OutputStatus};
use libretracks_video::settings::VideoOutputSettings;
use tauri::{AppHandle, Emitter, Manager};

use crate::infra::settings::{save_app_settings, AppSettingsStore};

/// A monitor for the display picker: numbered like "Identify" labels it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDisplayOption {
    #[serde(flatten)]
    pub monitor: libretracks_video::monitors::MonitorInfo,
    /// 1-based, in enumeration order: the number "Identify" shows on it.
    pub number: usize,
    /// The app's main window is on this monitor.
    pub has_app: bool,
}

#[tauri::command(async)]
pub fn video_list_displays(app: AppHandle) -> Vec<VideoDisplayOption> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let (monitors, app_monitor) = crate::video::displays::connected_monitors(&app);
        monitors
            .into_iter()
            .enumerate()
            .map(|(index, monitor)| VideoDisplayOption {
                has_app: app_monitor.as_deref() == Some(monitor.name.as_str()),
                number: index + 1,
                monitor,
            })
            .collect()
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command(async)]
pub fn video_output_status(state: State<'_, DesktopState>) -> OutputStatus {
    state.video.output_status()
}

/// Save the output settings with the rest of the app settings and apply them
/// live. Changing the fit does not reopen the window; changing the display
/// or the mode does.
#[tauri::command(async)]
pub fn video_apply_settings(
    app: AppHandle,
    settings: VideoOutputSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<VideoOutputSettings, String> {
    let settings = settings.clamped();
    let mut app_settings = settings_store.current().map_err(|error| error.to_string())?;
    if app_settings.video_output != settings {
        app_settings.video_output = settings.clone();
        settings_store
            .set(app_settings.clone())
            .map_err(|error| error.to_string())?;
        save_app_settings(&app, &app_settings).map_err(|error| error.to_string())?;
        let _ = app.emit("settings:updated", app_settings);
    }
    state
        .video
        .send(OutputCommand::ApplySettings(settings.clone()));
    Ok(settings)
}

/// A big number on every monitor for 3 s, matching `VideoDisplayOption.number`.
#[tauri::command(async)]
pub fn video_identify_displays(app: AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::{LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
        let (monitors, _) = crate::video::displays::connected_monitors(&app);
        let mut labels = Vec::new();
        for (index, monitor) in monitors.iter().enumerate() {
            let label = format!("identify-display-{}", index + 1);
            if let Some(existing) = app.get_webview_window(&label) {
                let _ = existing.close();
            }
            let url = WebviewUrl::App(format!("identify-display.html?n={}", index + 1).into());
            let window = WebviewWindowBuilder::new(&app, &label, url)
                .title("LibreTracks")
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .inner_size(260.0, 260.0)
                .visible(false)
                .build()
                .map_err(|error| error.to_string())?;
            let scale = window.scale_factor().unwrap_or(1.0);
            let side = (260.0 * scale) as i32;
            let _ = window.set_position(PhysicalPosition::new(
                monitor.x + (monitor.width as i32 - side) / 2,
                monitor.y + (monitor.height as i32 - side) / 2,
            ));
            let _ = window.set_size(LogicalSize::new(260.0, 260.0));
            let _ = window.show();
            labels.push(label);
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            for label in labels {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.close();
                }
            }
        });
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Resolve an image bundled under `resources/video/`.
fn bundled_video_image(app: &AppHandle, name: &str) -> Option<String> {
    app.path()
        .resolve(format!("video/{name}"), tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Show (or hide) the test pattern on the output.
#[tauri::command(async)]
pub fn video_test_pattern(
    app: AppHandle,
    on: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let image = if on {
        Some(bundled_video_image(&app, "test-pattern.png").ok_or("falta la carta de ajuste")?)
    } else {
        None
    };
    state.video.send(OutputCommand::Overlay(image));
    Ok(())
}
