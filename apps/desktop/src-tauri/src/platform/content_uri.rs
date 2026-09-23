//! Rutas de asset que son un `content://` de Android.
//!
//! Compilado en **todos** los sistemas a propósito, igual que
//! `storage_volumes`: reconocer la forma de una ruta es la parte que puede
//! equivocarse, y detrás de un `cfg(target_os = "android")` no la mira ningún
//! `cargo check` ni ningún test de escritorio. Lo que sí es de Android —hablar
//! con el `ContentResolver`— vive en `android_content_uri`.
//!
//! ## Por qué importa la distinción
//!
//! Cuando Android importa **por referencia**, la ruta que guarda la sesión es
//! un `content://`, no una ruta de sistema de ficheros. Eso choca con dos
//! decisiones que el resto del programa ya tenía tomadas:
//!
//! 1. `resolve_audio_file_path` resuelve una ruta **relativa** contra la
//!    carpeta de la sesión y deja pasar la **absoluta**. Un `content://` no es
//!    ninguna de las dos.
//! 2. `library.rs` decide si borrar los bytes al borrar un asset mirando
//!    justamente si la ruta es absoluta: lo relativo es de la sesión y se
//!    borra, lo absoluto es del usuario y no se toca. **Un `content://` es del
//!    usuario**, así que tiene que contar como externo o borrar una pista le
//!    borraría un fichero suyo.

/// Esquema de los URIs del `ContentResolver` de Android.
const CONTENT_SCHEME: &str = "content://";

/// ¿Esta ruta de asset es un `content://`?
///
/// Comparación sin distinguir mayúsculas porque el esquema de un URI no las
/// distingue (RFC 3986), y un proveedor podría devolver `CONTENT://`.
pub fn is_content_uri(path: &str) -> bool {
    path.len() > CONTENT_SCHEME.len()
        && path[..CONTENT_SCHEME.len()].eq_ignore_ascii_case(CONTENT_SCHEME)
}

/// ¿Esta ruta apunta a algo de FUERA de la sesión?
///
/// Las dos formas que lo son: una ruta absoluta de siempre (lo que registra
/// escritorio al importar por referencia) y un `content://` (lo que registra
/// Android). Lo demás es relativo a la carpeta de la sesión, o sea una copia
/// que la sesión posee.
///
/// **Es la pregunta que decide si borrar bytes.** Que esté aquí y no repetida
/// en cada llamante es justo lo que evita que el siguiente formato de ruta que
/// aparezca se cuele por un sitio y no por otro.
pub fn is_external_audio_path(path: &str) -> bool {
    is_content_uri(path) || is_absolute_on_any_platform(path)
}

/// ¿Es absoluta esta ruta, la mire quien la mire?
///
/// **No vale `Path::is_absolute`**, y el motivo es una sesión que viaja. Ese
/// método responde según el sistema que pregunta: en Windows,
/// `Path::new("/storage/emulated/0/Music/voz.wav").is_absolute()` es `false`,
/// porque a Windows le falta la letra de unidad.
///
/// Un `.ltset` exportado desde Android y abierto en Windows lleva exactamente
/// esas rutas. Con la comprobación del sistema anfitrión, borrar esa pista en
/// el portátil se leería como «es una copia de la sesión» e intentaría borrar
/// bytes. Por eso se reconocen las dos formas en todas partes.
fn is_absolute_on_any_platform(path: &str) -> bool {
    // POSIX, y UNC de Windows (que también empieza por separador).
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    // Letra de unidad de Windows: `C:\…` o `C:/…`.
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    std::path::Path::new(path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_a_content_uri() {
        assert!(is_content_uri(
            "content://com.android.externalstorage.documents/document/primary%3AMusic%2Fvoz.wav"
        ));
        // El esquema de un URI no distingue mayusculas.
        assert!(is_content_uri("CONTENT://x/y"));
    }

    #[test]
    fn everything_else_is_not_one() {
        assert!(!is_content_uri("audio/voz.wav"));
        assert!(!is_content_uri("/storage/emulated/0/Music/voz.wav"));
        assert!(!is_content_uri("C:/Users/yo/Music/voz.wav"));
        assert!(!is_content_uri("content://"));
        assert!(!is_content_uri(""));
        // Un fichero que EMPIEZA por "content" no es un URI.
        assert!(!is_content_uri("contenido/voz.wav"));
    }

    /// El criterio que impide borrarle un fichero al usuario.
    #[test]
    fn audio_from_outside_the_session_is_never_the_sessions_to_delete() {
        assert!(is_external_audio_path(
            "content://com.android.externalstorage.documents/document/primary%3Avoz.wav"
        ));

        // Lo de dentro: una copia que la sesion posee, y por tanto suya.
        assert!(!is_external_audio_path("audio/voz.wav"));
        assert!(!is_external_audio_path("audio\\voz.wav"));
    }

    /// La razon de no usar `Path::is_absolute`: una sesion que viaja.
    ///
    /// Un `.ltset` exportado desde Android lleva rutas `/storage/...`, y en
    /// Windows `Path::is_absolute` dice que NO son absolutas porque les falta
    /// la letra de unidad. Con esa comprobacion, borrar esa pista en el
    /// portatil se leeria como "es una copia de la sesion" e intentaria borrar
    /// bytes. Y al reves con una ruta de Windows leida en Linux.
    #[test]
    fn a_path_from_another_platform_is_still_external() {
        // De Android o de macOS, leida donde sea.
        assert!(is_external_audio_path("/storage/emulated/0/Music/voz.wav"));
        assert!(is_external_audio_path("/Users/yo/Music/voz.wav"));
        // De Windows, leida donde sea.
        assert!(is_external_audio_path("C:\\Users\\yo\\Music\\voz.wav"));
        assert!(is_external_audio_path("D:/multitracks/voz.wav"));
        // UNC.
        assert!(is_external_audio_path("\\\\servidor\\musica\\voz.wav"));

        // Y lo relativo sigue siendo relativo en todas partes.
        assert!(!is_external_audio_path("audio/voz.wav"));
        assert!(!is_external_audio_path("C"));
        assert!(!is_external_audio_path("C:"));
    }
}
