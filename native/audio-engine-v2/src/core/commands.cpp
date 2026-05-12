#include <lt_engine/core/commands.h>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <type_traits>

namespace lt {

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static JumpTarget jump_target_from_json(const json& j) {
    JumpTarget t;
    std::string kind_str = j.at("kind").get<std::string>();
    if      (kind_str == "Marker")       t.kind = JumpTarget::Kind::Marker;
    else if (kind_str == "Region")       t.kind = JumpTarget::Kind::Region;
    else if (kind_str == "Song")         t.kind = JumpTarget::Kind::Song;
    else if (kind_str == "NextSong")     t.kind = JumpTarget::Kind::NextSong;
    else if (kind_str == "PreviousSong") t.kind = JumpTarget::Kind::PreviousSong;
    else if (kind_str == "Frame")        t.kind = JumpTarget::Kind::Frame;
    else throw std::invalid_argument("Unknown JumpTarget::Kind: " + kind_str);

    if (j.contains("id"))    t.id    = j["id"].get<Id>();
    if (j.contains("frame")) t.frame = j["frame"].get<Frame>();
    return t;
}

static JumpTrigger trigger_from_json(const json& j) {
    std::string s = j.get<std::string>();
    if      (s == "Immediate")    return JumpTrigger::Immediate;
    else if (s == "AtRegionEnd")  return JumpTrigger::AtRegionEnd;
    else if (s == "AtSongEnd")    return JumpTrigger::AtSongEnd;
    else if (s == "AtFrame")      return JumpTrigger::AtFrame;
    throw std::invalid_argument("Unknown JumpTrigger: " + s);
}

// ---------------------------------------------------------------------------
// command_from_json
// ---------------------------------------------------------------------------
EngineCommand command_from_json(const std::string& raw) {
    json j = json::parse(raw);
    std::string type = j.at("type").get<std::string>();

    if (type == "LoadSession")
        return CmdLoadSession{ j.at("project_json").get<std::string>() };

    if (type == "Play")    return CmdPlay{};
    if (type == "Pause")   return CmdPause{};
    if (type == "Stop")    return CmdStop{};

    if (type == "SeekAbsolute")
        return CmdSeekAbsolute{ j.at("frame").get<Frame>() };

    if (type == "SeekRelative")
        return CmdSeekRelative{ j.at("delta_frames").get<Frame>() };

    if (type == "JumpToMarker")
        return CmdJumpToMarker{ j.at("marker_id").get<Id>() };

    if (type == "JumpToRegion")
        return CmdJumpToRegion{ j.at("region_id").get<Id>() };

    if (type == "JumpToSong")
        return CmdJumpToSong{ j.at("song_id").get<Id>() };

    if (type == "JumpToNextSong")       return CmdJumpToNextSong{};
    if (type == "JumpToPreviousSong")   return CmdJumpToPreviousSong{};

    if (type == "ScheduleJump") {
        CmdScheduleJump cmd;
        cmd.jump_id = j.at("jump_id").get<Id>();
        cmd.target  = jump_target_from_json(j.at("target"));
        cmd.trigger = trigger_from_json(j.at("trigger"));
        return cmd;
    }

    if (type == "CancelScheduledJump")
        return CmdCancelScheduledJump{ j.at("jump_id").get<Id>() };

    if (type == "CancelAllScheduledJumps")
        return CmdCancelAllScheduledJumps{};

    if (type == "ReplaceScheduledJump") {
        CmdReplaceScheduledJump cmd;
        cmd.jump_id     = j.at("jump_id").get<Id>();
        cmd.new_target  = jump_target_from_json(j.at("new_target"));
        cmd.new_trigger = trigger_from_json(j.at("new_trigger"));
        return cmd;
    }

    if (type == "SetTrackGain")
        return CmdSetTrackGain{ j.at("track_id").get<Id>(), j.at("gain").get<float>() };

    if (type == "SetTrackPan")
        return CmdSetTrackPan{ j.at("track_id").get<Id>(), j.at("pan").get<float>() };

    if (type == "SetTrackMute")
        return CmdSetTrackMute{ j.at("track_id").get<Id>(), j.at("mute").get<bool>() };

    if (type == "SetTrackSolo")
        return CmdSetTrackSolo{ j.at("track_id").get<Id>(), j.at("solo").get<bool>() };

    if (type == "SetTrackAudioRoute")
        return CmdSetTrackAudioRoute{ j.at("track_id").get<Id>(), j.at("audio_to").get<std::string>() };

    if (type == "SetTrackTransposeEnabled")
        return CmdSetTrackTransposeEnabled{ j.at("track_id").get<Id>(), j.at("enabled").get<bool>() };

    if (type == "SetSongTranspose")
        return CmdSetSongTranspose{ j.at("song_id").get<Id>(), j.at("semitones").get<Semitones>() };

    if (type == "SetRegionTranspose")
        return CmdSetRegionTranspose{ j.at("region_id").get<Id>(), j.at("semitones").get<Semitones>() };

    if (type == "SetOutputDevice")
        return CmdSetOutputDevice{ j.at("device_id").get<std::string>() };

    if (type == "SetSampleRate")
        return CmdSetSampleRate{ j.at("sample_rate").get<int>() };

    if (type == "SetBufferSize")
        return CmdSetBufferSize{ j.at("buffer_size").get<int>() };

    throw std::invalid_argument("Unknown command type: " + type);
}

// ---------------------------------------------------------------------------
// command_to_json
// ---------------------------------------------------------------------------
std::string command_to_json(const EngineCommand& cmd) {
    json j;
    std::visit([&j](auto&& c) {
        using T = std::decay_t<decltype(c)>;
        if constexpr (std::is_same_v<T, CmdPlay>)   { j["type"] = "Play"; }
        else if constexpr (std::is_same_v<T, CmdPause>)  { j["type"] = "Pause"; }
        else if constexpr (std::is_same_v<T, CmdStop>)   { j["type"] = "Stop"; }
        else if constexpr (std::is_same_v<T, CmdSeekAbsolute>) {
            j["type"] = "SeekAbsolute"; j["frame"] = c.frame;
        }
        else if constexpr (std::is_same_v<T, CmdSeekRelative>) {
            j["type"] = "SeekRelative"; j["delta_frames"] = c.delta_frames;
        }
        // ... additional types follow the same pattern.
        // Omitted for brevity — expand as needed.
    }, cmd);
    return j.dump();
}

} // namespace lt
