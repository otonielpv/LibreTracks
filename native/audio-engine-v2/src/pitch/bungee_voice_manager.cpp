#include <lt_engine/pitch/bungee_voice_manager.h>

#include <lt_engine/debug/logging.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
  #ifndef NOMINMAX
  #define NOMINMAX
  #endif
  #include <windows.h>
#elif defined(__APPLE__)
  #include <pthread.h>
  #include <pthread/qos.h>
#elif defined(__linux__)
  #include <sys/resource.h>
  #include <sys/time.h>
#endif

namespace lt {

namespace {

void request_source_range(const SourceManager& sources,
                          const Id& source_id,
                          Frame start,
                          int frames) {
    if (frames <= 0) return;
    const int first = static_cast<int>(std::max<Frame>(0, start) / kDefaultBlockFrames);
    const int last = static_cast<int>(
        std::max<Frame>(0, start + frames - 1) / kDefaultBlockFrames);
    for (int block = first; block <= last; ++block)
        sources.request_block(source_id, block);
}

// Mirror of the LIBRETRACKS_AUDIO_DEBUG flag used in engine_impl.cpp. Cached
// on first call. Used to gate all [BUNGEE] stdout traces — they're useful in
// dev but pure noise in production where stdout may be a real terminal.
bool bungee_debug_enabled() {
    static const bool on = [] {
        const char* raw = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        if (!raw) return false;
        return raw[0] == '1' || raw[0] == 't' || raw[0] == 'T'
            || raw[0] == 'y' || raw[0] == 'Y' || raw[0] == 'o' || raw[0] == 'O';
    }();
    return on;
}

} // namespace

// ─── Key / map ───────────────────────────────────────────────────────────

// Voices are keyed on clip_id only. Pitch is supplied per render block via
// Bungee's Request::pitch parameter, so a single voice carries a clip through
// arbitrary live pitch changes gaplessly. Rebuilding when pitch changes was
// the bug that caused ~200 ms of silence on every transpose adjustment.
using VoiceMap = PreparedVoiceMap;

// ─── Impl ────────────────────────────────────────────────────────────────

struct BungeeVoiceManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;

    // Published voice map. Audio thread reads via std::atomic_load; control
    // thread builds a new map and swaps via std::atomic_store.
    std::shared_ptr<const VoiceMap> empty{std::make_shared<const VoiceMap>()};
    std::shared_ptr<const VoiceMap> active{empty};

    // Source-ready callbacks and explicit seeks can ask for rebuilds from
    // different control threads. Building/warming Bungee streams is expensive
    // and not guaranteed to be reentrant, so serialize build/publish work while
    // keeping audio-thread lookup lock-free through the atomic voice map.
    std::mutex build_mutex;

    // Diagnostic counters. All relaxed atomics — we only need to know "did
    // the audio thread ever consume a Bungee voice?", not strict ordering.
    std::atomic<std::uint64_t> voices_built_total{0};
    std::atomic<std::uint64_t> rebuilds_for_session{0};
    std::atomic<std::uint64_t> rebuilds_for_seek{0};
    std::atomic<std::uint64_t> voice_lookups_hit{0};
    std::atomic<std::uint64_t> voice_lookups_miss{0};
    std::atomic<std::uint64_t> publish_generation{0};

    // ── Async rebuild worker ────────────────────────────────────────────────
    // Single dedicated thread that processes the "latest" rebuild_for_seek_async
    // request. If a new request arrives before the previous one starts, the
    // pending slot is overwritten — the audio thread cares about the freshest
    // target, not the queue. Captures Session by value so the caller may mutate
    // session state while the worker runs.
    struct AsyncJob {
        Frame                          target_frame = 0;
        std::shared_ptr<const Session> session;     // owned snapshot
        const SourceManager*           sources = nullptr;
        std::uint64_t                  expected_generation = 0;
    };
    std::mutex                  worker_mutex;
    std::condition_variable     worker_cv;
    std::optional<AsyncJob>     pending_job;
    bool                        worker_shutdown = false;
    std::thread                 worker_thread;
};

BungeeVoiceManager::BungeeVoiceManager()
    : impl_(std::make_unique<Impl>()) {}

BungeeVoiceManager::~BungeeVoiceManager() {
    if (!impl_) return;
    {
        std::lock_guard lock(impl_->worker_mutex);
        impl_->worker_shutdown = true;
        impl_->pending_job.reset();
    }
    impl_->worker_cv.notify_all();
    if (impl_->worker_thread.joinable())
        impl_->worker_thread.join();
}

// ─── prepare / availability ──────────────────────────────────────────────

bool BungeeVoiceManager::prepare(int sample_rate,
                                  int channel_count,
                                  int max_input_frames) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames <= 0)
        return false;
#if !LT_ENGINE_HAVE_BUNGEE
    impl_->prepared = false;
    return false;
#else
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    // Start with an empty map — voices are built on the first rebuild_*.
    std::atomic_store(&impl_->active, impl_->empty);
    return true;
#endif
}

bool BungeeVoiceManager::is_available() const noexcept {
#if !LT_ENGINE_HAVE_BUNGEE
    return false;
#else
    return impl_ && impl_->prepared;
#endif
}

// ─── Helpers ─────────────────────────────────────────────────────────────

namespace {

// Iterate the session and collect (clip_id, source, source_frame) tuples for
// every transposed-and-currently-playing voice at `playhead`. We enumerate by
// clip rather than by (clip, semitones) — the same voice handles arbitrary
// live pitch changes via the per-block pitch_scale parameter.
struct VoiceSpec {
    Id                   clip_id;
    Id                   source_id;
    std::shared_ptr<const DecodedSource> source;
    Frame                source_frame = 0;  // where in the source we will start
    Semitones            effective_semitones = 0;
    // Time-stretch ratio to use during warm + prefeed so Bungee's internal
    // speed state matches what track_renderer will request at runtime. 1.0
    // means no warp.
    double               time_ratio = 1.0;
};

std::vector<VoiceSpec> enumerate_voices(const Session& session,
                                        const SourceManager& sources,
                                        Frame playhead) {
    std::vector<VoiceSpec> out;
    out.reserve(16);
    for (const auto& song : session.songs) {
        // Determine which regions in this song have warp active. A clip
        // counts as "in a warp region" if its timeline range overlaps any
        // of these regions. We don't gate by playhead position — once the
        // user enables warp on a region, every clip inside it must own a
        // Bungee voice so playback can transition into the region without
        // a build hiccup.
        std::vector<const Region*> warp_regions;
        warp_regions.reserve(song.regions.size());
        for (const auto& r : song.regions) {
            if (r.warp_enabled && r.warp_source_bpm > 0.0)
                warp_regions.push_back(&r);
        }

        for (const auto& track : song.tracks) {
            const bool never_transpose =
                track.transpose_behavior == TransposeBehavior::NeverTranspose;
            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                const bool playhead_in_clip = (playhead >= clip.timeline_start_frame
                                                && playhead < clip_end);
                // Any overlap with a warp region counts (region edges don't
                // need to align with clip edges).
                bool clip_in_warp_region = false;
                for (const Region* wr : warp_regions) {
                    if (clip.timeline_start_frame < wr->end_frame
                        && clip_end > wr->start_frame) {
                        clip_in_warp_region = true;
                        break;
                    }
                }
                // NeverTranspose tracks never get a pitch voice, but they DO
                // get a warp voice when their clip sits inside a warp region.
                // For non-NeverTranspose tracks we additionally include clips
                // covering the playhead (legacy pitch path).
                if (never_transpose) {
                    if (!clip_in_warp_region) continue;
                } else if (!playhead_in_clip && !clip_in_warp_region) {
                    continue;
                }

                auto src = sources.get_shared(clip.source_id);
                if (!src || !src->is_loaded()) continue;

                const auto decision = resolve_pitch_render_decision(
                    track, clip, song, playhead);
                // Build a Bungee voice when the clip needs pitch OR when it
                // overlaps a warp region. Pitch-only clips keep the legacy
                // behaviour (no voice when effective_semitones == 0 and
                // warp is off everywhere).
                if (decision.effective_semitones == 0 && !clip_in_warp_region)
                    continue;

                VoiceSpec spec;
                spec.clip_id      = clip.id;
                spec.source_id    = clip.source_id;
                spec.source       = std::move(src);
                // Prime from where playback will resume: if the playhead is
                // already past this clip's start, jump into the middle;
                // otherwise prime from the clip's own start so the first
                // audible block is warm. Scale by warp ratio so the prefeed
                // reads from the same source frame that runtime will read
                // (otherwise Bungee's prefed FIFO contains audio shifted by
                // ~ratio relative to where playback expects to start).
                const Frame timeline_offset =
                    std::max<Frame>(0, playhead - clip.timeline_start_frame);
                const double spec_ratio =
                    decision.warp_active ? decision.warp_time_ratio : 1.0;
                const Frame source_offset = decision.warp_active
                    ? static_cast<Frame>(
                        static_cast<double>(timeline_offset) * spec_ratio)
                    : timeline_offset;
                spec.source_frame = clip.source_start_frame + source_offset;
                spec.effective_semitones = decision.effective_semitones;
                spec.time_ratio = spec_ratio;
                out.push_back(spec);
            }
        }
    }
    return out;
}

#if LT_ENGINE_HAVE_BUNGEE
// Warm a freshly-constructed voice on the control thread by feeding ZERO
// input until Bungee reports its analysis pipeline is full (latency caught
// up). The discarded output is what the listener WOULD have heard during
// Bungee's startup transient if we let the audio thread see it.
//
// Per the maintainer (issue #38 comment 4364737326), the precise runtime
// latency is reported by Bungee::Stream::latency(), and it is only valid
// after at least one process() call has returned output. So we loop:
//   process(zeros) → check latency() → repeat until small enough.
//
// We do NOT pre-feed real source audio. That was the previous bug: any
// real input fed before the audio thread takes over advances Bungee's
// internal output position, which then no longer corresponds to the
// source_frame the audio thread expects on its first read.
//
// Worst-case bound for safety: at most kMaxWarmFramesAt48k input frames
// before we give up (in case Bungee never reports "warm" with the configured
// ratios). At 200 ms documented latency this is ~3x the expected need.
constexpr int kMaxWarmFramesAt48k = 8192;  // ~170 ms at 48 kHz

void warm_voice(BungeePitchVoice& voice,
                int sample_rate,
                int channel_count,
                int max_in_frames,
                double time_ratio = 1.0) {
    if (!voice.is_ready()) return;
    const int max_warm_frames = std::max(0,
        static_cast<int>(static_cast<long long>(kMaxWarmFramesAt48k) * sample_rate / 48000));
    if (max_warm_frames <= 0) return;

    // Pre-allocated planar zero buffers. Reused across iterations.
    std::vector<std::vector<float>> in_planes(static_cast<std::size_t>(channel_count),
        std::vector<float>(static_cast<std::size_t>(max_in_frames), 0.0f));
    std::vector<std::vector<float>> out_planes(static_cast<std::size_t>(channel_count),
        std::vector<float>(static_cast<std::size_t>(max_in_frames), 0.0f));
    std::vector<const float*> in_ptrs(static_cast<std::size_t>(channel_count), nullptr);
    std::vector<float*>       out_ptrs(static_cast<std::size_t>(channel_count), nullptr);
    for (int c = 0; c < channel_count; ++c) {
        in_ptrs[static_cast<std::size_t>(c)]  = in_planes[static_cast<std::size_t>(c)].data();
        out_ptrs[static_cast<std::size_t>(c)] = out_planes[static_cast<std::size_t>(c)].data();
    }

    int fed = 0;
    while (fed < max_warm_frames) {
        const int chunk = std::min(max_in_frames, max_warm_frames - fed);
        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  /*pitch_scale*/ 1.0,
                                  /*time_ratio*/ time_ratio);
        fed += chunk;
        if (voice.is_warm())
            break;
    }

    // One-shot diagnostic so we can see what Bungee's stable latency turned
    // out to be on this hardware/voice configuration. The audio thread uses
    // this number directly (track_renderer reads source from
    // source_frame + latency_frames so output aligns to the timeline).
    const double final_latency = voice.latency_frames();
    const long long final_input = voice.input_position();
    const bool warm = voice.is_warm();
    (void)fed;
    (void)max_warm_frames;
    (void)final_input;
    (void)final_latency;
    (void)warm;
}

double semitones_to_pitch_scale(Semitones semitones) {
    return std::pow(2.0, static_cast<double>(semitones) / 12.0);
}

int seek_source_wait_ms() {
    static const int value = [] {
        const char* v = std::getenv("LIBRETRACKS_SEEK_SOURCE_WAIT_MS");
        if (!v) return 750;
        const int parsed = std::atoi(v);
        return parsed >= 0 && parsed <= 10000 ? parsed : 750;
    }();
    return value;
}

bool ensure_seek_read_window_ready(const SourceManager& sources,
                                   const VoiceSpec& spec,
                                   int max_in_frames,
                                   int latency_frames,
                                   int compensation_frames) {
    if (!spec.source)
        return false;

    const Frame src_end = spec.source->duration_frames();
    if (src_end <= 0 || spec.source_frame >= src_end)
        return false;

    const Frame compensation_start =
        spec.source_frame + std::min<Frame>(0, compensation_frames);
    const Frame read_start =
        spec.source_frame
        + static_cast<Frame>(latency_frames)
        + static_cast<Frame>(compensation_frames);
    const int read_ahead = std::max(
        std::max(1, max_in_frames) * 2,
        std::max(1, spec.source->sample_rate() / 2));
    const Frame required_start = std::min(compensation_start, read_start);
    const Frame required_end = read_start + static_cast<Frame>(read_ahead);

    const Frame clamped_start = std::max<Frame>(0, required_start);
    const Frame clamped_end = std::min<Frame>(
        src_end, std::max<Frame>(clamped_start, required_end));
    if (clamped_end <= clamped_start)
        return true;

    const int required_frames = static_cast<int>(std::min<Frame>(
        clamped_end - clamped_start,
        static_cast<Frame>(std::numeric_limits<int>::max())));
    if (spec.source->is_range_ready(clamped_start, required_frames))
        return true;

    request_source_range(sources, spec.source_id, clamped_start, required_frames);
    const int wait_ms = seek_source_wait_ms();
    if (lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG")) {
        lt_debug_log(
            "[LT_JUMP_DEBUG][bungee] wait_seek_source clip=%s source=%s source_frame=%lld ready_start=%lld ready_frames=%d latency=%d compensation=%d max_in=%d wait_ms=%d\n",
            spec.clip_id.c_str(),
            spec.source_id.c_str(),
            static_cast<long long>(spec.source_frame),
            static_cast<long long>(clamped_start),
            required_frames,
            latency_frames,
            compensation_frames,
            max_in_frames,
            wait_ms);
    }
    if (wait_ms <= 0)
        return false;

    const auto start = std::chrono::steady_clock::now();
    const auto deadline = start + std::chrono::milliseconds(wait_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (spec.source->is_range_ready(clamped_start, required_frames))
            return true;
        request_source_range(sources, spec.source_id, clamped_start, required_frames);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return spec.source->is_range_ready(clamped_start, required_frames);
}

void prefeed_voice_with_source_audio(BungeePitchVoice& voice,
                                     const DecodedSource& source,
                                     Frame source_frame,
                                     int sample_rate,
                                     int channel_count,
                                     int max_in_frames,
                                     double pitch_scale,
                                     double time_ratio = 1.0) {
    if (!voice.is_ready()) return;
    const int latency_frames = static_cast<int>(voice.latency_frames());
    if (latency_frames <= 0) return;
    const int compensation_frames = voice.alignment_compensation_frames(pitch_scale);

    std::vector<float> read_l(static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> read_r(static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> out_l (static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> out_r (static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<const float*> in_ptrs (static_cast<std::size_t>(channel_count));
    std::vector<float*>       out_ptrs(static_cast<std::size_t>(channel_count));
    in_ptrs [0] = read_l.data();
    out_ptrs[0] = out_l.data();
    if (channel_count >= 2) {
        in_ptrs [1] = read_r.data();
        out_ptrs[1] = out_r.data();
    }

    const Frame src_end = source.duration_frames();
    Frame read_cursor = source_frame + static_cast<Frame>(compensation_frames);
    int fed = 0;
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);

        std::fill(read_l.begin(), read_l.begin() + chunk, 0.0f);
        std::fill(read_r.begin(), read_r.begin() + chunk, 0.0f);
        const int dst_offset = read_cursor < 0
            ? static_cast<int>(std::min<Frame>(chunk, -read_cursor))
            : 0;
        const Frame read_start = std::max<Frame>(0, read_cursor);
        const int available = (dst_offset >= chunk || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                chunk - dst_offset, static_cast<long long>(src_end - read_start)));
        if (available > 0) {
            float* read_into[2] = {
                read_l.data() + dst_offset,
                read_r.data() + dst_offset};
            const int got = source.read(read_start, available, read_into,
                                         std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1)
                std::copy_n(read_l.begin() + dst_offset, got,
                            read_r.begin() + dst_offset);
        }

        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  pitch_scale,
                                  time_ratio);
        read_cursor += chunk;
        fed += chunk;
    }

    const int prime_target_frames = std::max(
        max_in_frames,
        std::min(max_in_frames * 4, std::max(max_in_frames, sample_rate / 20)));
    int primed_total = voice.queued_output_frames();
    int prime_budget = prime_target_frames * 2;
    while (max_in_frames > 0
           && primed_total < prime_target_frames
           && prime_budget > 0) {
        const int prime_frames = std::min(max_in_frames, prime_budget);
        std::fill(read_l.begin(), read_l.begin() + prime_frames, 0.0f);
        std::fill(read_r.begin(), read_r.begin() + prime_frames, 0.0f);
        const int dst_offset = read_cursor < 0
            ? static_cast<int>(std::min<Frame>(prime_frames, -read_cursor))
            : 0;
        const Frame read_start = std::max<Frame>(0, read_cursor);
        const int available = (dst_offset >= prime_frames || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                prime_frames - dst_offset, static_cast<long long>(src_end - read_start)));
        if (available > 0) {
            float* read_into[2] = {
                read_l.data() + dst_offset,
                read_r.data() + dst_offset};
            const int got = source.read(read_start, available, read_into,
                                         std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1)
                std::copy_n(read_l.begin() + dst_offset, got,
                            read_r.begin() + dst_offset);
        }
        const int before = voice.queued_output_frames();
        (void)voice.prime_output_fifo(in_ptrs.data(), prime_frames, pitch_scale,
                                      time_ratio);
        primed_total = voice.queued_output_frames();
        read_cursor += prime_frames;
        prime_budget -= prime_frames;
        if (primed_total <= before)
            break;
    }
}
#endif // LT_ENGINE_HAVE_BUNGEE

} // namespace

// ─── Control-thread rebuilds ─────────────────────────────────────────────

void BungeeVoiceManager::rebuild_for_session(const Session& session,
                                              const SourceManager& sources,
                                              Frame playhead) {
    if (!is_available()) return;

#if LT_ENGINE_HAVE_BUNGEE
    impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::lock_guard build_lock(impl_->build_mutex);
    impl_->rebuilds_for_session.fetch_add(1, std::memory_order_relaxed);

    const auto specs = enumerate_voices(session, sources, playhead);

    auto current = std::atomic_load(&impl_->active);
    auto next    = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int reused = 0;
    int built  = 0;
    for (const auto& spec : specs) {
        // Reuse the existing voice whenever the clip is unchanged. Pitch
        // changes are handled via the per-block pitch_scale parameter and
        // do NOT require rebuilding — that was the bug causing 200 ms of
        // silence on every transpose adjustment.
        auto it = current->find(spec.clip_id);
        if (it != current->end()) {
            (*next)[spec.clip_id] = it->second;
            ++reused;
            continue;
        }

        auto voice = std::make_shared<BungeePitchVoice>();
        if (!voice->configure(impl_->sample_rate,
                              impl_->channel_count,
                              impl_->max_in_frames)) {
            continue;
        }
        warm_voice(*voice,
                   impl_->sample_rate, impl_->channel_count, impl_->max_in_frames,
                   spec.time_ratio);
        // No prefeed here (rebuild_for_session is the cheap path) — but the
        // renderer's first read uses `cursor + latency + queued`, so anchor
        // the cursor at the spec's source position.
        voice->reset_source_cursor(
            static_cast<long long>(spec.source_frame));
        // warm_voice consumed the voice's initial fade window with zero
        // input. Re-arm it so the audio thread's first real frames are
        // ramped, masking Bungee's startup pop when a new clip voice appears.
        voice->arm_fade_in();
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    const int active_count = static_cast<int>(next->size());
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] rebuild_for_session playhead=%lld active=%d built=%d reused=%d\n",
            static_cast<long long>(playhead), active_count, built, reused);
    }
#else
    (void)session; (void)sources; (void)playhead;
#endif
}

void BungeeVoiceManager::rebuild_for_seek(Frame target_frame,
                                           const Session& session,
                                           const SourceManager& sources) {
    auto next = build_seek_voice_map(target_frame, session, sources);
    publish_prepared_voice_map_realtime(std::move(next));
}

void BungeeVoiceManager::retime_existing_for_session(
        const Session& session,
        const SourceManager& sources,
        Frame playhead) noexcept {
    if (!is_available()) return;

#if LT_ENGINE_HAVE_BUNGEE
    const auto specs = enumerate_voices(session, sources, playhead);
    auto current = std::atomic_load(&impl_->active);
    int retimed = 0;
    int missing = 0;
    for (const auto& spec : specs) {
        auto it = current->find(spec.clip_id);
        if (it == current->end() || !it->second) {
            ++missing;
            continue;
        }
        it->second->reset_source_cursor(
            static_cast<long long>(spec.source_frame));
        ++retimed;
    }
    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] retime_existing playhead=%lld specs=%zu retimed=%d missing=%d active=%zu\n",
            static_cast<long long>(playhead), specs.size(),
            retimed, missing, current ? current->size() : 0);
    }
#else
    (void)session; (void)sources; (void)playhead;
#endif
}

std::shared_ptr<const PreparedVoiceMap>
BungeeVoiceManager::build_seek_voice_map(Frame target_frame,
                                          const Session& session,
                                          const SourceManager& sources) {
    if (!is_available()) return {};

#if LT_ENGINE_HAVE_BUNGEE
    if (impl_)
        impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::lock_guard build_lock(impl_->build_mutex);

    // Per Bungee issue #16: the recommended reset model is destroy + rebuild.
    // Build fresh voices for every audible clip at the seek target, but do not
    // publish them here. The caller owns the atomicity of clock seek + publish.
    const auto specs = enumerate_voices(session, sources, target_frame);

    auto next = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    // Build voices in parallel. Each voice is an isolated BungeePitchVoice
    // instance — Bungee itself is not thread-safe per-instance but instances
    // are independent. warm_voice (~80ms each at hop=-1) dominates the cost
    // for SetSongTranspose / SeekAbsolute; serializing 8 voices took ~1s on
    // M1-class CPUs. Parallelizing collapses that to ~150-200ms (warm of the
    // slowest voice + overheads). Reads from SourceManager are thread-safe
    // (it serves a streaming background worker and concurrent renderers
    // already).
    const int sample_rate = impl_->sample_rate;
    const int channel_count = impl_->channel_count;
    const int max_in_frames = impl_->max_in_frames;

    struct BuildResult {
        std::shared_ptr<BungeePitchVoice> voice;  // null on failure
        Id clip_id;
        bool succeeded = false;
    };

    std::vector<BuildResult> results(specs.size());
    std::vector<std::thread> workers;
    workers.reserve(specs.size());
    for (std::size_t i = 0; i < specs.size(); ++i) {
        workers.emplace_back([&, i] {
            // Lower priority so 8 parallel Bungee FFT warms (~250ms each)
            // do NOT steal CPU from the audio thread. Without this the user
            // hears 50-200ms of silence at the moment of pitch change because
            // these 8 threads saturate the P-cores and the audio callback
            // misses its deadline.
#ifdef _WIN32
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#elif defined(__APPLE__)
            pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#elif defined(__linux__)
            setpriority(PRIO_PROCESS, 0, 10);
#endif

            const auto& spec = specs[i];
            auto& result = results[i];
            result.clip_id = spec.clip_id;

            auto voice = std::make_shared<BungeePitchVoice>();
            if (!voice->configure(sample_rate, channel_count, max_in_frames))
                return;

            warm_voice(*voice, sample_rate, channel_count, max_in_frames,
                       spec.time_ratio);
            const double pitch_scale = semitones_to_pitch_scale(spec.effective_semitones);
            const int latency_frames = static_cast<int>(voice->latency_frames());
            const int compensation_frames =
                voice->alignment_compensation_frames(pitch_scale);
            if (!ensure_seek_read_window_ready(
                    sources, spec, max_in_frames,
                    latency_frames, compensation_frames)) {
                return;
            }
            if (spec.source) {
                prefeed_voice_with_source_audio(
                    *voice, *spec.source, spec.source_frame,
                    sample_rate, channel_count, max_in_frames,
                    pitch_scale, spec.time_ratio);
            }
            // Anchor the voice's source cursor at the timeline position the
            // renderer will start reading from. The renderer's read formula
            // (cursor + latency + compensation + queued) assumes this anchor.
            voice->reset_source_cursor(
                static_cast<long long>(spec.source_frame));
            voice->arm_fade_in(0);
            result.voice = std::move(voice);
            result.succeeded = true;
        });
    }
    for (auto& worker : workers)
        worker.join();

    // Phase 2: install successful voices into the map serially. Cheap (just
    // moves + atomic counter increments).
    int built = 0;
    for (auto& result : results) {
        if (!result.succeeded) continue;
        (*next)[result.clip_id] = std::move(result.voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] build_seek_voice_map target=%lld voices=%d built=%d\n",
            static_cast<long long>(target_frame),
            static_cast<int>(next->size()),
            built);
    }
    return std::shared_ptr<const VoiceMap>(std::move(next));
#else
    (void)target_frame; (void)session; (void)sources;
    return {};
#endif
}

void BungeeVoiceManager::rebuild_for_seek_guarded(Frame target_frame,
                                                   const Session& session,
                                                   const SourceManager& sources,
                                                   std::uint64_t expected_generation) {
    if (!is_available()) return;

#if LT_ENGINE_HAVE_BUNGEE
    std::lock_guard build_lock(impl_->build_mutex);
    impl_->rebuilds_for_seek.fetch_add(1, std::memory_order_relaxed);

    // Per Bungee issue #16: the recommended reset model is destroy + rebuild.
    // We unconditionally build fresh voices for every audible clip at the
    // seek target, primed to that exact source frame.
    const auto specs = enumerate_voices(session, sources, target_frame);

    auto next = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int built = 0;
    for (const auto& spec : specs) {
        auto voice = std::make_shared<BungeePitchVoice>();
        if (!voice->configure(impl_->sample_rate,
                              impl_->channel_count,
                              impl_->max_in_frames)) {
            continue;
        }
        warm_voice(*voice,
                   impl_->sample_rate, impl_->channel_count, impl_->max_in_frames,
                   spec.time_ratio);
        // warm_voice consumed the voice's initial fade window with zero
        // input. Prefeed target audio and discard Bungee's silence->audio
        // transition so the audio thread starts on an already-stable grain.
        const double pitch_scale = semitones_to_pitch_scale(spec.effective_semitones);
        const int latency_frames = static_cast<int>(voice->latency_frames());
        const int compensation_frames =
            voice->alignment_compensation_frames(pitch_scale);
        if (!ensure_seek_read_window_ready(
                sources, spec, impl_->max_in_frames,
                latency_frames, compensation_frames)) {
            continue;
        }
        if (spec.source) {
            prefeed_voice_with_source_audio(
                *voice, *spec.source, spec.source_frame,
                impl_->sample_rate, impl_->channel_count, impl_->max_in_frames,
                pitch_scale, spec.time_ratio);
        }
        voice->reset_source_cursor(
            static_cast<long long>(spec.source_frame));
        // This voice has already been prefed to the seek target; the mixer's
        // seek de-click ramp handles the boundary. Avoid an extra per-voice
        // gain ramp here because it can roughen transposed post-seek audio.
        voice->arm_fade_in(0);
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    const int active_count = static_cast<int>(next->size());
    if (expected_generation != 0
        && impl_->publish_generation.load(std::memory_order_acquire) != expected_generation) {
        if (bungee_debug_enabled()) {
            lt_debug_log(
                "[BUNGEE] discard_stale_rebuild_for_seek target=%lld expected_generation=%llu current_generation=%llu\n",
                static_cast<long long>(target_frame),
                static_cast<unsigned long long>(expected_generation),
                static_cast<unsigned long long>(
                    impl_->publish_generation.load(std::memory_order_acquire)));
        }
        return;
    }
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] rebuild_for_seek target=%lld active=%d built=%d\n",
            static_cast<long long>(target_frame), active_count, built);
    }
#else
    (void)target_frame; (void)session; (void)sources;
#endif
}

void BungeeVoiceManager::rebuild_for_seek_async(Frame target_frame,
                                                 const Session& session,
                                                 const SourceManager& sources) {
    if (!is_available()) return;
#if !LT_ENGINE_HAVE_BUNGEE
    (void)target_frame; (void)session; (void)sources;
#else
    // Spawn the worker on first use. Single thread, runs at lowered priority
    // so it never starves the audio callback during the ~600ms warm. Same
    // reasoning as PrearmedJumpManager's worker — without this, transposes
    // mid-playback caused 50-200ms audio dropouts on macOS for several
    // seconds while the worker rebuilt voices in the background.
    {
        std::lock_guard lock(impl_->worker_mutex);
        if (!impl_->worker_thread.joinable() && !impl_->worker_shutdown) {
            impl_->worker_thread = std::thread([this] {
              #ifdef _WIN32
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
              #elif defined(__APPLE__)
                pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0);
              #elif defined(__linux__)
                setpriority(PRIO_PROCESS, 0, 10);
              #endif
                for (;;) {
                    Impl::AsyncJob job;
                    {
                        std::unique_lock lk(impl_->worker_mutex);
                        impl_->worker_cv.wait(lk, [this] {
                            return impl_->worker_shutdown || impl_->pending_job.has_value();
                        });
                        if (impl_->worker_shutdown) return;
                        job = std::move(*impl_->pending_job);
                        impl_->pending_job.reset();
                    }
                    if (!job.session || !job.sources) continue;
                    rebuild_for_seek_guarded(
                        job.target_frame, *job.session, *job.sources,
                        job.expected_generation);
                }
            });
        }

        // Latest-wins: overwrite any pending job rather than queueing.
        impl_->pending_job = Impl::AsyncJob{
            target_frame,
            std::make_shared<const Session>(session),
            &sources,
            impl_->publish_generation.load(std::memory_order_acquire),
        };
    }
    impl_->worker_cv.notify_one();
    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] rebuild_for_seek_async target=%lld scheduled\n",
            static_cast<long long>(target_frame));
    }
#endif
}

void BungeeVoiceManager::clear() {
    if (!impl_) return;
    impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::lock_guard build_lock(impl_->build_mutex);
    std::atomic_store(&impl_->active, impl_->empty);
}

void BungeeVoiceManager::swap_in_prepared_voices(PreparedVoiceMap prepared_voices) {
    if (!impl_) return;
#if !LT_ENGINE_HAVE_BUNGEE
    (void)prepared_voices;
    return;
#else
    if (!impl_->prepared) return;
    std::lock_guard build_lock(impl_->build_mutex);
    auto next = build_prepared_voice_map(std::move(prepared_voices));
    if (!next) return;

    const int active_count = static_cast<int>(next->size());
    impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::atomic_store(&impl_->active, std::move(next));
    impl_->rebuilds_for_seek.fetch_add(1, std::memory_order_relaxed);
    if (bungee_debug_enabled()) {
        lt_debug_log(
            "[BUNGEE] swap_in_prepared_voices active=%d (prearmed)\n",
            active_count);
    }
#endif
}

std::shared_ptr<const PreparedVoiceMap>
BungeeVoiceManager::build_prepared_voice_map(PreparedVoiceMap prepared_voices) const {
    if (!impl_) return {};
#if !LT_ENGINE_HAVE_BUNGEE
    (void)prepared_voices;
    return {};
#else
    if (!impl_->prepared) return {};
    auto next = std::make_shared<VoiceMap>();
    next->reserve(prepared_voices.size());
    for (auto& kv : prepared_voices) {
        if (kv.second) next->emplace(kv.first, std::move(kv.second));
    }
    return next;
#endif
}

void BungeeVoiceManager::publish_prepared_voice_map_realtime(
    std::shared_ptr<const PreparedVoiceMap> prepared_voices) noexcept {
    if (!impl_ || !prepared_voices) return;
#if !LT_ENGINE_HAVE_BUNGEE
    (void)prepared_voices;
    return;
#else
    if (!impl_->prepared) return;
    impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::atomic_store(&impl_->active, std::move(prepared_voices));
    impl_->rebuilds_for_seek.fetch_add(1, std::memory_order_relaxed);
#endif
}

// ─── Audio-thread lookup ─────────────────────────────────────────────────

void BungeeVoiceManager::publish_empty_voice_map_realtime() noexcept {
    if (!impl_) return;
#if LT_ENGINE_HAVE_BUNGEE
    if (!impl_->prepared) return;
    impl_->publish_generation.fetch_add(1, std::memory_order_acq_rel);
    std::atomic_store(&impl_->active, impl_->empty);
#endif
}

std::shared_ptr<BungeePitchVoice> BungeeVoiceManager::voice_for_shared(const Id& clip_id) noexcept {
    if (!impl_) return nullptr;
    auto snapshot = std::atomic_load(&impl_->active);
    if (!snapshot) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return {};
    }
    auto it = snapshot->find(clip_id);
    if (it == snapshot->end()) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return {};
    }
    impl_->voice_lookups_hit.fetch_add(1, std::memory_order_relaxed);
    return it->second;
}

BungeePitchVoice* BungeeVoiceManager::voice_for(const Id& clip_id) noexcept {
    return voice_for_shared(clip_id).get();
}

BungeeVoiceManagerDiagnostics BungeeVoiceManager::diagnostics() const noexcept {
    BungeeVoiceManagerDiagnostics d;
    if (!impl_) return d;
    auto snapshot = std::atomic_load(&impl_->active);
    d.active_voice_count   = snapshot ? static_cast<int>(snapshot->size()) : 0;
    d.voices_built_total   = impl_->voices_built_total.load(std::memory_order_relaxed);
    d.rebuilds_for_session = impl_->rebuilds_for_session.load(std::memory_order_relaxed);
    d.rebuilds_for_seek    = impl_->rebuilds_for_seek.load(std::memory_order_relaxed);
    d.voice_lookups_hit    = impl_->voice_lookups_hit.load(std::memory_order_relaxed);
    d.voice_lookups_miss   = impl_->voice_lookups_miss.load(std::memory_order_relaxed);
    return d;
}

} // namespace lt
