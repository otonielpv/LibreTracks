//! Salida de vídeo de LibreTracks.
//!
//! libmpv se carga **en ejecución** ([`library::load_libmpv`]), nunca se
//! enlaza al compilar: si falta, la app arranca igual y el vídeo aparece
//! desactivado con el motivo. Por eso los tests de este crate corren en la CI
//! sin libmpv instalada; los que necesitan una libmpv real se saltan con un
//! aviso explícito.
//!
//! En Android e iOS no hay libmpv (plan `video-mobile`, regla 2): todo lo que
//! depende de ella queda fuera de la compilación por plataforma, no por una
//! feature de Cargo. Allí la salida es un [`native::NativeOutputBackend`] que
//! delega en AVPlayer o Media3, y lo común (la salida, los monitores, los
//! ajustes, el formato `.ltthumbs`) es el mismo código que en escritorio.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod audio;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod extract;
pub mod mac_geometry;
pub mod media;
pub mod monitors;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod mpv_backend;
pub mod native;
pub mod output;
pub mod remote_clock;
pub mod settings;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod library;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod mpv;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod render;
#[cfg(windows)]
pub mod surface_win32;
#[cfg(target_os = "macos")]
pub mod surface_macos;
pub mod thumbs;

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) mod test_support;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use library::{load_libmpv, LoadedLibmpv, LIBMPV_ENV_VAR};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
