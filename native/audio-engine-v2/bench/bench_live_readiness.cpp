#include <lt_engine/core/commands.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;
constexpr int kBlockFrames = 512;
constexpr std::uint64_t kRevision = 11;

struct Config {
    int songs = 3;
    int stems_per_song = 6;
    int seconds_per_song = 45;
    int simultaneous_tracks = 18;
    int render_blocks = 600;
    bool full = false;
};

int env_int(const char* name, int fallback) {
    if (const char* v = std::getenv(name)) {
        const int n = std::atoi(v);
        if (n > 0)
            return n;
    }
    return fallback;
}

Config read_config() {
    Config c;
    if (const char* full = std::getenv("LT_LIVE_READINESS_FULL")) {
        c.full = std::strcmp(full, "0") != 0 && std::strcmp(full, "false") != 0;
    }
    if (c.full) {
        c.songs = 6;
        c.stems_per_song = 12;
        c.seconds_per_song = 300;
        c.simultaneous_tracks = 30;
        c.render_blocks = 2400;
    }
    c.songs = env_int("LT_LIVE_READINESS_SONGS", c.songs);
    c.stems_per_song = env_int("LT_LIVE_READINESS_STEMS", c.stems_per_song);
    c.seconds_per_song = env_int("LT_LIVE_READINESS_SECONDS", c.seconds_per_song);
    c.simultaneous_tracks = env_int("LT_LIVE_READINESS_SIMULTANEOUS", c.simultaneous_tracks);
    c.render_blocks = env_int("LT_LIVE_READINESS_BLOCKS", c.render_blocks);
    return c;
}

std::vector<float> make_source_audio(Frame frames, int source_index) {
    std::vector<float> samples(static_cast<std::size_t>(frames * kChannels), 0.0f);
    const double f1 = 90.0 + 7.0 * (source_index % 31);
    const double f2 = 210.0 + 11.0 * (source_index % 23);
    for (Frame f = 0; f < frames; ++f) {
        const double t = static_cast<double>(f) / kSampleRate;
        const float env = 0.65f + 0.35f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 0.21 * t));
        samples[static_cast<std::size_t>(f * kChannels)] =
            env * static_cast<float>(0.22 * std::sin(2.0 * 3.141592653589793 * f1 * t));
        samples[static_cast<std::size_t>(f * kChannels + 1)] =
            env * static_cast<float>(0.18 * std::cos(2.0 * 3.141592653589793 * f2 * t));
    }
    return samples;
}

JumpTarget marker_target(const Id& id, Frame fallback_frame = 0) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Marker;
    target.id = id;
    if (fallback_frame > 0)
        target.frame = fallback_frame;
    return target;
}

JumpTarget frame_target(Frame frame) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = frame;
    return target;
}

struct BuildMetrics {
    double build_ms = 0.0;
    std::size_t source_ram_bytes = 0;
    std::size_t cache_ram_bytes = 0;
    std::size_t disk_cache_bytes = 0;
};

BuildMetrics build_session(const Config& config, SourceManager& sources, Session& session) {
    session.id = "live-readiness";
    session.sample_rate = kSampleRate;

    const Frame song_frames = static_cast<Frame>(config.seconds_per_song) * kSampleRate;
    int source_index = 0;
    const auto t0 = Clock::now();
    for (int s = 0; s < config.songs; ++s) {
        Song song;
        song.id = "song-" + std::to_string(s);
        song.name = "Song " + std::to_string(s + 1);
        song.start_frame = static_cast<Frame>(s) * song_frames;
        song.end_frame = song.start_frame + song_frames;
        song.transpose_semitones = (s % 2 == 0) ? -2 : 2;
        song.markers.push_back(Marker{"song-" + std::to_string(s) + "-marker-a",
                                      "A",
                                      song.start_frame + song_frames / 3});
        song.markers.push_back(Marker{"song-" + std::to_string(s) + "-marker-b",
                                      "B",
                                      song.start_frame + (song_frames * 2) / 3});
        song.regions.push_back(Region{"song-" + std::to_string(s) + "-region-a",
                                      "A",
                                      song.start_frame,
                                      song.start_frame + song_frames / 2,
                                      song.transpose_semitones});
        song.regions.push_back(Region{"song-" + std::to_string(s) + "-region-b",
                                      "B",
                                      song.start_frame + song_frames / 2,
                                      song.end_frame,
                                      song.transpose_semitones});

        for (int t = 0; t < config.stems_per_song; ++t) {
            const Id source_id = "source-" + std::to_string(s) + "-" + std::to_string(t);
            sources.register_source(
                source_id,
                "live-readiness-" + std::to_string(s) + "-" + std::to_string(t) + ".wav");
            auto stored = sources.store_decoded_source(
                source_id,
                make_source_audio(song_frames, source_index++),
                kChannels,
                kSampleRate,
                song_frames);
            if (stored.is_err()) {
                std::fprintf(stderr, "source store failed: %s\n", stored.error().c_str());
                std::exit(2);
            }

            Track track;
            track.id = "track-" + std::to_string(s) + "-" + std::to_string(t);
            track.gain = 1.0f / static_cast<float>(std::max(1, config.stems_per_song));
            track.transpose_behavior = (t % 3 == 0)
                ? TransposeBehavior::FollowsSongOrRegion
                : TransposeBehavior::NeverTranspose;
            track.clips.push_back(Clip{
                "clip-" + std::to_string(s) + "-" + std::to_string(t),
                source_id,
                song.start_frame,
                0,
                song_frames,
                1.0f});
            song.tracks.push_back(std::move(track));
        }

        session.songs.push_back(std::move(song));
    }

    BuildMetrics metrics;
    metrics.build_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    for (const auto& d : sources.diagnostics()) {
        metrics.source_ram_bytes += d.memory_bytes;
        metrics.disk_cache_bytes += d.disk_cache_bytes;
    }
    metrics.cache_ram_bytes = sources.cache_diagnostics().bytes_used;
    return metrics;
}

bool wait_ready_range(const SourceManager& sources,
                      const Song& song,
                      Frame start,
                      int frames,
                      int max_tracks) {
    const int count = std::min<int>(max_tracks, static_cast<int>(song.tracks.size()));
    for (int i = 0; i < count; ++i) {
        const auto& clip = song.tracks[static_cast<std::size_t>(i)].clips.front();
        const Frame source_start = clip.source_start_frame + (start - clip.timeline_start_frame);
        const int first = static_cast<int>(source_start / kDefaultBlockFrames);
        const int last = static_cast<int>((source_start + frames - 1) / kDefaultBlockFrames);
        for (int block = first; block <= last; ++block)
            sources.request_block(clip.source_id, block);
    }

    for (int spin = 0; spin < 2000; ++spin) {
        bool ready = true;
        for (int i = 0; i < count; ++i) {
            const auto& clip = song.tracks[static_cast<std::size_t>(i)].clips.front();
            const auto source = sources.get_shared(clip.source_id);
            const Frame source_start = clip.source_start_frame + (start - clip.timeline_start_frame);
            ready = ready && source && source->is_range_ready(source_start, frames);
        }
        if (ready)
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}

struct RenderMetrics {
    double render_ms = 0.0;
    double checksum = 0.0;
    std::size_t cache_misses = 0;
    bool underrun_free = false;
};

RenderMetrics render_song_window(const SourceManager& sources,
                                 const Song& song,
                                 Frame start,
                                 int blocks,
                                 int simultaneous_tracks) {
    const int track_count = std::min<int>(
        simultaneous_tracks, static_cast<int>(song.tracks.size()));
    std::vector<TrackRenderer> renderers(static_cast<std::size_t>(track_count));
    for (auto& renderer : renderers)
        renderer.prepare(kBlockFrames);

    const auto before_cache = sources.cache_diagnostics();
    std::vector<float> left(kBlockFrames, 0.0f);
    std::vector<float> right(kBlockFrames, 0.0f);
    float* out[2] = {left.data(), right.data()};
    double checksum = 0.0;

    const auto t0 = Clock::now();
    for (int block = 0; block < blocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        const Frame timeline = start + Frame(block * kBlockFrames);
        for (int i = 0; i < track_count; ++i) {
            renderers[static_cast<std::size_t>(i)].render(
                song.tracks[static_cast<std::size_t>(i)],
                timeline,
                kBlockFrames,
                out,
                kChannels,
                sources,
                nullptr,
                kSampleRate,
                0,
                &song);
        }
        for (int i = 0; i < kBlockFrames; i += 29)
            checksum += left[static_cast<std::size_t>(i)] * 0.67
                + right[static_cast<std::size_t>(i)] * 0.31;
    }
    const auto after_cache = sources.cache_diagnostics();

    RenderMetrics metrics;
    metrics.render_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    metrics.checksum = checksum;
    metrics.cache_misses = after_cache.blocks_miss - before_cache.blocks_miss;
    metrics.underrun_free = metrics.cache_misses == 0;
    return metrics;
}

struct JumpMetrics {
    bool marker_exact = false;
    bool at_frame_exact = false;
    bool region_end_exact = false;
    bool prearmed_payload = false;
    bool bungee_available = false;
    double marker_schedule_us = 0.0;
    double at_frame_check_us = 0.0;
    double region_end_check_us = 0.0;
    double prearm_ms = 0.0;
    double take_publish_us = 0.0;
};

template <typename Fn>
double measure_us(Fn&& fn) {
    const auto t0 = Clock::now();
    fn();
    return std::chrono::duration<double, std::micro>(Clock::now() - t0).count();
}

JumpMetrics exercise_jumps(const SourceManager& sources, const Session& session) {
    JumpMetrics metrics;
    const Song& song = session.songs.front();
    const Marker& marker = song.markers.front();
    const Frame trigger_frame = song.regions.front().end_frame;

    TransportClock clock(kSampleRate);
    clock.seek(trigger_frame - 192);
    clock.play();
    clock.clear_pending_start();

    JumpScheduler scheduler;
    Frame resolved_marker = -1;
    metrics.marker_schedule_us = measure_us([&] {
        auto r = scheduler.schedule_immediate(
            "jump-marker", marker_target(marker.id), session, clock);
        if (r.is_ok())
            resolved_marker = r.unwrap();
    });
    metrics.marker_exact = resolved_marker == marker.frame;
    scheduler.drain_pending();
    if (auto due = scheduler.check_due(clock, session, kBlockFrames))
        scheduler.mark_executed(clock.position().frame, due->target_frame);

    ScheduledJump at_frame;
    at_frame.jump_id = "jump-at-frame";
    at_frame.target = marker_target(marker.id, marker.frame);
    at_frame.trigger = JumpTrigger::AtFrame;
    at_frame.status = JumpStatus::Pending;
    at_frame.trigger_frame = trigger_frame;
    scheduler.schedule(at_frame);
    scheduler.drain_pending();
    std::optional<DueJump> due_at_frame;
    metrics.at_frame_check_us = measure_us([&] {
        due_at_frame = scheduler.check_due(clock, session, kBlockFrames);
    });
    metrics.at_frame_exact = due_at_frame
        && due_at_frame->trigger_frame == trigger_frame
        && due_at_frame->target_frame == marker.frame;

    JumpScheduler region_scheduler;
    ScheduledJump region_end;
    region_end.jump_id = "jump-region-end";
    region_end.target = frame_target(marker.frame);
    region_end.trigger = JumpTrigger::AtRegionEnd;
    region_end.status = JumpStatus::Pending;
    region_scheduler.schedule(region_end);
    region_scheduler.drain_pending();
    std::optional<DueJump> due_region;
    metrics.region_end_check_us = measure_us([&] {
        due_region = region_scheduler.check_due(clock, session, kBlockFrames);
    });
    metrics.region_end_exact = due_region
        && due_region->trigger_frame == trigger_frame
        && due_region->target_frame == marker.frame;

    BungeeVoiceManager voices;
    metrics.bungee_available = voices.prepare(kSampleRate, kChannels, kBlockFrames)
        && voices.is_available();
    if (!metrics.bungee_available)
        return metrics;

    PrearmedJumpManager prearm;
    prearm.prepare(kSampleRate, kChannels, kBlockFrames);
    prearm.set_max_prepared_targets(1024);
    metrics.prearm_ms = measure_us([&] {
        prearm.prepare_all_targets(session, sources, kRevision);
    }) / 1000.0;

    PrearmTargetKey key;
    key.kind = PrearmTargetKind::Marker;
    key.song_id = song.id;
    key.target_id = marker.id;
    key.timeline_frame = marker.frame;
    key.sample_rate = kSampleRate;
    key.block_size = kBlockFrames;
    key.session_revision = kRevision;

    std::shared_ptr<const PreparedVoiceMap> prepared_map;
    metrics.take_publish_us = measure_us([&] {
        auto prepared = prearm.take_ready(key);
        if (prepared && prepared->valid) {
            auto map = prepared->extract_voice_map();
            prepared_map = voices.build_prepared_voice_map(map);
            voices.publish_prepared_voice_map_realtime(prepared_map);
        }
    });
    metrics.prearmed_payload = static_cast<bool>(prepared_map);
    return metrics;
}

double mb(std::size_t bytes) {
    return static_cast<double>(bytes) / (1024.0 * 1024.0);
}

} // namespace

int main() {
    const Config config = read_config();
    SourceManager sources;
    Session session;

    std::puts("LibreTracks live-readiness benchmark");
    std::printf("mode=%s songs=%d stems_per_song=%d seconds_per_song=%d simultaneous_tracks=%d render_blocks=%d\n",
                config.full ? "full" : "default",
                config.songs,
                config.stems_per_song,
                config.seconds_per_song,
                config.simultaneous_tracks,
                config.render_blocks);

    const auto build = build_session(config, sources, session);
    std::printf("build_ms=%.2f source_ram_mb=%.2f cache_ram_mb=%.2f disk_cache_mb=%.2f\n",
                build.build_ms,
                mb(build.source_ram_bytes),
                mb(build.cache_ram_bytes),
                mb(build.disk_cache_bytes));

    const Song& playback_song = session.songs.front();
    const Frame playback_start = playback_song.start_frame + kDefaultBlockFrames * 16;
    const int render_frames = config.render_blocks * kBlockFrames;
    const bool prebuffer_ready = wait_ready_range(
        sources,
        playback_song,
        playback_start,
        render_frames,
        config.simultaneous_tracks);
    const auto render = render_song_window(
        sources,
        playback_song,
        playback_start,
        config.render_blocks,
        config.simultaneous_tracks);
    std::printf("playback prebuffer_ready=%s render_ms=%.2f checksum=%.6f cache_misses=%zu underrun_free=%s\n",
                prebuffer_ready ? "yes" : "NO",
                render.render_ms,
                render.checksum,
                render.cache_misses,
                render.underrun_free ? "yes" : "NO");

    const auto jumps = exercise_jumps(sources, session);
    std::printf("jumps marker_exact=%s marker_schedule_us=%.2f at_frame_exact=%s at_frame_check_us=%.2f region_end_exact=%s region_end_check_us=%.2f\n",
                jumps.marker_exact ? "yes" : "NO",
                jumps.marker_schedule_us,
                jumps.at_frame_exact ? "yes" : "NO",
                jumps.at_frame_check_us,
                jumps.region_end_exact ? "yes" : "NO",
                jumps.region_end_check_us);
    if (jumps.bungee_available) {
        std::printf("prearm bungee=yes prearm_ms=%.2f take_publish_us=%.2f prepared_payload=%s\n",
                    jumps.prearm_ms,
                    jumps.take_publish_us,
                    jumps.prearmed_payload ? "yes" : "NO");
    } else {
        std::puts("prearm bungee=no");
    }

    const bool ok = prebuffer_ready
        && render.underrun_free
        && jumps.marker_exact
        && jumps.at_frame_exact
        && jumps.region_end_exact
        && (!jumps.bungee_available || jumps.prearmed_payload);
    return ok ? 0 : 5;
}
