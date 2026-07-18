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
    assert!(!rt.transport_pending_start);
    assert!(matches!(rt.playback_state, PlaybackState::Stopped));
}

#[test]
fn playing_state_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.playback_state = PlaybackState::Playing;
    snap.current_frame = 96000;
    snap.current_seconds = 2.0;
    snap.transport_pending_start = true;
    let rt = round_trip(&snap);
    assert!(matches!(rt.playback_state, PlaybackState::Playing));
    assert_eq!(rt.current_frame, 96000);
    assert!((rt.current_seconds - 2.0).abs() < 1e-9);
    assert!(rt.transport_pending_start);
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
        output_channel_count: 2,
        output_channel_names: vec!["Out 1".into(), "Out 2".into()],
        last_error: String::new(),
        fallback_active: true,
    };
    let rt = round_trip(&snap);
    assert_eq!(rt.device.backend, "WASAPI");
    assert_eq!(rt.device.sample_rate, 48000);
    assert_eq!(rt.device.buffer_size, 256);
    assert_eq!(rt.device.output_channel_count, 2);
    assert!(rt.device.fallback_active);
}

#[test]
fn cpu_diagnostics_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.cpu = CpuDiagnostics {
        callback_duration_ms: 1.23,
        callback_duration_max_ms: 2.34,
        callback_load_percent: 5.6,
        underrun_count: 2,
        callback_count: 1000,
        callback_over_budget_count: 3,
        mixer_rendered_track_count: 4,
        mixer_skipped_track_count: 5,
        track_renderer_prepare_count: 6,
        track_renderer_scratch_resize_count: 7,
        track_renderer_scratch_resize_in_audio_thread_count: 0,
        track_renderer_block_too_large_count: 0,
        track_renderer_scratch_capacity_frames: 4096,
        source_cache_miss_frames: 0,
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
            error_message: String::new(),
        },
        SourcePreparationInfo {
            source_id: "s2".into(),
            status: "queued".into(),
            progress_percent: 0,
            error_message: String::new(),
        },
    ];
    let rt = round_trip(&snap);
    assert_eq!(rt.source_states.len(), 2);
    assert_eq!(rt.source_states[0].status, "ready");
    assert_eq!(rt.source_states[1].status, "queued");
}

#[test]
fn metronome_snapshot_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.metronome = MetronomeSnapshot {
        enabled: true,
        volume: 0.5,
        output: "monitor".into(),
        last_beat_frame: 24000,
        next_beat_frame: 48000,
        current_bar: 2,
        current_beat: 1,
        route_resolved: "monitor".into(),
        rendered_clicks_count: 4,
        muted_reason: String::new(),
        current_gain: 0.4,
        target_gain: 0.5,
        toggle_count: 2,
    };
    let rt = round_trip(&snap);
    assert!(rt.metronome.enabled);
    assert_eq!(rt.metronome.output, "monitor");
    assert_eq!(rt.metronome.current_bar, 2);
    assert_eq!(rt.metronome.rendered_clicks_count, 4);
    assert_eq!(rt.metronome.toggle_count, 2);
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

// ── Meter / cache / pitch sub-snapshots (previously uncovered) ───────────────

#[test]
fn track_meters_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.track_meters = vec![TrackMeterValues {
        track_id: "t1".into(),
        left_peak: 0.8,
        right_peak: 0.7,
        left_rms: 0.4,
        right_rms: 0.35,
    }];
    let rt = round_trip(&snap);
    assert_eq!(rt.track_meters.len(), 1);
    assert_eq!(rt.track_meters[0].track_id, "t1");
    assert!((rt.track_meters[0].left_peak - 0.8).abs() < 1e-6);
    assert!((rt.track_meters[0].right_rms - 0.35).abs() < 1e-6);
}

#[test]
fn region_meters_round_trip() {
    let mut snap = EngineSnapshot::default();
    snap.region_meters = vec![RegionMeterValues {
        region_id: "r1".into(),
        peak: 0.9,
    }];
    let rt = round_trip(&snap);
    assert_eq!(rt.region_meters.len(), 1);
    assert_eq!(rt.region_meters[0].region_id, "r1");
    assert!((rt.region_meters[0].peak - 0.9).abs() < 1e-6);
}

#[test]
fn source_cache_snapshot_round_trips_and_defaults() {
    let mut snap = EngineSnapshot::default();
    snap.source_cache.ram_bytes_used = 1024;
    snap.source_cache.ram_bytes_capacity = 4096;
    snap.source_cache.disk_bytes_used = 2048;
    let rt = round_trip(&snap);
    assert_eq!(rt.source_cache.ram_bytes_used, 1024);
    assert_eq!(rt.source_cache.ram_bytes_capacity, 4096);
    assert_eq!(rt.source_cache.disk_bytes_used, 2048);

    // Defaulted struct round-trips to zeros.
    let default_rt = round_trip(&EngineSnapshot::default());
    assert_eq!(default_rt.source_cache.ram_bytes_used, 0);
}

#[test]
fn pitch_snapshot_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.pitch.pitch_engine_available = true;
    snap.pitch.pitch_backend = "bungee".into();
    let rt = round_trip(&snap);
    assert!(rt.pitch.pitch_engine_available);
    assert_eq!(rt.pitch.pitch_backend, "bungee");
}

#[test]
fn prearmed_jumps_snapshot_round_trips() {
    let mut snap = EngineSnapshot::default();
    snap.prearmed_jumps.ready_count = 3;
    snap.prearmed_jumps.prepared_total = 10;
    snap.prearmed_jumps.worker_busy = true;
    let rt = round_trip(&snap);
    assert_eq!(rt.prearmed_jumps.ready_count, 3);
    assert_eq!(rt.prearmed_jumps.prepared_total, 10);
    assert!(rt.prearmed_jumps.worker_busy);
}

#[test]
fn snapshot_tolerates_missing_optional_collections() {
    // Optional collections/sub-snapshots default when absent. Start from the
    // full default JSON, drop the defaulted array fields, and confirm it still
    // deserializes (the required device/cpu/meters objects stay in place).
    let mut value: serde_json::Value =
        serde_json::to_value(EngineSnapshot::default()).expect("to value");
    let obj = value.as_object_mut().unwrap();
    for optional in [
        "track_meters",
        "region_meters",
        "pending_jumps",
        "source_states",
    ] {
        obj.remove(optional);
    }
    let snap: EngineSnapshot =
        serde_json::from_value(value).expect("snapshot without optional arrays");
    assert!(snap.track_meters.is_empty());
    assert!(snap.region_meters.is_empty());
    assert!(snap.pending_jumps.is_empty());
}

#[test]
fn playback_state_serializes_lowercase() {
    // The C++ engine emits lowercase state strings; pin that contract.
    let mut snap = EngineSnapshot::default();
    snap.playback_state = PlaybackState::Playing;
    let json = serde_json::to_string(&snap).unwrap();
    assert!(json.contains("\"playing\""));
}
