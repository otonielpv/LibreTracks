//! Leer un `content://` como si fuera una ruta de fichero.
//!
//! ## El problema, y por qué esta solución y no otra
//!
//! Con import por referencia, la ruta que guarda la sesión en Android es un
//! `content://`. Pero **todo lo que lee audio espera una ruta**: los 26 usos de
//! `resolve_audio_file_path` en Rust, Symphonia al analizar la onda, y sobre
//! todo el motor en C++, que abre con `::open` y con libsndfile desde el hilo
//! de relleno.
//!
//! Hacer que todos entiendan URIs significa una abstracción de fichero en dos
//! lenguajes y ~30 puntos de llamada, uno de ellos en el camino que alimenta al
//! hilo de audio. Aquí se hace otra cosa:
//!
//! **Se abre el `content://` una vez, se queda el descriptor vivo, y se entrega
//! `/proc/self/fd/<n>`, que es una ruta que cualquiera puede abrir.** Android es
//! Linux; `/proc/self/fd/N` es un enlace al fichero que hay detrás del
//! descriptor y `open()` lo sigue. Ni el motor ni Symphonia se enteran de nada.
//!
//! ## Lo que esto NO cubre, y por eso hay una sonda
//!
//! Un proveedor virtualizado (Drive, «Recientes», «Descargas») no entrega un
//! fichero: entrega una tubería. Una tubería no se puede buscar, y el motor lee
//! bloques arbitrarios con `sf_seek`, así que reproduciría la cabeza y luego se
//! entrecortaría.
//!
//! Por eso [`probe_referenceable`] existe y por eso se llama **al importar**, no
//! al reproducir: si el fichero no se puede leer por este camino, el importador
//! cae al de copia de siempre y el usuario no se entera. Un aparato donde el
//! truco no funcione se comporta como hoy, no como una sesión rota.

#![cfg(target_os = "android")]

use std::collections::HashMap;
use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use jni::objects::{JObject, JValue};
use jni::JavaVM;

/// Descriptores abiertos, por URI.
///
/// Viven lo que vive el proceso: la ruta `/proc/self/fd/N` sólo es válida
/// mientras el descriptor esté abierto, y cerrarlo dejaría al motor leyendo una
/// ruta muerta a mitad de una canción. Son unos pocos descriptores por sesión
/// (uno por fichero distinto), no por clip.
static OPEN_FDS: OnceLock<Mutex<HashMap<String, File>>> = OnceLock::new();

fn open_fds() -> &'static Mutex<HashMap<String, File>> {
    OPEN_FDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Una ruta local que cualquiera puede abrir para leer el contenido de `uri`.
///
/// Devuelve `None` si Android no da el descriptor, que es lo que pasa cuando el
/// permiso persistible se perdió (el usuario revocó el acceso, o el fichero ya
/// no está). Quien llama lo trata como «falta el fichero», que es exactamente
/// lo que es, y el gestor del paso 08 se encarga.
pub fn local_path_for(uri: &str) -> Option<PathBuf> {
    let mut fds = open_fds().lock().ok()?;
    if let Some(file) = fds.get(uri) {
        return Some(proc_path(raw_fd(file)));
    }
    match open_content_fd(uri) {
        Ok(file) => {
            let path = proc_path(raw_fd(&file));
            fds.insert(uri.to_string(), file);
            Some(path)
        }
        Err(error) => {
            eprintln!("[LT_URI] no se pudo abrir {uri}: {error}");
            None
        }
    }
}

/// Suelta el descriptor de `uri`, si lo había.
///
/// Se llama al cerrar la sesión y al borrar un asset: un descriptor abierto
/// mantiene el fichero vivo para el sistema, y acumularlos entre sesiones es
/// una fuga lenta.
pub fn release(uri: &str) {
    if let Ok(mut fds) = open_fds().lock() {
        fds.remove(uri);
    }
}

/// Suelta todos. Al cerrar la sesión.
pub fn release_all() {
    if let Ok(mut fds) = open_fds().lock() {
        fds.clear();
    }
}

/// ¿Se puede REFERENCIAR este `content://`, o hay que copiarlo?
///
/// Comprueba dos cosas, y las dos importan:
///
/// 1. Que Android entregue un descriptor (el permiso persistible funciona).
/// 2. Que ese descriptor se pueda **buscar** y **reabrir por `/proc/self/fd`**.
///    Un proveedor virtualizado entrega una tubería, y el motor lee bloques
///    arbitrarios: con una tubería sonaría la cabeza y luego se entrecortaría.
///
/// Se llama **al importar**. Es lo que hace que un aparato donde el truco no
/// funcione se comporte como hoy —copiando— en vez de crear sesiones rotas.
pub fn probe_referenceable(uri: &str) -> bool {
    let Some(path) = local_path_for(uri) else {
        return false;
    };
    // Reabrir por la ruta de /proc es justo lo que hará el motor. Si esto
    // falla, referenciar no vale.
    let Ok(mut probe) = File::open(&path) else {
        eprintln!("[LT_URI] {uri}: /proc/self/fd no se puede reabrir");
        release(uri);
        return false;
    };
    // Y tiene que poder buscar: leer bloques sueltos es el caso normal.
    use std::io::{Read, Seek, SeekFrom};
    let mut header = [0u8; 16];
    let readable = probe.read(&mut header).is_ok()
        && probe.seek(SeekFrom::Start(0)).is_ok()
        && probe.seek(SeekFrom::End(0)).map(|size| size > 0).unwrap_or(false);
    if !readable {
        eprintln!("[LT_URI] {uri}: el descriptor no es buscable (proveedor virtual?)");
        release(uri);
        return false;
    }
    true
}

/// Limpia una excepción Java que haya quedado pendiente en este hilo.
///
/// jni-rs devuelve `Err` cuando el método llamado lanza, pero **no** limpia la
/// excepción: se queda pendiente, y con ella pendiente cualquier otra llamada
/// JNI del mismo hilo falla o aborta. Aquí eso importa más que en ningún sitio:
/// `openFileDescriptor` lanza `FileNotFoundException` o `SecurityException` en
/// el caso NORMAL de un fichero que el usuario movió o cuyo acceso revocó, y
/// este hilo puede ser el de preparación de audio.
pub(crate) fn clear_pending_exception(env: &mut jni::JNIEnv) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

fn raw_fd(file: &File) -> RawFd {
    use std::os::fd::AsRawFd;
    file.as_raw_fd()
}

fn proc_path(fd: RawFd) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{fd}"))
}

/// `contentResolver.openFileDescriptor(Uri.parse(uri), "r").detachFd()`.
///
/// `detachFd` y no `getFd`: el descriptor pasa a ser nuestro, y lo cierra el
/// `File` al soltarlo. Dejarlo en manos del finalizador del JVM es lo que
/// produjo el cuelgue `ParcelFileDescriptor.finalize() timed out` que ya
/// documenta `mobile_files`.
fn open_content_fd(uri: &str) -> Result<File, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let result = open_content_fd_with(&mut env, &activity, uri);
    // Un fichero movido o un acceso revocado hacen lanzar a
    // `openFileDescriptor`: es el caso normal, no un accidente. Sin limpiar,
    // la excepción envenena el resto de llamadas JNI de este hilo.
    if result.is_err() {
        clear_pending_exception(&mut env);
    }
    result
}

fn open_content_fd_with(
    env: &mut jni::JNIEnv,
    activity: &JObject,
    uri: &str,
) -> Result<File, String> {

    let resolver = env
        .call_method(
            activity,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getContentResolver: {e}"))?;

    let uri_string = env
        .new_string(uri)
        .map_err(|e| format!("new_string: {e}"))?;
    let parsed = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&uri_string)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("Uri.parse: {e}"))?;

    let mode = env.new_string("r").map_err(|e| format!("new_string: {e}"))?;
    let descriptor = env
        .call_method(
            &resolver,
            "openFileDescriptor",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
            &[JValue::Object(&parsed), JValue::Object(&mode)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("openFileDescriptor: {e}"))?;
    if descriptor.is_null() {
        return Err("openFileDescriptor devolvio null".to_string());
    }

    let fd = env
        .call_method(&descriptor, "detachFd", "()I", &[])
        .and_then(|value| value.i())
        .map_err(|e| format!("detachFd: {e}"))?;
    if fd < 0 {
        return Err(format!("detachFd devolvio {fd}"));
    }

    // SAFETY: `detachFd` cede la propiedad del descriptor; el `File` lo cierra.
    Ok(unsafe { File::from_raw_fd(fd as RawFd) })
}
