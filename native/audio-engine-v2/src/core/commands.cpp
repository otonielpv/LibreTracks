#include <lt_engine/core/commands.h>
#include <nlohmann/json.hpp>

#include "session/track_eq_json.h"
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
namespace {

LoopPatternSpec loop_pattern_from_json(const nlohmann::json& j) {
    LoopPatternSpec p;
    if (!j.is_object()) return p;
    p.steps_per_beat = j.value("steps_per_beat", 4);
    p.beats_per_bar = j.value("beats_per_bar", 4);
    p.beat_unit = j.value("beat_unit", 4);
    p.bars = j.value("bars", 1);
    p.free_bpm = j.value("free_bpm", 120.0);
    p.swing = j.value("swing", 0.0);
    if (j.contains("rows") && j["rows"].is_array()) {
        for (const auto& jr : j["rows"]) {
            LoopPatternRowSpec row;
            row.slot = jr.value("slot", -1);
            row.gain = jr.value("gain", 1.0f);
            row.choke_group = jr.value("choke_group", 0);
            if (jr.contains("variations") && jr["variations"].is_array()) {
                for (const auto& jv : jr["variations"]) {
                    std::vector<int> steps;
                    if (jv.is_array())
                        for (const auto& s : jv) steps.push_back(s.is_number() ? s.get<int>() : 0);
                    row.variations.push_back(std::move(steps));
                }
            }
            p.rows.push_back(std::move(row));
        }
    }
    return p;
}

nlohmann::json loop_pattern_to_json(const LoopPatternSpec& p) {
    nlohmann::json j;
    j["steps_per_beat"] = p.steps_per_beat;
    j["beats_per_bar"] = p.beats_per_bar;
    j["beat_unit"] = p.beat_unit;
    j["bars"] = p.bars;
    j["free_bpm"] = p.free_bpm;
    j["swing"] = p.swing;
    auto rows = nlohmann::json::array();
    for (const auto& row : p.rows) {
        nlohmann::json jr;
        jr["slot"] = row.slot;
        jr["gain"] = row.gain;
        jr["choke_group"] = row.choke_group;
        jr["variations"] = row.variations;
        rows.push_back(std::move(jr));
    }
    j["rows"] = std::move(rows);
    return j;
}

std::vector<LoopRowStateSpec> loop_rows_from_json(const nlohmann::json& j, const char* key) {
    std::vector<LoopRowStateSpec> rows;
    if (!j.contains(key) || !j[key].is_array()) return rows;
    for (const auto& jr : j[key]) {
        LoopRowStateSpec r;
        r.enabled = jr.value("enabled", true);
        r.variation = jr.value("variation", 0);
        rows.push_back(r);
    }
    return rows;
}

} // namespace

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
    if (type == "SetTrackEq") {
        // Lectura tolerante: sin `eq`, `null` o algo que no es un objeto =
        // quitar el EQ; campos desconocidos se ignoran.
        CmdSetTrackEq cmd;
        cmd.track_id = j.at("track_id").get<Id>();
        if (auto it = j.find("eq"); it != j.end())
            cmd.eq = parse_track_eq_json(*it);
        return cmd;
    }

    if (type == "SetTrackMute")
        return CmdSetTrackMute{ j.at("track_id").get<Id>(), j.at("mute").get<bool>() };

    if (type == "SetTrackSolo")
        return CmdSetTrackSolo{ j.at("track_id").get<Id>(), j.at("solo").get<bool>() };

    if (type == "SetTrackAudioRoute")
        return CmdSetTrackAudioRoute{ j.at("track_id").get<Id>(), j.at("audio_to").get<std::string>() };

    if (type == "SetTrackTransposeEnabled")
        return CmdSetTrackTransposeEnabled{ j.at("track_id").get<Id>(), j.at("enabled").get<bool>() };

    if (type == "SetPilotTone")
        return CmdSetPilotTone{
            j.at("enabled").get<bool>(),
            j.at("channel").get<int>(),
            j.at("frequency_hz").get<double>(),
            j.at("level_db").get<float>()
        };

    if (type == "StartMasterFade")
        return CmdStartMasterFade{
            j.at("target_gain").get<float>(),
            j.at("duration_seconds").get<double>()
        };

    if (type == "SetMetronomeEnabled")
        return CmdSetMetronomeEnabled{ j.at("enabled").get<bool>() };

    if (type == "SetMetronomeVolume")
        return CmdSetMetronomeVolume{ j.at("volume").get<float>() };
    if (type == "SetRenderThreads")
        return CmdSetRenderThreads{ j.at("threads").get<int>() };

    if (type == "SetMetronomeOutputRoute")
        return CmdSetMetronomeOutputRoute{ j.at("route").get<std::string>() };

    if (type == "SetMetronomeConfig") {
        CmdSetMetronomeConfig c;
        c.enabled = j.at("enabled").get<bool>();
        c.volume = j.at("volume").get<float>();
        c.route = j.at("route").get<std::string>();
        c.accent_enabled = j.value("accent_enabled", true);
        c.accent_preset = j.value("accent_preset", 0);
        c.beat_preset = j.value("beat_preset", 0);
        c.accent_pitch = j.value("accent_pitch", 0.0f);
        c.beat_pitch = j.value("beat_pitch", 0.0f);
        c.subdivision = j.value("subdivision", 1);
        c.subdivision_preset = j.value("subdivision_preset", 0);
        c.subdivision_pitch = j.value("subdivision_pitch", 0.0f);
        c.subdivision_gain = j.value("subdivision_gain", 0.5f);
        return c;
    }

    if (type == "SetVoiceGuideConfig") {
        CmdSetVoiceGuideConfig c;
        c.enabled = j.at("enabled").get<bool>();
        c.volume = j.at("volume").get<float>();
        c.route = j.value("route", std::string{"monitor"});
        c.lead_bars = j.value("lead_bars", 1);
        c.count_in_enabled = j.value("count_in_enabled", true);
        c.count_style = j.value("count_style", 0);
        return c;
    }

    if (type == "LoadVoiceGuideBank") {
        CmdLoadVoiceGuideBank c;
        c.voices_dir = j.value("voices_dir", std::string{});
        c.lang = j.value("lang", std::string{});
        return c;
    }

    if (type == "SetPadConfig") {
        CmdSetPadConfig c;
        c.enabled = j.value("enabled", false);
        c.volume = j.value("volume", 1.0f);
        c.route = j.value("route", std::string{"master"});
        c.key = j.value("key", 0);
        c.pad_id = j.value("pad_id", std::string{});
        c.fade_in_seconds = j.value("fade_in_seconds", 0.0f);
        c.fade_out_seconds = j.value("fade_out_seconds", 0.0f);
        c.stop_with_transport = j.value("stop_with_transport", false);
        return c;
    }

    if (type == "LoadPadClip") {
        CmdLoadPadClip c;
        c.pads_dir = j.value("pads_dir", std::string{});
        c.pad_id = j.value("pad_id", std::string{});
        c.key = j.value("key", 0);
        return c;
    }

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

    if (type == "SetRegionMasterGain") {
        CmdSetRegionMasterGain cmd;
        cmd.region_id = j.at("region_id").get<Id>();
        cmd.master_gain = j.value("master_gain", 1.0f);
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
            region.master_gain = item.value("master_gain", 1.0f);
            region.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
            region.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
            region.voice_guide_count_style = item.value("voice_guide_count_style", -1);
            cmd.regions.push_back(std::move(region));
        }
        return cmd;
    }

    if (type == "SetSongClips") {
        CmdSetSongClips cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        for (const auto& item : j.at("clips")) {
            CmdSetSongClips::ClipUpdate clip;
            clip.id = item.at("id").get<Id>();
            clip.track_id = item.at("track_id").get<Id>();
            clip.source_id = item.at("source_id").get<Id>();
            clip.timeline_start_frame = item.at("timeline_start_frame").get<Frame>();
            clip.source_start_frame = item.at("source_start_frame").get<Frame>();
            clip.length_frames = item.at("length_frames").get<Frame>();
            clip.gain = item.value("gain", 1.0f);
            clip.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
            clip.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
            clip.fade_in_curve_x = item.value("fade_in_curve_x", 0.5f);
            clip.fade_in_curve_y = item.value("fade_in_curve_y", 0.5f);
            clip.fade_out_curve_x = item.value("fade_out_curve_x", 0.5f);
            clip.fade_out_curve_y = item.value("fade_out_curve_y", 0.5f);
            clip.semitones = item.value("semitones", static_cast<Semitones>(0));
            cmd.clips.push_back(std::move(clip));
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
            marker.kind = item.value("kind", std::string{});
            marker.variant = item.value("variant", 0);
            marker.category_override = item.value("category_override", std::string{});
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
            marker.ramp = item.value("ramp", false);
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

    if (type == "SetSongTimelineWindow") {
        CmdSetSongTimelineWindow cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        cmd.bpm = j.at("bpm").get<double>();
        cmd.beats_per_bar = j.at("beats_per_bar").get<int>();
        cmd.beat_unit = j.at("beat_unit").get<int>();
        cmd.live = j.value("live", false);
        for (const auto& item : j.at("clips")) {
            CmdSetSongClips::ClipUpdate clip;
            clip.id = item.at("id").get<Id>();
            clip.track_id = item.at("track_id").get<Id>();
            clip.source_id = item.at("source_id").get<Id>();
            clip.timeline_start_frame = item.at("timeline_start_frame").get<Frame>();
            clip.source_start_frame = item.at("source_start_frame").get<Frame>();
            clip.length_frames = item.at("length_frames").get<Frame>();
            clip.gain = item.value("gain", 1.0f);
            clip.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
            clip.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
            clip.fade_in_curve_x = item.value("fade_in_curve_x", 0.5f);
            clip.fade_in_curve_y = item.value("fade_in_curve_y", 0.5f);
            clip.fade_out_curve_x = item.value("fade_out_curve_x", 0.5f);
            clip.fade_out_curve_y = item.value("fade_out_curve_y", 0.5f);
            clip.semitones = item.value("semitones", static_cast<Semitones>(0));
            cmd.clips.push_back(std::move(clip));
        }
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
            region.master_gain = item.value("master_gain", 1.0f);
            region.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
            region.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
            region.voice_guide_count_style = item.value("voice_guide_count_style", -1);
            cmd.regions.push_back(std::move(region));
        }
        for (const auto& item : j.at("markers")) {
            CmdSetSongMarkers::MarkerUpdate marker;
            marker.id = item.at("id").get<Id>();
            marker.name = item.value("name", std::string{});
            marker.frame = item.at("frame").get<Frame>();
            marker.kind = item.value("kind", std::string{});
            marker.variant = item.value("variant", 0);
            marker.category_override = item.value("category_override", std::string{});
            cmd.markers.push_back(std::move(marker));
        }
        for (const auto& item : j.at("tempo_markers")) {
            CmdSetSongTiming::TempoMarkerUpdate marker;
            marker.id = item.at("id").get<Id>();
            marker.frame = item.at("frame").get<Frame>();
            marker.bpm = item.at("bpm").get<double>();
            marker.ramp = item.value("ramp", false);
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

    if (type == "UpsertSongTracks") {
        CmdUpsertSongTracks cmd;
        cmd.song_id = j.at("song_id").get<Id>();
        for (const auto& t : j.at("tracks")) {
            CmdUpsertSongTracks::TrackUpdate track;
            track.id   = t.at("id").get<Id>();
            track.name = t.value("name", std::string{});
            track.gain = t.value("gain", 1.0f);
            track.pan  = t.value("pan", 0.0f);
            track.audio_to = t.value("audio_to", std::string{"master"});
            // Espejo de session_adapter.cpp: channel_mode manda; si falta, el
            // viejo mono_downmix=true es Mono.
            track.channel_mode = t.value("channel_mode", std::string{});
            if (track.channel_mode.empty() && t.value("mono_downmix", false))
                track.channel_mode = "mono";
            track.mute = t.value("mute", false);
            track.solo = t.value("solo", false);
            track.transpose_behavior = t.value("transpose_behavior", std::string{});
            track.role = t.value("role", std::string{});
            track.kind = t.value("kind", std::string{});
            track.parent_track_id = t.value("parent_track_id", std::string{});
            // Espejo de session_adapter.cpp (mismo lector) y solo en audio.
            if (track.kind.empty() || track.kind == "audio") {
                if (auto it = t.find("eq"); it != t.end())
                    track.eq = parse_track_eq_json(*it);
            }
            if (auto it = t.find("clips"); it != t.end() && it->is_array()) {
                for (const auto& item : *it) {
                    CmdUpsertSongTracks::ClipUpdate clip;
                    clip.id = item.at("id").get<Id>();
                    clip.source_id = item.at("source_id").get<Id>();
                    clip.timeline_start_frame = item.at("timeline_start_frame").get<Frame>();
                    clip.source_start_frame = item.at("source_start_frame").get<Frame>();
                    clip.length_frames = item.at("length_frames").get<Frame>();
                    clip.gain = item.value("gain", 1.0f);
                    clip.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
                    clip.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
                    clip.fade_in_curve_x = item.value("fade_in_curve_x", 0.5f);
                    clip.fade_in_curve_y = item.value("fade_in_curve_y", 0.5f);
                    clip.fade_out_curve_x = item.value("fade_out_curve_x", 0.5f);
                    clip.fade_out_curve_y = item.value("fade_out_curve_y", 0.5f);
                    clip.semitones = item.value("semitones", static_cast<Semitones>(0));
                    track.clips.push_back(std::move(clip));
                }
            }
            cmd.tracks.push_back(std::move(track));
        }
        if (auto it = j.find("sources"); it != j.end() && it->is_array()) {
            for (const auto& s : *it) {
                CmdUpsertSongTracks::SourceRef sref;
                sref.id = s.at("id").get<Id>();
                sref.file_path = s.value("file_path", std::string{});
                cmd.sources.push_back(std::move(sref));
            }
        }
        if (auto it = j.find("regions"); it != j.end() && it->is_array()) {
            for (const auto& item : *it) {
                CmdSetSongRegions::RegionUpdate region;
                region.id = item.at("id").get<Id>();
                region.name = item.value("name", std::string{});
                region.start_frame = item.at("start_frame").get<Frame>();
                region.end_frame = item.at("end_frame").get<Frame>();
                region.transpose_semitones = item.value("transpose_semitones", static_cast<Semitones>(0));
                region.warp_enabled = item.value("warp_enabled", false);
                region.warp_source_bpm = item.value("warp_source_bpm", 0.0);
                region.master_gain = item.value("master_gain", 1.0f);
                region.fade_in_frames = item.value("fade_in_frames", static_cast<Frame>(0));
                region.fade_out_frames = item.value("fade_out_frames", static_cast<Frame>(0));
                region.voice_guide_count_style = item.value("voice_guide_count_style", -1);
                cmd.regions.push_back(std::move(region));
            }
        }
        if (auto it = j.find("markers"); it != j.end() && it->is_array()) {
            for (const auto& item : *it) {
                CmdSetSongMarkers::MarkerUpdate marker;
                marker.id = item.at("id").get<Id>();
                marker.name = item.value("name", std::string{});
                marker.frame = item.at("frame").get<Frame>();
                marker.kind = item.value("kind", std::string{});
                marker.variant = item.value("variant", 0);
                // Must mirror the other two marker parsers above. Omitting this
                // silently reset a dragged marker's lane: SetSongMarkers
                // delivered the override, then the reload that follows every
                // edit came through here and dropped it, so the engine went
                // back to announcing the marker as its kind's category.
                marker.category_override = item.value("category_override", std::string{});
                cmd.markers.push_back(std::move(marker));
            }
        }
        cmd.bpm = j.value("bpm", 120.0);
        cmd.beats_per_bar = j.value("beats_per_bar", 4);
        cmd.beat_unit = j.value("beat_unit", 4);
        if (auto it = j.find("tempo_markers"); it != j.end() && it->is_array()) {
            for (const auto& item : *it) {
                CmdSetSongTiming::TempoMarkerUpdate marker;
                marker.id = item.at("id").get<Id>();
                marker.frame = item.at("frame").get<Frame>();
                marker.bpm = item.at("bpm").get<double>();
                marker.ramp = item.value("ramp", false);
                cmd.tempo_markers.push_back(std::move(marker));
            }
        }
        if (auto it = j.find("time_signature_markers"); it != j.end() && it->is_array()) {
            for (const auto& item : *it) {
                CmdSetSongTiming::TimeSignatureMarkerUpdate marker;
                marker.id = item.at("id").get<Id>();
                marker.frame = item.at("frame").get<Frame>();
                marker.beats_per_bar = item.at("beats_per_bar").get<int>();
                marker.beat_unit = item.at("beat_unit").get<int>();
                cmd.time_signature_markers.push_back(std::move(marker));
            }
        }
        return cmd;
    }

    if (type == "PrepareSources") {
        CmdPrepareSources cmd;
        if (auto it = j.find("sources"); it != j.end() && it->is_array()) {
            for (const auto& s : *it) {
                CmdPrepareSources::SourceRef sref;
                sref.id = s.at("id").get<Id>();
                sref.file_path = s.value("file_path", std::string{});
                cmd.sources.push_back(std::move(sref));
            }
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

    if (type == "SetPauseAtSongEnd")
        return CmdSetPauseAtSongEnd{ j.at("enabled").get<bool>() };

    if (type == "SetSongGapVamp")
        return CmdSetSongGapVamp{ j.at("enabled").get<bool>() };

    if (type == "EndSongGapVamp")
        return CmdEndSongGapVamp{};

    if (type == "SetLoopPattern") {
        CmdSetLoopPattern c;
        if (j.contains("pattern")) c.pattern = loop_pattern_from_json(j["pattern"]);
        return c;
    }

    if (type == "SetLoopTransport")
        return CmdSetLoopTransport{ j.value("playing", false) };

    if (type == "SetLoopRow") {
        CmdSetLoopRow c;
        c.row = j.value("row", 0);
        if (j.contains("enabled") && j["enabled"].is_boolean()) c.enabled = j["enabled"].get<bool>();
        if (j.contains("variation") && j["variation"].is_number()) c.variation = j["variation"].get<int>();
        return c;
    }

    if (type == "SetLoopAllRows")
        return CmdSetLoopAllRows{ j.value("variation", 0) };

    if (type == "SetLoopConfig") {
        CmdSetLoopConfig c;
        c.clock_mode = j.value("clock_mode", std::string{"follow"});
        c.free_bpm = j.value("free_bpm", 0.0);
        c.quantize = j.value("quantize", std::string{"bar"});
        c.route = j.value("route", std::string{"master"});
        c.gain = j.value("gain", 1.0f);
        c.follow_transport = j.value("follow_transport", true);
        return c;
    }

    if (type == "SetOneShotBank") {
        CmdSetOneShotBank c;
        if (j.contains("pads") && j["pads"].is_array()) {
            for (const auto& jp : j["pads"]) {
                OneShotPadSpec p;
                if (!jp.is_object()) {
                    c.pads.push_back(p);  // hueco vacío
                    continue;
                }
                p.slot = jp.value("slot", -1);
                p.gain = jp.value("gain", 1.0f);
                p.mode = jp.value("mode", std::string{"oneShot"});
                p.quantize = jp.value("quantize", std::string{"off"});
                p.choke_group = jp.value("choke_group", 0);
                c.pads.push_back(std::move(p));
            }
        }
        return c;
    }

    if (type == "SetOneShotConfig") {
        CmdSetOneShotConfig c;
        c.route = j.value("route", std::string{"master"});
        c.gain = j.value("gain", 1.0f);
        return c;
    }

    if (type == "SetRegionLoops") {
        CmdSetRegionLoops c;
        if (j.contains("regions") && j["regions"].is_array()) {
            for (const auto& jr : j["regions"]) {
                RegionLoopSpec r;
                r.region_id = jr.value("region_id", std::string{});
                if (jr.contains("pattern")) r.pattern = loop_pattern_from_json(jr["pattern"]);
                r.autostart = jr.value("autostart", false);
                r.initial_rows = loop_rows_from_json(jr, "initial_rows");
                c.regions.push_back(std::move(r));
            }
        }
        return c;
    }

    if (type == "SetTrackMeterMode") {
        const std::string mode = j.value("mode", std::string{"postFader"});
        CmdSetTrackMeterMode c;
        c.mode = mode == "postPan" ? 1 : mode == "preFader" ? 2 : 0;
        return c;
    }

    if (type == "SetLowLatency")
        return CmdSetLowLatency{ j.at("enabled").get<bool>() };

    if (type == "RecoverOutputDevice")
        return CmdRecoverOutputDevice{};

    if (type == "SetOutputSuspended")
        return CmdSetOutputSuspended{ j.at("suspended").get<bool>() };

    if (type == "ReopenOutputDevice")
        return CmdReopenOutputDevice{};

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
        else if constexpr (std::is_same_v<T, CmdSetRenderThreads>) {
            j["type"] = "SetRenderThreads"; j["threads"] = c.threads;
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeOutputRoute>) {
            j["type"] = "SetMetronomeOutputRoute"; j["route"] = c.route;
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeConfig>) {
            j["type"] = "SetMetronomeConfig";
            j["enabled"] = c.enabled;
            j["volume"] = c.volume;
            j["route"] = c.route;
            j["accent_enabled"] = c.accent_enabled;
            j["accent_preset"] = c.accent_preset;
            j["beat_preset"] = c.beat_preset;
            j["accent_pitch"] = c.accent_pitch;
            j["beat_pitch"] = c.beat_pitch;
            j["subdivision"] = c.subdivision;
            j["subdivision_preset"] = c.subdivision_preset;
            j["subdivision_pitch"] = c.subdivision_pitch;
            j["subdivision_gain"] = c.subdivision_gain;
        }
        else if constexpr (std::is_same_v<T, CmdSetVoiceGuideConfig>) {
            j["type"] = "SetVoiceGuideConfig";
            j["enabled"] = c.enabled;
            j["volume"] = c.volume;
            j["route"] = c.route;
            j["lead_bars"] = c.lead_bars;
            j["count_in_enabled"] = c.count_in_enabled;
            j["count_style"] = c.count_style;
        }
        else if constexpr (std::is_same_v<T, CmdLoadVoiceGuideBank>) {
            j["type"] = "LoadVoiceGuideBank";
            j["voices_dir"] = c.voices_dir;
            j["lang"] = c.lang;
        }
        else if constexpr (std::is_same_v<T, CmdSetPadConfig>) {
            j["type"] = "SetPadConfig";
            j["enabled"] = c.enabled;
            j["volume"] = c.volume;
            j["route"] = c.route;
            j["key"] = c.key;
            j["pad_id"] = c.pad_id;
            j["fade_in_seconds"] = c.fade_in_seconds;
            j["fade_out_seconds"] = c.fade_out_seconds;
            j["stop_with_transport"] = c.stop_with_transport;
        }
        else if constexpr (std::is_same_v<T, CmdSetPauseAtSongEnd>) {
            j["type"] = "SetPauseAtSongEnd";
            j["enabled"] = c.enabled;
        }
        else if constexpr (std::is_same_v<T, CmdSetSongGapVamp>) {
            j["type"] = "SetSongGapVamp";
            j["enabled"] = c.enabled;
        }
        else if constexpr (std::is_same_v<T, CmdEndSongGapVamp>) {
            j["type"] = "EndSongGapVamp";
        }
        else if constexpr (std::is_same_v<T, CmdSetLoopPattern>) {
            j["type"] = "SetLoopPattern";
            j["pattern"] = loop_pattern_to_json(c.pattern);
        }
        else if constexpr (std::is_same_v<T, CmdSetLoopTransport>) {
            j["type"] = "SetLoopTransport";
            j["playing"] = c.playing;
        }
        else if constexpr (std::is_same_v<T, CmdSetLoopRow>) {
            j["type"] = "SetLoopRow";
            j["row"] = c.row;
            if (c.enabled) j["enabled"] = *c.enabled;
            if (c.variation) j["variation"] = *c.variation;
        }
        else if constexpr (std::is_same_v<T, CmdSetLoopAllRows>) {
            j["type"] = "SetLoopAllRows";
            j["variation"] = c.variation;
        }
        else if constexpr (std::is_same_v<T, CmdSetLoopConfig>) {
            j["type"] = "SetLoopConfig";
            j["clock_mode"] = c.clock_mode;
            j["free_bpm"] = c.free_bpm;
            j["quantize"] = c.quantize;
            j["route"] = c.route;
            j["gain"] = c.gain;
            j["follow_transport"] = c.follow_transport;
        }
        else if constexpr (std::is_same_v<T, CmdSetOneShotBank>) {
            j["type"] = "SetOneShotBank";
            auto pads = nlohmann::json::array();
            for (const auto& p : c.pads) {
                pads.push_back({{"slot", p.slot}, {"gain", p.gain}, {"mode", p.mode},
                                {"quantize", p.quantize}, {"choke_group", p.choke_group}});
            }
            j["pads"] = std::move(pads);
        }
        else if constexpr (std::is_same_v<T, CmdSetOneShotConfig>) {
            j["type"] = "SetOneShotConfig";
            j["route"] = c.route;
            j["gain"] = c.gain;
        }
        else if constexpr (std::is_same_v<T, CmdSetRegionLoops>) {
            j["type"] = "SetRegionLoops";
            auto regions = nlohmann::json::array();
            for (const auto& r : c.regions) {
                nlohmann::json jr;
                jr["region_id"] = r.region_id;
                jr["pattern"] = loop_pattern_to_json(r.pattern);
                jr["autostart"] = r.autostart;
                auto rows = nlohmann::json::array();
                for (const auto& row : r.initial_rows)
                    rows.push_back({{"enabled", row.enabled}, {"variation", row.variation}});
                jr["initial_rows"] = std::move(rows);
                regions.push_back(std::move(jr));
            }
            j["regions"] = std::move(regions);
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackMeterMode>) {
            j["type"] = "SetTrackMeterMode";
            j["mode"] = c.mode == 1 ? "postPan" : c.mode == 2 ? "preFader" : "postFader";
        }
        else if constexpr (std::is_same_v<T, CmdLoadPadClip>) {
            j["type"] = "LoadPadClip";
            j["pads_dir"] = c.pads_dir;
            j["pad_id"] = c.pad_id;
            j["key"] = c.key;
        }
        // ... additional types follow the same pattern.
        // Omitted for brevity — expand as needed.
    }, cmd);
    return j.dump();
}

} // namespace lt
