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

void RealtimePitchEngine::prepare_for_session(const Session& session, const SourceManager& sources, int sample_rate) {
    std::lock_guard lock(control_mutex_);
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;
    // On session load, publish an empty set — streams will be primed on first play/seek.
    // This avoids blocking construction of dozens of RubberBand instances upfront.
    publish_stream_set(std::make_shared<ActivePitchStreamSet>());
}

// Compute how many frames the ring must contain before publishing.
// Must be large enough that the audio thread cannot drain the ring before the
// control thread refills it. Formula:
//   crossfade_ramp (~1024) + 2 × max_block + start_delay_safety
// We use 4 × max_block_size as the floor to cover device jitter.
static int compute_min_ready_frames(int sample_rate, int max_block_size) {
    // RubberBand start delay at 48 kHz in HighConsistency mode is ~8192 frames.
    // We already account for it during reset_for_seek, but add a safety margin.
    const int rb_latency_safety = 2048;
    const int crossfade_ramp    = 1024;
    const int jitter_margin     = 4 * max_block_size;
    (void)sample_rate;
    return rb_latency_safety + crossfade_ramp + jitter_margin;
}

std::shared_ptr<RealtimePitchEngine::ActivePitchStreamSet>
RealtimePitchEngine::build_stream_set_for_target(Frame target_frame,
                                                 const Session& session,
                                                 const SourceManager& sources,
                                                 bool prime_target_streams,
                                                 int max_block_size,
                                                 Frame lookahead_override) {
    auto set = std::make_shared<ActivePitchStreamSet>();
    set->streams.reserve(16);

    // Lookahead window: cover enough time that the audio thread stays fed even if
    // the control thread is delayed. 2 seconds is the default safe window. Seek and
    // transpose-change rebuilds pass a smaller override (~500ms) so they finish faster;
    // extend_for_playhead fills in the rest of the lookahead as playback advances.
    const Frame lookahead = lookahead_override > 0
        ? lookahead_override
        : static_cast<Frame>(sample_rate_) * 2;
    const Frame window_start = std::max<Frame>(0, target_frame);
    const Frame window_end   = window_start + lookahead;

    // Effective block size for priming — never smaller than 512.
    const int block = std::max(512, max_block_size);
    const int min_ready = compute_min_ready_frames(sample_rate_, block);

    // We build exactly one stream per (clip × effective-semitones-at-target-frame).
    // We do NOT enumerate every region in the song — only the semitone value active
    // at target_frame for each clip that is audible within [window_start, window_end].
    // This keeps voice count proportional to audible tracks, not to song structure.

    for (const auto& song : session.songs) {
        // Skip songs entirely outside the window.
        if (song.end_frame <= window_start || song.start_frame >= window_end)
            continue;

        for (const auto& track : song.tracks) {
            // Skip folder tracks and NeverTranspose tracks — they don't need pitch streams.
            if (track.kind == TrackKind::Folder)
                continue;
            if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
                continue;

            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;

                // Skip clips not overlapping the target window.
                if (clip_end <= window_start || clip.timeline_start_frame >= window_end)
                    continue;

                auto source = sources.get_shared(clip.source_id);
                if (!source || !source->is_loaded())
                    continue;

                // A clip may cross multiple region boundaries within the lookahead window,
                // requiring a different pitch stream for each distinct semitone value.
                // Collect all distinct (semitone, effective_start_frame) pairs:
                //   1. At the clip/target overlap start (covers the initial section).
                //   2. At each region boundary that falls inside the clip × window intersection.
                // This ensures we have a ready stream for every semitone value that will
                // be requested during the lookahead window — including region transitions.

                const Frame clip_window_start = std::max({window_start, clip.timeline_start_frame});
                const Frame clip_window_end   = std::min(clip_end, window_end);

                // Gather probe frames: at clip_window_start and at each region boundary inside window.
                // We use a small fixed-size list to avoid heap allocation on the hot path.
                std::array<Frame, 16> probe_frames;
                int n_probes = 0;
                probe_frames[n_probes++] = clip_window_start;

                for (const auto& region : song.regions) {
                    if (region.start_frame > clip_window_start && region.start_frame < clip_window_end) {
                        if (n_probes < static_cast<int>(probe_frames.size()))
                            probe_frames[n_probes++] = region.start_frame;
                    }
                }

                for (int pi = 0; pi < n_probes; ++pi) {
                    const Frame probe = probe_frames[pi];
                    const auto decision = resolve_pitch_render_decision(track, clip, song, probe);

                    // If semitones == 0, no pitch stream needed for this section.
                    if (!decision.needs_pitch || decision.effective_semitones == 0)
                        continue;

                    const Semitones semitones = decision.effective_semitones;
                    PitchStreamKey key{clip.source_id, track.id, clip.id,
                                       static_cast<double>(semitones),
                                       sample_rate_, source->channel_count(),
                                       clip.source_start_frame, 1};

                    // Deduplicate — same key from multiple probes within same semitone zone.
                    bool found = false;
                    for (const auto& h : set->streams)
                        if (h.key == key) { found = true; break; }
                    if (found) continue;

                    // Always create a fresh stream — never reuse from the published set.
                    // SAFETY: the audio thread reads the old set via atomic_load while we build.
                    // Publishing atomically makes it safe.
                    auto stream = std::make_shared<RealtimePitchStream>();
                    stream->configure(RealtimePitchStream::Config{
                        sample_rate_, source->channel_count(), static_cast<double>(semitones),
                        0.0, block, std::clamp(sample_rate_ / 20, 1024, 4096), 65536});

                    if (prime_target_streams) {
                        // Prime at the clip/target overlap start so the stream is aligned
                        // to where the audio thread will first request it.
                        const Frame overlap_start = std::max(target_frame, clip.timeline_start_frame);
                        const Frame source_frame  = clip.source_start_frame
                            + (overlap_start - clip.timeline_start_frame);

                        // Warm the source read-ahead cache so process_source() hits memory.
                        source_cache_.prepare_window(*source,
                            std::max<Frame>(0, source_frame - static_cast<Frame>(sample_rate_) / 10),
                            lookahead + static_cast<Frame>(sample_rate_) / 10);

                        stream->reset_for_seek(*source, source_frame, overlap_start);

                        // Prime until the ring has min_ready_frames of output.
                        // This guarantees the audio thread cannot underflow on the first several blocks
                        // even if the control thread is slow to refill.
                        stream->prime(*source, overlap_start, min_ready);
                    }

                    set->streams.push_back(ActivePitchStreamHandle{std::move(key), std::move(stream)});
                }
            }
        }
    }

    set->min_ready_frames = min_ready;
    set->target_frame     = target_frame;
    set->build_lookahead  = lookahead;
    return set;
}

void RealtimePitchEngine::prepare_window(Frame target_frame,
                                         const Session& session,
                                         const SourceManager& sources,
                                         bool reset_streams,
                                         int max_block_size) {
    publish_stream_set(build_stream_set_for_target(target_frame, session, sources,
                                                   reset_streams, max_block_size));
}

void RealtimePitchEngine::prepare_for_play(Frame playhead_frame, const Session& session, const SourceManager& sources) {
    std::lock_guard lock(control_mutex_);
    prepare_window(playhead_frame, session, sources, true, max_block_size_hint_);
}

void RealtimePitchEngine::prepare_for_transport_discontinuity(Frame target_frame,
                                                              const std::string& reason,
                                                              const Session& session,
                                                              const SourceManager& sources) {
    std::lock_guard lock(control_mutex_);
    // Debounce only exact-same-frame + same-reason calls within kDebounceMs.
    // Seeks always go through even if the frame happens to match (different reason).
    // Never debounce seek_absolute / seek_relative — they need immediate alignment.
    const bool is_seek = (reason == "seek_absolute" || reason == "seek_relative"
                          || reason == "scheduled_jump");
    if (!is_seek) {
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
    } else {
        // Always update time for seeks so subsequent non-seek debounce is fresh.
        last_discontinuity_time_ = std::chrono::steady_clock::now();
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
    // Reset rolling-extend cursor so the next extend_for_playhead call covers the new window.
    last_extend_playhead_ = target_frame;

    // Suppress repair requests for a grace period after the discontinuity.
    post_seek_repair_suppression_remaining_.store(kPostSeekRepairSuppressionBlocks,
                                                  std::memory_order_release);
    repair_pending_.store(false, std::memory_order_release);
    for (auto& c : stream_mismatch_counts_)
        c.store(0, std::memory_order_relaxed);

    const auto t_rebuild_start = std::chrono::steady_clock::now();
    // Build a new stream set primed at target_frame. Use a SHORT lookahead (~500ms)
    // so the rebuild finishes quickly; extend_for_playhead will add the rest of the
    // 2-second lookahead as playback advances. This trades a longer total warm-up for
    // a much shorter blocking rebuild — critical for live seeks/transpose changes.
    const Frame discontinuity_lookahead = static_cast<Frame>(sample_rate_) / 2;
    auto new_set = build_stream_set_for_target(target_frame, session, sources,
                                               /*prime=*/true, max_block_size_hint_,
                                               discontinuity_lookahead);

    const auto t_rebuild_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t_rebuild_start).count();

    // If the build took significant time, the audio clock has advanced past target_frame.
    // Prime extra frames so the gap-discard on first render finds the ring sufficiently full.
    // This is the key to eliminating post-seek dropouts: ring must survive the gap discard
    // AND still have min_ready_frames left for the audio thread.
    if (t_rebuild_ms > 0 && !new_set->streams.empty()) {
        const Frame extra_frames = static_cast<Frame>(t_rebuild_ms * sample_rate_ / 1000) + 1024;
        for (auto& handle : new_set->streams) {
            if (!handle.stream) continue;
            auto source = sources.get_shared(handle.key.source_id);
            if (!source || !source->is_loaded()) continue;
            handle.stream->prime(*source, target_frame, static_cast<int>(extra_frames));
        }
    }

    std::fprintf(stdout, "[PITCH_ENGINE] discontinuity_done reason=%s frame=%lld rebuild_ms=%lld voices=%d\n",
        reason.c_str(), (long long)target_frame, (long long)t_rebuild_ms,
        static_cast<int>(new_set->streams.size()));
    std::fflush(stdout);

    // Publish atomically — audio thread sees the new set on the very next render().
    publish_stream_set(std::move(new_set));
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

int RealtimePitchEngine::extend_for_playhead(Frame playhead_frame,
                                              const Session& session,
                                              const SourceManager& sources) {
    std::lock_guard lock(control_mutex_);
    // Retrigger threshold: extend when playhead has advanced at least 1 second past the
    // last extend point. This keeps the lookahead window at [playhead, playhead+2s] while
    // allowing the control thread to call us on every snapshot poll without doing work.
    const Frame retrigger = static_cast<Frame>(sample_rate_);
    if (last_extend_playhead_ >= 0
            && std::llabs(playhead_frame - last_extend_playhead_) < retrigger)
        return 0;

    const Frame lookahead    = static_cast<Frame>(sample_rate_) * 2;
    const Frame window_start = std::max<Frame>(0, playhead_frame);
    const Frame window_end   = window_start + lookahead;
    const int   block        = std::max(512, max_block_size_hint_);
    const int   min_ready    = compute_min_ready_frames(sample_rate_, block);

    // Snapshot the currently published set. The audio thread owns the atomically-shared
    // pointer; we hold a local copy so the set doesn't disappear underneath us.
    auto current = std::atomic_load(&active_);
    if (!current) current = std::make_shared<const ActivePitchStreamSet>();

    // Collect keys we need to add. Do not modify current — build a candidate list first.
    struct NewStream {
        PitchStreamKey key;
        std::shared_ptr<RealtimePitchStream> stream;
    };
    std::vector<NewStream> to_add;

    for (const auto& song : session.songs) {
        if (song.end_frame <= window_start || song.start_frame >= window_end)
            continue;

        for (const auto& track : song.tracks) {
            if (track.kind == TrackKind::Folder)
                continue;
            if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
                continue;

            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                if (clip_end <= window_start || clip.timeline_start_frame >= window_end)
                    continue;

                auto source = sources.get_shared(clip.source_id);
                if (!source || !source->is_loaded())
                    continue;

                const Frame clip_window_start = std::max({window_start, clip.timeline_start_frame});
                const Frame clip_window_end   = std::min(clip_end, window_end);

                // Enumerate distinct semitone zones within clip × window.
                std::array<Frame, 16> probe_frames;
                int n_probes = 0;
                probe_frames[n_probes++] = clip_window_start;
                for (const auto& region : song.regions) {
                    if (region.start_frame > clip_window_start && region.start_frame < clip_window_end)
                        if (n_probes < static_cast<int>(probe_frames.size()))
                            probe_frames[n_probes++] = region.start_frame;
                }

                for (int pi = 0; pi < n_probes; ++pi) {
                    const auto decision = resolve_pitch_render_decision(track, clip, song, probe_frames[pi]);
                    if (!decision.needs_pitch || decision.effective_semitones == 0)
                        continue;

                    PitchStreamKey key{clip.source_id, track.id, clip.id,
                                       static_cast<double>(decision.effective_semitones),
                                       sample_rate_, source->channel_count(),
                                       clip.source_start_frame, 1};

                    // Already in the published set?
                    bool found = false;
                    for (const auto& h : current->streams)
                        if (h.key == key) { found = true; break; }
                    if (found) continue;

                    // Already in our to_add list (dedup across probes)?
                    for (const auto& n : to_add)
                        if (n.key == key) { found = true; break; }
                    if (found) continue;

                    // Build and prime at the clip's audible overlap start with the window.
                    const Frame overlap_start = std::max(playhead_frame, clip.timeline_start_frame);
                    const Frame source_frame  = clip.source_start_frame
                        + (overlap_start - clip.timeline_start_frame);

                    source_cache_.prepare_window(*source,
                        std::max<Frame>(0, source_frame - static_cast<Frame>(sample_rate_) / 10),
                        lookahead + static_cast<Frame>(sample_rate_) / 10);

                    auto stream = std::make_shared<RealtimePitchStream>();
                    stream->configure(RealtimePitchStream::Config{
                        sample_rate_, source->channel_count(),
                        static_cast<double>(decision.effective_semitones),
                        0.0, block, std::clamp(sample_rate_ / 20, 1024, 4096), 65536});
                    stream->reset_for_seek(*source, source_frame, overlap_start);
                    stream->prime(*source, overlap_start, min_ready);

                    to_add.push_back(NewStream{std::move(key), std::move(stream)});
                }
            }
        }
    }

    if (to_add.empty()) {
        last_extend_playhead_ = playhead_frame;
        return 0;
    }

    // Build the merged set: all existing streams + new ones.
    // We copy the handle vector so the audio thread's atomic_load still sees the old set
    // until we atomically publish the new merged one.
    auto merged = std::make_shared<ActivePitchStreamSet>();
    merged->streams.reserve(current->streams.size() + to_add.size());
    for (const auto& h : current->streams)
        merged->streams.push_back(h);
    for (auto& n : to_add)
        merged->streams.push_back(ActivePitchStreamHandle{std::move(n.key), std::move(n.stream)});
    merged->min_ready_frames = min_ready;
    merged->target_frame     = playhead_frame;
    merged->build_lookahead  = lookahead;

    std::fprintf(stdout, "[PITCH_ENGINE] extend_for_playhead frame=%lld added=%d total=%d\n",
        (long long)playhead_frame, static_cast<int>(to_add.size()),
        static_cast<int>(merged->streams.size()));
    std::fflush(stdout);

    publish_stream_set(std::move(merged));
    last_extend_playhead_ = playhead_frame;
    return static_cast<int>(to_add.size());
}

void RealtimePitchEngine::pre_prepare_for_scheduled_jump(Frame jump_target_frame,
                                                          const Session& session,
                                                          const SourceManager& sources) {
    std::lock_guard lock(control_mutex_);
    std::fprintf(stdout, "[PITCH_ENGINE] pre_prepare_for_scheduled_jump frame=%lld\n",
        (long long)jump_target_frame);
    std::fflush(stdout);

    // Build and prime a graph at the jump target. This runs on the control thread
    // while the audio thread still plays with the current (pre-jump) graph.
    pending_jump_graph_ = build_stream_set_for_target(jump_target_frame, session, sources,
                                                       /*prime=*/true, max_block_size_hint_);
    pending_jump_target_frame_ = jump_target_frame;
}

void RealtimePitchEngine::publish_pending_jump_graph(Frame jump_target_frame,
                                                      const Session& session,
                                                      const SourceManager& sources) {
    std::lock_guard lock(control_mutex_);
    // Suppress repair requests for a grace period — the new graph is already aligned.
    post_seek_repair_suppression_remaining_.store(kPostSeekRepairSuppressionBlocks,
                                                  std::memory_order_release);
    repair_pending_.store(false, std::memory_order_release);
    for (auto& c : stream_mismatch_counts_)
        c.store(0, std::memory_order_relaxed);

    last_transport_discontinuity_target_frame_.store(jump_target_frame, std::memory_order_release);
    last_reason_ = "scheduled_jump";
    last_extend_playhead_ = jump_target_frame;

    if (pending_jump_graph_ && pending_jump_target_frame_ == jump_target_frame) {
        // Happy path: use the pre-built graph. It was primed before the jump fired,
        // so the audio thread sees a fully-ready ring immediately on publish.
        std::fprintf(stdout, "[PITCH_ENGINE] publish_pending_jump_graph FAST frame=%lld voices=%d\n",
            (long long)jump_target_frame,
            static_cast<int>(pending_jump_graph_->streams.size()));
        std::fflush(stdout);

        publish_stream_set(std::move(pending_jump_graph_));
        pending_jump_target_frame_ = -1;
    } else {
        // Fallback: the jump target changed or pre-prepare wasn't called. Rebuild now.
        std::fprintf(stdout, "[PITCH_ENGINE] publish_pending_jump_graph REBUILD frame=%lld (pre_frame=%lld)\n",
            (long long)jump_target_frame, (long long)pending_jump_target_frame_);
        std::fflush(stdout);

        pending_jump_graph_.reset();
        pending_jump_target_frame_ = -1;

        auto new_set = build_stream_set_for_target(jump_target_frame, session, sources,
                                                    /*prime=*/true, max_block_size_hint_);
        publish_stream_set(std::move(new_set));
    }
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
    std::lock_guard lock(control_mutex_);
    prepare_window(target_frame, session, sources, true, max_block_size_hint_);
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
