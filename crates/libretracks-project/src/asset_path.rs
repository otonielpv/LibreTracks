//! De la ruta que guarda la sesión al fichero que hay que abrir.
//!
//! Una sesión guarda la ruta de su audio de tres formas, y hasta ahora cada
//! sitio que necesitaba abrirlo repetía la misma decisión a mano
//! (`is_absolute()` ? tal cual : `song_dir.join(…)`): el análisis de ondas, el
//! export de `.ltpkg` y el de `.ltset`, cada uno con su copia.
//!
//! - **relativa** (`audio/voz.wav`) — una copia que la sesión posee.
//! - **absoluta** — el original del usuario, referenciado. Escritorio e iOS lo
//!   hacen desde siempre.
//! - **`content://`** — el original del usuario en Android, referenciado. **No
//!   es una ruta**: hay que pedirle el descriptor al `ContentResolver`, y eso
//!   sólo lo sabe hacer el crate de la aplicación, que es el que tiene la JVM.
//!
//! De ahí el gancho: este crate no puede resolver la tercera forma por su
//! cuenta, así que deja que se la resuelvan. Sin gancho instalado —escritorio,
//! iOS, y cualquier test— se comporta exactamente como antes.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Cómo abrir una ruta que este crate no sabe interpretar.
///
/// Devuelve la ruta local que sí se puede abrir y el **nombre visible** del
/// fichero. El nombre va aparte a propósito: la ruta local de un `content://`
/// es `/proc/self/fd/7`, y usar su `file_name()` metería un fichero llamado
/// `7` dentro del `.ltset` exportado.
///
/// `None` si esa ruta no es de las suyas, o si ya no se puede abrir.
pub type AssetPathResolver = fn(&str) -> Option<(PathBuf, String)>;

static RESOLVER: OnceLock<AssetPathResolver> = OnceLock::new();

/// Instala el gancho. Una sola vez, al arrancar; las siguientes se ignoran.
pub fn set_asset_path_resolver(resolver: AssetPathResolver) {
    let _ = RESOLVER.set(resolver);
}

/// Dónde está de verdad el audio de `stored_path`, y cómo se llama.
///
/// El nombre visible es el del fichero salvo que el gancho diga otro, que es
/// el caso de un `content://`.
pub fn resolve_asset(song_dir: &Path, stored_path: &str) -> (PathBuf, String) {
    if let Some(resolver) = RESOLVER.get() {
        if let Some((path, display_name)) = resolver(stored_path) {
            return (path, display_name);
        }
    }
    let path = resolve_asset_path(song_dir, stored_path);
    let display_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(stored_path)
        .to_string();
    (path, display_name)
}

/// El camino inverso: de una ruta YA resuelta a lo que la identifica de forma
/// estable, y su nombre visible sin extensión.
///
/// Existe por las cachés que se indexan por ruta. La ruta local de un
/// `content://` es `/proc/self/fd/206`, y **ese número cambia en cada
/// arranque**: una caché con esa clave falla siempre, y en el teléfono eso era
/// volver a analizar todas las ondas cada vez que se abría la sesión.
///
/// `None` si la ruta no es de las del gancho: entonces la propia ruta ya es
/// estable.
pub type AssetIdentityResolver = fn(&Path) -> Option<(String, String)>;

static IDENTITY_RESOLVER: OnceLock<AssetIdentityResolver> = OnceLock::new();

/// Instala el gancho inverso. Una sola vez, al arrancar.
pub fn set_asset_identity_resolver(resolver: AssetIdentityResolver) {
    let _ = IDENTITY_RESOLVER.set(resolver);
}

/// Identidad estable de `resolved_path` (clave) y su nombre sin extensión
/// (para nombres de fichero legibles en la caché).
pub fn stable_asset_identity(resolved_path: &Path) -> (String, String) {
    if let Some(resolver) = IDENTITY_RESOLVER.get() {
        if let Some(identity) = resolver(resolved_path) {
            return identity;
        }
    }
    let stem = resolved_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("waveform")
        .to_string();
    (resolved_path.to_string_lossy().into_owned(), stem)
}

/// Sólo la ruta. Para quien no necesita el nombre visible.
pub fn resolve_asset_path(song_dir: &Path, stored_path: &str) -> PathBuf {
    if let Some(resolver) = RESOLVER.get() {
        if let Some((path, _)) = resolver(stored_path) {
            return path;
        }
    }
    let path = Path::new(stored_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_hangs_from_the_session_folder() {
        let song_dir = Path::new("/sesiones/Domingo");
        assert_eq!(
            resolve_asset_path(song_dir, "audio/voz.wav"),
            song_dir.join("audio/voz.wav")
        );
    }

    #[test]
    fn an_absolute_path_is_left_alone() {
        let song_dir = Path::new("/sesiones/Domingo");
        let absolute = if cfg!(windows) {
            "C:\\Multitracks\\voz.wav"
        } else {
            "/Multitracks/voz.wav"
        };
        assert_eq!(
            resolve_asset_path(song_dir, absolute),
            PathBuf::from(absolute)
        );
    }

    /// Sin gancho —escritorio, iOS y todos los tests— el nombre visible sale de
    /// la propia ruta, como salía antes de que el gancho existiera.
    #[test]
    fn the_display_name_comes_from_the_path_when_nothing_is_hooked() {
        let (_, name) = resolve_asset(Path::new("/sesiones/Domingo"), "audio/voz.wav");
        assert_eq!(name, "voz.wav");
    }
}
