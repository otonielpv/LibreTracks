//! Redundancy step 02: the audio clock is read through a plain C struct.
//! Under no-link the stub hands back a fixed reading; this checks the Rust
//! side turns it into the right `AudioClockReading` (and that the path has no
//! JSON in it: `Engine::audio_clock` only copies a `#[repr(C)]` struct).

use crate::Engine;

#[test]
fn audio_clock_reads_the_plain_struct() {
    let engine = Engine::new().expect("stub engine");
    let reading = engine.audio_clock().expect("stub reading");
    assert_eq!(reading.frame, 48_000);
    assert_eq!(reading.sample_rate, 48_000);
    // steady_now_ns - callback_steady_ns, measured by the engine itself.
    assert_eq!(reading.callback_age_ns, 2_000_000);
    assert!(reading.moving);
    assert_eq!(reading.output_latency_samples, 480);
    assert!(reading.latency_reported);
    assert!(!reading.fallback_active);
    assert_eq!(reading.blocks, 1);
}
