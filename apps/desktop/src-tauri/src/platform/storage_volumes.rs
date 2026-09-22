//! Which storage volume new sessions are written to.
//!
//! La decisión vive aquí, **fuera de `cfg(target_os = "android")`**, a
//! propósito: es la parte que puede equivocarse (elegir un volumen que ya no
//! está y dejar la aplicación apuntando a una ruta muerta), y dentro del `cfg`
//! no habría forma de probarla — `cargo check` de escritorio ni siquiera
//! compila ese código. `android_storage` se queda con lo que sólo se puede
//! hacer hablando con Android: enumerar los volúmenes y mirar el disco.

// Solo Android llama a esto; en los demas sistemas se compila igualmente para
// que los tests de abajo corran en cualquier maquina (ver la cabecera).
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// El volumen que toca usar, dado lo que el usuario eligió.
///
/// `selected` es la ruta absoluta guardada en los ajustes; `None` o vacío
/// significa «el primario», que es lo que tenía todo el mundo antes de que
/// esto fuera configurable. `usable` contesta si se puede escribir ahí **ahora
/// mismo** (la tarjeta se puede haber sacado entre el arranque y este momento).
///
/// Orden de preferencia:
///
/// 1. El volumen elegido, si sigue en la lista y es usable.
/// 2. El primero de la lista que sea usable. **Degrada, no falla**: una tarjeta
///    que se ha quedado en casa no puede impedir abrir la aplicación cinco
///    minutos antes de tocar.
/// 3. `None`, y quien llama se queda con el almacenamiento interno.
pub fn pick_volume<'a, F>(
    volumes: &'a [PathBuf],
    selected: Option<&str>,
    usable: F,
) -> Option<&'a PathBuf>
where
    F: Fn(&Path) -> bool,
{
    if let Some(selected) = selected.filter(|value| !value.is_empty()) {
        if let Some(dir) = volumes
            .iter()
            .find(|dir| dir.as_os_str() == selected && usable(dir))
        {
            return Some(dir);
        }
    }
    volumes.iter().find(|dir| usable(dir))
}

/// ¿El volumen elegido es el que se está usando de verdad?
///
/// `false` es lo que hace que la interfaz pueda decir «la tarjeta no está, se
/// está guardando en la memoria interna» en vez de mentir sobre dónde aterriza
/// lo que el usuario acaba de crear.
pub fn selected_is_available<F>(volumes: &[PathBuf], selected: Option<&str>, usable: F) -> bool
where
    F: Fn(&Path) -> bool,
{
    match selected.filter(|value| !value.is_empty()) {
        None => true,
        Some(selected) => volumes
            .iter()
            .any(|dir| dir.as_os_str() == selected && usable(dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volumes() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/storage/emulated/0/Android/data/app/files"),
            PathBuf::from("/storage/1A2B-3C4D/Android/data/app/files"),
        ]
    }

    fn all_usable(_: &Path) -> bool {
        true
    }

    fn card_is_gone(dir: &Path) -> bool {
        !dir.to_string_lossy().contains("1A2B-3C4D")
    }

    #[test]
    fn no_choice_means_the_primary_volume() {
        let volumes = volumes();
        assert_eq!(pick_volume(&volumes, None, all_usable), Some(&volumes[0]));
        // Una cadena vacía es lo mismo que no haber elegido: es lo que manda
        // el desplegable cuando el usuario vuelve a "Memoria interna".
        assert_eq!(
            pick_volume(&volumes, Some(""), all_usable),
            Some(&volumes[0])
        );
    }

    #[test]
    fn the_chosen_card_wins_while_it_is_there() {
        let volumes = volumes();
        let card = volumes[1].to_string_lossy().into_owned();
        assert_eq!(
            pick_volume(&volumes, Some(&card), all_usable),
            Some(&volumes[1])
        );
        assert!(selected_is_available(&volumes, Some(&card), all_usable));
    }

    /// El criterio del paso: sacar la tarjeta NO puede tumbar la aplicación.
    #[test]
    fn pulling_the_card_degrades_to_the_primary_volume() {
        let volumes = volumes();
        let card = volumes[1].to_string_lossy().into_owned();

        assert_eq!(
            pick_volume(&volumes, Some(&card), card_is_gone),
            Some(&volumes[0]),
            "con la tarjeta fuera hay que caer al primario, no devolver la ruta muerta"
        );
        assert!(
            !selected_is_available(&volumes, Some(&card), card_is_gone),
            "y hay que poder DECIRLO, no degradar en silencio"
        );
    }

    /// Y si Android ya ni siquiera la lista (desmontada al arrancar), igual.
    #[test]
    fn a_volume_android_no_longer_lists_degrades_too() {
        let volumes = vec![PathBuf::from("/storage/emulated/0/Android/data/app/files")];
        let card = "/storage/1A2B-3C4D/Android/data/app/files";

        assert_eq!(
            pick_volume(&volumes, Some(card), all_usable),
            Some(&volumes[0])
        );
        assert!(!selected_is_available(&volumes, Some(card), all_usable));
    }

    /// Sin volúmenes (todo desmontado, o no es Android) quien llama se queda
    /// con el almacenamiento interno, que es lo que hacía antes de esto.
    #[test]
    fn no_volumes_at_all_is_not_an_error() {
        assert_eq!(pick_volume(&[], None, all_usable), None);
        assert_eq!(pick_volume(&[], Some("/whatever"), all_usable), None);
        assert!(selected_is_available(&[], None, all_usable));
    }
}
