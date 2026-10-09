//! Carpetas de la biblioteca en Android (plan next-release, paso 12).
//!
//! Android no da rutas de las carpetas que elige el usuario: da un **árbol**
//! del Storage Access Framework (`content://…/tree/…`). La parte Java está en
//! `MainActivity` (`pickLibraryTree`, `listLibraryTree`, `releaseLibraryTree`):
//! el selector, porque su resultado llega por `onActivityResult`, que es de la
//! Activity; el listado, porque `DocumentsContract` es API de Java.
//!
//! El permiso persistible se toma sobre el árbol, uno por lugar, y cubre la
//! lectura de todo lo que cuelga de él: los ficheros se importan por
//! referencia con el URI de documento dentro del árbol, como el resto del
//! import por referencia de Android (`import_referenced_audio_uris_to_library`).

#![cfg(target_os = "android")]

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use jni::objects::{JObject, JObjectArray, JString, JValue};
use jni::JavaVM;

/// Quien espera el selector de carpetas ahora mismo. Uno solo: es una
/// actividad del sistema.
static PENDING: Mutex<Option<Sender<String>>> = Mutex::new(None);

/// Igual que los otros selectores: generoso, sólo para no colgar el comando
/// si la actividad del sistema no contesta nunca.
const PICK_TIMEOUT: Duration = Duration::from_secs(600);

/// Marca que `listLibraryTree` devuelve cuando no pudo listar (tiene que
/// coincidir con `MainActivity.kt`).
const LIST_ERROR: &str = "!error";

/// Un hijo de una carpeta del árbol.
#[derive(Debug, Clone)]
pub struct TreeChild {
    pub name: String,
    pub uri: String,
    pub mime: String,
}

/// Abre el selector de carpetas y espera. `None` = canceló, o no se pudo tomar
/// el permiso persistible (un lugar que dejaría de leerse al reiniciar).
pub fn pick_library_tree() -> Result<Option<String>, String> {
    let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
    {
        let mut pending = PENDING
            .lock()
            .map_err(|_| "selector de carpetas en estado inconsistente".to_string())?;
        if pending.is_some() {
            return Err("ya hay un selector de carpetas abierto".to_string());
        }
        *pending = Some(tx);
    }

    if let Err(error) = call_activity("pickLibraryTree") {
        let _ = PENDING.lock().map(|mut pending| pending.take());
        return Err(error);
    }

    match rx.recv_timeout(PICK_TIMEOUT) {
        Ok(uri) if uri.is_empty() => Ok(None),
        Ok(uri) => Ok(Some(uri)),
        Err(_) => {
            let _ = PENDING.lock().map(|mut pending| pending.take());
            Err("el selector de carpetas no respondio".to_string())
        }
    }
}

/// Un nivel de una carpeta del árbol (la raíz del lugar o una subcarpeta).
pub fn list_library_tree(folder_uri: &str) -> Result<Vec<TreeChild>, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let uri = env
        .new_string(folder_uri)
        .map_err(|e| format!("new_string: {e}"))?;
    let result = env.call_method(
        &activity,
        "listLibraryTree",
        "(Ljava/lang/String;)[Ljava/lang/String;",
        &[JValue::Object(&uri)],
    );
    let array = match result.and_then(|value| value.l()) {
        Ok(array) => array,
        Err(error) => {
            super::android_content_uri::clear_pending_exception(&mut env);
            return Err(format!("listLibraryTree: {error}"));
        }
    };
    let array = JObjectArray::from(array);
    let length = env
        .get_array_length(&array)
        .map_err(|e| format!("get_array_length: {e}"))?;
    let mut flat = Vec::with_capacity(length.max(0) as usize);
    for index in 0..length {
        let item = env
            .get_object_array_element(&array, index)
            .map_err(|e| format!("get_object_array_element({index}): {e}"))?;
        let item: JString = item.into();
        let value: String = env
            .get_string(&item)
            .map_err(|e| format!("get_string: {e}"))?
            .into();
        flat.push(value);
    }
    if flat.first().map(String::as_str) == Some(LIST_ERROR) {
        return Err(flat.get(1).cloned().unwrap_or_default());
    }
    Ok(flat
        .chunks_exact(3)
        .map(|chunk| TreeChild {
            name: chunk[0].clone(),
            uri: chunk[1].clone(),
            mime: chunk[2].clone(),
        })
        .collect())
}

/// Suelta el permiso persistible de un lugar que el usuario quitó.
pub fn release_library_tree(tree_uri: &str) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    // Un solo entorno: la cadena es una referencia local suya y deja de valer
    // en cuanto se suelta el hilo.
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let uri = env
        .new_string(tree_uri)
        .map_err(|e| format!("new_string: {e}"))?;
    let result = env
        .call_method(
            &activity,
            "releaseLibraryTree",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&uri)],
        )
        .map(|_| ())
        .map_err(|e| format!("releaseLibraryTree: {e}"));
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}

/// Llama a un método `()V` de la Activity.
fn call_activity(method: &str) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let result = env
        .call_method(&activity, method, "()V", &[])
        .map(|_| ())
        .map_err(|e| format!("{method}: {e}"));
    // Una excepción Java pendiente haría fallar en silencio la siguiente
    // llamada JNI de este hilo (ver android_persistable_pick).
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}

/// Punto de entrada JNI. `MainActivity` lo llama en el hilo de UI con el URI
/// del árbol elegido, o "" si se canceló.
///
/// # Safety
/// La JVM lo llama con punteros `JNIEnv`/`jobject` válidos.
#[no_mangle]
pub unsafe extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnLibraryTreePicked(
    env: *mut jni::sys::JNIEnv,
    _class: *mut std::ffi::c_void,
    uri: jni::sys::jstring,
) {
    let value = read_string(env, uri).unwrap_or_else(|error| {
        eprintln!("[LT_TREE] no se pudo leer el URI elegido: {error}");
        String::new()
    });
    let sender = PENDING.lock().ok().and_then(|mut pending| pending.take());
    match sender {
        Some(sender) => {
            let _ = sender.send(value);
        }
        None => eprintln!("[LT_TREE] resultado sin destinatario, descartado"),
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
    let text: String = env
        .get_string(&value)
        .map_err(|e| format!("get_string: {e}"))?
        .into();
    Ok(text)
}
