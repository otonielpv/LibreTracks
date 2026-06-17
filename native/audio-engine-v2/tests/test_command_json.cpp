#include <doctest/doctest.h>
#include <lt_engine/core/commands.h>
#include <lt_engine/core/events.h>
#include <lt_engine/core/snapshot.h>
#include <stdexcept>

using namespace lt;

// ── command_from_json ─────────────────────────────────────────────────────────

TEST_CASE("parse Play command") {
    auto cmd = command_from_json(R"({"type":"Play"})");
    CHECK(std::holds_alternative<CmdPlay>(cmd));
}

TEST_CASE("parse Pause command") {
    auto cmd = command_from_json(R"({"type":"Pause"})");
    CHECK(std::holds_alternative<CmdPause>(cmd));
}

TEST_CASE("parse Stop command") {
    auto cmd = command_from_json(R"({"type":"Stop"})");
    CHECK(std::holds_alternative<CmdStop>(cmd));
}

TEST_CASE("parse SeekAbsolute command") {
    auto cmd = command_from_json(R"({"type":"SeekAbsolute","frame":192000})");
    REQUIRE(std::holds_alternative<CmdSeekAbsolute>(cmd));
    CHECK(std::get<CmdSeekAbsolute>(cmd).frame == 192000);
}

TEST_CASE("parse SeekRelative with negative delta") {
    auto cmd = command_from_json(R"({"type":"SeekRelative","delta_frames":-48000})");
    REQUIRE(std::holds_alternative<CmdSeekRelative>(cmd));
    CHECK(std::get<CmdSeekRelative>(cmd).delta_frames == -48000);
}

TEST_CASE("parse JumpToMarker") {
    auto cmd = command_from_json(R"({"type":"JumpToMarker","marker_id":"m1"})");
    REQUIRE(std::holds_alternative<CmdJumpToMarker>(cmd));
    CHECK(std::get<CmdJumpToMarker>(cmd).marker_id == "m1");
}

TEST_CASE("parse JumpToNextSong") {
    auto cmd = command_from_json(R"({"type":"JumpToNextSong"})");
    CHECK(std::holds_alternative<CmdJumpToNextSong>(cmd));
}

TEST_CASE("parse CancelAllScheduledJumps") {
    auto cmd = command_from_json(R"({"type":"CancelAllScheduledJumps"})");
    CHECK(std::holds_alternative<CmdCancelAllScheduledJumps>(cmd));
}

TEST_CASE("parse CancelScheduledJump") {
    auto cmd = command_from_json(R"({"type":"CancelScheduledJump","jump_id":"j99"})");
    REQUIRE(std::holds_alternative<CmdCancelScheduledJump>(cmd));
    CHECK(std::get<CmdCancelScheduledJump>(cmd).jump_id == "j99");
}

TEST_CASE("parse ScheduleJump with explicit trigger frame") {
    auto cmd = command_from_json(R"({
        "type":"ScheduleJump",
        "jump_id":"j-after-bars",
        "target":{"kind":"Region","id":"r1"},
        "trigger":"AtFrame",
        "trigger_frame":288000,
        "suppress_seek_fade":true
    })");
    REQUIRE(std::holds_alternative<CmdScheduleJump>(cmd));
    auto& c = std::get<CmdScheduleJump>(cmd);
    CHECK(c.jump_id == "j-after-bars");
    CHECK(c.target.kind == JumpTarget::Kind::Region);
    REQUIRE(c.target.id.has_value());
    CHECK(*c.target.id == "r1");
    CHECK(c.trigger == JumpTrigger::AtFrame);
    REQUIRE(c.trigger_frame.has_value());
    CHECK(*c.trigger_frame == 288000);
    CHECK(c.suppress_seek_fade == true);
}

TEST_CASE("parse SetSongMarkers") {
    auto cmd = command_from_json(R"({
        "type":"SetSongMarkers",
        "song_id":"song1",
        "markers":[{"id":"section_a","name":"Verse","frame":2025472}]
    })");
    REQUIRE(std::holds_alternative<CmdSetSongMarkers>(cmd));
    auto& c = std::get<CmdSetSongMarkers>(cmd);
    CHECK(c.song_id == "song1");
    REQUIRE(c.markers.size() == 1);
    CHECK(c.markers[0].id == "section_a");
    CHECK(c.markers[0].name == "Verse");
    CHECK(c.markers[0].frame == 2025472);
}

TEST_CASE("parse SetSongTiming") {
    auto cmd = command_from_json(R"({
        "type":"SetSongTiming",
        "song_id":"song1",
        "bpm":132.5,
        "beats_per_bar":7,
        "beat_unit":8,
        "tempo_markers":[{"id":"tempo_a","frame":96000,"bpm":99.0}],
        "time_signature_markers":[{"id":"sig_a","frame":144000,"beats_per_bar":3,"beat_unit":4}]
    })");
    REQUIRE(std::holds_alternative<CmdSetSongTiming>(cmd));
    auto& c = std::get<CmdSetSongTiming>(cmd);
    CHECK(c.song_id == "song1");
    CHECK(c.bpm == doctest::Approx(132.5));
    CHECK(c.beats_per_bar == 7);
    CHECK(c.beat_unit == 8);
    REQUIRE(c.tempo_markers.size() == 1);
    CHECK(c.tempo_markers[0].id == "tempo_a");
    CHECK(c.tempo_markers[0].frame == 96000);
    CHECK(c.tempo_markers[0].bpm == doctest::Approx(99.0));
    REQUIRE(c.time_signature_markers.size() == 1);
    CHECK(c.time_signature_markers[0].id == "sig_a");
    CHECK(c.time_signature_markers[0].beats_per_bar == 3);
    CHECK(c.time_signature_markers[0].beat_unit == 4);
}

TEST_CASE("parse UpsertSongTracks full structural snapshot") {
    // Mirrors the JSON the Rust AudioController::upsert_song_tracks emits.
    auto cmd = command_from_json(R"({
        "type":"UpsertSongTracks",
        "song_id":"song1",
        "tracks":[{
            "id":"trk1","name":"Bass","gain":0.8,"pan":-0.2,
            "audio_to":"master","mute":false,"solo":false,
            "transpose_behavior":"never_transpose","role":"","kind":"audio",
            "parent_track_id":"",
            "clips":[{
                "id":"clip1","source_id":"bass.mp3",
                "timeline_start_frame":0,"source_start_frame":0,
                "length_frames":480000,"gain":1.0,
                "fade_in_frames":0,"fade_out_frames":0,"semitones":0
            }]
        }],
        "sources":[{"id":"bass.mp3","file_path":"bass.mp3"}],
        "regions":[{"id":"reg1","name":"A","start_frame":0,"end_frame":480000,
                    "transpose_semitones":2,"warp_enabled":false,
                    "warp_source_bpm":0.0,"master_gain":1.0}],
        "markers":[{"id":"mk1","name":"Verse","frame":0,"kind":"verse","variant":1}],
        "bpm":128.0,"beats_per_bar":4,"beat_unit":4,
        "tempo_markers":[],"time_signature_markers":[]
    })");
    REQUIRE(std::holds_alternative<CmdUpsertSongTracks>(cmd));
    auto& c = std::get<CmdUpsertSongTracks>(cmd);
    CHECK(c.song_id == "song1");
    REQUIRE(c.tracks.size() == 1);
    CHECK(c.tracks[0].id == "trk1");
    CHECK(c.tracks[0].name == "Bass");
    CHECK(c.tracks[0].gain == doctest::Approx(0.8f));
    CHECK(c.tracks[0].kind == "audio");
    CHECK(c.tracks[0].transpose_behavior == "never_transpose");
    REQUIRE(c.tracks[0].clips.size() == 1);
    CHECK(c.tracks[0].clips[0].id == "clip1");
    CHECK(c.tracks[0].clips[0].source_id == "bass.mp3");
    CHECK(c.tracks[0].clips[0].length_frames == 480000);
    REQUIRE(c.sources.size() == 1);
    CHECK(c.sources[0].id == "bass.mp3");
    CHECK(c.sources[0].file_path == "bass.mp3");
    REQUIRE(c.regions.size() == 1);
    CHECK(c.regions[0].id == "reg1");
    CHECK(c.regions[0].transpose_semitones == 2);
    REQUIRE(c.markers.size() == 1);
    CHECK(c.markers[0].id == "mk1");
    CHECK(c.markers[0].kind == "verse");
    CHECK(c.bpm == doctest::Approx(128.0));
}

TEST_CASE("parse SetTrackGain") {
    auto cmd = command_from_json(R"({"type":"SetTrackGain","track_id":"t1","gain":0.75})");
    REQUIRE(std::holds_alternative<CmdSetTrackGain>(cmd));
    auto& c = std::get<CmdSetTrackGain>(cmd);
    CHECK(c.track_id == "t1");
    CHECK(c.gain == doctest::Approx(0.75f));
}

TEST_CASE("parse SetTrackPan") {
    auto cmd = command_from_json(R"({"type":"SetTrackPan","track_id":"t1","pan":-0.5})");
    REQUIRE(std::holds_alternative<CmdSetTrackPan>(cmd));
    auto& c = std::get<CmdSetTrackPan>(cmd);
    CHECK(c.track_id == "t1");
    CHECK(c.pan == doctest::Approx(-0.5f));
}

TEST_CASE("parse SetTrackMute true") {
    auto cmd = command_from_json(R"({"type":"SetTrackMute","track_id":"t1","mute":true})");
    REQUIRE(std::holds_alternative<CmdSetTrackMute>(cmd));
    CHECK(std::get<CmdSetTrackMute>(cmd).mute == true);
}

TEST_CASE("parse StartMasterFade") {
    auto cmd = command_from_json(R"({"type":"StartMasterFade","target_gain":0.0,"duration_seconds":0.35})");
    REQUIRE(std::holds_alternative<CmdStartMasterFade>(cmd));
    auto& c = std::get<CmdStartMasterFade>(cmd);
    CHECK(c.target_gain == doctest::Approx(0.0f));
    CHECK(c.duration_seconds == doctest::Approx(0.35));
}

TEST_CASE("parse SetTrackAudioRoute") {
    auto cmd = command_from_json(R"({"type":"SetTrackAudioRoute","track_id":"t1","audio_to":"ext:2-3"})");
    REQUIRE(std::holds_alternative<CmdSetTrackAudioRoute>(cmd));
    auto& c = std::get<CmdSetTrackAudioRoute>(cmd);
    CHECK(c.track_id == "t1");
    CHECK(c.audio_to == "ext:2-3");
}

TEST_CASE("parse SetMetronomeConfig") {
    auto cmd = command_from_json(R"({"type":"SetMetronomeConfig","enabled":true,"volume":0.5,"route":"monitor"})");
    REQUIRE(std::holds_alternative<CmdSetMetronomeConfig>(cmd));
    auto& c = std::get<CmdSetMetronomeConfig>(cmd);
    CHECK(c.enabled == true);
    CHECK(c.volume == doctest::Approx(0.5f));
    CHECK(c.route == "monitor");
}

TEST_CASE("parse SetSongTranspose negative") {
    auto cmd = command_from_json(R"({"type":"SetSongTranspose","song_id":"s1","semitones":-5})");
    REQUIRE(std::holds_alternative<CmdSetSongTranspose>(cmd));
    CHECK(std::get<CmdSetSongTranspose>(cmd).semitones == -5);
}

TEST_CASE("parse SetOutputDevice") {
    auto cmd = command_from_json(R"({"type":"SetOutputDevice","device_id":"ASIO4ALL"})");
    REQUIRE(std::holds_alternative<CmdSetOutputDevice>(cmd));
    CHECK(std::get<CmdSetOutputDevice>(cmd).device_id == "ASIO4ALL");
}

TEST_CASE("parse SetSampleRate") {
    auto cmd = command_from_json(R"({"type":"SetSampleRate","sample_rate":44100})");
    REQUIRE(std::holds_alternative<CmdSetSampleRate>(cmd));
    CHECK(std::get<CmdSetSampleRate>(cmd).sample_rate == 44100);
}

TEST_CASE("unknown type throws") {
    CHECK_THROWS_AS(command_from_json(R"({"type":"Nonexistent"})"), std::invalid_argument);
}

TEST_CASE("malformed JSON throws") {
    CHECK_THROWS(command_from_json("not json at all"));
}

// ── event_to_json ─────────────────────────────────────────────────────────────

TEST_CASE("PlaybackStarted event has correct type field") {
    auto json = event_to_json(EvPlaybackStarted{ 1000 });
    CHECK(json.find("\"PlaybackStarted\"") != std::string::npos);
    CHECK(json.find("\"frame\"") != std::string::npos);
}

TEST_CASE("JumpExecuted event encodes frames") {
    auto json = event_to_json(EvJumpExecuted{ "j1", 100, 5000 });
    CHECK(json.find("\"JumpExecuted\"")  != std::string::npos);
    CHECK(json.find("\"from_frame\"")    != std::string::npos);
    CHECK(json.find("\"to_frame\"")      != std::string::npos);
}

TEST_CASE("DeviceError event has message") {
    auto json = event_to_json(EvDeviceError{ "device lost" });
    CHECK(json.find("device lost") != std::string::npos);
}

// ── snapshot_to_json ──────────────────────────────────────────────────────────

TEST_CASE("snapshot has required top-level keys") {
    EngineSnapshot snap;
    snap.current_frame   = 48000;
    snap.playback_state  = PlaybackState::Playing;
    snap.device.backend  = "WASAPI";

    auto json = snapshot_to_json(snap);
    CHECK(json.find("\"current_frame\"")  != std::string::npos);
    CHECK(json.find("\"playback_state\"") != std::string::npos);
    CHECK(json.find("\"playing\"")        != std::string::npos);
    CHECK(json.find("\"WASAPI\"")         != std::string::npos);
    CHECK(json.find("\"pending_jumps\"")  != std::string::npos);
    CHECK(json.find("\"meters\"")         != std::string::npos);
    CHECK(json.find("\"metronome\"")      != std::string::npos);
    CHECK(json.find("\"pitch\"")          != std::string::npos);
    CHECK(json.find("\"mixer_scheduled_jump_executed_count\"") != std::string::npos);
}

TEST_CASE("snapshot serializes pending jumps array") {
    EngineSnapshot snap;
    PendingJumpInfo j;
    j.jump_id      = "j1";
    j.status       = "pending";
    j.created_frame = 100;
    snap.pending_jumps.push_back(j);

    auto json = snapshot_to_json(snap);
    CHECK(json.find("\"j1\"")      != std::string::npos);
    CHECK(json.find("\"pending\"") != std::string::npos);
}
