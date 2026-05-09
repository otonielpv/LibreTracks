use crate::events::EngineEvent;

fn type_field(ev: &EngineEvent) -> String {
    let json = serde_json::to_string(ev).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    v["type"].as_str().unwrap_or("").to_owned()
}

fn round_trip(ev: EngineEvent) -> EngineEvent {
    let json = serde_json::to_string(&ev).unwrap();
    serde_json::from_str(&json).expect("deserialize event")
}

#[test]
fn playback_started_type() {
    assert_eq!(type_field(&EngineEvent::PlaybackStarted { frame: 0 }), "PlaybackStarted");
}

#[test]
fn playback_paused_preserves_frame() {
    let ev = round_trip(EngineEvent::PlaybackPaused { frame: 96000 });
    assert!(matches!(ev, EngineEvent::PlaybackPaused { frame: 96000 }));
}

#[test]
fn playback_stopped_type() {
    assert_eq!(type_field(&EngineEvent::PlaybackStopped { frame: 0 }), "PlaybackStopped");
}

#[test]
fn seek_executed_preserves_frames() {
    let ev = round_trip(EngineEvent::SeekExecuted { from_frame: 1000, to_frame: 48000 });
    assert!(matches!(ev, EngineEvent::SeekExecuted { from_frame: 1000, to_frame: 48000 }));
}

#[test]
fn jump_scheduled_type() {
    let ev = EngineEvent::JumpScheduled {
        jump_id: "j1".into(),
        target_description: "Marker A".into(),
    };
    assert_eq!(type_field(&ev), "JumpScheduled");
}

#[test]
fn jump_cancelled_preserves_id() {
    let ev = round_trip(EngineEvent::JumpCancelled { jump_id: "j42".into() });
    assert!(matches!(ev, EngineEvent::JumpCancelled { jump_id } if jump_id == "j42"));
}

#[test]
fn jump_executed_preserves_all_fields() {
    let ev = round_trip(EngineEvent::JumpExecuted {
        jump_id: "j1".into(),
        from_frame: 1000,
        to_frame: 5000,
    });
    assert!(matches!(ev, EngineEvent::JumpExecuted { from_frame: 1000, to_frame: 5000, .. }));
}

#[test]
fn jump_failed_preserves_reason() {
    let ev = round_trip(EngineEvent::JumpFailed {
        jump_id: "j1".into(),
        reason: "Marker not found".into(),
    });
    assert!(matches!(ev, EngineEvent::JumpFailed { reason, .. } if reason.contains("not found")));
}

#[test]
fn device_changed_type() {
    let ev = EngineEvent::DeviceChanged {
        device_id: "id1".into(),
        device_name: "Speakers".into(),
        sample_rate: 48000,
        buffer_size: 256,
    };
    assert_eq!(type_field(&ev), "DeviceChanged");
}

#[test]
fn device_error_preserves_message() {
    let ev = round_trip(EngineEvent::DeviceError { message: "no device".into() });
    assert!(matches!(ev, EngineEvent::DeviceError { message } if message == "no device"));
}

#[test]
fn source_prepared_type() {
    assert_eq!(type_field(&EngineEvent::SourcePrepared { source_id: "s1".into() }), "SourcePrepared");
}

#[test]
fn source_starved_type() {
    let ev = EngineEvent::SourceStarved { source_id: "s1".into(), track_id: "t1".into() };
    assert_eq!(type_field(&ev), "SourceStarved");
}

#[test]
fn pitch_cache_prepared_preserves_semitones() {
    let ev = round_trip(EngineEvent::PitchCachePrepared { source_id: "s1".into(), semitones: -5 });
    assert!(matches!(ev, EngineEvent::PitchCachePrepared { semitones: -5, .. }));
}

#[test]
fn diagnostic_warning_preserves_message() {
    let ev = round_trip(EngineEvent::DiagnosticWarning { message: "high CPU".into() });
    assert!(matches!(ev, EngineEvent::DiagnosticWarning { message } if message == "high CPU"));
}

#[test]
fn all_events_have_type_field() {
    let events: &[EngineEvent] = &[
        EngineEvent::PlaybackStarted { frame: 0 },
        EngineEvent::PlaybackPaused  { frame: 0 },
        EngineEvent::PlaybackStopped { frame: 0 },
        EngineEvent::SeekExecuted { from_frame: 0, to_frame: 0 },
        EngineEvent::JumpScheduled { jump_id: "".into(), target_description: "".into() },
        EngineEvent::JumpCancelled { jump_id: "".into() },
        EngineEvent::JumpExecuted  { jump_id: "".into(), from_frame: 0, to_frame: 0 },
        EngineEvent::JumpFailed    { jump_id: "".into(), reason: "".into() },
        EngineEvent::DeviceChanged { device_id: "".into(), device_name: "".into(), sample_rate: 0, buffer_size: 0 },
        EngineEvent::DeviceError { message: "".into() },
        EngineEvent::SourcePrepared    { source_id: "".into() },
        EngineEvent::SourceStarved     { source_id: "".into(), track_id: "".into() },
        EngineEvent::PitchCachePrepared{ source_id: "".into(), semitones: 0 },
        EngineEvent::DiagnosticWarning { message: "".into() },
    ];
    for ev in events {
        let json = serde_json::to_string(ev).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v.get("type").is_some(), "missing 'type' field in: {json}");
    }
}
