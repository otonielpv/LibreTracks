use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Failed to create engine instance")]
    CreateFailed,
    #[error("Invalid engine handle")]
    InvalidHandle,
    #[error("Engine already initialized")]
    AlreadyInitialized,
    #[error("Engine not initialized")]
    NotInitialized,
    #[error("Invalid or unknown command")]
    InvalidCommand,
    #[error("Audio device error: {0}")]
    Device(String),
    #[error("Snapshot unavailable")]
    SnapshotFailed,
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("Internal engine error: {0}")]
    Internal(String),
}
