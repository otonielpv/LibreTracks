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
        if (j.contains("trigger_frame"))
            cmd.trigger_frame = j.at("trigger_frame").get<Frame>();
        if (j.contains("suppress_seek_fade"))
            cmd.suppress_seek_fade = j.at("suppress_seek_fade").get<bool>();
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

    if (type == "StartMasterFade")
        return CmdStartMasterFade{
            j.at("target_gain").get<float>(),
            j.at("duration_seconds").get<double>()
        };

    if (type == "SetMetronomeEnabled")
        return CmdSetMetronomeEnabled{ j.at("enabled").get<bool>() };

    if (type == "SetMetronomeVolume")
        return CmdSetMetronomeVolume{ j.at("volume").get<float>() };

    if (type == "SetMetronomeOutputRoute")
        return CmdSetMetronomeOutputRoute{ j.at("route").get<std::string>() };

    if (type == "SetMetronomeConfig")
        return CmdSetMetronomeConfig{
            j.at("enabled").get<bool>(),
            j.at("volume").get<float>(),
            j.at("route").get<std::string>()
        };

    if (type == "SetSongTranspose")
        return CmdSetSongTranspose{ j.at("song_id").get<Id>(), j.at("semitones").get<Semitones>() };

    if (type == "SetRegionTranspose")
        return CmdSetRegionTranspose{ j.at("region_id").get<Id>(), j.at("semitones").get<Semitones>() };

    if (type == "SetRegionWarp") {
        CmdSetRegionWarp cmd;
        cmd.region_id = j.at("region_id").get<Id>();
        cmd.warp_enabled = j.value("warp_enabled", false);
        cmd.warp_source_bpm = j.value("warp_source_bpm", 0.0);
        return cmd;
    }

    if (type == "SetSongRegions") {
        CmdSetSongRegions cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        for (const auto& item : j.at("regions")) {
            CmdSetSongRegions::RegionUpdate region;
            region.id = item.at("id").get<Id>();
            region.name = item.value("name", std::string{});
            region.start_frame = item.at("start_frame").get<Frame>();
            region.end_frame = item.at("end_frame").get<Frame>();
            region.transpose_semitones =
                item.value("transpose_semitones", static_cast<Semitones>(0));
            region.warp_enabled = item.value("warp_enabled", false);
            region.warp_source_bpm = item.value("warp_source_bpm", 0.0);
            cmd.regions.push_back(std::move(region));
        }
        return cmd;
    }

    if (type == "SetSongMarkers") {
        CmdSetSongMarkers cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        for (const auto& item : j.at("markers")) {
            CmdSetSongMarkers::MarkerUpdate marker;
            marker.id = item.at("id").get<Id>();
            marker.name = item.value("name", std::string{});
            marker.frame = item.at("frame").get<Frame>();
            cmd.markers.push_back(std::move(marker));
        }
        return cmd;
    }

    if (type == "SetSongTiming") {
        CmdSetSongTiming cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        cmd.bpm = j.at("bpm").get<double>();
        cmd.beats_per_bar = j.at("beats_per_bar").get<int>();
        cmd.beat_unit = j.at("beat_unit").get<int>();
        for (const auto& item : j.at("tempo_markers")) {
            CmdSetSongTiming::TempoMarkerUpdate marker;
            marker.id = item.at("id").get<Id>();
            marker.frame = item.at("frame").get<Frame>();
            marker.bpm = item.at("bpm").get<double>();
            cmd.tempo_markers.push_back(std::move(marker));
        }
        for (const auto& item : j.at("time_signature_markers")) {
            CmdSetSongTiming::TimeSignatureMarkerUpdate marker;
            marker.id = item.at("id").get<Id>();
            marker.frame = item.at("frame").get<Frame>();
            marker.beats_per_bar = item.at("beats_per_bar").get<int>();
            marker.beat_unit = item.at("beat_unit").get<int>();
            cmd.time_signature_markers.push_back(std::move(marker));
        }
        return cmd;
    }

    if (type == "SetOutputDevice") {
        CmdSetOutputDevice cmd;
        cmd.device_id = j.at("device_id").get<std::string>();
        if (auto it = j.find("active_channels"); it != j.end() && it->is_array()) {
            cmd.active_channels.reserve(it->size());
            for (const auto& ch : *it)
                cmd.active_channels.push_back(ch.get<int>());
        }
        return cmd;
    }

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
        else if constexpr (std::is_same_v<T, CmdSetMetronomeEnabled>) {
            j["type"] = "SetMetronomeEnabled"; j["enabled"] = c.enabled;
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeVolume>) {
            j["type"] = "SetMetronomeVolume"; j["volume"] = c.volume;
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeOutputRoute>) {
            j["type"] = "SetMetronomeOutputRoute"; j["route"] = c.route;
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeConfig>) {
            j["type"] = "SetMetronomeConfig";
            j["enabled"] = c.enabled;
            j["volume"] = c.volume;
            j["route"] = c.route;
        }
        // ... additional types follow the same pattern.
        // Omitted for brevity — expand as needed.
    }, cmd);
    return j.dump();
}

} // namespace lt
