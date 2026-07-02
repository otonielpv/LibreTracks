//! Platform shim over the synchronous native file dialogs.
//!
//! Desktop re-exports `rfd::FileDialog` unchanged. Android has no
//! desktop-style modal file dialogs (and `rfd` has no Android backend), so
//! the stub mirrors the subset of the builder API this app uses and answers
//! every pick as if the user cancelled. Mobile file flows should go through
//! `tauri-plugin-dialog` / the Storage Access Framework instead, which will
//! land with the mobile UI work.

#[cfg(not(target_os = "android"))]
pub use rfd::FileDialog;

#[cfg(target_os = "android")]
mod stub {
    use std::path::{Path, PathBuf};

    #[derive(Default)]
    pub struct FileDialog;

    impl FileDialog {
        pub fn new() -> Self {
            Self
        }

        pub fn set_title(self, _title: impl Into<String>) -> Self {
            self
        }

        pub fn set_directory(self, _path: impl AsRef<Path>) -> Self {
            self
        }

        pub fn add_filter(self, _name: impl Into<String>, _extensions: &[impl ToString]) -> Self {
            self
        }

        pub fn set_file_name(self, _file_name: impl Into<String>) -> Self {
            self
        }

        pub fn pick_file(self) -> Option<PathBuf> {
            None
        }

        pub fn pick_files(self) -> Option<Vec<PathBuf>> {
            None
        }

        pub fn save_file(self) -> Option<PathBuf> {
            None
        }
    }
}

#[cfg(target_os = "android")]
pub use stub::FileDialog;
