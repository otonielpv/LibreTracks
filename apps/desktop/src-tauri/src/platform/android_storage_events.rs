//! Aviso de «se ha montado o desmontado un volumen» (microSD, pendrive por OTG).
//!
//! `MainActivity` registra un `BroadcastReceiver` para `ACTION_MEDIA_MOUNTED` y
//! compañía —broadcasts del sistema que cualquier app recibe sin permiso— y
//! llama aquí. Aquí se refresca la lista de volúmenes y se avisa a la interfaz
//! con `storage:volumes-changed`, para que Ajustes y «Tus sesiones» se pongan
//! al día solos en vez de esperar a que el usuario vuelva a entrar.

#![cfg(target_os = "android")]

use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};

/// Evento que escucha el frontend (`listenToStorageVolumesChanged`).
pub const STORAGE_VOLUMES_CHANGED_EVENT: &str = "storage:volumes-changed";

/// Con quién hablar cuando llegue el aviso. El broadcast lo entrega la
/// Activity, que no sabe nada de Tauri; la app se apunta aquí al arrancar.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Punto de entrada JNI. Llega en el hilo de UI de Android, así que el trabajo
/// (una consulta JNI por volumen y el aviso) va a un hilo aparte.
///
/// # Safety
/// La JVM lo llama con punteros `JNIEnv`/`jobject` válidos; no se usan.
#[no_mangle]
pub unsafe extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnStorageVolumesChanged(
    _env: *mut jni::sys::JNIEnv,
    _this: *mut std::ffi::c_void,
) {
    std::thread::spawn(|| {
        let volumes = super::android_storage::refresh_external_files_dirs();
        eprintln!("[LT_STORAGE] volumes changed: {} mounted", volumes.len());
        if let Some(app) = APP.get() {
            let _ = app.emit(STORAGE_VOLUMES_CHANGED_EVENT, ());
        }
    });
}
