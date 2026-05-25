#include <lt_engine/pitch/warp_voice_manager.h>

#include <lt_engine/debug/logging.h>
#include <lt_engine/pitch/bungee_warp_voice.h>
#include <lt_engine/pitch/rubberband_warp_voice.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
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

bool env_equals_ignore_case(const char* raw, const char* expected) noexcept {
    if (!raw || !expected) return false;
    while (*raw && *expected) {
        const auto a = static_cast<unsigned char>(*raw++);
        const auto b = static_cast<unsigned char>(*expected++);
        if (std::tolower(a) != std::tolower(b))
            return false;
    }
    return *raw == '\0' && *expected == '\0';
}

bool force_rubberband_backend() noexcept {
    const char* raw = std::getenv("LIBRETRACKS_WARP_BACKEND");
    return env_equals_ignore_case(raw, "rubberband")
        || env_equals_ignore_case(raw, "rubberband_r2")
        || env_equals_ignore_case(raw, "rb");
}

std::shared_ptr<WarpVoice> make_voice(int sample_rate,
                                       int channel_count,
                                       int max_in_frames) {
#if LT_ENGINE_HAVE_BUNGEE
    if (!force_rubberband_backend()) {
        auto bungee = std::make_shared<BungeeWarpVoice>();
        if (bungee->configure(sample_rate, channel_count, max_in_frames))
            return bungee;
    }
#endif
#if LT_ENGINE_HAVE_RUBBERBAND
    auto v = std::make_shared<RubberBandWarpVoice>();
    if (!v->configure(sample_rate, channel_count, max_in_frames))
        return nullptr;
    return v;
#endif
#if !LT_ENGINE_HAVE_BUNGEE && !LT_ENGINE_HAVE_RUBBERBAND
    (void)sample_rate; (void)channel_count; (void)max_in_frames;
    return nullptr;
#endif
    return nullptr;
}

} // namespace

struct WarpVoiceManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;

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
#if !LT_ENGINE_HAVE_BUNGEE && !LT_ENGINE_HAVE_RUBBERBAND
    impl_->prepared = false;
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] prepare_failed no warp backend compiled in\n");
    return false;
#else
#if LT_ENGINE_HAVE_BUNGEE && !LT_ENGINE_HAVE_RUBBERBAND
    if (force_rubberband_backend()) {
        impl_->prepared = false;
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] prepare_failed RubberBand forced but not compiled in\n");
        return false;
    }
#endif
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    std::atomic_store(&impl_->active, impl_->empty);
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] prepare backend=%s sr=%d ch=%d max_in=%d\n",
        active_backend_name(), sample_rate, channel_count, max_input_frames);
    return true;
#endif
}

bool WarpVoiceManager::is_available() const noexcept {
    return impl_ && impl_->prepared;
}

const char* WarpVoiceManager::active_backend_name() const noexcept {
#if LT_ENGINE_HAVE_BUNGEE
    if (force_rubberband_backend()) {
#if LT_ENGINE_HAVE_RUBBERBAND
        return "rubberband_r2";
#else
        return "unavailable";
#endif
    }
    return "bungee_basic_warp";
#elif LT_ENGINE_HAVE_RUBBERBAND
    return "rubberband_r2";
#else
    return "unavailable";
#endif
}

namespace {

// Prefeed a freshly-built WarpVoice so its internal stretcher has a warm
// analysis window centred on `target_source_cursor`. Without this, the first
// post-publish render_block returns ~latency_frames of silence while the
// stretcher (Bungee Stream warp = ~4864 frames @ 48k) builds up its grain
// pipeline from scratch. Same logic as the prearm helper in
// prearmed_jump_manager.cpp — duplicated here so seek-time publish has it
// without pulling in the prearm module.
void prefeed_warp_voice_with_target_audio(WarpVoice& voice,
                                           const DecodedSource& source,
                                           long long target_source_cursor,
                                           int channel_count,
                                           int max_in_frames,
                                           double warp_ratio) {
    if (!voice.is_ready()) return;
    const int latency_frames = std::max(0, voice.input_latency_frames());
    if (latency_frames <= 0) return;

    voice.reset_source_cursor(target_source_cursor);

    std::vector<float> in_l (static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> in_r (static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> out_l(static_cast<std::size_t>(max_in_frames), 0.0f);
    std::vector<float> out_r(static_cast<std::size_t>(max_in_frames), 0.0f);
    const float* in_ptrs[2]  = { in_l.data(), in_r.data() };
    float*       out_ptrs[2] = { out_l.data(), out_r.data() };
    (void)channel_count;

    const Frame src_end = source.duration_frames();
    long long read_cursor = target_source_cursor;
    int fed = 0;
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);

        std::fill(in_l.begin(), in_l.begin() + chunk, 0.0f);
        std::fill(in_r.begin(), in_r.begin() + chunk, 0.0f);
        const int dst_offset = read_cursor < 0
            ? static_cast<int>(std::min<long long>(chunk, -read_cursor))
            : 0;
        const Frame read_start = static_cast<Frame>(
            std::max<long long>(0, read_cursor));
        const int available = (dst_offset >= chunk || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                chunk - dst_offset,
                static_cast<long long>(src_end - read_start)));
        if (available > 0) {
            float* read_into[2] = {
                in_l.data() + dst_offset,
                in_r.data() + dst_offset};
            const int got = source.read(read_start, available, read_into,
                                         std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1) {
                std::copy_n(in_l.begin() + dst_offset, got,
                            in_r.begin() + dst_offset);
            }
        }

        (void)voice.render_block(in_ptrs, chunk, out_ptrs, chunk, warp_ratio);
        read_cursor += chunk;
        fed         += chunk;
    }
    // Stretcher's internal cursor now sits at (target + latency); the audio
    // thread reads from `wv->source_cursor()` on the first post-publish
    // block, picking up exactly where prefeed stopped — no double-feed.
}

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
                    // Cursor advances in warped source units in both Warp
                    // and Cascade paths: the renderer reads the source file
                    // at ratio-scaled speed in both (warp directly, cascade
                    // through Bungee at speed=1 but with ceil(out*ratio)
                    // input per block).
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
        // Reuse if the clip already has a warp voice; RubberBand is stateful
        // and reconstructing wastes its analysis window.
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
        auto voice = make_voice(impl_->sample_rate,
                                 impl_->channel_count,
                                 impl_->max_in_frames);
        if (!voice) {
            warp_debug_log(
                "[LT_JUMP_DEBUG][warp-mgr] configure_failed clip=%s sr=%d ch=%d max_in=%d\n",
                spec.clip_id.c_str(),
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
        "[LT_JUMP_DEBUG][warp-mgr] rebuild_for_session playhead=%lld specs=%zu built=%d reused=%d active=%zu\n",
        static_cast<long long>(playhead),
        specs.size(), built, reused, next->size());
}

void WarpVoiceManager::rebuild_for_seek(const Session& session,
                                         const SourceManager& /*sources*/,
                                         Frame playhead) {
    if (!is_available()) return;
    std::lock_guard build_lock(impl_->build_mutex);
    impl_->rebuilds_total.fetch_add(1, std::memory_order_relaxed);

    const auto specs = enumerate_warp_clips(session, playhead);

    auto next = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int built = 0;
    for (const auto& spec : specs) {
        auto voice = make_voice(impl_->sample_rate,
                                impl_->channel_count,
                                impl_->max_in_frames);
        if (!voice) {
            warp_debug_log(
                "[LT_JUMP_DEBUG][warp-mgr] seek_configure_failed clip=%s sr=%d ch=%d max_in=%d\n",
                spec.clip_id.c_str(),
                impl_->sample_rate, impl_->channel_count, impl_->max_in_frames);
            continue;
        }
        voice->reset_source_cursor(spec.initial_source_cursor);
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] seek_build_voice clip=%s backend=%s initial_cursor=%lld ratio=%.6f in_lat=%d out_lat=%d\n",
            spec.clip_id.c_str(), voice->backend_name(),
            spec.initial_source_cursor, spec.warp_ratio,
            voice->input_latency_frames(), voice->output_latency_frames());
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    std::atomic_store(&impl_->active, std::shared_ptr<const VoiceMap>(next));
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] rebuild_for_seek playhead=%lld specs=%zu built=%d active=%zu\n",
        static_cast<long long>(playhead),
        specs.size(), built, next->size());
}

void WarpVoiceManager::retime_existing_for_session(
    const Session& session,
    const SourceManager& /*sources*/,
    Frame playhead) {
    if (!is_available()) return;

    const auto specs = enumerate_warp_clips(session, playhead);
    auto current = std::atomic_load(&impl_->active);
    if (!current) return;

    auto next = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int retimed = 0;
    int missing = 0;
    for (const auto& spec : specs) {
        auto it = current->find(spec.clip_id);
        if (it == current->end() || !it->second) {
            ++missing;
            continue;
        }
        it->second->reset_source_cursor(spec.initial_source_cursor);
        (*next)[spec.clip_id] = it->second;
        ++retimed;
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] retime_voice clip=%s cursor=%lld ratio=%.6f\n",
            spec.clip_id.c_str(), spec.initial_source_cursor,
            spec.warp_ratio);
    }

    std::atomic_store(&impl_->active, std::shared_ptr<const VoiceMap>(next));
    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] retime_existing playhead=%lld specs=%zu retimed=%d missing=%d active=%zu\n",
        static_cast<long long>(playhead),
        specs.size(), retimed, missing, next->size());
}

void WarpVoiceManager::retime_existing_realtime(const Session& session,
                                                Frame playhead) noexcept {
    if (!is_available()) return;

    auto current = std::atomic_load(&impl_->active);
    if (!current) return;

    int retimed = 0;
    int missing = 0;
    for (const auto& song : session.songs) {
        struct ActiveRegion { const Region* r; double ratio; };
        constexpr int kMaxRealtimeWarpRegions = 64;
        ActiveRegion warp_regions[kMaxRealtimeWarpRegions]{};
        int warp_region_count = 0;
        for (const auto& r : song.regions) {
            if (!r.warp_enabled || r.warp_source_bpm <= 0.0) continue;
            if (warp_region_count >= kMaxRealtimeWarpRegions)
                break;
            warp_regions[warp_region_count++] =
                ActiveRegion{&r, resolve_warp_time_ratio(song, r.start_frame)};
        }
        if (warp_region_count == 0) continue;

        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                const Frame clip_end =
                    clip.timeline_start_frame + clip.length_frames;
                const ActiveRegion* hit = nullptr;
                for (int i = 0; i < warp_region_count; ++i) {
                    const auto& wr = warp_regions[i];
                    if (clip.timeline_start_frame < wr.r->end_frame
                        && clip_end > wr.r->start_frame) {
                        hit = &wr;
                        break;
                    }
                }
                if (!hit) continue;

                auto it = current->find(clip.id);
                if (it == current->end() || !it->second) {
                    ++missing;
                    continue;
                }

                long long source_cursor = clip.source_start_frame;
                if (playhead >= clip.timeline_start_frame
                    && playhead < clip_end) {
                    const Frame timeline_offset =
                        playhead - clip.timeline_start_frame;
                    source_cursor = clip.source_start_frame
                        + static_cast<long long>(
                            static_cast<double>(timeline_offset)
                            * hit->ratio);
                }
                it->second->reset_source_cursor(source_cursor);
                ++retimed;
            }
        }
    }

    warp_debug_log(
        "[LT_JUMP_DEBUG][warp-mgr] retime_realtime playhead=%lld retimed=%d missing=%d active=%zu\n",
        static_cast<long long>(playhead),
        retimed, missing, current->size());
}

std::shared_ptr<const WarpVoiceManager::VoiceMap>
WarpVoiceManager::build_prepared_voice_map(VoiceMap prepared_voices) const {
    return std::make_shared<const VoiceMap>(std::move(prepared_voices));
}

std::shared_ptr<WarpVoice> WarpVoiceManager::make_voice_for_clip() const {
    if (!impl_ || !impl_->prepared) return nullptr;
    return make_voice(impl_->sample_rate, impl_->channel_count,
                       impl_->max_in_frames);
}

std::shared_ptr<const WarpVoiceManager::VoiceMap>
WarpVoiceManager::build_seek_voice_map(Frame target_frame,
                                        const Session& session,
                                        const SourceManager& sources) const {
    auto out = std::make_shared<VoiceMap>();
    if (!impl_ || !impl_->prepared) return out;

    const int sr  = impl_->sample_rate;
    const int ch  = impl_->channel_count;
    const int max_in = impl_->max_in_frames;

    const auto specs = enumerate_warp_clips(session, target_frame);
    out->reserve(specs.size());

    for (const auto& spec : specs) {
        auto voice = make_voice(sr, ch, max_in);
        if (!voice || !voice->is_ready()) {
            warp_debug_log(
                "[LT_JUMP_DEBUG][warp-mgr] seek_build_voice_failed clip=%s\n",
                spec.clip_id.c_str());
            continue;
        }
        // Find the clip's source to prefeed against. We re-walk the session
        // because enumerate_warp_clips only carries clip_id + cursor + ratio.
        const DecodedSource* src = nullptr;
        for (const auto& song : session.songs) {
            for (const auto& track : song.tracks) {
                for (const auto& clip : track.clips) {
                    if (clip.id == spec.clip_id) {
                        auto s = sources.get_shared(clip.source_id);
                        if (s && s->is_loaded())
                            src = s.get();
                    }
                }
            }
        }
        if (src) {
            prefeed_warp_voice_with_target_audio(
                *voice, *src, spec.initial_source_cursor,
                ch, max_in, spec.warp_ratio);
        } else {
            // No source loaded — fall back to a bare cursor reset. The first
            // post-publish block will be the usual ~100 ms of stretcher
            // analysis silence, but at least we don't crash.
            voice->reset_source_cursor(spec.initial_source_cursor);
        }
        warp_debug_log(
            "[LT_JUMP_DEBUG][warp-mgr] seek_build_voice_map clip=%s backend=%s cursor=%lld ratio=%.6f in_lat=%d had_source=%d\n",
            spec.clip_id.c_str(), voice->backend_name(),
            spec.initial_source_cursor, spec.warp_ratio,
            voice->input_latency_frames(), src ? 1 : 0);
        (*out)[spec.clip_id] = std::move(voice);
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }
    return out;
}

void WarpVoiceManager::publish_prepared_voice_map_realtime(
    std::shared_ptr<const VoiceMap> prepared_voices) noexcept {
    if (!impl_) return;
    if (!prepared_voices) {
        std::atomic_store(&impl_->active, impl_->empty);
        return;
    }
    std::atomic_store(&impl_->active, std::move(prepared_voices));
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
    return d;
}

} // namespace lt
