#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/render/pitch_resolution.h>

#include <algorithm>

namespace lt {

RealtimePitchEngine::RealtimePitchEngine()
    : active_(std::make_shared<const ActivePitchStreamSet>()) {}

RealtimePitchEngine::~RealtimePitchEngine() = default;

void RealtimePitchEngine::publish_stream_set(std::shared_ptr<ActivePitchStreamSet> set) {
    const auto generation = active_stream_set_generation_.fetch_add(1, std::memory_order_acq_rel) + 1;
    for (auto& handle : set->streams) {
        if (handle.stream)
            handle.stream->mark_published(generation);
    }
    std::atomic_store(&active_, std::shared_ptr<const ActivePitchStreamSet>(std::move(set)));
    active_stream_swap_count_.fetch_add(1, std::memory_order_relaxed);
}

std::shared_ptr<RealtimePitchStream> RealtimePitchEngine::find_stream(const PitchStreamKey& key) const noexcept {
    auto set = std::atomic_load(&active_);
    for (const auto& handle : set->streams) {
        if (handle.key == key)
            return handle.stream;
    }
    return {};
}

void RealtimePitchEngine::prepare_for_session(const Session& session, const SourceManager& sources, int sample_rate) {
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;
    publish_stream_set(build_stream_set_for_target(-1, session, sources, false));
}

std::shared_ptr<RealtimePitchEngine::ActivePitchStreamSet>
RealtimePitchEngine::build_stream_set_for_target(Frame target_frame,
                                                 const Session& session,
                                                 const SourceManager& sources,
                                                 bool prime_target_streams) {
    auto set = std::make_shared<ActivePitchStreamSet>();
    set->streams.reserve(64);
    const Frame ahead = static_cast<Frame>(sample_rate_) * 3;
    for (const auto& song : session.songs) {
        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                const auto* source = sources.get(clip.source_id);
                if (!source || !source->is_loaded())
                    continue;
                const auto semitones = resolve_effective_semitones(track, clip, song, clip.timeline_start_frame);
                if (semitones == 0)
                    continue;
                PitchStreamKey key{clip.source_id, track.id, clip.id, static_cast<double>(semitones),
                                   sample_rate_, source->channel_count(), clip.source_start_frame, 1};
                auto stream = std::make_shared<RealtimePitchStream>();
                stream->configure(RealtimePitchStream::Config{
                    sample_rate_, source->channel_count(), static_cast<double>(semitones),
                    0.0, 4096, std::clamp(sample_rate_ / 20, 1024, 4096), 32768});
                if (prime_target_streams && target_frame >= 0) {
                    const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                    if (target_frame < clip_end && target_frame + ahead > clip.timeline_start_frame) {
                        const Frame overlap_start = std::max(target_frame, clip.timeline_start_frame);
                        const Frame source_frame = clip.source_start_frame + (overlap_start - clip.timeline_start_frame);
                        source_cache_.prepare_window(*source, std::max<Frame>(0, source_frame - sample_rate_ / 10), ahead);
                        stream->reset_for_seek(*source, source_frame, overlap_start);
                        stream->prime(*source, overlap_start, 1024);
                    }
                }
                set->streams.push_back(ActivePitchStreamHandle{std::move(key), std::move(stream)});
            }
        }
    }
    return set;
}

void RealtimePitchEngine::prepare_window(Frame target_frame,
                                         const Session& session,
                                         const SourceManager& sources,
                                         bool reset_streams) {
    publish_stream_set(build_stream_set_for_target(target_frame, session, sources, reset_streams));
}

void RealtimePitchEngine::prepare_for_play(Frame playhead_frame, const Session& session, const SourceManager& sources) {
    prepare_window(playhead_frame, session, sources, true);
}

void RealtimePitchEngine::prepare_for_transport_discontinuity(Frame target_frame,
                                                              const std::string& reason,
                                                              const Session& session,
                                                              const SourceManager& sources) {
    last_reason_ = reason;
    last_transport_discontinuity_target_frame_.store(target_frame, std::memory_order_release);
    if (target_frame > static_cast<Frame>(sample_rate_) * 30)
        long_seek_count_.fetch_add(1, std::memory_order_relaxed);
    prepare_window(target_frame, session, sources, true);
}

int RealtimePitchEngine::render_pitched_clip(const Clip& clip,
                                             const Id& track_id,
                                             const DecodedSource& source,
                                             Frame source_frame,
                                             Frame timeline_frame,
                                             int frame_count,
                                             double semitones,
                                             float** out,
                                             int out_channels) noexcept {
    PitchStreamKey key{clip.source_id, track_id, clip.id, semitones, sample_rate_,
                       source.channel_count(), clip.source_start_frame, 1};
    auto stream = find_stream(key);
    if (!stream) {
        missing_stream_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    if (!source_cache_.is_ready(source, source_frame, frame_count))
        stream_not_ready_count_.fetch_add(1, std::memory_order_relaxed);
    if (stream->expected_timeline_frame() != timeline_frame) {
        stream->reset_for_seek(source, source_frame, timeline_frame);
        stream->prime(source, timeline_frame, frame_count);
    }
    const int rendered = stream->render(source, timeline_frame, frame_count, out, out_channels);
    render_count_.fetch_add(1, std::memory_order_relaxed);
    return rendered;
}

PitchStreamDiagnostics RealtimePitchEngine::diagnostics() const noexcept {
    PitchStreamDiagnostics d;
    d.render_count = render_count_.load(std::memory_order_relaxed);
    d.source_miss_count = source_cache_.miss_count();
    d.emergency_silence_count = emergency_silence_count_.load(std::memory_order_relaxed);
    d.active_stream_set_generation = active_stream_set_generation_.load(std::memory_order_relaxed);
    d.active_stream_swap_count = active_stream_swap_count_.load(std::memory_order_relaxed);
    d.long_seek_count = long_seek_count_.load(std::memory_order_relaxed);
    d.last_transport_discontinuity_target_frame =
        last_transport_discontinuity_target_frame_.load(std::memory_order_relaxed);
    d.last_transport_discontinuity_reason = last_reason_;
    d.active_render_path = "realtime_stream";
    auto set = std::atomic_load(&active_);
    for (const auto& handle : set->streams) {
        if (!handle.stream)
            continue;
        auto sd = handle.stream->diagnostics();
        d.underflow_count += sd.underflow_count;
        d.overflow_count += sd.overflow_count;
        d.reset_count += sd.reset_count;
        d.prime_count += sd.prime_count;
        d.unsafe_cross_thread_reset_count += sd.unsafe_cross_thread_reset_count;
        d.concurrent_stream_mutation_detected += sd.concurrent_stream_mutation_detected;
        d.stream_generation = std::max(d.stream_generation, sd.stream_generation);
        d.stream_reset_thread_id = std::max(d.stream_reset_thread_id, sd.stream_reset_thread_id);
        d.stream_render_thread_id = std::max(d.stream_render_thread_id, sd.stream_render_thread_id);
        d.start_delay_frames = std::max(d.start_delay_frames, sd.start_delay_frames);
        d.preroll_frames = std::max(d.preroll_frames, sd.preroll_frames);
        d.discarded_frames = std::max(d.discarded_frames, sd.discarded_frames);
        d.compensated_latency_frames = std::max(d.compensated_latency_frames, sd.compensated_latency_frames);
        d.ring_available_frames = std::max(d.ring_available_frames, sd.ring_available_frames);
        d.ring_capacity_frames = std::max(d.ring_capacity_frames, sd.ring_capacity_frames);
    }
    d.underflow_count += stream_not_ready_count_.load(std::memory_order_relaxed);
    return d;
}

void RealtimePitchEngine::reset_diagnostics() noexcept {
    render_count_.store(0, std::memory_order_relaxed);
    missing_stream_count_.store(0, std::memory_order_relaxed);
    stream_not_ready_count_.store(0, std::memory_order_relaxed);
    emergency_silence_count_.store(0, std::memory_order_relaxed);
    unsafe_cross_thread_reset_count_.store(0, std::memory_order_relaxed);
    concurrent_stream_mutation_detected_.store(0, std::memory_order_relaxed);
}

} // namespace lt
