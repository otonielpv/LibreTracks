//! The remote's way to the backup (redundancy step 17). Filled in by step
//! 17; step 16 only calls these hooks.

use tauri::AppHandle;

/// The backup's remote address is known (or gone).
pub fn backup_remote(_app: &AppHandle, _url: Option<String>) {}

/// The backup took over: the remote clients are told.
pub fn handed_over(_app: &AppHandle, _url: Option<String>) {}
