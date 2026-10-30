//! Which cloud providers exist, and everything the app needs to pick one.
//!
//! The desktop crate cannot run tests, so the mapping from "the string the
//! frontend sent" to "this OAuth flow, this storage client, this keychain
//! entry" lives here where it can be checked.

use std::sync::Arc;

use crate::dropbox::client::DropboxClient;
use crate::dropbox::oauth::DropboxOAuth;
use crate::google::drive::DriveClient;
use crate::google::oauth::GoogleOAuth;
use crate::oauth::{AuthSession, OAuthProvider, OauthError};
use crate::onedrive::client::OneDriveClient;
use crate::onedrive::oauth::OneDriveOAuth;
use crate::{AccessTokens, CloudError, CloudStorage};

/// One of the accounts a user can connect. Several may be connected at once:
/// someone whose Drive is full of Gmail keeps it for songs and sends the big
/// sessions to Dropbox, without disconnecting anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CloudProvider {
    GoogleDrive,
    OneDrive,
    Dropbox,
}

impl CloudProvider {
    /// In the order the UI lists them.
    pub const ALL: [CloudProvider; 3] = [
        CloudProvider::GoogleDrive,
        CloudProvider::OneDrive,
        CloudProvider::Dropbox,
    ];

    /// Stable identifier: what the frontend sends, and the name of the entry
    /// in the OS credential store.
    ///
    /// Never change one. `google-drive` predates this enum and is the key the
    /// existing installs keep their token under; renaming it would silently
    /// sign every Drive user out.
    pub fn key(self) -> &'static str {
        match self {
            CloudProvider::GoogleDrive => "google-drive",
            CloudProvider::OneDrive => "onedrive",
            CloudProvider::Dropbox => "dropbox",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.key() == key)
    }

    /// Product name, shown to the user as is.
    pub fn display_name(self) -> &'static str {
        match self {
            CloudProvider::GoogleDrive => "Google Drive",
            CloudProvider::OneDrive => "OneDrive",
            CloudProvider::Dropbox => "Dropbox",
        }
    }

    /// Whether this build carries what the provider needs to sign in.
    ///
    /// Checked before any browser opens. Google's desktop client needs a
    /// secret despite documenting it as optional, and OneDrive and Dropbox
    /// need their client ids; all three are build inputs, so a clone built
    /// without them legitimately lacks them. Discovering that after the user
    /// already granted access is the outcome this exists to prevent.
    pub fn is_configured(self) -> bool {
        match self {
            CloudProvider::GoogleDrive => {
                cfg!(any(target_os = "android", target_os = "ios"))
                    || crate::google::client_config::CLIENT_SECRET.is_some()
            }
            // On mobile the sign-in comes back through a private scheme that
            // must be declared in tauri.conf.json (Android) and
            // Info.ios.plist (iOS); see the mobile redirect constants.
            CloudProvider::OneDrive => crate::onedrive::CLIENT_ID.is_some_and(|id| !id.is_empty()),
            CloudProvider::Dropbox => crate::dropbox::APP_KEY.is_some_and(|key| !key.is_empty()),
        }
    }

    pub fn oauth(self) -> Arc<dyn OAuthProvider> {
        match self {
            CloudProvider::GoogleDrive => Arc::new(GoogleOAuth),
            CloudProvider::OneDrive => Arc::new(OneDriveOAuth),
            CloudProvider::Dropbox => Arc::new(DropboxOAuth),
        }
    }

    /// Start a sign-in. `port` is the loopback listener's on desktop and
    /// ignored on mobile.
    pub fn begin_sign_in(self, port: u16) -> Result<AuthSession, OauthError> {
        match self {
            CloudProvider::GoogleDrive => crate::google::oauth::begin(port),
            CloudProvider::OneDrive => crate::onedrive::oauth::begin(port),
            CloudProvider::Dropbox => crate::dropbox::oauth::begin(port),
        }
    }

    /// The listener for this provider's desktop redirect: any free port,
    /// except for Dropbox, which only accepts the ones registered with it.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub async fn bind_loopback(self) -> Result<crate::loopback::LoopbackListener, CloudError> {
        match self {
            CloudProvider::Dropbox => {
                crate::loopback::LoopbackListener::bind_first_free(&crate::dropbox::LOOPBACK_PORTS)
                    .await
            }
            _ => crate::loopback::LoopbackListener::bind().await,
        }
    }

    pub fn storage(self, tokens: Box<dyn AccessTokens>) -> Result<Box<dyn CloudStorage>, CloudError> {
        Ok(match self {
            CloudProvider::GoogleDrive => Box::new(DriveClient::new(tokens)?),
            CloudProvider::OneDrive => Box::new(OneDriveClient::new(tokens)?),
            CloudProvider::Dropbox => Box::new(DropboxClient::new(tokens)?),
        })
    }

    /// Drop anything cached for the account being disconnected.
    ///
    /// Only Drive caches (folder ids, which belong to the account they came
    /// from); OneDrive and Dropbox address everything by path.
    pub async fn forget_cached_state(self) {
        if self == CloudProvider::GoogleDrive {
            crate::google::drive::forget_cached_folders().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip() {
        for provider in CloudProvider::ALL {
            assert_eq!(CloudProvider::from_key(provider.key()), Some(provider));
        }
        assert_eq!(CloudProvider::from_key("mega"), None);
        assert_eq!(CloudProvider::from_key(""), None);
    }

    /// Existing installs keep the Drive token under this entry name. Changing
    /// it signs every one of them out on update.
    #[test]
    fn the_drive_key_is_the_one_existing_installs_use() {
        assert_eq!(CloudProvider::GoogleDrive.key(), "google-drive");
    }

    /// The refresh lock is keyed by OAuth name; two providers sharing one
    /// would serialise each other and, worse, share a slot.
    #[test]
    fn oauth_names_are_distinct_and_match_the_display_names() {
        for provider in CloudProvider::ALL {
            assert_eq!(provider.oauth().name(), provider.display_name());
        }
    }

    #[test]
    fn storage_reports_the_same_provider() {
        struct NoToken;
        #[async_trait::async_trait]
        impl AccessTokens for NoToken {
            async fn access_token(&self) -> Result<String, CloudError> {
                Err(CloudError::NotConnected)
            }
        }
        for provider in CloudProvider::ALL {
            let storage = provider.storage(Box::new(NoToken)).unwrap();
            assert_eq!(storage.provider_name(), provider.display_name());
        }
    }

    /// The registered ids are in the source, so a plain build has OneDrive and
    /// Dropbox without any environment set up.
    #[test]
    fn onedrive_and_dropbox_work_out_of_the_box() {
        assert!(CloudProvider::OneDrive.is_configured());
        assert!(CloudProvider::Dropbox.is_configured());
    }

    /// A mobile redirect whose scheme is not declared to the OS completes the
    /// consent screen and never comes back to the app. The schemes live in two
    /// config files outside this crate; this keeps them from drifting away
    /// from the constants the sign-in actually sends.
    #[test]
    fn mobile_redirect_schemes_are_declared_to_the_os() {
        let conf = include_str!("../../../apps/desktop/src-tauri/tauri.conf.json");
        let plist = include_str!("../../../apps/desktop/src-tauri/Info.ios.plist");
        // Tracked copy of what the deep-link plugin generates. It only
        // rewrites it when its build script runs, which a warm cargo cache
        // skips, so it has to be right on its own.
        let manifest = include_str!(
            "../../../apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml"
        );
        let onedrive = crate::onedrive::MOBILE_REDIRECT_URI.split(':').next().unwrap();
        let dropbox = format!("db-{}", crate::dropbox::REGISTERED_APP_KEY);
        for scheme in [onedrive, dropbox.as_str()] {
            let quoted = format!("\"{scheme}\"");
            let tagged = format!("<string>{scheme}</string>");
            assert!(conf.contains(&quoted), "{scheme} missing from tauri.conf.json deep-link schemes");
            assert!(plist.contains(&tagged), "{scheme} missing from Info.ios.plist CFBundleURLSchemes");
            assert!(
                manifest.contains(&format!("android:scheme={quoted}")),
                "{scheme} missing from the Android manifest deep-link intent-filter"
            );
        }
    }
}
