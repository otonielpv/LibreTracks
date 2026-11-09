//! The remote's way to the backup (redundancy step 17). A browser on the
//! main's remote cannot jump servers by itself if it reloads (the page comes
//! from the main), so the main tells it where the backup's remote is and,
//! on a handover, that the backup took over; the remote shows a notice with
//! a button to go there.

use serde::Serialize;

use tauri::AppHandle;

/// What the remote receives as its `redundancy` event.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRedundancyInfo {
    pub backup_remote_url: Option<String>,
    pub handover: bool,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn publish(app: &AppHandle, info: &RemoteRedundancyInfo) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::remote::RemoteServiceState>() {
        state.handle.publish_redundancy(info);
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn publish(_app: &AppHandle, _info: &RemoteRedundancyInfo) {}

/// The backup's remote address is known (or gone).
pub fn backup_remote(app: &AppHandle, url: Option<String>) {
    publish(
        app,
        &RemoteRedundancyInfo {
            backup_remote_url: url,
            handover: false,
        },
    );
}

/// The backup took over: the remote clients are told now.
pub fn handed_over(app: &AppHandle, url: Option<String>) {
    publish(
        app,
        &RemoteRedundancyInfo {
            backup_remote_url: url,
            handover: true,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_remote_payload_is_camel_case() {
        let json = serde_json::to_value(RemoteRedundancyInfo {
            backup_remote_url: Some("http://10.0.0.2:3030".into()),
            handover: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "backupRemoteUrl": "http://10.0.0.2:3030", "handover": true })
        );
    }
}
