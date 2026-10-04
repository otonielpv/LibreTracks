//! iOS network MIDI session (RTP-MIDI), plan mobile-midi paso 07.
//!
//! `MIDINetworkSession.defaultSession` is CoreMIDI's built-in RTP-MIDI peer:
//! enabled with the "anyone" policy, a Mac sees the iPhone/iPad under "Network"
//! in Audio MIDI Setup, and once connected the session's source and
//! destination ("Network Session 1") appear as ordinary CoreMIDI endpoints, so
//! `midir` lists them with everything else.
//!
//! The first time it is enabled iOS asks for the local-network permission
//! (`NSLocalNetworkUsageDescription`), which is why it is off by default and
//! only touched when the user turns the setting on.

use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject},
};

/// `MIDINetworkConnectionPolicy_Anyone`.
const CONNECTION_POLICY_ANYONE: usize = 2;

pub(crate) fn set_network_session(enabled: bool) -> Result<(), String> {
    let class = AnyClass::get(c"MIDINetworkSession")
        .ok_or_else(|| "MIDINetworkSession is not available".to_string())?;
    unsafe {
        let session: *mut AnyObject = msg_send![class, defaultSession];
        if session.is_null() {
            return Err("MIDINetworkSession.defaultSession is nil".into());
        }
        let _: () = msg_send![session, setEnabled: enabled];
        if enabled {
            let _: () = msg_send![session, setConnectionPolicy: CONNECTION_POLICY_ANYONE];
        }
    }
    Ok(())
}
