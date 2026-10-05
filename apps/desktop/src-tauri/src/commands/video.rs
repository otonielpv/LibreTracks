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
    let result = edit(&mut session, &state.audio).map_err(|error| error.to_string());
    drop(session);
    // Video edits and library changes: the sync runtime refreshes its timeline.
    state.video.runtime.notify();
    result
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

#[derive(Debug, Clone, Serialize)]
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
        match state.video.probe(std::path::Path::new(&file_path)) {
            Ok(info) => analysed.push((file_path, info)),
            // A codec this device cannot decode still joins the library with
            // what could be read (paso 07 §1): it plays on the desktop, and
            // here it reads "not playable on this device", not "missing".
            Err(libretracks_video::media::ProbeError::Unsupported {
                info: Some(info), ..
            }) => analysed.push((file_path, info)),
            Err(error) => skipped.push(skip(error.message())),
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
    let (mut assets, song_dir) = with_session(&state, |session, _| {
        Ok((session.list_video_assets()?, session.song_dir.clone()))
    })?;
    crate::state::mark_unplayable_video_assets(&mut assets, |file_path| {
        let resolved = match song_dir.as_deref() {
            Some(dir) => crate::state::resolve_audio_file_path(dir, file_path),
            None => std::path::PathBuf::from(file_path),
        };
        state.video.unplayable_reason(&resolved)
    });
    Ok(assets)
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
#[derive(Debug, Clone, Serialize)]
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
    // A phone: the external displays the native side reported (paso 10). The
    // phone's own screen is never one of them.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        mobile_display_options(crate::video::native_events::last_displays())
    }
}

/// The display picker's entries on a phone: numbered, none of them the app's.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub(crate) fn mobile_display_options(
    displays: Vec<libretracks_video::monitors::MonitorInfo>,
) -> Vec<VideoDisplayOption> {
    displays
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| VideoDisplayOption {
            monitor,
            number: index + 1,
            has_app: false,
        })
        .collect()
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
) -> Result<VideoOutputSettings, String> {
    persist_and_apply_output_settings(&app, settings)
}

/// Save the output settings (if they changed) and hand them to the output.
/// Shared with the live "output on/off" action (paso 13).
pub fn persist_and_apply_output_settings(
    app: &AppHandle,
    settings: VideoOutputSettings,
) -> Result<VideoOutputSettings, String> {
    let settings = settings.clamped();
    let settings_store = app.state::<AppSettingsStore>();
    let mut app_settings = settings_store.current().map_err(|error| error.to_string())?;
    if app_settings.video_output != settings {
        app_settings.video_output = settings.clone();
        settings_store
            .set(app_settings.clone())
            .map_err(|error| error.to_string())?;
        save_app_settings(app, &app_settings).map_err(|error| error.to_string())?;
        let _ = app.emit("settings:updated", app_settings);
    }
    app.state::<DesktopState>().video.set_settings(settings.clone());
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

/// Resolve an image bundled under `resources/video/`. Android has no Tauri
/// resource dir in the APK: `MainActivity` copies the assets to `filesDir`
/// (like the voice bank and the demo).
fn bundled_video_image(app: &AppHandle, name: &str) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return app
            .path()
            .app_local_data_dir()
            .ok()
            .map(|base| base.join("files").join("video").join(name))
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned());
    }
    #[cfg(not(target_os = "android"))]
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

/// Sync diagnostics for the settings tab (error p50/p95, seeks, swaps…).
#[tauri::command(async)]
pub fn video_sync_stats(state: State<'_, DesktopState>) -> crate::video::runtime::VideoSyncStats {
    state.video.runtime.stats()
}

/// Start (with a beat grid) or stop (`None`) the latency calibration: the
/// output flashes white on every beat while the metronome clicks.
#[tauri::command(async)]
pub fn video_calibration(
    app: AppHandle,
    grid: Option<crate::video::runtime::CalibrationGrid>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let flash = match grid {
        Some(_) => Some(
            bundled_video_image(&app, "flash-white.png").ok_or("falta la imagen del destello")?,
        ),
        None => None,
    };
    state.video.set_calibration(grid, flash);
    Ok(())
}

// ---------------------------------------------------------------------------
// Audio of a video (paso 11).
// ---------------------------------------------------------------------------

#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoAudioProgress<'a> {
    clip_id: &'a str,
    fraction: f64,
}

/// Decode a video clip's audio to a WAV in the session and put it on a new
/// audio track below the video track, aligned with the clip (one undo step).
/// The decoding runs off the session lock; `video:audio-extract-progress`
/// reports it.
/// Decoding a video's audio needs libmpv (plan video-mobile, paso 09 §2):
/// the menu entry is hidden on mobile; this is the backstop.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command(async)]
pub fn extract_video_audio(
    _app: AppHandle,
    _clip_id: String,
    _state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    Err("extraer el audio de un vídeo solo está disponible en escritorio".into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command(async)]
pub fn extract_video_audio(
    app: AppHandle,
    clip_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let libmpv = state.video.libmpv()?;
    let plan = with_session(&state, |session, _| session.plan_video_audio_extraction(&clip_id))?;
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let decoded = libretracks_video::audio::extract_audio_to_wav(
        &libmpv,
        &plan.source,
        &plan.destination,
        plan.duration_seconds,
        &|fraction| {
            let _ = app.emit(
                "video:audio-extract-progress",
                VideoAudioProgress {
                    clip_id: &plan.clip_id,
                    fraction,
                },
            );
        },
        &cancel,
    );
    if let Err(error) = decoded {
        plan.abandon();
        return Err(error.to_string());
    }
    with_session(&state, |session, audio| {
        session.commit_video_audio_extraction(&plan, audio)
    })
}

// ---------------------------------------------------------------------------
// Live control (paso 13).
// ---------------------------------------------------------------------------

/// Black, fade to black, idle screen, output on/off: `action` is `black`,
/// `fadeBlack`, `idle` or `output`.
#[tauri::command(async)]
pub fn video_live_action(
    app: AppHandle,
    action: String,
) -> Result<crate::video::live::VideoLiveStateDto, String> {
    crate::video::live::run(&app, action.parse()?)
}

#[tauri::command(async)]
pub fn video_live_state(app: AppHandle) -> crate::video::live::VideoLiveStateDto {
    crate::video::live::state_dto(&app)
}

// ---------------------------------------------------------------------------
// Videos on a phone (plan video-mobile, paso 08).
// ---------------------------------------------------------------------------

/// The user's answer to `video:import-question` ("bring the videos too?").
#[tauri::command(async)]
pub fn answer_video_import_question(request_id: u64, include: bool) -> bool {
    crate::video::import_question::answer(request_id, include)
}

/// `video:device-import-done`: what adding videos from the phone left.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceVideoImportDone {
    pub result: Option<VideoImportResult>,
    pub error: Option<String>,
}

/// A video picked on the phone, not copied yet.
#[cfg(any(target_os = "android", target_os = "ios"))]
struct PickedVideo {
    name: String,
    size: u64,
    open: Box<dyn FnOnce() -> Result<std::fs::File, String> + Send>,
    /// A local copy made by the picker (iOS), deleted once handled.
    temporary: Option<std::path::PathBuf>,
}

/// Copy, analyse and register picked videos on a worker thread, then emit
/// `video:device-import-done`. Asks first, with the size and the free space
/// (paso 08 §3): a 1 GB video is not copied by surprise.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn add_picked_videos(app: AppHandle, picked: Vec<PickedVideo>) {
    let _ = std::thread::Builder::new()
        .name("lt-video-device-import".into())
        .spawn(move || {
            let done = match add_picked_videos_now(&app, picked) {
                Ok(result) => DeviceVideoImportDone {
                    result: Some(result),
                    error: None,
                },
                Err(error) => DeviceVideoImportDone {
                    result: None,
                    error: Some(error),
                },
            };
            let _ = app.emit("video:device-import-done", done);
        });
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn add_picked_videos_now(
    app: &AppHandle,
    picked: Vec<PickedVideo>,
) -> Result<VideoImportResult, String> {
    use crate::video::import_question::{ask_from_app, videos_fit, VideoImportSource};
    let state = app.state::<DesktopState>();
    let song_dir = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?
        .song_dir
        .clone()
        .ok_or_else(|| "Abre una sesión antes de añadir vídeos".to_string())?;
    let total: u64 = picked.iter().map(|video| video.size).sum();
    let free = crate::state::free_space_near(&song_dir);
    if !ask_from_app(app, VideoImportSource::Device, picked.len(), total, free) {
        // Cancelled by the user: nothing to report. Only "it does not fit"
        // is worth telling (a video outside the session cannot be used on a
        // phone, so not copying it means not adding it).
        let fits = videos_fit(total, free);
        if fits {
            for video in &picked {
                if let Some(temporary) = &video.temporary {
                    let _ = std::fs::remove_file(temporary);
                }
            }
            return Ok(VideoImportResult {
                assets: Vec::new(),
                skipped: Vec::new(),
            });
        }
        let reason = "no cabe en el dispositivo";
        return Ok(VideoImportResult {
            assets: Vec::new(),
            skipped: picked
                .into_iter()
                .map(|video| {
                    if let Some(temporary) = &video.temporary {
                        let _ = std::fs::remove_file(temporary);
                    }
                    video
                })
                .map(|video| SkippedImport {
                    source_path: video.name.clone(),
                    file_name: video.name,
                    reason: reason.to_string(),
                })
                .collect(),
        });
    }

    let mut analysed = Vec::new();
    let mut skipped = Vec::new();
    for video in picked {
        let name = video.name.clone();
        let skip = |reason: String| SkippedImport {
            file_name: name.clone(),
            source_path: name.clone(),
            reason,
        };
        let copied = (video.open)().and_then(|mut file| {
            crate::video::device_import::copy_into_session(&mut file, &song_dir, &video.name)
                .map_err(|error| error.to_string())
        });
        if let Some(temporary) = &video.temporary {
            let _ = std::fs::remove_file(temporary);
        }
        let relative = match copied {
            Ok(relative) => relative,
            Err(error) => {
                skipped.push(skip(error));
                continue;
            }
        };
        let absolute = song_dir.join(&relative);
        match state.video.probe(&absolute) {
            Ok(info)
            | Err(libretracks_video::media::ProbeError::Unsupported {
                info: Some(info), ..
            }) => analysed.push((relative, info)),
            Err(error) => {
                let _ = std::fs::remove_file(&absolute);
                skipped.push(skip(error.message()));
            }
        }
    }

    let assets = if analysed.is_empty() {
        Vec::new()
    } else {
        with_session(&state, |session, _| {
            session.register_video_assets(analysed, None)
        })?
    };
    state.video.thumbnails.request(
        assets
            .iter()
            .map(|asset| ThumbnailJob {
                key: asset.file_path.clone(),
                source: crate::state::resolve_audio_file_path(&song_dir, &asset.file_path),
                duration_seconds: asset.info.duration_seconds,
            })
            .collect(),
        false,
    );
    Ok(VideoImportResult { assets, skipped })
}

/// Pick videos on the phone and add them to the session. `source` is
/// `"gallery"` (the system's photos picker) or `"files"` (the documents
/// picker: Downloads, a USB stick, Drive; keeps the real name). Returns false
/// if the picker was cancelled; the result arrives as
/// `video:device-import-done`. On the desktop videos are referenced where
/// they are (drag and drop, the library), so this does nothing there.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn pick_and_add_videos(app: AppHandle, source: Option<String>) -> Result<bool, String> {
    let _ = (app, source);
    Ok(false)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn pick_and_add_videos(app: AppHandle, source: Option<String>) -> Result<bool, String> {
    let files: Vec<tauri_plugin_dialog::FilePath> = if source.as_deref() == Some("gallery") {
        // The photos picker: the gallery, but it hides the real file name
        // ("32.mp4" -> `picked_video_name` makes it "video-32.mp4").
        use tauri_plugin_dialog::DialogExt;
        let (sender, receiver) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .set_title("Selecciona vídeos")
            .add_filter("Vídeo", &["mp4", "mov", "m4v", "mkv", "webm", "3gp"])
            .pick_files(move |files| {
                let _ = sender.send(files);
            });
        receiver.recv().ok().flatten().unwrap_or_default()
    } else {
        crate::platform::android_persistable_pick::pick_video_documents()?
            .into_iter()
            .filter_map(|uri| uri.parse::<tauri::Url>().ok())
            .map(tauri_plugin_dialog::FilePath::Url)
            .collect()
    };
    if files.is_empty() {
        return Ok(false);
    }
    let mut picked = Vec::new();
    for file in files {
        let display_name = match &file {
            tauri_plugin_dialog::FilePath::Url(url) => {
                crate::platform::android_video::display_name(url.as_str())
            }
            tauri_plugin_dialog::FilePath::Path(_) => None,
        };
        let name = crate::video::device_import::picked_video_name(
            display_name.as_deref(),
            &crate::platform::mobile_files::picked_file_name(&file),
        );
        let size = crate::platform::mobile_files::open_picked_file_for_read(&app, &file)
            .and_then(|handle| handle.metadata().map_err(|error| error.to_string()))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let open_app = app.clone();
        picked.push(PickedVideo {
            name,
            size,
            open: Box::new(move || {
                crate::platform::mobile_files::open_picked_file_for_read(&open_app, &file)
            }),
            temporary: None,
        });
    }
    add_picked_videos(app, picked);
    Ok(true)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn pick_and_add_videos(app: AppHandle, source: Option<String>) -> Result<bool, String> {
    let from_library = source.as_deref() == Some("gallery");
    let Some(path) = libretracks_ios_folder_picker::pick_video(app.clone(), from_library).await?
    else {
        return Ok(false);
    };
    let path = std::path::PathBuf::from(path);
    let name = crate::video::device_import::picked_video_name(
        None,
        &path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    let size = std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let open_path = path.clone();
    add_picked_videos(
        app,
        vec![PickedVideo {
            name,
            size,
            open: Box::new(move || {
                std::fs::File::open(&open_path).map_err(|error| error.to_string())
            }),
            // The plugin's local copy under tmp: gone once it is in the session.
            temporary: Some(path),
        }],
    );
    Ok(true)
}
