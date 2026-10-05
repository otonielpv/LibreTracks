//! Rutas guardadas que apuntan a un contenedor de iOS que ya no existe.
//!
//! iOS mete cada app en `/var/mobile/Containers/Data/Application/<UUID>/`, y
//! ese UUID cambia al actualizar o reinstalar. Una ruta absoluta guardada en
//! recientes (`…/<UUID viejo>/Documents/Sesion/Sesion.ltsession`) deja entonces
//! de existir aunque la sesión siga ahí, bajo el UUID nuevo. Sin traducirla,
//! «Borrar» no encontraba nada, daba por bueno el borrado y sólo quitaba la
//! entrada de la lista, mientras el aviso juraba que eliminaba el proyecto.
//!
//! Compilado en todos los sistemas, como `content_uri`: la lógica que decide
//! qué carpeta se borra no puede quedar detrás de un `cfg` que ningún test ve.

use std::path::{Component, Path, PathBuf};

/// La misma ruta, pero dentro del contenedor `current_home`. `None` si `path`
/// no está dentro de un contenedor de datos de app de iOS.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn rebase_onto_container(path: &Path, current_home: &Path) -> Option<PathBuf> {
    let parts: Vec<Component<'_>> = path.components().collect();
    let at = parts.windows(3).position(|window| {
        window[0].as_os_str() == "Data"
            && window[1].as_os_str() == "Application"
            && is_uuid(&window[2].as_os_str().to_string_lossy())
    })?;
    let mut rebased = current_home.to_path_buf();
    for part in &parts[at + 3..] {
        rebased.push(part.as_os_str());
    }
    Some(rebased)
}

/// Where `path` lives now: itself if it exists, else (iOS) the same place
/// inside the current app container, if THAT exists.
pub fn current_location(path: &Path) -> PathBuf {
    if path.exists() {
        return path.to_path_buf();
    }
    #[cfg(target_os = "ios")]
    if let Some(home) = std::env::var_os("HOME") {
        if let Some(rebased) = rebase_onto_container(path, Path::new(&home)) {
            if rebased.exists() {
                return rebased;
            }
        }
    }
    path.to_path_buf()
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "/private/var/mobile/Containers/Data/Application/0A1B2C3D-0000-4000-8000-00000000AAAA";
    const NEW: &str = "/var/mobile/Containers/Data/Application/9F8E7D6C-1111-4111-8111-11111111BBBB";

    #[test]
    fn a_session_in_an_old_container_moves_to_the_current_one() {
        let saved = Path::new(OLD).join("Documents/Sunday/Sunday.ltsession");
        assert_eq!(
            rebase_onto_container(&saved, Path::new(NEW)),
            Some(Path::new(NEW).join("Documents/Sunday/Sunday.ltsession"))
        );
    }

    #[test]
    fn a_path_outside_an_app_container_is_left_alone() {
        // iCloud Drive / another provider: not ours to rewrite.
        let icloud = Path::new("/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/S/S.ltsession");
        assert_eq!(rebase_onto_container(icloud, Path::new(NEW)), None);
        // "Application" followed by something that is not a container id.
        let odd = Path::new("/Users/me/Data/Application/notes/S.ltsession");
        assert_eq!(rebase_onto_container(odd, Path::new(NEW)), None);
    }

    #[test]
    fn an_existing_path_is_its_own_current_location() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(current_location(dir.path()), dir.path());
    }
}
