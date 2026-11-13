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

TEST_CASE("parse SetOutputSuspended in both directions") {
    auto on = command_from_json(R"({"type":"SetOutputSuspended","suspended":true})");
    REQUIRE(std::holds_alternative<CmdSetOutputSuspended>(on));
    CHECK(std::get<CmdSetOutputSuspended>(on).suspended);

    auto off = command_from_json(R"({"type":"SetOutputSuspended","suspended":false})");
    REQUIRE(std::holds_alternative<CmdSetOutputSuspended>(off));
    CHECK_FALSE(std::get<CmdSetOutputSuspended>(off).suspended);
}

TEST_CASE("parse ReopenOutputDevice") {
    auto cmd = command_from_json(R"({"type":"ReopenOutputDevice"})");
    CHECK(std::holds_alternative<CmdReopenOutputDevice>(cmd));
}

TEST_CASE("parse SetPauseAtSongEnd in both directions") {
    auto on = command_from_json(R"({"type":"SetPauseAtSongEnd","enabled":true})");
    REQUIRE(std::holds_alternative<CmdSetPauseAtSongEnd>(on));
    CHECK(std::get<CmdSetPauseAtSongEnd>(on).enabled);

    auto off = command_from_json(R"({"type":"SetPauseAtSongEnd","enabled":false})");
    REQUIRE(std::holds_alternative<CmdSetPauseAtSongEnd>(off));
    CHECK_FALSE(std::get<CmdSetPauseAtSongEnd>(off).enabled);
}

TEST_CASE("parse SetSongGapVamp and EndSongGapVamp") {
    auto on = command_from_json(R"({"type":"SetSongGapVamp","enabled":true})");
    REQUIRE(std::holds_alternative<CmdSetSongGapVamp>(on));
    CHECK(std::get<CmdSetSongGapVamp>(on).enabled);

    auto off = command_from_json(R"({"type":"SetSongGapVamp","enabled":false})");
    REQUIRE(std::holds_alternative<CmdSetSongGapVamp>(off));
    CHECK_FALSE(std::get<CmdSetSongGapVamp>(off).enabled);

    auto end = command_from_json(R"({"type":"EndSongGapVamp"})");
    CHECK(std::holds_alternative<CmdEndSongGapVamp>(end));
}

TEST_CASE("parse SetTrackMeterMode: camelCase names, unknown falls back to postFader") {
    auto mode_of = [](const char* json) {
        auto cmd = command_from_json(json);
        REQUIRE(std::holds_alternative<CmdSetTrackMeterMode>(cmd));
        return std::get<CmdSetTrackMeterMode>(cmd).mode;
    };
    CHECK(mode_of(R"({"type":"SetTrackMeterMode","mode":"postFader"})") == 0);
    CHECK(mode_of(R"({"type":"SetTrackMeterMode","mode":"postPan"})") == 1);
    CHECK(mode_of(R"({"type":"SetTrackMeterMode","mode":"preFader"})") == 2);
    CHECK(mode_of(R"({"type":"SetTrackMeterMode","mode":"nope"})") == 0);
    CHECK(mode_of(R"({"type":"SetTrackMeterMode"})") == 0);

    auto again = command_from_json(command_to_json(CmdSetTrackMeterMode{2}));
    REQUIRE(std::holds_alternative<CmdSetTrackMeterMode>(again));
    CHECK(std::get<CmdSetTrackMeterMode>(again).mode == 2);
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

// Three separate commands carry markers, each with its own parser. A dragged
// marker's lane arrives on SetSongMarkers, but the reload that follows every
// edit comes through SetSongTimelineWindow / UpsertSongTracks — so a parser
// that forgets category_override silently resets the lane and the marker goes
// back to being announced as its kind's category. Pin all three together.
TEST_CASE("every marker parser keeps category_override") {
    const std::string marker =
        R"({"id":"m1","name":"Repeticion","frame":1000,"kind":"tag","category_override":"cue"})";

    SUBCASE("SetSongMarkers") {
        auto cmd = command_from_json(
            R"({"type":"SetSongMarkers","song_id":"s","markers":[)" + marker + "]}");
        auto& c = std::get<CmdSetSongMarkers>(cmd);
        REQUIRE(c.markers.size() == 1);
        CHECK(c.markers[0].category_override == "cue");
    }

    SUBCASE("SetSongTimelineWindow") {
        auto cmd = command_from_json(
            R"({"type":"SetSongTimelineWindow","song_id":"s","clips":[],"regions":[],)"
            R"("markers":[)" + marker + R"(],"bpm":120,"beats_per_bar":4,"beat_unit":4,)"
            R"("tempo_markers":[],"time_signature_markers":[]})");
        auto& c = std::get<CmdSetSongTimelineWindow>(cmd);
        REQUIRE(c.markers.size() == 1);
        CHECK(c.markers[0].category_override == "cue");
    }

    SUBCASE("UpsertSongTracks") {
        auto cmd = command_from_json(
            R"({"type":"UpsertSongTracks","song_id":"s","tracks":[],"regions":[],)"
            R"("markers":[)" + marker + R"(],"bpm":120,"beats_per_bar":4,"beat_unit":4})");
        auto& c = std::get<CmdUpsertSongTracks>(cmd);
        REQUIRE(c.markers.size() == 1);
        CHECK(c.markers[0].category_override == "cue");
    }

    SUBCASE("absent means inherit, for callers that never send it") {
        auto cmd = command_from_json(
            R"({"type":"SetSongMarkers","song_id":"s","markers":[)"
            R"({"id":"m1","name":"Coro","frame":1000,"kind":"chorus"}]})");
        auto& c = std::get<CmdSetSongMarkers>(cmd);
        CHECK(c.markers[0].category_override.empty());
    }
}

TEST_CASE("parse SetSongTiming") {
    auto cmd = command_from_json(R"({
        "type":"SetSongTiming",
        "song_id":"song1",
        "bpm":132.5,
        "beats_per_bar":7,
        "beat_unit":8,
        "tempo_markers":[{"id":"tempo_a","frame":96000,"bpm":99.0},
                         {"id":"tempo_b","frame":192000,"bpm":80.0,"ramp":true}],
        "time_signature_markers":[{"id":"sig_a","frame":144000,"beats_per_bar":3,"beat_unit":4}]
    })");
    REQUIRE(std::holds_alternative<CmdSetSongTiming>(cmd));
    auto& c = std::get<CmdSetSongTiming>(cmd);
    CHECK(c.song_id == "song1");
    CHECK(c.bpm == doctest::Approx(132.5));
    CHECK(c.beats_per_bar == 7);
    CHECK(c.beat_unit == 8);
    REQUIRE(c.tempo_markers.size() == 2);
    CHECK(c.tempo_markers[0].id == "tempo_a");
    CHECK(c.tempo_markers[0].frame == 96000);
    CHECK(c.tempo_markers[0].bpm == doctest::Approx(99.0));
    // No "ramp" field: a step, as every session before ramps.
    CHECK_FALSE(c.tempo_markers[0].ramp);
    CHECK(c.tempo_markers[1].ramp);
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

TEST_CASE("parse SetSongTimelineWindow keeps region master_gain") {
    // Regression: warp/transpose edits go through SetSongTimelineWindow; if the
    // parser drops master_gain the song master fader snaps back to unity.
    auto cmd = command_from_json(R"({
        "type":"SetSongTimelineWindow",
        "song_id":"song1",
        "clips":[],
        "regions":[{"id":"reg1","name":"A","start_frame":0,"end_frame":480000,
                    "transpose_semitones":2,"warp_enabled":true,
                    "warp_source_bpm":91.0,"master_gain":0.46}],
        "markers":[],
        "bpm":128.0,"beats_per_bar":4,"beat_unit":4,
        "tempo_markers":[],"time_signature_markers":[]
    })");
    REQUIRE(std::holds_alternative<CmdSetSongTimelineWindow>(cmd));
    auto& c = std::get<CmdSetSongTimelineWindow>(cmd);
    REQUIRE(c.regions.size() == 1);
    CHECK(c.regions[0].master_gain == doctest::Approx(0.46f));
    CHECK(c.regions[0].warp_enabled == true);
    CHECK(c.regions[0].warp_source_bpm == doctest::Approx(91.0));

    // Absent field falls back to unity (older callers).
    auto legacy = command_from_json(R"({
        "type":"SetSongTimelineWindow",
        "song_id":"song1",
        "clips":[],
        "regions":[{"id":"reg1","start_frame":0,"end_frame":480000}],
        "markers":[],
        "bpm":128.0,"beats_per_bar":4,"beat_unit":4,
        "tempo_markers":[],"time_signature_markers":[]
    })");
    auto& l = std::get<CmdSetSongTimelineWindow>(legacy);
    REQUIRE(l.regions.size() == 1);
    CHECK(l.regions[0].master_gain == doctest::Approx(1.0f));
}

// Song fades ride along with the master gain through all three region parsers
// (SetSongRegions, SetSongTimelineWindow, UpsertSongTracks). A parser that drops
// them silently turns the song's fades off on that path.
TEST_CASE("every region parser keeps the song fades") {
    const char* region = R"({"id":"reg1","name":"A","start_frame":0,"end_frame":480000,
                             "master_gain":0.8,"fade_in_frames":4800,"fade_out_frames":9600})";
    auto check = [](const auto& regions) {
        REQUIRE(regions.size() == 1);
        CHECK(regions[0].fade_in_frames == 4800);
        CHECK(regions[0].fade_out_frames == 9600);
    };
    const std::string tail = R"(,"markers":[],"bpm":128.0,"beats_per_bar":4,"beat_unit":4,
                                "tempo_markers":[],"time_signature_markers":[]})";

    auto regions_cmd = command_from_json(
        std::string(R"({"type":"SetSongRegions","song_id":"s","regions":[)") + region + "]}");
    check(std::get<CmdSetSongRegions>(regions_cmd).regions);

    auto window_cmd = command_from_json(
        std::string(R"({"type":"SetSongTimelineWindow","song_id":"s","clips":[],"regions":[)")
        + region + "]" + tail);
    check(std::get<CmdSetSongTimelineWindow>(window_cmd).regions);

    auto upsert_cmd = command_from_json(
        std::string(R"({"type":"UpsertSongTracks","song_id":"s","tracks":[],"sources":[],"regions":[)")
        + region + "]" + tail);
    check(std::get<CmdUpsertSongTracks>(upsert_cmd).regions);
}

// The per-song voice-guide count style rides the same three region parsers. A
// parser that drops it makes the song fall back to the global count style on
// that path (e.g. after a warp/transpose edit), which is the desync that the
// master_gain bug already showed.
TEST_CASE("every region parser keeps the voice-guide count style") {
    const char* region = R"({"id":"reg1","name":"A","start_frame":0,"end_frame":480000,
                             "voice_guide_count_style":2})";
    const char* legacy = R"({"id":"reg2","name":"B","start_frame":480000,"end_frame":960000})";
    auto check = [](const auto& regions) {
        REQUIRE(regions.size() == 2);
        CHECK(regions[0].voice_guide_count_style == 2);
        CHECK(regions[1].voice_guide_count_style == -1);   // absent = follow global
    };
    const std::string list = std::string(region) + "," + legacy;
    const std::string tail = R"(,"markers":[],"bpm":128.0,"beats_per_bar":4,"beat_unit":4,
                                "tempo_markers":[],"time_signature_markers":[]})";

    auto regions_cmd = command_from_json(
        std::string(R"({"type":"SetSongRegions","song_id":"s","regions":[)") + list + "]}");
    check(std::get<CmdSetSongRegions>(regions_cmd).regions);

    auto window_cmd = command_from_json(
        std::string(R"({"type":"SetSongTimelineWindow","song_id":"s","clips":[],"regions":[)")
        + list + "]" + tail);
    check(std::get<CmdSetSongTimelineWindow>(window_cmd).regions);

    auto upsert_cmd = command_from_json(
        std::string(R"({"type":"UpsertSongTracks","song_id":"s","tracks":[],"sources":[],"regions":[)")
        + list + "]" + tail);
    check(std::get<CmdUpsertSongTracks>(upsert_cmd).regions);
}

TEST_CASE("parse SetVoiceGuideConfig keeps the count style and round-trips it") {
    auto cmd = command_from_json(
        R"({"type":"SetVoiceGuideConfig","enabled":true,"volume":1.0,"route":"monitor",)"
        R"("lead_bars":1,"count_in_enabled":true,"count_style":1})");
    CHECK(std::get<CmdSetVoiceGuideConfig>(cmd).count_style == 1);
    auto again = command_from_json(command_to_json(cmd));
    CHECK(std::get<CmdSetVoiceGuideConfig>(again).count_style == 1);

    // Older hosts never send it: the original "1 2 3 4".
    auto legacy = command_from_json(
        R"({"type":"SetVoiceGuideConfig","enabled":true,"volume":1.0})");
    CHECK(std::get<CmdSetVoiceGuideConfig>(legacy).count_style == 0);
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
    snap.cpu.callback_over_budget_count = 7;
    snap.cpu.callback_deadline_miss_count = 2;

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
    CHECK(json.find("\"callback_over_budget_count\":7") != std::string::npos);
    CHECK(json.find("\"callback_deadline_miss_count\":2") != std::string::npos);
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

// Plan channel-split, paso 02. El parser de comandos y el adaptador de sesion
// van en espejo: channel_mode manda; si falta, el viejo mono_downmix=true es
// Mono (invitados y sesiones de versiones anteriores).
TEST_CASE("UpsertSongTracks: channel_mode, con caida al viejo mono_downmix") {
    const auto parse_one = [](const std::string& track_fields) {
        auto cmd = command_from_json(
            R"({"type":"UpsertSongTracks","song_id":"s","tracks":[{"id":"t")" + track_fields +
            R"(}],"regions":[],"markers":[],"bpm":120,"beats_per_bar":4,"beat_unit":4})");
        return std::get<CmdUpsertSongTracks>(cmd).tracks.at(0).channel_mode;
    };
    CHECK(parse_one("") == "");
    CHECK(parse_one(R"(,"mono_downmix":true)") == "mono");
    CHECK(parse_one(R"(,"mono_downmix":false)") == "");
    CHECK(parse_one(R"(,"channel_mode":"right")") == "right");
    CHECK(parse_one(R"(,"channel_mode":"left","mono_downmix":true)") == "left");
}
