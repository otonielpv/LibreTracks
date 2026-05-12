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
