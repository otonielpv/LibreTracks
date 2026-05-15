#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/render/pitch_resolution.h>

#include <algorithm>
#include <chrono>
#include <cstdio>

namespace lt {

RealtimePitchEngine::RealtimePitchEngine()
    : active_(std::make_shared<const ActivePitchStreamSet>()) {
    for (auto& c : stream_mismatch_counts_)
        c.store(0, std::memory_order_relaxed);
}

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
    publish_stream_set(build_stream_set_for_target(0, session, sources, true));
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

                // Build a stream for every distinct semitone value this clip can have.
                // A clip can have different semitones depending on which region (if any)
                // covers the render timeline_frame. We enumerate:
                //   1. Semitones outside all regions (using clip.timeline_start_frame as a
                //      representative gap frame — may equal song.transpose_semitones + clip.semitones).
                //   2. Semitones inside each region that overlaps this clip's timeline span.
                // This ensures the stream key built here always matches what render_clip()
                // will look up at runtime, regardless of where the playhead actually is.

                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;

                // Helper: add a stream for the given semitone value if not already present.
                // Reuses the existing stream object when the key matches to avoid recreating
                // the RubberBandStretcher (which is expensive — ~120ms per instance).
                auto add_stream_for_semitones = [&](Semitones semitones, Frame prime_frame) {
                    if (semitones == 0) return;
                    PitchStreamKey key{clip.source_id, track.id, clip.id,
                                       static_cast<double>(semitones),
                                       sample_rate_, source->channel_count(),
                                       clip.source_start_frame, 1};
                    // Deduplicate — same semitone value may appear from multiple regions.
                    for (const auto& h : set->streams)
                        if (h.key == key) return;

                    // Reuse existing stream if key matches — avoids RubberBandStretcher recreation.
                    std::shared_ptr<RealtimePitchStream> stream = find_stream(key);
                    if (!stream || !stream->configured()) {
                        stream = std::make_shared<RealtimePitchStream>();
                        stream->configure(RealtimePitchStream::Config{
                            sample_rate_, source->channel_count(), static_cast<double>(semitones),
                            0.0, 4096, std::clamp(sample_rate_ / 20, 1024, 4096), 32768});
                    }

                    if (prime_target_streams && prime_frame >= 0) {
                        if (prime_frame < clip_end && prime_frame + ahead > clip.timeline_start_frame) {
                            const Frame overlap_start = std::max(prime_frame, clip.timeline_start_frame);
                            const Frame source_frame = clip.source_start_frame
                                + (overlap_start - clip.timeline_start_frame);
                            source_cache_.prepare_window(*source,
                                std::max<Frame>(0, source_frame - sample_rate_ / 10), ahead);
                            stream->reset_for_seek(*source, source_frame, overlap_start);
                            // Prime just enough to cover RubberBand's startup latency (~2048 frames).
                            // The sentinel discards any clock-advance gap on first render.
                            // Keeping this small is critical: this runs synchronously on the control
                            // thread for every stream, so latency multiplies by stream count.
                            const int prime_frames = std::max(1024, sample_rate_ / 24);
                            stream->prime(*source, overlap_start, prime_frames);
                        }
                    }
                    set->streams.push_back(ActivePitchStreamHandle{std::move(key), std::move(stream)});
                };

                // 1. Semitones outside all regions (gap semitones).
                //    Use clip.timeline_start_frame as the canonical gap probe frame.
                {
                    const auto gap_semitones = resolve_effective_semitones(
                        track, clip, song, clip.timeline_start_frame);
                    const Frame prime_frame = (target_frame >= 0) ? target_frame : clip.timeline_start_frame;
                    add_stream_for_semitones(gap_semitones, prime_frame);
                }

                // 2. Semitones inside each region that overlaps this clip's span.
                for (const auto& region : song.regions) {
                    // Skip regions that don't overlap this clip.
                    if (region.end_frame <= clip.timeline_start_frame) continue;
                    if (region.start_frame >= clip_end) continue;
                    // Also skip regions whose end_frame is zero (malformed; they would never
                    // match in resolve_region_transpose either).
                    if (region.end_frame == 0) continue;

                    // Use the region's start_frame as the probe (it's inside the region by
                    // definition: start_frame < end_frame, and start_frame >= start_frame).
                    const Frame probe = region.start_frame;
                    const auto region_semitones = resolve_effective_semitones(track, clip, song, probe);
                    // For priming, prefer target_frame if it's inside this region; otherwise
                    // use the region's start as the representative frame.
                    Frame prime_frame = clip.timeline_start_frame;
                    if (target_frame >= 0) {
                        if (target_frame >= region.start_frame && target_frame < region.end_frame)
                            prime_frame = target_frame;
                        else
                            prime_frame = region.start_frame;
                    }
                    add_stream_for_semitones(region_semitones, prime_frame);
                }
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
    // Debounce all discontinuity calls: if the same reason+frame was processed
    // within kDebounceMs, skip the expensive rebuild. This prevents the control thread
    // being overwhelmed by repeated identical calls (e.g. rapid seek clicks, slider drag).
    {
        const auto now = std::chrono::steady_clock::now();
        const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - last_discontinuity_time_).count();
        if (elapsed_ms < kDebounceMs
                && last_discontinuity_reason_ == reason
                && last_transport_discontinuity_target_frame_.load(std::memory_order_relaxed) == target_frame) {
            std::fprintf(stdout, "[PITCH_ENGINE] discontinuity debounced reason=%s frame=%lld elapsed_ms=%lld\n",
                reason.c_str(), (long long)target_frame, (long long)elapsed_ms);
            std::fflush(stdout);
            return;
        }
        last_discontinuity_time_ = now;
        last_discontinuity_reason_ = reason;
    }
    {
        auto streams = std::atomic_load(&active_);
        const int n_streams = streams ? static_cast<int>(streams->streams.size()) : 0;
        std::fprintf(stdout, "[PITCH_ENGINE] discontinuity reason=%s frame=%lld streams=%d\n",
            reason.c_str(), (long long)target_frame, n_streams);
        std::fflush(stdout);
    }

    last_reason_ = reason;
    last_transport_discontinuity_target_frame_.store(target_frame, std::memory_order_release);
    if (target_frame > static_cast<Frame>(sample_rate_) * 30)
        long_seek_count_.fetch_add(1, std::memory_order_relaxed);
    // Suppress repair requests for a grace period after the discontinuity.
    post_seek_repair_suppression_remaining_.store(kPostSeekRepairSuppressionBlocks,
                                                  std::memory_order_release);
    repair_pending_.store(false, std::memory_order_release);
    for (auto& c : stream_mismatch_counts_)
        c.store(0, std::memory_order_relaxed);
    const auto t_rebuild_start = std::chrono::steady_clock::now();
    prepare_window(target_frame, session, sources, true);
    const auto t_rebuild_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t_rebuild_start).count();

    // The audio clock kept running while we were rebuilding. Prime extra frames to
    // cover the rebuild latency so the gap discard on first_render finds the ring full.
    if (t_rebuild_ms > 0) {
        const Frame extra_frames = static_cast<Frame>(t_rebuild_ms * sample_rate_ / 1000) + 512;
        auto set = std::atomic_load(&active_);
        if (set) {
            for (const auto& handle : set->streams) {
                if (!handle.stream) continue;
                const auto* source = sources.get(handle.key.source_id);
                if (!source || !source->is_loaded()) continue;
                handle.stream->prime(*source, target_frame, static_cast<int>(extra_frames));
            }
        }
        std::fprintf(stdout, "[PITCH_ENGINE] discontinuity_done reason=%s frame=%lld rebuild_ms=%lld extra_primed=%lld\n",
            reason.c_str(), (long long)target_frame, (long long)t_rebuild_ms, (long long)extra_frames);
    } else {
        std::fprintf(stdout, "[PITCH_ENGINE] discontinuity_done reason=%s frame=%lld rebuild_ms=%lld\n",
            reason.c_str(), (long long)target_frame, (long long)t_rebuild_ms);
    }
    std::fflush(stdout);
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

    // Find the stream and its slot index for per-slot mismatch tracking.
    auto set = std::atomic_load(&active_);
    std::shared_ptr<RealtimePitchStream> stream;
    int slot_index = -1;
    for (int i = 0; i < static_cast<int>(set->streams.size()) && i < kMaxStreamSlots; ++i) {
        if (set->streams[static_cast<std::size_t>(i)].key == key) {
            stream = set->streams[static_cast<std::size_t>(i)].stream;
            slot_index = i;
            break;
        }
    }

    if (!stream) {
        missing_stream_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    if (!source_cache_.is_ready(source, source_frame, frame_count))
        stream_not_ready_count_.fetch_add(1, std::memory_order_relaxed);

    // expected_timeline_frame() == -1 means freshly primed; stream will accept any position.
    const Frame expected = stream->expected_timeline_frame();
    const bool primed_sentinel = (expected == -1);
    if (!primed_sentinel && expected != timeline_frame) {
        pitch_timeline_mismatch_count_.fetch_add(1, std::memory_order_relaxed);
        pitch_stream_not_aligned_count_.fetch_add(1, std::memory_order_relaxed);

        const int suppression = post_seek_repair_suppression_remaining_.load(std::memory_order_relaxed);
        if (suppression > 0) {
            post_seek_repair_suppression_remaining_.store(suppression - 1, std::memory_order_relaxed);
        } else if (slot_index >= 0) {
            const int prev = stream_mismatch_counts_[slot_index].fetch_add(1, std::memory_order_relaxed);
            if (prev + 1 >= kPitchMismatchRepairThreshold) {
                repair_target_frame_.store(timeline_frame, std::memory_order_relaxed);
                repair_pending_.store(true, std::memory_order_release);
                pitch_repair_requested_count_.fetch_add(1, std::memory_order_relaxed);
                stream_mismatch_counts_[slot_index].store(0, std::memory_order_relaxed);
            }
        }
    } else if (!primed_sentinel) {
        if (slot_index >= 0)
            stream_mismatch_counts_[slot_index].store(0, std::memory_order_relaxed);
    }

    const int rendered = stream->render(source, source_frame, timeline_frame, frame_count, out, out_channels);
    render_count_.fetch_add(1, std::memory_order_relaxed);
    return rendered;
}

bool RealtimePitchEngine::take_repair_request(Frame& out_target_frame) noexcept {
    if (!repair_pending_.load(std::memory_order_acquire))
        return false;
    out_target_frame = repair_target_frame_.load(std::memory_order_relaxed);
    repair_pending_.store(false, std::memory_order_release);
    return true;
}

void RealtimePitchEngine::prepare_for_pitch_repair(Frame target_frame,
                                                   const Session& session,
                                                   const SourceManager& sources) {
    prepare_window(target_frame, session, sources, true);
    pitch_repair_completed_count_.fetch_add(1, std::memory_order_relaxed);
    // Clear all per-slot mismatch counters since we have a fresh primed set.
    for (auto& c : stream_mismatch_counts_)
        c.store(0, std::memory_order_relaxed);
}

PitchStreamDiagnostics RealtimePitchEngine::diagnostics() const noexcept {
    PitchStreamDiagnostics d;
    d.render_count = render_count_.load(std::memory_order_relaxed);
    d.source_miss_count = source_cache_.miss_count();
    d.emergency_silence_count = emergency_silence_count_.load(std::memory_order_relaxed);
    d.active_stream_set_generation = active_stream_set_generation_.load(std::memory_order_relaxed);
    d.active_stream_swap_count = active_stream_swap_count_.load(std::memory_order_relaxed);
    d.pitch_timeline_mismatch_count = pitch_timeline_mismatch_count_.load(std::memory_order_relaxed);
    d.pitch_stream_not_aligned_count = pitch_stream_not_aligned_count_.load(std::memory_order_relaxed);
    d.pitch_audio_thread_reset_count = pitch_audio_thread_reset_count_.load(std::memory_order_relaxed);
    d.pitch_audio_thread_prime_count = pitch_audio_thread_prime_count_.load(std::memory_order_relaxed);
    d.pitch_repair_requested_count = pitch_repair_requested_count_.load(std::memory_order_relaxed);
    d.pitch_repair_completed_count = pitch_repair_completed_count_.load(std::memory_order_relaxed);
    d.long_seek_count = long_seek_count_.load(std::memory_order_relaxed);
    d.last_transport_discontinuity_target_frame =
        last_transport_discontinuity_target_frame_.load(std::memory_order_relaxed);
    d.last_transport_discontinuity_reason = last_reason_;
    d.active_render_path = "realtime_stream";
    auto set = std::atomic_load(&active_);
    for (const auto& handle : set->streams) {
        if (!handle.stream)
            continue;
        ++d.active_pitch_stream_count;
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
    // Aggregate stub/backend diagnostics from each stream and set engine-level fields.
    auto set2 = std::atomic_load(&active_);
    for (const auto& handle : set2->streams) {
        if (!handle.stream) continue;
        auto sd = handle.stream->diagnostics();
        d.stub_passthrough_count += sd.stub_passthrough_count;
        d.stub_passthrough_blocked_count += sd.stub_passthrough_blocked_count;
        d.backend_unavailable_count += sd.backend_unavailable_count;
        // Use last stream's backend identity (all streams have same backend).
        d.pitch_backend = sd.pitch_backend;
        d.pitch_runtime_enabled = sd.pitch_runtime_enabled;
        if (!sd.pitch_muted_or_bypassed_reason.empty())
            d.pitch_muted_or_bypassed_reason = sd.pitch_muted_or_bypassed_reason;
    }
    // If no streams exist, get backend identity from a temporary stream's diagnostics.
    if (set2->streams.empty()) {
        RealtimePitchStream tmp;
        auto td = tmp.diagnostics();
        d.pitch_backend = td.pitch_backend;
        d.pitch_runtime_enabled = td.pitch_runtime_enabled;
        d.pitch_muted_or_bypassed_reason = td.pitch_muted_or_bypassed_reason;
    }
    d.missing_stream_count = missing_stream_count_.load(std::memory_order_relaxed);
    return d;
}

void RealtimePitchEngine::reset_diagnostics() noexcept {
    render_count_.store(0, std::memory_order_relaxed);
    missing_stream_count_.store(0, std::memory_order_relaxed);
    stream_not_ready_count_.store(0, std::memory_order_relaxed);
    emergency_silence_count_.store(0, std::memory_order_relaxed);
    unsafe_cross_thread_reset_count_.store(0, std::memory_order_relaxed);
    concurrent_stream_mutation_detected_.store(0, std::memory_order_relaxed);
    pitch_timeline_mismatch_count_.store(0, std::memory_order_relaxed);
    pitch_stream_not_aligned_count_.store(0, std::memory_order_relaxed);
    pitch_audio_thread_reset_count_.store(0, std::memory_order_relaxed);
    pitch_audio_thread_prime_count_.store(0, std::memory_order_relaxed);
    pitch_repair_requested_count_.store(0, std::memory_order_relaxed);
    pitch_repair_completed_count_.store(0, std::memory_order_relaxed);
}

} // namespace lt
