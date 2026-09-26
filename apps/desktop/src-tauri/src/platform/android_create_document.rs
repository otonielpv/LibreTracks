//! "Guardar como" de Android con el tipo MIME del fichero.
//!
//! ## Por qué existe, si ya hay un diálogo de guardar
//!
//! `tauri-plugin-dialog` 2.7.0 lanza `ACTION_CREATE_DOCUMENT` siempre con tipo
//! `*/*`. El proveedor de documentos (Descargas, almacenamiento interno) decide
//! con ese tipo qué parte del nombre es la extensión, y con `*/*` no hay
//! ninguna: si ya existe `mezcla.wav`, el nuevo se llama `mezcla.wav (1)`. Ese
//! fichero ya no termina en `.wav`, así que la galería, los reproductores y el
//! propio selector de la tablet dejan de verlo como audio.
//!
//! Con el MIME real (`audio/x-wav`, `application/zip`) el proveedor separa
//! nombre y extensión y lo llama `mezcla (1).wav`.
//!
//! ## Cómo viaja el resultado
//!
//! La parte de Java es `MainActivity.createDocument`: deduce el MIME de la
//! extensión con `MimeTypeMap` y, si Android no la conoce (`.ltpkg`, `.ltset`),
//! contesta al momento con [`UNKNOWN_MIME`] sin abrir nada, y el llamante usa
//! el diálogo de siempre. El URI vuelve por
//! `nativeOnDocumentCreated`, el mismo camino Kotlin → Rust que
//! `android_persistable_pick`.

#![cfg(target_os = "android")]

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;

/// Lo que Java contesta cuando Android no conoce la extensión. Tiene que
/// coincidir con `UNKNOWN_MIME` en `MainActivity.kt`.
const UNKNOWN_MIME: &str = "!unknown-mime";

/// Resultado que llega de Java: el URI creado, "" si el usuario canceló, o
/// [`UNKNOWN_MIME`].
static PENDING: Mutex<Option<Sender<String>>> = Mutex::new(None);

/// Igual que el selector de audio: generoso, sólo para no colgar el comando si
/// la actividad del sistema no contesta nunca.
const SAVE_TIMEOUT: Duration = Duration::from_secs(600);

/// Qué pasó con el diálogo.
#[derive(Debug, PartialEq, Eq)]
pub enum CreatedDocument {
    /// El usuario eligió dónde guardar: el `content://` del documento nuevo.
    Created(String),
    /// El usuario canceló.
    Cancelled,
    /// Android no conoce la extensión: no se abrió nada, usa el diálogo genérico.
    UnknownMime,
}

/// Abre el "Guardar como" del sistema para `file_name` y espera la respuesta.
pub fn create_document(file_name: &str) -> Result<CreatedDocument, String> {
    let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
    {
        let mut pending = PENDING
            .lock()
            .map_err(|_| "dialogo de guardar en estado inconsistente".to_string())?;
        if pending.is_some() {
            return Err("ya hay un dialogo de guardar abierto".to_string());
        }
        *pending = Some(tx);
    }

    if let Err(error) = start_dialog(file_name) {
        let _ = PENDING.lock().map(|mut pending| pending.take());
        return Err(error);
    }

    match rx.recv_timeout(SAVE_TIMEOUT) {
        Ok(uri) if uri == UNKNOWN_MIME => Ok(CreatedDocument::UnknownMime),
        Ok(uri) if uri.is_empty() => Ok(CreatedDocument::Cancelled),
        Ok(uri) => Ok(CreatedDocument::Created(uri)),
        Err(_) => {
            let _ = PENDING.lock().map(|mut pending| pending.take());
            Err("el dialogo de guardar no respondio".to_string())
        }
    }
}

fn start_dialog(file_name: &str) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let name = env
        .new_string(file_name)
        .map_err(|e| format!("new_string: {e}"))?;
    let result = env
        .call_method(
            &activity,
            "createDocument",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&name)],
        )
        .map(|_| ())
        .map_err(|e| format!("createDocument: {e}"));
    // Misma razón que en android_persistable_pick: una excepción Java pendiente
    // haría fallar en silencio la llamada JNI del diálogo de respaldo.
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}

/// Punto de entrada JNI. Lo llama `MainActivity` en el hilo de UI.
///
/// # Safety
/// La JVM lo llama con punteros `JNIEnv`/`jobject` válidos.
#[no_mangle]
pub unsafe extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnDocumentCreated(
    env: *mut jni::sys::JNIEnv,
    _class: *mut std::ffi::c_void,
    uri: jni::sys::jstring,
) {
    let value = read_string(env, uri).unwrap_or_else(|error| {
        eprintln!("[LT_SAVE] no se pudo leer el URI creado: {error}");
        String::new()
    });
    let sender = PENDING.lock().ok().and_then(|mut pending| pending.take());
    match sender {
        Some(sender) => {
            let _ = sender.send(value);
        }
        None => eprintln!("[LT_SAVE] resultado sin destinatario, descartado"),
    }
}

unsafe fn read_string(
    env: *mut jni::sys::JNIEnv,
    value: jni::sys::jstring,
) -> Result<String, String> {
    if value.is_null() {
        return Ok(String::new());
    }
    let mut env = jni::JNIEnv::from_raw(env).map_err(|e| format!("JNIEnv::from_raw: {e}"))?;
    let value = JString::from_raw(value);
    let text = env
        .get_string(&value)
        .map_err(|e| format!("get_string: {e}"))?
        .to_string_lossy()
        .into_owned();
    Ok(text)
}
