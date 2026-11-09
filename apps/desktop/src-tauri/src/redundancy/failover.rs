//! Moving clients to the new main (redundancy steps 16-17). Step 15 only
//! calls the hook; the guests and the remote are wired in 16 and 17.

use libretracks_link::HostHandle;
use tauri::AppHandle;

use super::main_monitor::Handover;

/// This main handed over to its backup: send its guests and remote clients
/// there.
pub fn main_handed_over(_app: &AppHandle, _handle: &HostHandle, _handover: &Handover) {}
