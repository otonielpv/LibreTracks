#include <lt_engine/pitch/warp_voice_manager.h>

#include <lt_engine/debug/logging.h>
#include <lt_engine/pitch/rubberband_warp_voice.h>
#include <lt_engine/pitch/signalsmith_warp_voice.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace lt {

namespace {

bool warp_debug_enabled() {
    static const bool on = lt_env_flag_enabled("LIBRETRACKS_AUDIO_DEBUG");
    return on;
}

void warp_debug_log(const char* fmt, ...) {
    if (!warp_debug_enabled()) return;
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

// Read LT_WARP_BACKEND once, resolved to whatever is actually compiled in.
// Default: Signalsmith when available, otherwise RubberBand, otherwise the
// manager just won't be available at all.
WarpBackend resolve_backend_from_env() {
    const char* raw = std::getenv("LT_WARP_BACKEND");
    std::string value = raw ? raw : "";
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
#if LT_ENGINE_HAVE_RUBBERBAND
    if (value == "rubberband" || value == "rubberband_r3" || value == "r3")
        return WarpBackend::RubberBandR3;
#endif
#if LT_ENGINE_HAVE_SIGNALSMITH
    if (value == "signalsmith" || value == "smith" || value.empty())
        return WarpBackend::Signalsmith;
#endif
#if LT_ENGINE_HAVE_RUBBERBAND
    // Signalsmith not compiled in: fall through to RubberBand if present.
    return WarpBackend::RubberBandR3;
#else
    return WarpBackend::Signalsmith;
#endif
}

const char* backend_name(WarpBackend b) {
    switch (b) {
        case WarpBackend::Signalsmith:  return "signalsmith";
        case WarpBackend::RubberBandR3: return "rubberband_r3";
    }
    return "unknown";
}

std::shared_ptr<WarpVoice> make_voice(WarpBackend backend,
                                       int sample_rate,
                                       int channel_count,
                                       int max_in_frames) {
    switch (backend) {
        case WarpBackend::Signalsmith: {
#if LT_ENGINE_HAVE_SIGNALSMITH
            auto v = std::make_shared<SignalsmithWarpVoice>();
            if (!v->configure(sample_rate, channel_count, max_in_frames))
                return nullptr;
            return v;
#else
            return nullptr;
#endif
        }
        case WarpBackend::RubberBandR3: {
#if LT_ENGINE_HAVE_RUBBERBAND
            auto v = std::make_shared<RubberBandWarpVoice>();
            if (!v->configure(sample_rate, channel_count, max_in_frames))
                return nullptr;
            return v;
#else
            return nullptr;
#endif
        }
    }
    return nullptr;
}

bool backend_available(WarpBackend backend) {
    switch (backend) {
        case WarpBackend::Signalsmith:
#if LT_ENGINE_HAVE_SIGNALSMITH
            return true;
#else
            return false;
#endif
        case WarpBackend::RubberBandR3:
#if LT_ENGINE_HAVE_RUBBERBAND
            return true;
#else
            return false;
#endif
    }
    return false;
}

} // namespace

struct WarpVoiceManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;
    WarpBackend backend = WarpBackend::Signalsmith;

    std::shared_ptr<const VoiceMap> empty{std::make_shared<const VoiceMap>()};
    std::shared_ptr<const VoiceMap> active{empty};

    std::mutex build_mutex;

    std::atomic<std::uint64_t> voices_built_total{0};
    std::atomic<std::uint64_t> rebuilds_total{0};
    std::atomic<std::uint64_t> voice_lookups_hit{0};
    std::atomic<std::uint64_t> voice_lookups_miss{0};
};

WarpVoiceManager::WarpVoiceManager() : impl_(std::make_unique<Impl>()) {}
WarpVoiceManager::~WarpVoiceManager() = default;

bool WarpVoiceManager::prepare(int sample_rate,
                                int channel_count,
                                int max_input_frames) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames <= 0)
        return false;

    impl_->backend = resolve_backend_from_env();
    if (!backend_available(impl_->backend)) {
        impl_->prepared = false;
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] prepare_failed backend=%s not compiled in\n",
            backend_name(impl_->backend));
        return false;
    }

    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    std::atomic_store(&impl_->active, impl_->empty);
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] prepare backend=%s sr=%d ch=%d max_in=%d\n",
        backend_name(impl_->backend),
        sample_rate, channel_count, max_input_frames);
    return true;
}

bool WarpVoiceManager::is_available() const noexcept {
    return impl_ && impl_->prepared;
}

WarpBackend WarpVoiceManager::active_backend() const noexcept {
    return impl_ ? impl_->backend : WarpBackend::Signalsmith;
}

const char* WarpVoiceManager::active_backend_name() const noexcept {
    return backend_name(active_backend());
}

namespace {

// Only collects clips whose containing region has warp active. Tracks marked
// NeverTranspose still receive warp — warp is a song-level concept.
struct WarpVoiceSpec {
    Id        clip_id;
    long long initial_source_cursor = 0;
    double    warp_ratio = 1.0;
};

std::vector<WarpVoiceSpec> enumerate_warp_clips(const Session& session,
                                                  Frame playhead) {
    std::vector<WarpVoiceSpec> out;
    out.reserve(16);
    for (const auto& song : session.songs) {
        struct ActiveRegion { const Region* r; double ratio; };
        std::vector<ActiveRegion> warp_regions;
        warp_regions.reserve(song.regions.size());
        for (const auto& r : song.regions) {
            if (!r.warp_enabled || r.warp_source_bpm <= 0.0) continue;
            const double ratio = resolve_warp_time_ratio(song, r.start_frame);
            warp_regions.push_back({&r, ratio});
        }
        if (warp_regions.empty()) continue;

        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                const Frame clip_end =
                    clip.timeline_start_frame + clip.length_frames;
                const ActiveRegion* hit = nullptr;
                for (const auto& wr : warp_regions) {
                    if (clip.timeline_start_frame < wr.r->end_frame
                        && clip_end > wr.r->start_frame) {
                        hit = &wr;
                        break;
                    }
                }
                if (!hit) continue;
                WarpVoiceSpec spec;
                spec.clip_id = clip.id;
                spec.warp_ratio = hit->ratio;
                if (playhead >= clip.timeline_start_frame
                    && playhead < clip_end) {
                    const Frame timeline_offset =
                        playhead - clip.timeline_start_frame;
                    spec.initial_source_cursor = clip.source_start_frame
                        + static_cast<long long>(
                            static_cast<double>(timeline_offset) * hit->ratio);
                } else {
                    spec.initial_source_cursor = clip.source_start_frame;
                }
                out.push_back(spec);
            }
        }
    }
    return out;
}

} // namespace

void WarpVoiceManager::rebuild_for_session(const Session& session,
                                            const SourceManager& /*sources*/,
                                            Frame playhead) {
    if (!is_available()) return;
    std::lock_guard build_lock(impl_->build_mutex);
    impl_->rebuilds_total.fetch_add(1, std::memory_order_relaxed);

    const auto specs = enumerate_warp_clips(session, playhead);

    auto current = std::atomic_load(&impl_->active);
    auto next    = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int built = 0;
    int reused = 0;
    for (const auto& spec : specs) {
        auto it = current->find(spec.clip_id);
        if (it != current->end()) {
            (*next)[spec.clip_id] = it->second;
            warp_debug_log(
                "[LT_JUMP_DEBUG][warp-mgr] reuse_voice clip=%s cursor=%lld ratio=%.6f\n",
                spec.clip_id.c_str(),
                it->second ? it->second->source_cursor() : 0LL,
                spec.warp_ratio);
            ++reused;
            continue;
        }
        auto voice = make_voice(impl_->backend,
                                 impl_->sample_rate,
                                 impl_->channel_count,
                                 impl_->max_in_frames);
        if (!voice) {
            warp_debug_log(
                "[LT_JUMP_DEBUG][warp-mgr] configure_failed clip=%s backend=%s sr=%d ch=%d max_in=%d\n",
                spec.clip_id.c_str(), backend_name(impl_->backend),
                impl_->sample_rate, impl_->channel_count, impl_->max_in_frames);
            continue;
        }
        voice->reset_source_cursor(spec.initial_source_cursor);
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] build_voice clip=%s backend=%s initial_cursor=%lld ratio=%.6f in_lat=%d out_lat=%d\n",
            spec.clip_id.c_str(), voice->backend_name(),
            spec.initial_source_cursor, spec.warp_ratio,
            voice->input_latency_frames(), voice->output_latency_frames());
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    std::atomic_store(&impl_->active, std::shared_ptr<const VoiceMap>(next));
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] rebuild_for_session playhead=%lld backend=%s specs=%zu built=%d reused=%d active=%zu\n",
        static_cast<long long>(playhead),
        backend_name(impl_->backend),
        specs.size(), built, reused, next->size());
}

void WarpVoiceManager::clear() {
    if (!impl_) return;
    std::lock_guard build_lock(impl_->build_mutex);
    std::atomic_store(&impl_->active, impl_->empty);
}

std::shared_ptr<WarpVoice>
WarpVoiceManager::voice_for_shared(const Id& clip_id) noexcept {
    if (!impl_) return nullptr;
    auto snapshot = std::atomic_load(&impl_->active);
    if (!snapshot) return nullptr;
    auto it = snapshot->find(clip_id);
    if (it == snapshot->end()) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    impl_->voice_lookups_hit.fetch_add(1, std::memory_order_relaxed);
    return it->second;
}

WarpVoiceManagerDiagnostics WarpVoiceManager::diagnostics() const noexcept {
    WarpVoiceManagerDiagnostics d;
    if (!impl_) return d;
    auto snapshot = std::atomic_load(&impl_->active);
    d.active_voice_count = snapshot ? static_cast<int>(snapshot->size()) : 0;
    d.voices_built_total = impl_->voices_built_total.load(std::memory_order_relaxed);
    d.rebuilds_total     = impl_->rebuilds_total.load(std::memory_order_relaxed);
    d.voice_lookups_hit  = impl_->voice_lookups_hit.load(std::memory_order_relaxed);
    d.voice_lookups_miss = impl_->voice_lookups_miss.load(std::memory_order_relaxed);
    d.backend            = impl_->backend;
    return d;
}

} // namespace lt
