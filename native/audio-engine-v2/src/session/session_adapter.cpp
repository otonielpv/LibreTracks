#include <lt_engine/session/session_adapter.h>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace lt {

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static TransposeBehavior parse_transpose_behavior(const std::string& s) {
    if (s == "NeverTranspose") return TransposeBehavior::NeverTranspose;
    return TransposeBehavior::FollowsSongOrRegion;
}

static TrackRole parse_track_role(const std::string& s) {
    if (s == "Click")   return TrackRole::Click;
    if (s == "Guide")   return TrackRole::Guide;
    if (s == "Cue")     return TrackRole::Cue;
    if (s == "Backing") return TrackRole::Backing;
    if (s == "Other")   return TrackRole::Other;
    return TrackRole::Normal;
}

// ---------------------------------------------------------------------------
// session_from_project_json
//
// Expected top-level shape (from libretracks-project Rust serialisation):
// {
//   "id": "...",
//   "name": "...",
//   "songs": [...],
//   "library": {
//     "assets": [ { "id", "file_path", "original_sample_rate", "channels", "duration_frames" } ]
//   }
// }
// ---------------------------------------------------------------------------
Result<Session> session_from_project_json(const std::string& project_json,
                                           int engine_sample_rate) {
    try {
        json j = json::parse(project_json);
        Session session;
        session.id          = j.value("id", "session");
        session.name        = j.value("name", "Untitled");
        session.sample_rate = engine_sample_rate;

        // ── Sources from library assets ───────────────────────────────────
        if (j.contains("library") && j["library"].contains("assets")) {
            for (const auto& asset : j["library"]["assets"]) {
                Source src;
                src.id                    = asset.value("id", "");
                src.file_path             = asset.value("file_path", "");
                src.original_sample_rate  = asset.value("original_sample_rate", 0);
                src.channel_count         = asset.value("channels", 2);
                src.duration_frames       = asset.value("duration_frames", 0LL);
                src.decode_status         = DecodeStatus::Unknown;
                src.cache_status          = CacheStatus::Uncached;
                session.sources.push_back(std::move(src));
            }
        }

        // ── Songs ─────────────────────────────────────────────────────────
        if (j.contains("songs")) {
            for (const auto& jsong : j["songs"]) {
                Song song;
                song.id                  = jsong.value("id", "");
                song.name                = jsong.value("name", "");
                song.start_frame         = jsong.value("start_frame", 0LL);
                song.end_frame           = jsong.value("end_frame", 0LL);
                song.transpose_semitones = jsong.value("transpose_semitones", 0);

                // ── Tracks ─────────────────────────────────────────────────
                if (jsong.contains("tracks")) {
                    for (const auto& jtrack : jsong["tracks"]) {
                        Track track;
                        track.id   = jtrack.value("id", "");
                        track.name = jtrack.value("name", "");
                        track.gain = jtrack.value("gain", 1.0f);
                        track.mute = jtrack.value("mute", false);
                        track.solo = jtrack.value("solo", false);
                        track.transpose_behavior = parse_transpose_behavior(
                            jtrack.value("transpose_behavior", "FollowsSongOrRegion"));
                        track.role = parse_track_role(jtrack.value("role", "Normal"));

                        if (jtrack.contains("clips")) {
                            for (const auto& jclip : jtrack["clips"]) {
                                Clip clip;
                                clip.id                   = jclip.value("id", "");
                                clip.source_id            = jclip.value("source_id", "");
                                clip.timeline_start_frame = jclip.value("timeline_start_frame", 0LL);
                                clip.source_start_frame   = jclip.value("source_start_frame", 0LL);
                                clip.length_frames        = jclip.value("length_frames", 0LL);
                                clip.gain                 = jclip.value("gain", 1.0f);
                                clip.fade_in_frames       = jclip.value("fade_in_frames", 0LL);
                                clip.fade_out_frames      = jclip.value("fade_out_frames", 0LL);
                                track.clips.push_back(std::move(clip));
                            }
                        }
                        song.tracks.push_back(std::move(track));
                    }
                }

                // ── Markers ────────────────────────────────────────────────
                if (jsong.contains("markers")) {
                    for (const auto& jm : jsong["markers"]) {
                        Marker m;
                        m.id    = jm.value("id", "");
                        m.name  = jm.value("name", "");
                        m.frame = jm.value("frame", 0LL);
                        song.markers.push_back(std::move(m));
                    }
                }

                // ── Regions ────────────────────────────────────────────────
                if (jsong.contains("regions")) {
                    for (const auto& jr : jsong["regions"]) {
                        Region r;
                        r.id                  = jr.value("id", "");
                        r.name                = jr.value("name", "");
                        r.start_frame         = jr.value("start_frame", 0LL);
                        r.end_frame           = jr.value("end_frame", 0LL);
                        r.transpose_semitones = jr.value("transpose_semitones", 0);
                        song.regions.push_back(std::move(r));
                    }
                }

                session.songs.push_back(std::move(song));
            }
        }

        auto validation = validate_session(session);
        if (validation.is_err())
            return Result<Session>::err("Session validation failed: " + validation.error());

        return Result<Session>::ok(std::move(session));

    } catch (const std::exception& ex) {
        return Result<Session>::err(std::string("session_from_project_json: ") + ex.what());
    }
}

} // namespace lt
