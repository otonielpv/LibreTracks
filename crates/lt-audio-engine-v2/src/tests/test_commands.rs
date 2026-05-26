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
        suppress_seek_fade: false,
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
        suppress_seek_fade: true,
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"trigger_frame\":288000"));
    assert!(json.contains("\"suppress_seek_fade\":true"));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::ScheduleJump {
            trigger: JumpTrigger::AtFrame,
            trigger_frame: Some(288000),
            suppress_seek_fade: true,
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

#[test]
fn set_song_markers_round_trip() {
    let cmd = EngineCommand::SetSongMarkers {
        song_id: "song1".into(),
        markers: vec![MarkerUpdate {
            id: "section_a".into(),
            name: "Verse".into(),
            frame: 2025472,
        }],
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"type\":\"SetSongMarkers\""));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::SetSongMarkers { song_id, markers }
            if song_id == "song1"
                && markers.len() == 1
                && markers[0].id == "section_a"
                && markers[0].frame == 2025472
    ));
}

// ── Track / mix ─────────────────────────────────────────────────────────────

#[test]
fn set_song_clips_round_trip() {
    let cmd = EngineCommand::SetSongClips {
        song_id: "song1".into(),
        clips: vec![ClipUpdate {
            id: "clip_a".into(),
            track_id: "track_a".into(),
            source_id: "D:/audio/song.wav".into(),
            timeline_start_frame: 1024,
            source_start_frame: 256,
            length_frames: 48000,
            gain: 0.75,
            fade_in_frames: 128,
            fade_out_frames: 256,
            semitones: 0,
        }],
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"type\":\"SetSongClips\""));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::SetSongClips { song_id, clips }
            if song_id == "song1"
                && clips.len() == 1
                && clips[0].id == "clip_a"
                && clips[0].timeline_start_frame == 1024
                && clips[0].length_frames == 48000
    ));
}

#[test]
fn set_song_timing_round_trip() {
    let cmd = EngineCommand::SetSongTiming {
        song_id: "song1".into(),
        bpm: 132.5,
        beats_per_bar: 7,
        beat_unit: 8,
        tempo_markers: vec![TempoMarkerUpdate {
            id: "tempo_a".into(),
            frame: 96000,
            bpm: 99.0,
        }],
        time_signature_markers: vec![TimeSignatureMarkerUpdate {
            id: "sig_a".into(),
            frame: 144000,
            beats_per_bar: 3,
            beat_unit: 4,
        }],
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"type\":\"SetSongTiming\""));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::SetSongTiming {
            song_id,
            bpm,
            beats_per_bar: 7,
            beat_unit: 8,
            tempo_markers,
            time_signature_markers,
        } if song_id == "song1"
            && (bpm - 132.5).abs() < 1e-9
            && tempo_markers.len() == 1
            && tempo_markers[0].id == "tempo_a"
            && (tempo_markers[0].bpm - 99.0).abs() < 1e-9
            && time_signature_markers.len() == 1
            && time_signature_markers[0].beats_per_bar == 3
    ));
}

#[test]
fn set_song_timeline_window_round_trip() {
    let cmd = EngineCommand::SetSongTimelineWindow {
        song_id: "song1".into(),
        clips: vec![ClipUpdate {
            id: "clip_a".into(),
            track_id: "track_a".into(),
            source_id: "D:/audio/song.wav".into(),
            timeline_start_frame: 1024,
            source_start_frame: 256,
            length_frames: 48000,
            gain: 0.75,
            fade_in_frames: 128,
            fade_out_frames: 256,
            semitones: 0,
        }],
        regions: vec![RegionUpdate {
            id: "region_a".into(),
            name: "Verse".into(),
            start_frame: 1024,
            end_frame: 49024,
            transpose_semitones: -2,
            warp_enabled: true,
            warp_source_bpm: 100.0,
        }],
        markers: vec![MarkerUpdate {
            id: "section_a".into(),
            name: "Verse".into(),
            frame: 1024,
        }],
        bpm: 111.0,
        beats_per_bar: 4,
        beat_unit: 4,
        tempo_markers: vec![TempoMarkerUpdate {
            id: "tempo_a".into(),
            frame: 1024,
            bpm: 111.0,
        }],
        time_signature_markers: vec![TimeSignatureMarkerUpdate {
            id: "sig_a".into(),
            frame: 2048,
            beats_per_bar: 6,
            beat_unit: 8,
        }],
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"type\":\"SetSongTimelineWindow\""));
    let rt: EngineCommand = serde_json::from_str(&json).unwrap();
    assert!(matches!(
        rt,
        EngineCommand::SetSongTimelineWindow {
            song_id,
            clips,
            regions,
            markers,
            bpm,
            beats_per_bar: 4,
            beat_unit: 4,
            tempo_markers,
            time_signature_markers,
        } if song_id == "song1"
            && clips.len() == 1
            && clips[0].length_frames == 48000
            && regions.len() == 1
            && regions[0].warp_enabled
            && (regions[0].warp_source_bpm - 100.0).abs() < 1e-9
            && markers.len() == 1
            && (bpm - 111.0).abs() < 1e-9
            && tempo_markers.len() == 1
            && time_signature_markers.len() == 1
            && time_signature_markers[0].beats_per_bar == 6
    ));
}

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
fn start_master_fade_round_trip() {
    let cmd = EngineCommand::StartMasterFade {
        target_gain: 0.0,
        duration_seconds: 0.35,
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("\"StartMasterFade\""));
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::StartMasterFade {
            target_gain,
            duration_seconds,
        } if (target_gain - 0.0).abs() < 1e-6 && (duration_seconds - 0.35).abs() < 1e-9
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
        active_channels: vec![0, 1, 2, 3],
    };
    let rt = round_trip(&cmd);
    assert!(matches!(
        rt,
        EngineCommand::SetOutputDevice { ref device_id, ref active_channels }
            if device_id.contains("Realtek") && active_channels == &vec![0, 1, 2, 3]
    ));
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
        EngineCommand::SetSongTiming {
            song_id: "song1".into(),
            bpm: 120.0,
            beats_per_bar: 4,
            beat_unit: 4,
            tempo_markers: vec![],
            time_signature_markers: vec![],
        },
        EngineCommand::SetSongTimelineWindow {
            song_id: "song1".into(),
            clips: vec![],
            regions: vec![],
            markers: vec![],
            bpm: 120.0,
            beats_per_bar: 4,
            beat_unit: 4,
            tempo_markers: vec![],
            time_signature_markers: vec![],
        },
        EngineCommand::SetSampleRate { sample_rate: 48000 },
        EngineCommand::SetBufferSize { buffer_size: 512 },
    ];
    for cmd in commands {
        let json = serde_json::to_string(cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v.get("type").is_some(), "missing 'type' field in: {json}");
    }
}
