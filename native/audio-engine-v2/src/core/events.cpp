#include <lt_engine/core/events.h>
#include <nlohmann/json.hpp>

namespace lt {

using json = nlohmann::json;

std::string event_to_json(const EngineEvent& ev) {
    json j;
    std::visit([&j](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, EvPlaybackStarted>) {
            j["type"] = "PlaybackStarted"; j["frame"] = e.frame;
        } else if constexpr (std::is_same_v<T, EvPlaybackPaused>) {
            j["type"] = "PlaybackPaused";  j["frame"] = e.frame;
        } else if constexpr (std::is_same_v<T, EvPlaybackStopped>) {
            j["type"] = "PlaybackStopped"; j["frame"] = e.frame;
        } else if constexpr (std::is_same_v<T, EvSeekExecuted>) {
            j["type"] = "SeekExecuted";
            j["from_frame"] = e.from_frame;
            j["to_frame"]   = e.to_frame;
        } else if constexpr (std::is_same_v<T, EvJumpScheduled>) {
            j["type"]               = "JumpScheduled";
            j["jump_id"]            = e.jump_id;
            j["target_description"] = e.target_description;
        } else if constexpr (std::is_same_v<T, EvJumpCancelled>) {
            j["type"]    = "JumpCancelled";
            j["jump_id"] = e.jump_id;
        } else if constexpr (std::is_same_v<T, EvJumpExecuted>) {
            j["type"]       = "JumpExecuted";
            j["jump_id"]    = e.jump_id;
            j["from_frame"] = e.from_frame;
            j["to_frame"]   = e.to_frame;
        } else if constexpr (std::is_same_v<T, EvJumpFailed>) {
            j["type"]    = "JumpFailed";
            j["jump_id"] = e.jump_id;
            j["reason"]  = e.reason;
        } else if constexpr (std::is_same_v<T, EvDeviceChanged>) {
            j["type"]        = "DeviceChanged";
            j["device_id"]   = e.device_id;
            j["device_name"] = e.device_name;
            j["sample_rate"] = e.sample_rate;
            j["buffer_size"] = e.buffer_size;
        } else if constexpr (std::is_same_v<T, EvDeviceError>) {
            j["type"]    = "DeviceError";
            j["message"] = e.message;
        } else if constexpr (std::is_same_v<T, EvSourcePrepared>) {
            j["type"]      = "SourcePrepared";
            j["source_id"] = e.source_id;
        } else if constexpr (std::is_same_v<T, EvSourceStarved>) {
            j["type"]      = "SourceStarved";
            j["source_id"] = e.source_id;
            j["track_id"]  = e.track_id;
        } else if constexpr (std::is_same_v<T, EvPitchCachePrepared>) {
            j["type"]      = "PitchCachePrepared";
            j["source_id"] = e.source_id;
            j["semitones"] = e.semitones;
        } else if constexpr (std::is_same_v<T, EvDiagnosticWarning>) {
            j["type"]    = "DiagnosticWarning";
            j["message"] = e.message;
        }
    }, ev);
    return j.dump();
}

} // namespace lt
