use crate::snapshot::*;

fn round_trip(snap: &EngineSnapshot) -> EngineSnapshot {
    let json = serde_json::to_string(snap).unwrap();
    serde_json::from_str(&json).expect("deserialize snapshot")
}

#[test]
fn default_snapshot_round_trips() {
    let snap = EngineSnapshot::default();
    let rt = round_trip(&snap);
    assert_eq!(rt.current_frame, 0);
    assert_eq!(rt.current_seconds, 0.0);
    assert!(matches!(rt.playback_state, PlaybackState::Stopped));
}

#[test]
fn playing_state_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.playback_state = PlaybackState::Playing;
    snap.current_frame = 96000;
    snap.current_seconds = 2.0;
    let rt = round_trip(&snap);
    assert!(matches!(rt.playback_state, PlaybackState::Playing));
    assert_eq!(rt.current_frame, 96000);
    assert!((rt.current_seconds - 2.0).abs() < 1e-9);
}

#[test]
fn paused_state_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.playback_state = PlaybackState::Paused;
    let rt = round_trip(&snap);
    assert!(matches!(rt.playback_state, PlaybackState::Paused));
}

#[test]
fn song_region_marker_ids_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.current_song_id = "song-1".into();
    snap.current_region_id = "region-A".into();
    snap.current_marker_id = "marker-intro".into();
    let rt = round_trip(&snap);
    assert_eq!(rt.current_song_id, "song-1");
    assert_eq!(rt.current_region_id, "region-A");
    assert_eq!(rt.current_marker_id, "marker-intro");
}

#[test]
fn pending_jump_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.pending_jumps.push(PendingJumpInfo {
        jump_id: "j1".into(),
        target_description: "Marker A".into(),
        trigger_description: "AtSongEnd".into(),
        status: "pending".into(),
        created_frame: 48000,
    });
    let rt = round_trip(&snap);
    assert_eq!(rt.pending_jumps.len(), 1);
    assert_eq!(rt.pending_jumps[0].jump_id, "j1");
    assert_eq!(rt.pending_jumps[0].status, "pending");
    assert_eq!(rt.pending_jumps[0].created_frame, 48000);
}

#[test]
fn device_info_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.device = DeviceInfo {
        device_id: "speakers-1".into(),
        device_name: "Speakers (Realtek Audio)".into(),
        backend: "WASAPI".into(),
        sample_rate: 48000,
        buffer_size: 256,
        last_error: String::new(),
    };
    let rt = round_trip(&snap);
    assert_eq!(rt.device.backend, "WASAPI");
    assert_eq!(rt.device.sample_rate, 48000);
    assert_eq!(rt.device.buffer_size, 256);
}

#[test]
fn cpu_diagnostics_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.cpu = CpuDiagnostics {
        callback_duration_ms: 1.23,
        callback_load_percent: 5.6,
        underrun_count: 2,
        callback_count: 1000,
    };
    let rt = round_trip(&snap);
    assert!((rt.cpu.callback_duration_ms - 1.23).abs() < 1e-9);
    assert_eq!(rt.cpu.callback_count, 1000);
    assert_eq!(rt.cpu.underrun_count, 2);
}

#[test]
fn meter_values_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.meters = MeterValues {
        left_peak: 0.9,
        right_peak: 0.85,
        left_rms: 0.3,
        right_rms: 0.28,
    };
    let rt = round_trip(&snap);
    assert!((rt.meters.left_peak - 0.9).abs() < 1e-6);
    assert!((rt.meters.right_peak - 0.85).abs() < 1e-6);
}

#[test]
fn source_states_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.source_states = vec![
        SourcePreparationInfo {
            source_id: "s1".into(),
            status: "ready".into(),
            progress_percent: 100,
        },
        SourcePreparationInfo {
            source_id: "s2".into(),
            status: "queued".into(),
            progress_percent: 0,
        },
    ];
    let rt = round_trip(&snap);
    assert_eq!(rt.source_states.len(), 2);
    assert_eq!(rt.source_states[0].status, "ready");
    assert_eq!(rt.source_states[1].status, "queued");
}

#[test]
fn multiple_pending_jumps_round_trip() {
    let mut snap = EngineSnapshot::default();
    for i in 0..5 {
        snap.pending_jumps.push(PendingJumpInfo {
            jump_id: format!("j{i}"),
            status: "pending".into(),
            ..Default::default()
        });
    }
    let rt = round_trip(&snap);
    assert_eq!(rt.pending_jumps.len(), 5);
    assert_eq!(rt.pending_jumps[4].jump_id, "j4");
}
