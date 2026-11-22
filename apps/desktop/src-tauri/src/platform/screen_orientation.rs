//! Girar la pantalla del teléfono mientras está abierto un menú de escribir
//! texto (plan `docs/plans/portrait-text-modals`).
//!
//! La app va bloqueada en horizontal. Los menús de letra, acordes y
//! sincronización con proyección piden `portrait` al abrirse y `landscape` al
//! cerrarse (hook `usePortraitWhileOpen` del frontend, que solo lo llama en
//! teléfonos). Con la letra y acordes a pantalla completa se pide `free`: el
//! móvil gira con el sensor, sin forzar nada. En escritorio no hace nada.
//!
//! Compilado en todos los sistemas a propósito: el parseo del modo es lo único
//! que puede equivocarse fuera del código nativo, y tras un `cfg` no lo miraría
//! ningún test de escritorio.

use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenOrientation {
    Portrait,
    Landscape,
    /// Sigue al sensor: vertical u horizontal según se sostenga el móvil.
    Free,
}

impl FromStr for ScreenOrientation {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "portrait" => Ok(Self::Portrait),
            "landscape" => Ok(Self::Landscape),
            "free" => Ok(Self::Free),
            other => Err(format!("orientacion desconocida: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_two_modes_the_frontend_sends() {
        assert_eq!(
            "portrait".parse::<ScreenOrientation>(),
            Ok(ScreenOrientation::Portrait)
        );
        assert_eq!(
            "landscape".parse::<ScreenOrientation>(),
            Ok(ScreenOrientation::Landscape)
        );
        assert_eq!("free".parse::<ScreenOrientation>(), Ok(ScreenOrientation::Free));
    }

    #[test]
    fn rejects_anything_else() {
        assert!("Portrait".parse::<ScreenOrientation>().is_err());
        assert!("sensor".parse::<ScreenOrientation>().is_err());
        assert!("".parse::<ScreenOrientation>().is_err());
    }
}
