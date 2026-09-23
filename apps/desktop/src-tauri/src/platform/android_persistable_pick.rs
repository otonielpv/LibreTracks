//! Selector de audio de Android con permiso **persistible**.
//!
//! ## Por qué existe, si ya hay un selector
//!
//! `tauri-plugin-dialog` 2.7.0 abre con `Intent.ACTION_GET_CONTENT` (su propio
//! fuente lleva un `// TODO: ACTION_OPEN_DOCUMENT ??` al lado). Un URI de
//! `GET_CONTENT` viene con un permiso **temporal**, atado a la tarea: llamar a
//! `takePersistableUriPermission` sobre él lanza `SecurityException`, y en
//! cuanto el proceso se reinicia la aplicación deja de poder leer el fichero.
//!
//! Para importar **por referencia** hace falta exactamente lo contrario: un
//! permiso que sobreviva a reiniciar el teléfono. Eso es `ACTION_OPEN_DOCUMENT`
//! con `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` y después tomarlo de verdad. Es
//! el equivalente de los marcadores de seguridad que iOS ya guarda en
//! `IosFolderPickerPlugin.swift`.
//!
//! ## Cómo viaja el resultado
//!
//! La parte de Java está en `MainActivity.pickPersistableAudioDocuments`,
//! porque el resultado llega por `onActivityResult`, que es de la Activity.
//! Vuelve por `nativeOnAudioDocumentsPicked`, el mismo camino Kotlin → Rust que
//! ya usa `android_memory`. Aquí se espera en un canal.
//!
//! **Sólo devuelve los URIs cuyo permiso persistible se tomó.** Uno que no lo
//! consiguió no sirve para referenciar, y devolverlo crearía una sesión que
//! deja de sonar mañana; el llamante cae al camino de copia de siempre.

#![cfg(target_os = "android")]

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use jni::objects::{JObject, JObjectArray, JString};
use jni::JavaVM;

/// Quien espera el resultado del selector ahora mismo.
///
/// Uno solo: el selector es una actividad del sistema, así que no puede haber
/// dos abiertos a la vez. Si llegara un resultado sin nadie esperando (la
/// actividad se recreó mientras tanto), se descarta.
static PENDING: Mutex<Option<Sender<Vec<String>>>> = Mutex::new(None);

/// Cuánto se espera al usuario antes de rendirse.
///
/// Generoso a propósito: el usuario puede estar navegando por sus carpetas, o
/// haber dejado el teléfono encima de la mesa. Lo que evita es que un fallo del
/// selector deje el comando de Tauri colgado para siempre.
const PICK_TIMEOUT: Duration = Duration::from_secs(600);

/// Abre el selector y espera. `Vec` vacío = canceló, o ningún URI consiguió
/// permiso persistible.
///
/// Bloquea, como el resto de los selectores de `mobile_files`: los comandos de
/// Tauri nunca corren en el hilo de UI de Android, y el resultado de la
/// actividad llega justamente en ese hilo, que queda libre.
pub fn pick_persistable_audio_documents() -> Result<Vec<String>, String> {
    let (tx, rx): (Sender<Vec<String>>, Receiver<Vec<String>>) = mpsc::channel();
    {
        let mut pending = PENDING
            .lock()
            .map_err(|_| "selector de audio en estado inconsistente".to_string())?;
        if pending.is_some() {
            return Err("ya hay un selector de archivos abierto".to_string());
        }
        *pending = Some(tx);
    }

    if let Err(error) = start_picker() {
        let _ = PENDING.lock().map(|mut pending| pending.take());
        return Err(error);
    }

    match rx.recv_timeout(PICK_TIMEOUT) {
        Ok(uris) => Ok(uris),
        Err(_) => {
            let _ = PENDING.lock().map(|mut pending| pending.take());
            Err("el selector de archivos no respondio".to_string())
        }
    }
}

fn start_picker() -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    let result = env
        .call_method(&activity, "pickPersistableAudioDocuments", "()V", &[])
        .map(|_| ())
        .map_err(|e| format!("pickPersistableAudioDocuments: {e}"));
    // Si Java lanzó (un `NoSuchMethodError` porque R8 borró el método, por
    // ejemplo), la excepción se queda PENDIENTE en este hilo: jni-rs devuelve
    // el error pero no la limpia. Cualquier llamada JNI posterior en el mismo
    // hilo —la del selector de respaldo, sin ir más lejos— falla entonces en
    // silencio, y el import se quedaba sin hacer nada. Limpiarla es lo que
    // convierte un fallo aquí en «usa el selector de siempre».
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}

/// Punto de entrada JNI. Lo llama `MainActivity.onActivityResult` en el hilo de
/// UI, así que sólo copia cadenas y despierta al que espera.
///
/// # Safety
/// La JVM lo llama con punteros `JNIEnv`/`jobject` válidos.
#[no_mangle]
pub unsafe extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnAudioDocumentsPicked(
    env: *mut jni::sys::JNIEnv,
    _class: *mut std::ffi::c_void,
    uris: jni::sys::jobjectArray,
) {
    let picked = read_uri_array(env, uris).unwrap_or_else(|error| {
        eprintln!("[LT_PICK] no se pudieron leer los URIs elegidos: {error}");
        Vec::new()
    });
    eprintln!("[LT_PICK] {} documento(s) con permiso persistible", picked.len());

    let sender = PENDING.lock().ok().and_then(|mut pending| pending.take());
    match sender {
        Some(sender) => {
            let _ = sender.send(picked);
        }
        // Nadie espera: la actividad se recreó mientras el selector estaba
        // abierto. Descartar es lo correcto; el usuario vuelve a pulsar.
        None => eprintln!("[LT_PICK] resultado sin destinatario, descartado"),
    }
}

unsafe fn read_uri_array(
    env: *mut jni::sys::JNIEnv,
    uris: jni::sys::jobjectArray,
) -> Result<Vec<String>, String> {
    if uris.is_null() {
        return Ok(Vec::new());
    }
    let mut env = jni::JNIEnv::from_raw(env).map_err(|e| format!("JNIEnv::from_raw: {e}"))?;
    let array = JObjectArray::from_raw(uris);
    let length = env
        .get_array_length(&array)
        .map_err(|e| format!("get_array_length: {e}"))?;

    let mut out = Vec::with_capacity(length.max(0) as usize);
    for index in 0..length {
        let item = env
            .get_object_array_element(&array, index)
            .map_err(|e| format!("get_object_array_element({index}): {e}"))?;
        if item.is_null() {
            continue;
        }
        let item: JString = item.into();
        let value = env
            .get_string(&item)
            .map_err(|e| format!("get_string: {e}"))?
            .to_string_lossy()
            .into_owned();
        if !value.is_empty() {
            out.push(value);
        }
    }
    Ok(out)
}
