#include <lt_engine/session/session_adapter.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <stdexcept>
#include <unordered_set>

namespace lt {

using json = nlohmann::json;

static TransposeBehavior parse_transpose_behavior(const std::string& s) {
    if (s == "NeverTranspose" || s == "never_transpose") return TransposeBehavior::NeverTranspose;
    return TransposeBehavior::FollowsSongOrRegion;
}

static TrackRole parse_track_role(const std::string& s) {
    if (s == "Click" || s == "click")     return TrackRole::Click;
    if (s == "Guide" || s == "guide")     return TrackRole::Guide;
    if (s == "Cue" || s == "cue")         return TrackRole::Cue;
    if (s == "Backing" || s == "backing") return TrackRole::Backing;
    if (s == "Other" || s == "other")     return TrackRole::Other;
    return TrackRole::Normal;
}

static Frame seconds_to_frames(double seconds, int sample_rate) {
    return static_cast<Frame>(std::llround(seconds * static_cast<double>(sample_rate)));
}

template <typename T>
static T value_any(const json& j, const char* snake, const char* camel, T fallback) {
    if (j.contains(snake) && !j[snake].is_null()) return j[snake].get<T>();
    if (j.contains(camel) && !j[camel].is_null()) return j[camel].get<T>();
    return fallback;
}

static const json* array_any(const json& j, const char* snake, const char* camel) {
    if (j.contains(snake) && j[snake].is_array()) return &j[snake];
    if (j.contains(camel) && j[camel].is_array()) return &j[camel];
    return nullptr;
}

static void ensure_source(Session& session, const Id& id, const std::string& file_path) {
    if (id.empty() || file_path.empty()) return;
    for (const auto& source : session.sources) {
        if (source.id == id) return;
    }

    Source src;
    src.id = id;
    src.file_path = file_path;
    src.decode_status = DecodeStatus::Unknown;
    src.cache_status = CacheStatus::Uncached;
    session.sources.push_back(std::move(src));
}

static std::vector<json> collect_song_json(const json& root) {
    if (root.contains("songs") && root["songs"].is_array()) {
        return root["songs"].get<std::vector<json>>();
    }
    if (root.contains("tracks") || root.contains("clips") || root.contains("sectionMarkers")) {
        return { root };
    }
    return {};
}

Result<Session> session_from_project_json(const std::string& project_json,
                                           int engine_sample_rate) {
    try {
        json root = json::parse(project_json);

        Session session;
        session.id = root.value("id", "session");
        session.name = root.value("name", root.value("title", "Untitled"));
        session.sample_rate = engine_sample_rate;

        if (root.contains("library") && root["library"].contains("assets")) {
            for (const auto& asset : root["library"]["assets"]) {
                Source src;
                src.id = asset.value("id", "");
                src.file_path = value_any<std::string>(asset, "file_path", "filePath", "");
                if (src.id.empty()) src.id = src.file_path;
                src.original_sample_rate = value_any<int>(asset, "original_sample_rate", "originalSampleRate", 0);
                src.channel_count = asset.value("channels", asset.value("channelCount", 2));
                src.duration_frames = value_any<Frame>(asset, "duration_frames", "durationFrames", 0LL);
                src.decode_status = DecodeStatus::Unknown;
                src.cache_status = CacheStatus::Uncached;
                if (!src.id.empty()) session.sources.push_back(std::move(src));
            }
        }

        for (const auto& jsong : collect_song_json(root)) {
            Song song;
            song.id = jsong.value("id", "");
            song.name = jsong.value("name", jsong.value("title", ""));
            song.start_frame = value_any<Frame>(jsong, "start_frame", "startFrame", 0LL);
            song.end_frame = value_any<Frame>(jsong, "end_frame", "endFrame", 0LL);
            if (song.end_frame <= song.start_frame) {
                song.end_frame = seconds_to_frames(
                    value_any<double>(jsong, "duration_seconds", "durationSeconds", 0.0),
                    engine_sample_rate);
            }
            song.transpose_semitones = value_any<Semitones>(jsong, "transpose_semitones", "transposeSemitones", 0);

            std::vector<json> top_level_clips;
            if (auto* clips = array_any(jsong, "clips", "clips")) {
                top_level_clips = clips->get<std::vector<json>>();
            }

            if (auto* tracks = array_any(jsong, "tracks", "tracks")) {
                for (const auto& jtrack : *tracks) {
                    Track track;
                    track.id = jtrack.value("id", "");
                    track.name = jtrack.value("name", "");
                    track.gain = static_cast<Gain>(jtrack.value("gain", jtrack.value("volume", 1.0)));
                    track.pan = static_cast<float>(jtrack.value("pan", 0.0));
                    track.audio_to = jtrack.value("audioTo", jtrack.value("audio_to", std::string("master")));
                    track.mute = jtrack.value("mute", jtrack.value("muted", false));
                    track.solo = jtrack.value("solo", false);
                    track.role = parse_track_role(jtrack.value("role", "Normal"));
                    if (jtrack.contains("transposeEnabled")) {
                        track.transpose_behavior = jtrack["transposeEnabled"].get<bool>()
                            ? TransposeBehavior::FollowsSongOrRegion
                            : TransposeBehavior::NeverTranspose;
                    } else {
                        track.transpose_behavior = parse_transpose_behavior(
                            value_any<std::string>(jtrack, "transpose_behavior", "transposeBehavior", "FollowsSongOrRegion"));
                    }

                    auto add_clip = [&](const json& jclip) {
                        Clip clip;
                        clip.id = jclip.value("id", "");
                        clip.source_id = value_any<std::string>(jclip, "source_id", "sourceId", "");
                        std::string file_path = value_any<std::string>(jclip, "file_path", "filePath", "");
                        if (clip.source_id.empty()) clip.source_id = file_path;

                        clip.timeline_start_frame = value_any<Frame>(jclip, "timeline_start_frame", "timelineStartFrame", 0LL);
                        clip.source_start_frame = value_any<Frame>(jclip, "source_start_frame", "sourceStartFrame", 0LL);
                        clip.length_frames = value_any<Frame>(jclip, "length_frames", "lengthFrames", 0LL);
                        if (clip.timeline_start_frame == 0) {
                            clip.timeline_start_frame = seconds_to_frames(
                                value_any<double>(jclip, "timeline_start_seconds", "timelineStartSeconds", 0.0),
                                engine_sample_rate);
                        }
                        if (clip.source_start_frame == 0) {
                            clip.source_start_frame = seconds_to_frames(
                                value_any<double>(jclip, "source_start_seconds", "sourceStartSeconds", 0.0),
                                engine_sample_rate);
                        }
                        if (clip.length_frames == 0) {
                            clip.length_frames = seconds_to_frames(
                                value_any<double>(jclip, "duration_seconds", "durationSeconds", 0.0),
                                engine_sample_rate);
                        }

                        clip.gain = jclip.value("gain", 1.0f);
                        clip.fade_in_frames = value_any<Frame>(jclip, "fade_in_frames", "fadeInFrames", 0LL);
                        clip.fade_out_frames = value_any<Frame>(jclip, "fade_out_frames", "fadeOutFrames", 0LL);
                        if (clip.fade_in_frames == 0) {
                            clip.fade_in_frames = seconds_to_frames(
                                value_any<double>(jclip, "fade_in_seconds", "fadeInSeconds", 0.0),
                                engine_sample_rate);
                        }
                        if (clip.fade_out_frames == 0) {
                            clip.fade_out_frames = seconds_to_frames(
                                value_any<double>(jclip, "fade_out_seconds", "fadeOutSeconds", 0.0),
                                engine_sample_rate);
                        }
                        clip.semitones = jclip.value("semitones", song.transpose_semitones);

                        if (!clip.id.empty() && !clip.source_id.empty()) {
                            ensure_source(session, clip.source_id, file_path.empty() ? clip.source_id : file_path);
                            track.clips.push_back(std::move(clip));
                        }
                    };

                    if (auto* nested = array_any(jtrack, "clips", "clips")) {
                        for (const auto& jclip : *nested) add_clip(jclip);
                    }
                    for (const auto& jclip : top_level_clips) {
                        if (value_any<std::string>(jclip, "track_id", "trackId", "") == track.id) {
                            add_clip(jclip);
                        }
                    }

                    song.tracks.push_back(std::move(track));
                }
            }

            if (auto* markers = array_any(jsong, "markers", "sectionMarkers")) {
                for (const auto& jm : *markers) {
                    Marker marker;
                    marker.id = jm.value("id", "");
                    marker.name = jm.value("name", "");
                    marker.frame = value_any<Frame>(jm, "frame", "frame", 0LL);
                    if (marker.frame == 0) {
                        marker.frame = seconds_to_frames(
                            value_any<double>(jm, "start_seconds", "startSeconds", 0.0),
                            engine_sample_rate);
                    }
                    song.markers.push_back(std::move(marker));
                }
            }

            if (auto* regions = array_any(jsong, "regions", "regions")) {
                for (const auto& jr : *regions) {
                    Region region;
                    region.id = jr.value("id", "");
                    region.name = jr.value("name", "");
                    region.start_frame = value_any<Frame>(jr, "start_frame", "startFrame", 0LL);
                    region.end_frame = value_any<Frame>(jr, "end_frame", "endFrame", 0LL);
                    if (region.start_frame == 0) {
                        region.start_frame = seconds_to_frames(
                            value_any<double>(jr, "start_seconds", "startSeconds", 0.0),
                            engine_sample_rate);
                    }
                    if (region.end_frame == 0) {
                        region.end_frame = seconds_to_frames(
                            value_any<double>(jr, "end_seconds", "endSeconds", 0.0),
                            engine_sample_rate);
                    }
                    region.transpose_semitones = value_any<Semitones>(jr, "transpose_semitones", "transposeSemitones", 0);
                    song.regions.push_back(std::move(region));
                }
            }

            session.songs.push_back(std::move(song));
        }

        auto validation = validate_session(session);
        if (validation.is_err()) {
            return Result<Session>::err("Session validation failed: " + validation.error());
        }

        return Result<Session>::ok(std::move(session));
    } catch (const std::exception& ex) {
        return Result<Session>::err(std::string("session_from_project_json: ") + ex.what());
    }
}

} // namespace lt
