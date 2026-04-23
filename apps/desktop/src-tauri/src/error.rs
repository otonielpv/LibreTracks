use libretracks_audio::AudioEngineError;
use libretracks_project::ProjectError;

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("transport state is unavailable")]
    StatePoisoned,
    #[error("no song is loaded")]
    NoSongLoaded,
    #[error("audio thread is unavailable")]
    AudioThreadUnavailable,
    #[error("audio command failed: {0}")]
    AudioCommand(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("project error: {0}")]
    Project(#[from] ProjectError),
    #[error("audio engine error: {0}")]
    Audio(#[from] AudioEngineError),
    #[error("clip not found: {0}")]
    ClipNotFound(String),
    #[error("track not found: {0}")]
    TrackNotFound(String),
    #[error("section not found: {0}")]
    SectionNotFound(String),
    #[error("clip range is invalid")]
    InvalidClipRange,
    #[error("track parent is invalid")]
    InvalidTrackParent,
    #[error("clip split point is invalid")]
    InvalidSplitPoint,
}
