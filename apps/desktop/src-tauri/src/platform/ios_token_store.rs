//! iOS implementation of the cloud [`TokenStore`], over the native plugin.
//!
//! The desktop builds keep the Google refresh token in the OS credential store
//! through the `keyring` crate, which has no iOS backend. Here it goes into the
//! iOS keychain, reached through the Swift side of
//! `libretracks-ios-folder-picker` — the plugin already exists for the document
//! picker, and adding a second one would mean duplicating its whole Swift
//! package for three functions.
//!
//! The token is stored `kSecAttrAccessibleAfterFirstUnlock`, not
//! `WhenUnlocked`: a set can still be uploading with the screen locked, and the
//! token has to be refreshable while that happens.

#![cfg(target_os = "ios")]

use tauri::AppHandle;

use libretracks_cloud::token::{StoredToken, TokenStore};
use libretracks_cloud::CloudError;

pub struct IosTokenStore {
    app: AppHandle,
    /// Entry name, so a second provider later does not collide with Google's.
    name: String,
}

impl IosTokenStore {
    pub fn new(app: AppHandle, provider: &str) -> Self {
        Self {
            app,
            name: provider.to_string(),
        }
    }

    pub fn google_drive(app: AppHandle) -> Self {
        Self::new(app, "google-drive")
    }
}

impl TokenStore for IosTokenStore {
    fn load(&self) -> Result<Option<StoredToken>, CloudError> {
        let raw = libretracks_ios_folder_picker::secure_store_get(&self.app, &self.name)
            .map_err(CloudError::Network)?;

        // Same rule as every other platform: a blob that will not parse is from
        // an older shape or is corrupt, and asking for a fresh sign-in beats
        // leaving the user with an error they cannot clear from inside the app.
        Ok(raw.and_then(|text| serde_json::from_str(&text).ok()))
    }

    fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
        let payload =
            serde_json::to_string(token).map_err(|e| CloudError::Network(e.to_string()))?;
        libretracks_ios_folder_picker::secure_store_set(&self.app, &self.name, &payload)
            .map_err(CloudError::Network)
    }

    fn clear(&self) -> Result<(), CloudError> {
        libretracks_ios_folder_picker::secure_store_delete(&self.app, &self.name)
            .map_err(CloudError::Network)
    }
}
