#include <lt_engine/pitch/bungee_voice_manager.h>

#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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
#endif

namespace lt {

namespace {

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
using VoiceMap = std::unordered_map<Id,
                                    std::shared_ptr<BungeePitchVoice>>;

// ─── Impl ────────────────────────────────────────────────────────────────

struct BungeeVoiceManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;

    // Published voice map. Audio thread reads via std::atomic_load; control
    // thread builds a new map and swaps via std::atomic_store.
    std::shared_ptr<const VoiceMap> active{std::make_shared<const VoiceMap>()};

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
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::make_shared<const VoiceMap>()));
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
    std::shared_ptr<const DecodedSource> source;
    Frame                source_frame = 0;  // where in the source we will start
    Semitones            effective_semitones = 0;
};

std::vector<VoiceSpec> enumerate_voices(const Session& session,
                                        const SourceManager& sources,
                                        Frame playhead) {
    std::vector<VoiceSpec> out;
    out.reserve(16);
    for (const auto& song : session.songs) {
        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                // Skip clips that don't include the playhead — Phase 2 builds
                // only voices for clips audible right now. Future phases can
                // pre-build a forward window, mirroring extend_for_playhead.
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                const bool playhead_in_clip = (playhead >= clip.timeline_start_frame
                                                && playhead < clip_end);
                if (!playhead_in_clip) continue;

                auto src = sources.get_shared(clip.source_id);
                if (!src || !src->is_loaded()) continue;

                if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
                    continue;

                const auto decision = resolve_pitch_render_decision(
                    track, clip, song, playhead);
                if (decision.effective_semitones == 0)
                    continue;

                VoiceSpec spec;
                spec.clip_id      = clip.id;
                spec.source       = std::move(src);
                // Source frame the audio thread will request first after the
                // playhead lands here. We will prime up to this position.
                spec.source_frame = clip.source_start_frame
                                    + (playhead - clip.timeline_start_frame);
                spec.effective_semitones = decision.effective_semitones;
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
                int max_in_frames) {
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
                                  /*pitch_scale*/ 1.0);
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

void prefeed_voice_with_source_audio(BungeePitchVoice& voice,
                                     const DecodedSource& source,
                                     Frame source_frame,
                                     int channel_count,
                                     int max_in_frames,
                                     double pitch_scale) {
    if (!voice.is_ready()) return;
    const int latency_frames = static_cast<int>(voice.latency_frames());
    if (latency_frames <= 0) return;

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
    Frame read_cursor = source_frame;
    int fed = 0;
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);

        std::fill(read_l.begin(), read_l.begin() + chunk, 0.0f);
        std::fill(read_r.begin(), read_r.begin() + chunk, 0.0f);
        const int available = (read_cursor >= src_end || read_cursor < 0)
            ? 0
            : static_cast<int>(std::min<long long>(
                chunk, static_cast<long long>(src_end - read_cursor)));
        if (available > 0) {
            float* read_into[2] = {read_l.data(), read_r.data()};
            const int got = source.read(read_cursor, available, read_into,
                                         std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1)
                std::copy_n(read_l.begin(), got, read_r.begin());
        }

        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  pitch_scale);
        read_cursor += chunk;
        fed += chunk;
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
                   impl_->sample_rate, impl_->channel_count, impl_->max_in_frames);
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
        std::fprintf(stdout,
            "[BUNGEE] rebuild_for_session playhead=%lld active=%d built=%d reused=%d\n",
            static_cast<long long>(playhead), active_count, built, reused);
        std::fflush(stdout);
    }
#else
    (void)session; (void)sources; (void)playhead;
#endif
}

void BungeeVoiceManager::rebuild_for_seek(Frame target_frame,
                                           const Session& session,
                                           const SourceManager& sources) {
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
                   impl_->sample_rate, impl_->channel_count, impl_->max_in_frames);
        // warm_voice consumed the voice's initial fade window with zero
        // input. Prefeed target audio and discard Bungee's silence->audio
        // transition so the audio thread starts on an already-stable grain.
        if (spec.source) {
            prefeed_voice_with_source_audio(
                *voice, *spec.source, spec.source_frame,
                impl_->channel_count, impl_->max_in_frames,
                semitones_to_pitch_scale(spec.effective_semitones));
        }
        // Keep a tiny ramp as a last guard against arbitrary waveform
        // discontinuity at the seek boundary without making the seek feel late.
        voice->arm_fade_in(2);
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    const int active_count = static_cast<int>(next->size());
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    if (bungee_debug_enabled()) {
        std::fprintf(stdout,
            "[BUNGEE] rebuild_for_seek target=%lld active=%d built=%d\n",
            static_cast<long long>(target_frame), active_count, built);
        std::fflush(stdout);
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
    // Spawn the worker on first use. Single thread, runs at BELOW_NORMAL on
    // Windows so it never starves the audio callback during the ~600ms warm.
    {
        std::lock_guard lock(impl_->worker_mutex);
        if (!impl_->worker_thread.joinable() && !impl_->worker_shutdown) {
            impl_->worker_thread = std::thread([this] {
              #ifdef _WIN32
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
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
                    // Reuse the sync path; it serializes via build_mutex so a
                    // concurrent sync rebuild from another thread is safe.
                    rebuild_for_seek(job.target_frame, *job.session, *job.sources);
                }
            });
        }

        // Latest-wins: overwrite any pending job rather than queueing.
        impl_->pending_job = Impl::AsyncJob{
            target_frame,
            std::make_shared<const Session>(session),
            &sources,
        };
    }
    impl_->worker_cv.notify_one();
    if (bungee_debug_enabled()) {
        std::fprintf(stdout,
            "[BUNGEE] rebuild_for_seek_async target=%lld scheduled\n",
            static_cast<long long>(target_frame));
        std::fflush(stdout);
    }
#endif
}

void BungeeVoiceManager::clear() {
    if (!impl_) return;
    std::lock_guard build_lock(impl_->build_mutex);
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::make_shared<const VoiceMap>()));
}

void BungeeVoiceManager::swap_in_prepared_voices(
    std::unordered_map<Id, std::shared_ptr<BungeePitchVoice>> prepared_voices) {
    if (!impl_) return;
#if !LT_ENGINE_HAVE_BUNGEE
    (void)prepared_voices;
    return;
#else
    if (!impl_->prepared) return;
    std::lock_guard build_lock(impl_->build_mutex);

    auto next = std::make_shared<VoiceMap>();
    next->reserve(prepared_voices.size());
    for (auto& kv : prepared_voices) {
        if (kv.second) next->emplace(kv.first, std::move(kv.second));
    }

    const int active_count = static_cast<int>(next->size());
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    impl_->rebuilds_for_seek.fetch_add(1, std::memory_order_relaxed);
    if (bungee_debug_enabled()) {
        std::fprintf(stdout,
            "[BUNGEE] swap_in_prepared_voices active=%d (prearmed)\n",
            active_count);
        std::fflush(stdout);
    }
#endif
}

// ─── Audio-thread lookup ─────────────────────────────────────────────────

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
