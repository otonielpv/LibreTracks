//! Comandos de la preparación de pistas: rendir warp y tono a disco para que
//! la reproducción lea el archivo en vez de ejecutar el estirador.
//!
//! Todos son `(async)`. Volver a un `#[tauri::command]` plano es una regresión,
//! no una cuestión de estilo: Tauri ejecuta un comando plano en línea sobre el
//! hilo principal, y estos toman el lock de sesión para clonar la canción.
//!
//! El trabajo pesado NO ocurre aquí. Estos comandos sólo encolan, cancelan o
//! consultan; la preparación corre en el trabajador de
//! [`crate::state::prepared_queue`], fuera del lock, porque dura segundos por
//! pista y `engine_snapshot` toma el mismo lock en cada sondeo de medidores.

use std::sync::Arc;

use tauri::State;

use crate::infra::error::DesktopError;
use crate::state::prepared_queue::{tracks_worth_preparing, PreparationStatus};
use crate::state::DesktopState;

/// Encola la preparación de las pistas con warp o tono de la canción abierta.
///
/// Devuelve `false` si ya hay una preparación en marcha: una cada vez es el
/// diseño, no un límite que haya que sortear.
#[tauri::command(async)]
pub fn prepare_song_tracks(state: State<'_, DesktopState>) -> Result<bool, String> {
    // Lock breve: clonar la canción y soltar. Todo lo caro pasa después.
    let (song_id, song_dir, song) = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let Some(song) = session.engine.song().cloned() else {
            return Err("no hay ninguna canción abierta".into());
        };
        let Some(song_dir) = session.song_dir.clone() else {
            return Err("la canción no está guardada en disco todavía".into());
        };
        (song.id.clone(), song_dir, song)
    };

    if tracks_worth_preparing(&song).is_empty() {
        return Err(
            "ninguna pista de esta canción usa warp ni tono, así que no hay nada que preparar"
                .into(),
        );
    }

    Ok(state
        .prepared_jobs
        .enqueue(song_id, song_dir, song, Arc::clone(&state.audio)))
}

/// Pide a la preparación en marcha que pare. No es un error llamarlo cuando no
/// hay ninguna.
#[tauri::command(async)]
pub fn cancel_song_preparation(state: State<'_, DesktopState>) {
    state.prepared_jobs.cancel();
}

/// Estado de la preparación, para que la interfaz lo sondee.
#[tauri::command(async)]
pub fn song_preparation_status(state: State<'_, DesktopState>) -> PreparationStatus {
    state.prepared_jobs.status()
}
