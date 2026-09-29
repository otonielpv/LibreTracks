//! Cerrar la app pasando por la interfaz.
//!
//! Pulsar la X de la ventana no cierra en el acto: se lo pide a la interfaz
//! (`app:close-requested`), que guarda la sesion, enseña "Proyecto guardado" y
//! entonces llama a [`exit_app`]. Asi quien cierra VE que su trabajo esta en
//! disco en vez de tener que fiarse del guardado silencioso de la salida (que
//! sigue ahi, en `save_session_on_exit`, para cualquier otra ruta de cierre).
//!
//! Nunca debe dejar la app sin poder cerrarse: si la interfaz no contesta
//! (colgada, sin montar), la segunda pulsacion de la X cierra sin preguntar.
//!
//! Solo escritorio: en movil el sistema cierra la app, no una X.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// Evento que la interfaz escucha para arrancar el cierre guardado.
pub const CLOSE_REQUESTED_EVENT: &str = "app:close-requested";

/// Si ya hay un cierre en marcha esperando a la interfaz.
#[derive(Default)]
pub struct AppCloseState {
    pending: AtomicBool,
}

/// Engancha la X de la ventana principal: retiene el cierre y se lo pasa a la
/// interfaz para que lo termine.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let Some(state) = window.try_state::<AppCloseState>() else {
        return;
    };
    // Segunda X con el cierre ya pedido: la interfaz no ha podido terminarlo
    // (o el usuario no quiere esperar). Se deja cerrar; el guardado de la
    // salida sigue corriendo en `ExitRequested`.
    if state.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    if window.emit(CLOSE_REQUESTED_EVENT, ()).is_err() {
        state.pending.store(false, Ordering::SeqCst);
        return;
    }
    api.prevent_close();
}

/// La interfaz ya ha guardado (o el usuario ha elegido salir sin guardar):
/// cerrar la app. Tambien lo usa ARCHIVO > Salir.
#[tauri::command(async)]
pub fn exit_app(app: AppHandle) {
    if let Some(state) = app.try_state::<AppCloseState>() {
        state.pending.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

/// El usuario ha cancelado el cierre (fallo al guardar y eligio quedarse): la
/// proxima X vuelve a pasar por la interfaz.
#[tauri::command(async)]
pub fn cancel_app_close(app: AppHandle) {
    if let Some(state) = app.try_state::<AppCloseState>() {
        state.pending.store(false, Ordering::SeqCst);
    }
}
