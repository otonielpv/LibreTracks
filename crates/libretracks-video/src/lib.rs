//! Salida de vídeo de LibreTracks.
//!
//! libmpv se carga **en ejecución** ([`library::load_libmpv`]), nunca se
//! enlaza al compilar: si falta, la app arranca igual y el vídeo aparece
//! desactivado con el motivo. Por eso los tests de este crate corren en la CI
//! sin libmpv instalada; los que necesitan una libmpv real se saltan con un
//! aviso explícito.
//!
//! En Android e iOS el vídeo no se reproduce: [`library::load_libmpv`]
//! devuelve [`VideoError::Unsupported`] sin buscar nada.

pub mod library;
pub mod mpv;

pub use library::{load_libmpv, LoadedLibmpv, LIBMPV_ENV_VAR};
pub use mpv::{Mpv, MpvEvent, MpvLibrary, ObserveAs, PropertyValue};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VideoError {
    /// libmpv could not be loaded; the text says from where and why.
    #[error("libmpv no disponible: {0}")]
    LibraryUnavailable(String),
    /// Video is not played on this platform (mobile).
    #[error("el vídeo solo se reproduce en la versión de escritorio")]
    Unsupported,
    #[error("mpv: {0}")]
    Command(String),
}
