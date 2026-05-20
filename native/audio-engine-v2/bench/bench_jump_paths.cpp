#include <lt_engine/core/commands.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;
constexpr int kBlockFrames = 512;
constexpr int kTrackCount = 12;
constexpr Frame kSongFrames = kSampleRate * 30;
constexpr Frame kMarkerFrame = kSampleRate * 10;
constexpr Frame kScheduledTrigger = kSampleRate * 6;
constexpr Frame kArbitraryFrame = kSampleRate * 17 + 173;
constexpr std::uint64_t kRevision = 7;

struct Timed {
    double us = 0.0;
};

template <typename Fn>
Timed measure(Fn&& fn) {
    const auto t0 = Clock::now();
    fn();
    const auto t1 = Clock::now();
    return {std::chrono::duration<double, std::micro>(t1 - t0).count()};
}

JumpTarget frame_target(Frame frame) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = frame;
    return target;
}

JumpTarget marker_target(const Id& id, Frame fallback_frame = 0) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Marker;
    target.id = id;
    if (fallback_frame > 0)
        target.frame = fallback_frame;
    return target;
}

std::vector<float> make_source_audio(Frame frames, int index) {
    std::vector<float> samples(static_cast<std::size_t>(frames * kChannels), 0.0f);
    const double base = 146.83 + 13.0 * index;
    for (Frame f = 0; f < frames; ++f) {
        const float left = static_cast<float>(
            0.28 * std::sin(2.0 * 3.141592653589793 * base * double(f) / kSampleRate));
        const float right = static_cast<float>(
            0.21 * std::cos(2.0 * 3.141592653589793 * (base * 1.5) * double(f) / kSampleRate));
        samples[static_cast<std::size_t>(f * kChannels)] = left;
        samples[static_cast<std::size_t>(f * kChannels + 1)] = right;
    }
    return samples;
}

void build_live_session(SourceManager& sources, Session& session) {
    session.id = "jump-bench-session";
    session.sample_rate = kSampleRate;

    Song song;
    song.id = "song-main";
    song.name = "Main";
    song.start_frame = 0;
    song.end_frame = kSongFrames;
    song.transpose_semitones = -2;
    song.markers.push_back(Marker{"chorus", "Chorus", kMarkerFrame});
    song.regions.push_back(Region{"verse", "Verse", 0, kScheduledTrigger, -2});
    song.regions.push_back(Region{"chorus-region", "Chorus", kMarkerFrame, kSongFrames, -2});

    for (int i = 0; i < kTrackCount; ++i) {
        const Id source_id = "src-" + std::to_string(i);
        sources.register_source(source_id, "jump-bench-source-" + std::to_string(i) + ".wav");
        auto stored = sources.store_decoded_source(
            source_id, make_source_audio(kSongFrames, i), kChannels, kSampleRate, kSongFrames);
        if (stored.is_err()) {
            std::fprintf(stderr, "source store failed: %s\n", stored.error().c_str());
            std::exit(2);
        }

        Track track;
        track.id = "track-" + std::to_string(i);
        track.gain = 1.0f / static_cast<float>(kTrackCount);
        track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
        track.clips.push_back(Clip{
            "clip-" + std::to_string(i),
            source_id,
            0,
            0,
            kSongFrames,
            1.0f});
        song.tracks.push_back(std::move(track));
    }

    session.songs.push_back(std::move(song));
}

PrearmTargetKey marker_key() {
    PrearmTargetKey key;
    key.kind = PrearmTargetKind::Marker;
    key.song_id = "song-main";
    key.target_id = "chorus";
    key.timeline_frame = kMarkerFrame;
    key.sample_rate = kSampleRate;
    key.block_size = kBlockFrames;
    key.session_revision = kRevision;
    return key;
}

struct SchedulerBenchResult {
    double schedule_immediate_us = 0.0;
    double scheduled_check_us = 0.0;
    double region_end_check_us = 0.0;
    bool marker_resolved_exact = false;
    bool at_frame_exact = false;
    bool region_end_exact = false;
};

SchedulerBenchResult bench_scheduler_contracts(const Session& session) {
    SchedulerBenchResult result;
    TransportClock clock(kSampleRate);
    clock.seek(kScheduledTrigger - 192);
    clock.play();
    clock.clear_pending_start();

    JumpScheduler scheduler;
    Frame resolved_marker = -1;
    result.schedule_immediate_us = measure([&] {
        auto r = scheduler.schedule_immediate("jump-marker", marker_target("chorus"), session, clock);
        if (r.is_ok())
            resolved_marker = r.unwrap();
    }).us;
    result.marker_resolved_exact = (resolved_marker == kMarkerFrame);

    scheduler.drain_pending();
    scheduler.check_due(clock, session, kBlockFrames);
    scheduler.mark_executed(clock.position().frame, kMarkerFrame);

    ScheduledJump at_frame;
    at_frame.jump_id = "scheduled-at-frame";
    at_frame.target = marker_target("chorus", kMarkerFrame);
    at_frame.trigger = JumpTrigger::AtFrame;
    at_frame.status = JumpStatus::Pending;
    at_frame.trigger_frame = kScheduledTrigger;
    scheduler.schedule(at_frame);
    scheduler.drain_pending();

    std::optional<DueJump> due_at_frame;
    result.scheduled_check_us = measure([&] {
        due_at_frame = scheduler.check_due(clock, session, kBlockFrames);
    }).us;
    result.at_frame_exact = due_at_frame
        && due_at_frame->trigger_frame == kScheduledTrigger
        && due_at_frame->target_frame == kMarkerFrame;
    if (due_at_frame)
        scheduler.mark_executed(clock.position().frame, due_at_frame->target_frame);

    JumpScheduler region_scheduler;
    ScheduledJump region_end;
    region_end.jump_id = "region-end";
    region_end.target = frame_target(kMarkerFrame);
    region_end.trigger = JumpTrigger::AtRegionEnd;
    region_end.status = JumpStatus::Pending;
    region_scheduler.schedule(region_end);
    region_scheduler.drain_pending();

    std::optional<DueJump> due_region;
    result.region_end_check_us = measure([&] {
        due_region = region_scheduler.check_due(clock, session, kBlockFrames);
    }).us;
    result.region_end_exact = due_region
        && due_region->trigger_frame == kScheduledTrigger
        && due_region->target_frame == kMarkerFrame;

    return result;
}

struct PrearmBenchResult {
    bool bungee_available = false;
    bool marker_ready = false;
    double prearm_all_ms = 0.0;
    double take_and_swap_us = 0.0;
    double scheduled_prepared_check_us = 0.0;
    bool scheduled_prepared_exact = false;
    bool scheduled_has_prepared_payload = false;
    double arbitrary_reactive_rebuild_ms = 0.0;
};

PrearmBenchResult bench_prearmed_vs_arbitrary(const Session& session, const SourceManager& sources) {
    PrearmBenchResult result;

    BungeeVoiceManager active_voices;
    result.bungee_available = active_voices.prepare(kSampleRate, kChannels, kBlockFrames)
        && active_voices.is_available();
    if (!result.bungee_available)
        return result;

    PrearmedJumpManager prearm;
    prearm.prepare(kSampleRate, kChannels, kBlockFrames);
    result.prearm_all_ms = measure([&] {
        prearm.prepare_all_targets(session, sources, kRevision);
    }).us / 1000.0;

    std::shared_ptr<const PreparedVoiceMap> prepared_for_schedule;
    result.take_and_swap_us = measure([&] {
        auto prepared = prearm.take_ready(marker_key());
        result.marker_ready = static_cast<bool>(prepared) && prepared->valid;
        if (prepared) {
            auto voice_map = prepared->extract_voice_map();
            prepared_for_schedule = active_voices.build_prepared_voice_map(voice_map);
            active_voices.publish_prepared_voice_map_realtime(prepared_for_schedule);
        }
    }).us;

    JumpScheduler scheduler;
    TransportClock clock(kSampleRate);
    clock.seek(kScheduledTrigger - 192);
    clock.play();
    clock.clear_pending_start();

    ScheduledJump scheduled;
    scheduled.jump_id = "scheduled-prepared-marker";
    scheduled.target = marker_target("chorus", kMarkerFrame);
    scheduled.trigger = JumpTrigger::AtFrame;
    scheduled.status = JumpStatus::Pending;
    scheduled.trigger_frame = kScheduledTrigger;
    scheduled.prepared_voice_map = prepared_for_schedule;
    scheduled.suppress_seek_fade = static_cast<bool>(prepared_for_schedule);
    scheduler.schedule(scheduled);
    scheduler.drain_pending();

    std::optional<DueJump> due;
    result.scheduled_prepared_check_us = measure([&] {
        due = scheduler.check_due(clock, session, kBlockFrames);
    }).us;
    result.scheduled_prepared_exact = due
        && due->trigger_frame == kScheduledTrigger
        && due->target_frame == kMarkerFrame;
    result.scheduled_has_prepared_payload = due && static_cast<bool>(due->prepared_voice_map);

    result.arbitrary_reactive_rebuild_ms = measure([&] {
        active_voices.rebuild_for_seek(kArbitraryFrame, session, sources);
    }).us / 1000.0;

    return result;
}

} // namespace

int main() {
    SourceManager sources;
    Session session;
    build_live_session(sources, session);

    const auto scheduler = bench_scheduler_contracts(session);
    const auto prearm = bench_prearmed_vs_arbitrary(session, sources);

    std::puts("LibreTracks jump-path benchmark");
    std::printf("tracks=%d block_frames=%d sample_rate=%d marker_frame=%lld scheduled_trigger=%lld arbitrary_frame=%lld\n",
                kTrackCount,
                kBlockFrames,
                kSampleRate,
                static_cast<long long>(kMarkerFrame),
                static_cast<long long>(kScheduledTrigger),
                static_cast<long long>(kArbitraryFrame));

    std::puts("\nScheduler contracts");
    std::printf("marker schedule_immediate: %.2f us exact=%s\n",
                scheduler.schedule_immediate_us,
                scheduler.marker_resolved_exact ? "yes" : "NO");
    std::printf("scheduled AtFrame check_due: %.2f us exact=%s\n",
                scheduler.scheduled_check_us,
                scheduler.at_frame_exact ? "yes" : "NO");
    std::printf("scheduled AtRegionEnd check_due: %.2f us exact=%s\n",
                scheduler.region_end_check_us,
                scheduler.region_end_exact ? "yes" : "NO");

    std::puts("\nPrepared marker vs arbitrary frame");
    if (!prearm.bungee_available) {
        std::puts("Bungee unavailable in this build; prearm/reactive voice timings skipped.");
        return scheduler.marker_resolved_exact && scheduler.at_frame_exact && scheduler.region_end_exact ? 0 : 3;
    }

    std::printf("prearm all targets: %.2f ms marker_ready=%s\n",
                prearm.prearm_all_ms,
                prearm.marker_ready ? "yes" : "NO");
    std::printf("marker take+publish prepared voices: %.2f us\n",
                prearm.take_and_swap_us);
    std::printf("scheduled prepared check_due: %.2f us exact=%s prepared_payload=%s\n",
                prearm.scheduled_prepared_check_us,
                prearm.scheduled_prepared_exact ? "yes" : "NO",
                prearm.scheduled_has_prepared_payload ? "yes" : "NO");
    std::printf("arbitrary frame reactive rebuild: %.2f ms\n",
                prearm.arbitrary_reactive_rebuild_ms);

    const bool ok = scheduler.marker_resolved_exact
        && scheduler.at_frame_exact
        && scheduler.region_end_exact
        && prearm.marker_ready
        && prearm.scheduled_prepared_exact
        && prearm.scheduled_has_prepared_payload;
    return ok ? 0 : 4;
}
