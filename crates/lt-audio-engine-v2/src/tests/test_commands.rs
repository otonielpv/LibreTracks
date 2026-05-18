use crate::commands::*;

// Helper: serialize → deserialize → must equal original tag.
fn round_trip_type(cmd: &EngineCommand) -> String {
    let json = serde_json::to_string(cmd).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&json).expect("parse");
    v["type"].as_str().unwrap_or("").to_owned()
}

fn round_trip(cmd: &EngineCommand) -> EngineCommand {
    let json = serde_json::to_string(cmd).expect("serialize");
    serde_json::from_str(&json).expect("deserialize")
}

// ── Transport ───────────────────────────────────────────────────────────────

#[test]
fn play_round_trip() {
    assert_eq!(round_trip_type(&EngineCommand::Play), "Play");
}

#[test]
fn pause_round_trip() {
    assert_eq!(round_trip_type(&EngineCommand::Pause), "Pause");
}

#[test]
fn stop_round_trip() {
    assert_eq!(round_trip_type(&EngineCommand::Stop), "Stop");
}

#[test]
fn seek_absolute_round_trip() {
    let cmd = EngineCommand::SeekAbsolute { frame: 192000 };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::SeekAbsolute { frame: 192000 }));
}

#[test]
fn seek_relative_negative_round_trip() {
    let cmd = EngineCommand::SeekRelative {
        delta_frames: -48000,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SeekRelative {
            delta_frames: -48000
        }
    ));
}

// ── Jumps ───────────────────────────────────────────────────────────────────

#[test]
fn jump_to_marker_round_trip() {
    let cmd = EngineCommand::JumpToMarker {
        marker_id: "m1".into(),
    };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::JumpToMarker { marker_id } if marker_id == "m1"));
}

#[test]
fn jump_to_next_song_round_trip() {
    assert_eq!(
        round_trip_type(&EngineCommand::JumpToNextSong),
        "JumpToNextSong"
    );
}

#[test]
fn schedule_jump_immediate_round_trip() {
    let cmd = EngineCommand::ScheduleJump {
        jump_id: "j1".into(),
        target: JumpTarget {
            kind: JumpTargetKind::Marker,
            id: Some("m1".into()),
            frame: None,
        },
        trigger: JumpTrigger::Immediate,
        trigger_frame: None,
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"jump_id\":\"j1\""));
    assert!(json.contains("\"Immediate\""));
    assert!(!json.contains("trigger_frame"));
}

#[test]
fn schedule_jump_at_frame_round_trip() {
    let cmd = EngineCommand::ScheduleJump {
        jump_id: "j-at-frame".into(),
        target: JumpTarget {
            kind: JumpTargetKind::Region,
            id: Some("r1".into()),
            frame: None,
        },
        trigger: JumpTrigger::AtFrame,
        trigger_frame: Some(288000),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"trigger_frame\":288000"));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::ScheduleJump {
            trigger: JumpTrigger::AtFrame,
            trigger_frame: Some(288000),
            ..
        }
    ));
}

#[test]
fn cancel_scheduled_jump_round_trip() {
    let cmd = EngineCommand::CancelScheduledJump {
        jump_id: "j42".into(),
    };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::CancelScheduledJump { jump_id } if jump_id == "j42"));
}

#[test]
fn cancel_all_jumps_round_trip() {
    assert_eq!(
        round_trip_type(&EngineCommand::CancelAllScheduledJumps),
        "CancelAllScheduledJumps"
    );
}

#[test]
fn replace_jump_round_trip() {
    let cmd = EngineCommand::ReplaceScheduledJump {
        jump_id: "j1".into(),
        new_target: JumpTarget {
            kind: JumpTargetKind::Song,
            id: Some("song2".into()),
            frame: None,
        },
        new_trigger: JumpTrigger::AtSongEnd,
    };
    let json = serde_json::to_string(&cmd).unwrap();
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(rt, EngineCommand::ReplaceScheduledJump { .. }));
}

// ── Track / mix ─────────────────────────────────────────────────────────────

#[test]
fn set_track_gain_round_trip() {
    let cmd = EngineCommand::SetTrackGain {
        track_id: "t1".into(),
        gain: 0.75,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::SetTrackGain { gain, .. } if (gain - 0.75).abs() < 1e-6));
}

#[test]
fn set_track_pan_round_trip() {
    let cmd = EngineCommand::SetTrackPan {
        track_id: "t1".into(),
        pan: -0.5,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::SetTrackPan { pan, .. } if (pan + 0.5).abs() < 1e-6));
}

#[test]
fn set_track_mute_true_round_trip() {
    let cmd = EngineCommand::SetTrackMute {
        track_id: "t1".into(),
        mute: true,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(rt, EngineCommand::SetTrackMute { mute: true, .. }));
}

#[test]
fn set_track_audio_route_round_trip() {
    let cmd = EngineCommand::SetTrackAudioRoute {
        track_id: "t1".into(),
        audio_to: "ext:2-3".into(),
    };
    let rt = round_trip(&cmd);
    assert!(
        matches!(rt, EngineCommand::SetTrackAudioRoute { audio_to, .. } if audio_to == "ext:2-3")
    );
}

#[test]
fn set_track_transpose_enabled_false_round_trip() {
    let cmd = EngineCommand::SetTrackTransposeEnabled {
        track_id: "t1".into(),
        enabled: false,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetTrackTransposeEnabled { enabled: false, .. }
    ));
}

#[test]
fn set_metronome_config_round_trip() {
    let cmd = EngineCommand::SetMetronomeConfig {
        enabled: true,
        volume: 0.5,
        route: "monitor".into(),
    };
    let rt = round_trip(&cmd);
    assert!(
        matches!(rt, EngineCommand::SetMetronomeConfig { enabled: true, volume, route }
            if (volume - 0.5).abs() < 1e-6 && route == "monitor")
    );
}

// ── Pitch ───────────────────────────────────────────────────────────────────

#[test]
fn set_song_transpose_round_trip() {
    let cmd = EngineCommand::SetSongTranspose {
        song_id: "s1".into(),
        semitones: -3,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetSongTranspose { semitones: -3, .. }
    ));
}

#[test]
fn set_region_transpose_max_round_trip() {
    let cmd = EngineCommand::SetRegionTranspose {
        region_id: "r1".into(),
        semitones: 12,
    };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetRegionTranspose { semitones: 12, .. }
    ));
}

// ── Device ──────────────────────────────────────────────────────────────────

#[test]
fn set_output_device_round_trip() {
    let cmd = EngineCommand::SetOutputDevice {
        device_id: "Speakers (Realtek)".into(),
    };
    let rt = round_trip(&cmd);
    assert!(
        matches!(rt, EngineCommand::SetOutputDevice { device_id } if device_id.contains("Realtek"))
    );
}

#[test]
fn set_sample_rate_round_trip() {
    let cmd = EngineCommand::SetSampleRate { sample_rate: 44100 };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetSampleRate { sample_rate: 44100 }
    ));
}

#[test]
fn set_buffer_size_round_trip() {
    let cmd = EngineCommand::SetBufferSize { buffer_size: 256 };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetBufferSize { buffer_size: 256 }
    ));
}

// ── Session ─────────────────────────────────────────────────────────────────

#[test]
fn load_session_round_trip() {
    let cmd = EngineCommand::LoadSession {
        project_json: r#"{"id":"s1"}"#.into(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("LoadSession"));
    assert!(json.contains("project_json"));
}

// ── JSON schema contract ─────────────────────────────────────────────────────
// Verify the "type" field is always present (C++ parser requirement).

#[test]
fn all_commands_have_type_field() {
    let commands: &[EngineCommand] = &[
        EngineCommand::Play,
        EngineCommand::Pause,
        EngineCommand::Stop,
        EngineCommand::SeekAbsolute { frame: 0 },
        EngineCommand::SeekRelative { delta_frames: 0 },
        EngineCommand::JumpToNextSong,
        EngineCommand::JumpToPreviousSong,
        EngineCommand::CancelAllScheduledJumps,
        EngineCommand::SetTrackPan {
            track_id: "t1".into(),
            pan: 0.0,
        },
        EngineCommand::SetTrackAudioRoute {
            track_id: "t1".into(),
            audio_to: "master".into(),
        },
        EngineCommand::SetMetronomeEnabled { enabled: true },
        EngineCommand::SetSampleRate { sample_rate: 48000 },
        EngineCommand::SetBufferSize { buffer_size: 512 },
    ];
    for cmd in commands {
        let json = serde_json::to_string(cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v.get("type").is_some(), "missing 'type' field in: {json}");
    }
}
