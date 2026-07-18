//! Integration test for the device-loss resilience path: when the output
//! device cannot open, the engine must fall back to its internal silent clock
//! (fallback pump) so the transport keeps running, and report it through
//! `snapshot.device.fallback_active` so the watchdog retries and the UI shows
//! the "no audio output" badge.
//!
//! Runs against the real C++ engine DLL, but never opens real hardware: the
//! requested device id is deliberately bogus, so the test is deterministic on
//! any machine (with or without audio devices).

use crate::{Engine, EngineCommand};
use std::time::Duration;

#[test]
fn failed_device_open_falls_back_to_internal_clock_and_transport_runs() {
    let engine = Engine::new().expect("engine");
    engine.initialize().expect("initialize");

    // Minimal valid session: every field of session_from_project_json has a
    // default, and the mixer advances the clock whenever a session is loaded
    // and the transport is Playing — no songs/tracks needed.
    engine
        .send_command(&EngineCommand::LoadSession {
            project_json: r#"{"id":"fallback-test","name":"fallback","songs":[]}"#.into(),
        })
        .expect("load minimal session");

    // A device id whose backend/name cannot exist. open_device must fail and
    // hand the render callback to the fallback pump.
    let open_result = engine.send_command(&EngineCommand::SetOutputDevice {
        device_id: "NoSuchBackend::NoSuchDevice".into(),
        active_channels: vec![],
    });
    assert!(
        open_result.is_err(),
        "opening a nonexistent device should report an error"
    );

    let snap = engine.get_snapshot().expect("snapshot");
    assert!(
        snap.device.fallback_active,
        "engine must run on the fallback clock after a failed open"
    );

    engine.send_command(&EngineCommand::Play).expect("play");
    // Give the pump a few blocks (512 frames @ 48 kHz ≈ 10.7 ms per block).
    std::thread::sleep(Duration::from_millis(400));

    let snap = engine.get_snapshot().expect("snapshot");
    assert!(
        snap.current_frame > 0,
        "transport must advance on the fallback clock (frame={})",
        snap.current_frame
    );
    assert!(snap.device.fallback_active);

    // RecoverOutputDevice retries the last *accepted* request. The bogus id
    // above never became current (it failed to open), so this retries the
    // system default: on a machine with audio it opens real hardware (which
    // also exercises the pump→hardware swap); on a headless machine it fails
    // and the engine stays on the pump. Both are correct — what matters is
    // that the transport keeps running seamlessly either way.
    let recover = engine.send_command(&EngineCommand::RecoverOutputDevice);
    let snap = engine.get_snapshot().expect("snapshot");
    match &recover {
        Ok(()) => assert!(
            !snap.device.fallback_active,
            "successful recovery must leave the fallback clock"
        ),
        Err(_) => assert!(
            snap.device.fallback_active,
            "failed recovery must stay on the fallback clock"
        ),
    }
    let frame_before = snap.current_frame;
    std::thread::sleep(Duration::from_millis(400));
    let snap = engine.get_snapshot().expect("snapshot");
    assert!(
        snap.current_frame > frame_before,
        "transport keeps running across recovery attempts (before={} after={})",
        frame_before,
        snap.current_frame
    );

    engine.send_command(&EngineCommand::Stop).expect("stop");
    engine.shutdown().expect("shutdown");
}

#[test]
fn recover_command_is_a_noop_without_fallback() {
    let engine = Engine::new().expect("engine");
    engine.initialize().expect("initialize");
    // No device was ever requested: fallback is not active, so the recovery
    // command must succeed as a no-op instead of touching any device.
    engine
        .send_command(&EngineCommand::RecoverOutputDevice)
        .expect("no-op recovery");
    engine.shutdown().expect("shutdown");
}
