#include <lt_engine/pitch/warp_voice_manager.h>

#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <atomic>
#include <memory>
#include <mutex>

namespace lt {

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
#if !LT_ENGINE_HAVE_SIGNALSMITH
    impl_->prepared = false;
    return false;
#else
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    std::atomic_store(&impl_->active, impl_->empty);
    return true;
#endif
}

bool WarpVoiceManager::is_available() const noexcept {
#if !LT_ENGINE_HAVE_SIGNALSMITH
    return false;
#else
    return impl_ && impl_->prepared;
#endif
}

namespace {

// Mirror of BungeeVoiceManager's enumerate_voices but only collects clips
// whose containing region has warp active. Tracks marked NeverTranspose
// still receive warp — warp is a song-level concept.
struct WarpVoiceSpec {
    Id clip_id;
};

std::vector<WarpVoiceSpec> enumerate_warp_clips(const Session& session) {
    std::vector<WarpVoiceSpec> out;
    out.reserve(16);
    for (const auto& song : session.songs) {
        // Collect warp-active regions in this song.
        std::vector<const Region*> warp_regions;
        warp_regions.reserve(song.regions.size());
        for (const auto& r : song.regions) {
            if (r.warp_enabled && r.warp_source_bpm > 0.0)
                warp_regions.push_back(&r);
        }
        if (warp_regions.empty()) continue;

        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                const Frame clip_end =
                    clip.timeline_start_frame + clip.length_frames;
                bool overlaps_warp = false;
                for (const Region* wr : warp_regions) {
                    if (clip.timeline_start_frame < wr->end_frame
                        && clip_end > wr->start_frame) {
                        overlaps_warp = true;
                        break;
                    }
                }
                if (!overlaps_warp) continue;
                WarpVoiceSpec spec;
                spec.clip_id = clip.id;
                out.push_back(spec);
            }
        }
    }
    return out;
}

} // namespace

void WarpVoiceManager::rebuild_for_session(const Session& session,
                                            const SourceManager& /*sources*/) {
    if (!is_available()) return;
#if LT_ENGINE_HAVE_SIGNALSMITH
    std::lock_guard build_lock(impl_->build_mutex);
    impl_->rebuilds_total.fetch_add(1, std::memory_order_relaxed);

    const auto specs = enumerate_warp_clips(session);

    auto current = std::atomic_load(&impl_->active);
    auto next    = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int built = 0;
    for (const auto& spec : specs) {
        // Reuse if the clip already has a warp voice.
        auto it = current->find(spec.clip_id);
        if (it != current->end()) {
            (*next)[spec.clip_id] = it->second;
            continue;
        }
        // Build a fresh voice.
        auto voice = std::make_shared<SignalsmithWarpVoice>();
        if (!voice->configure(impl_->sample_rate,
                              impl_->channel_count,
                              impl_->max_in_frames)) {
            continue;
        }
        (*next)[spec.clip_id] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    std::atomic_store(&impl_->active, std::shared_ptr<const VoiceMap>(next));
    (void)built;
#else
    (void)session;
#endif
}

void WarpVoiceManager::clear() {
#if LT_ENGINE_HAVE_SIGNALSMITH
    if (!impl_) return;
    std::lock_guard build_lock(impl_->build_mutex);
    std::atomic_store(&impl_->active, impl_->empty);
#endif
}

std::shared_ptr<SignalsmithWarpVoice>
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
