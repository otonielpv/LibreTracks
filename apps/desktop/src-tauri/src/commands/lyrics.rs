//! Letra en proyección (plan lyrics-sync): ajustes, prueba de conexión,
//! vínculo de cada canción y estado. Todo el HTTP sale de Rust: el WebView no
//! habla nunca con el programa de letras (en Android release el cleartext del
//! WebView está bloqueado).

use libretracks_core::lyrics_config::{uses_token, LyricsConfig};
use libretracks_core::{LyricsSoftware, RegionLyrics};
use libretracks_lyrics::clients::{client_for, Connection, LyricsClient, Presentation, ProbeInfo};
use libretracks_lyrics::report::{region_report, RegionReport};
use libretracks_lyrics::thumbs::ThumbCache;
use libretracks_lyrics::worker::{LyricsStatus, WorkerInput};
use libretracks_lyrics::LyricsError;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::infra::error::DesktopError;
use crate::lyrics::{config, connection_for, load_token, save_token, LyricsService};
use crate::models::TransportSnapshot;
use crate::state::DesktopState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsConfigView {
    pub config: LyricsConfig,
    /// Whether a token is stored for the selected program (never the token).
    pub has_token: bool,
}

fn current_config(service: &LyricsService) -> LyricsConfig {
    service
        .config
        .lock()
        .map(|config| config.clone())
        .unwrap_or_default()
}

fn config_view(app: &AppHandle, service: &LyricsService) -> LyricsConfigView {
    let config = current_config(service);
    let has_token = config
        .software
        .filter(|software| uses_token(*software))
        .and_then(|software| load_token(app, software))
        .is_some();
    LyricsConfigView { config, has_token }
}

#[tauri::command(async)]
pub fn lyrics_get_config(app: AppHandle, service: State<'_, LyricsService>) -> LyricsConfigView {
    config_view(&app, &service)
}

/// Guarda los ajustes. `token`: `None` deja el guardado; `Some("")` lo borra.
#[tauri::command(async)]
pub fn lyrics_save_config(
    app: AppHandle,
    service: State<'_, LyricsService>,
    config: LyricsConfig,
    token: Option<String>,
) -> Result<LyricsConfigView, String> {
    if let (Some(software), Some(token)) = (config.software, token.as_deref()) {
        if uses_token(software) {
            save_token(&app, software, token)?;
        }
    }
    let resumed = {
        let mut slot = service
            .config
            .lock()
            .map_err(|_| "lyrics config poisoned".to_string())?;
        let resumed = slot.paused && !config.paused;
        *slot = config;
        config::save(&app, &slot);
        resumed
    };
    service.apply(&app);
    if resumed {
        take_over(&app);
    }
    Ok(config_view(&app, &service))
}

fn take_over(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let locked = state.session.lock();
    if let Ok(mut session) = locked {
        session.lyrics_take_over();
    }
}

/// «Probar conexión» con lo que hay en el formulario, sin guardarlo.
/// `token: None` usa el guardado.
#[tauri::command(async)]
pub async fn lyrics_probe(
    app: AppHandle,
    software: LyricsSoftware,
    host: String,
    port: u16,
    token: Option<String>,
) -> Result<ProbeInfo, LyricsError> {
    let token = match token {
        Some(token) if !token.trim().is_empty() => Some(token.trim().to_string()),
        _ if uses_token(software) => load_token(&app, software),
        _ => None,
    };
    let client = client_for(
        software,
        Connection {
            host: host.trim().to_string(),
            port,
            token,
        },
    )?;
    client.probe().await
}

fn configured_client(
    app: &AppHandle,
    service: &LyricsService,
) -> Result<(LyricsSoftware, Box<dyn LyricsClient>), LyricsError> {
    let config = current_config(service);
    let (software, connection) =
        connection_for(app, &config).ok_or_else(|| LyricsError::Unexpected {
            detail: "elige el programa de letras y su puerto".into(),
        })?;
    Ok((software, client_for(software, connection)?))
}

#[tauri::command(async)]
pub async fn lyrics_list_presentations(
    app: AppHandle,
    service: State<'_, LyricsService>,
) -> Result<Vec<Presentation>, LyricsError> {
    let (_, client) = configured_client(&app, &service)?;
    client.list_presentations().await
}

fn session_song(state: &DesktopState) -> Result<libretracks_core::Song, LyricsError> {
    let session = state.session.lock().map_err(|_| LyricsError::Unexpected {
        detail: "estado bloqueado".into(),
    })?;
    session
        .engine
        .song()
        .cloned()
        .ok_or_else(|| LyricsError::Unexpected {
            detail: "no hay sesión abierta".into(),
        })
}

/// Lo que muestra el panel de letra de una canción.
#[tauri::command(async)]
pub async fn lyrics_region_report(
    app: AppHandle,
    service: State<'_, LyricsService>,
    state: State<'_, DesktopState>,
    region_id: String,
) -> Result<RegionReport, LyricsError> {
    let (software, client) = configured_client(&app, &service)?;
    let song = session_song(&state)?;
    let catalog = client.list_presentations().await?;
    region_report(client.as_ref(), software, &song, &region_id, &catalog).await
}

/// Miniaturas de diapositivas para el editor de sección (`data:` URL, o
/// `None` si el programa no las da). Las de FreeShow cuestan ~6 s cada una
/// (las renderiza con esperas fijas), así que se guardan en disco por versión
/// de la presentación. `cached_only`: solo las ya guardadas, al momento.
#[tauri::command(async)]
pub async fn lyrics_slide_thumbnails(
    app: AppHandle,
    service: State<'_, LyricsService>,
    presentation_id: String,
    indexes: Vec<u32>,
    cached_only: Option<bool>,
) -> Result<Vec<Option<String>>, LyricsError> {
    let (software, client) = configured_client(&app, &service)?;
    let cache = match (client.thumbnail_version(&presentation_id).await, app.path().app_cache_dir()) {
        (Some(version), Ok(base)) => Some(ThumbCache::open(
            &base.join("lyrics-thumbnails"),
            software,
            &presentation_id,
            &version,
        )),
        _ => None,
    };
    let mut pictures: Vec<Option<String>> = indexes
        .iter()
        .map(|index| cache.as_ref().and_then(|cache| cache.get(*index)))
        .collect();
    if cached_only.unwrap_or(false) {
        return Ok(pictures);
    }
    let missing: Vec<u32> = indexes
        .iter()
        .zip(&pictures)
        .filter(|(_, picture)| picture.is_none())
        .map(|(index, _)| *index)
        .collect();
    if missing.is_empty() {
        return Ok(pictures);
    }
    let made = client.thumbnails(&presentation_id, &missing).await?;
    for (index, picture) in missing.iter().zip(made) {
        if let Some(url) = picture {
            if let Some(cache) = &cache {
                cache.put(*index, &url);
            }
            if let Some(slot) = indexes.iter().position(|wanted| wanted == index) {
                pictures[slot] = Some(url);
            }
        }
    }
    Ok(pictures)
}

/// Lo que muestra «Vincular canciones»: un informe por canción.
#[tauri::command(async)]
pub async fn lyrics_setlist_report(
    app: AppHandle,
    service: State<'_, LyricsService>,
    state: State<'_, DesktopState>,
) -> Result<Vec<RegionReport>, LyricsError> {
    let (software, client) = configured_client(&app, &service)?;
    let song = session_song(&state)?;
    let catalog = client.list_presentations().await?;
    let mut reports = Vec::with_capacity(song.regions.len());
    for region in &song.regions {
        reports.push(region_report(client.as_ref(), software, &song, &region.id, &catalog).await?);
    }
    Ok(reports)
}

/// Guarda la letra en proyección de una canción (con deshacer).
#[tauri::command(async)]
pub fn lyrics_set_region_lyrics(
    state: State<'_, DesktopState>,
    region_id: String,
    lyrics: Option<RegionLyrics>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .set_region_lyrics(&region_id, lyrics, &state.audio)
        .map_err(|error| error.to_string())
}

/// «Probar»: manda ya esa sección (y su diapositiva `k`).
#[tauri::command(async)]
pub fn lyrics_test_send(
    service: State<'_, LyricsService>,
    region_id: String,
    marker_id: String,
    k: u32,
) {
    service.send(WorkerInput::TestSend {
        region_id,
        marker_id,
        k,
    });
}

#[tauri::command(async)]
pub fn lyrics_set_paused(
    app: AppHandle,
    service: State<'_, LyricsService>,
    paused: bool,
) -> Result<(), String> {
    {
        let mut slot = service
            .config
            .lock()
            .map_err(|_| "lyrics config poisoned".to_string())?;
        if slot.paused == paused {
            return Ok(());
        }
        slot.paused = paused;
        config::save(&app, &slot);
    }
    service.apply(&app);
    if !paused {
        take_over(&app);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn lyrics_refresh(app: AppHandle, service: State<'_, LyricsService>) {
    service.send(WorkerInput::Refresh);
    service.apply(&app);
}

#[tauri::command(async)]
pub fn lyrics_status(service: State<'_, LyricsService>) -> LyricsStatus {
    service
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

/// Los toques grabados en el editor de una sección, como pulsos desde el
/// inicio de esa marca y guardados contra su id exacto (solo esa repetición).
#[tauri::command(async)]
pub fn lyrics_section_steps_from_taps(
    state: State<'_, DesktopState>,
    region_id: String,
    marker_id: String,
    taps: Vec<f64>,
) -> Result<Vec<libretracks_core::LyricsStep>, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    let song = session.engine.song().ok_or("no hay sesión abierta")?;
    Ok(libretracks_core::lyrics_schedule::section_steps_from_taps(
        song, &region_id, &marker_id, &taps,
    ))
}

/// El grabador de cambios está abierto en esta canción (`None`: cerrado):
/// mientras tanto la reproducción no manda sus cambios de diapositiva.
#[tauri::command(async)]
pub fn lyrics_set_recording(service: State<'_, LyricsService>, region_id: Option<String>) {
    service.send(WorkerInput::Recording(region_id));
}

/// Dónde está el cursor ahora, en segundos de fuente (los de las marcas),
/// para un toque del grabador de cambios.
#[tauri::command(async)]
pub fn lyrics_tap_position(state: State<'_, DesktopState>) -> Result<f64, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    Ok(session.lyrics_tap_position())
}

/// Marca el tutorial de configuración de un programa como visto (o saltado).
#[tauri::command(async)]
pub fn lyrics_tutorial_done(
    app: AppHandle,
    service: State<'_, LyricsService>,
    software: LyricsSoftware,
) -> Result<LyricsConfigView, String> {
    {
        let mut slot = service
            .config
            .lock()
            .map_err(|_| "lyrics config poisoned".to_string())?;
        if !slot.tutorial_done.contains(&software) {
            slot.tutorial_done.push(software);
            config::save(&app, &slot);
        }
    }
    Ok(config_view(&app, &service))
}
