#include <lt_engine/pitch/bungee_voice_manager.h>

#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace lt {

// ─── Key / map ───────────────────────────────────────────────────────────

struct VoiceKey {
    Id        clip_id;
    Semitones semitones;
    bool operator==(const VoiceKey& o) const noexcept {
        return semitones == o.semitones && clip_id == o.clip_id;
    }
};

struct VoiceKeyHash {
    std::size_t operator()(const VoiceKey& k) const noexcept {
        std::size_t h = std::hash<std::string>{}(k.clip_id);
        h ^= std::hash<int>{}(static_cast<int>(k.semitones))
             + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

using VoiceMap = std::unordered_map<VoiceKey,
                                    std::shared_ptr<BungeePitchVoice>,
                                    VoiceKeyHash>;

// ─── Impl ────────────────────────────────────────────────────────────────

struct BungeeVoiceManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;

    // Published voice map. Audio thread reads via std::atomic_load; control
    // thread builds a new map and swaps via std::atomic_store.
    std::shared_ptr<const VoiceMap> active{std::make_shared<const VoiceMap>()};

    // Diagnostic counters. All relaxed atomics — we only need to know "did
    // the audio thread ever consume a Bungee voice?", not strict ordering.
    std::atomic<std::uint64_t> voices_built_total{0};
    std::atomic<std::uint64_t> rebuilds_for_session{0};
    std::atomic<std::uint64_t> rebuilds_for_seek{0};
    std::atomic<std::uint64_t> voice_lookups_hit{0};
    std::atomic<std::uint64_t> voice_lookups_miss{0};
};

BungeeVoiceManager::BungeeVoiceManager()
    : impl_(std::make_unique<Impl>()) {}

BungeeVoiceManager::~BungeeVoiceManager() = default;

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

// Iterate the session and collect (clip_id, semitones, source, source_frame)
// tuples for every transposed-and-currently-playing voice at `playhead`.
struct VoiceSpec {
    VoiceKey             key;
    const DecodedSource* source = nullptr;
    Frame                source_frame = 0;  // where in the source we will start
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

                const auto* src = sources.get(clip.source_id);
                if (!src || !src->is_loaded()) continue;

                const auto decision = resolve_pitch_render_decision(
                    track, clip, song, playhead);
                if (!decision.needs_pitch || decision.effective_semitones == 0)
                    continue;

                VoiceSpec spec;
                spec.key.clip_id      = clip.id;
                spec.key.semitones    = decision.effective_semitones;
                spec.source           = src;
                // Source frame the audio thread will request first after the
                // playhead lands here. We will prime up to this position.
                spec.source_frame     = clip.source_start_frame
                                        + (playhead - clip.timeline_start_frame);
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
constexpr int kMaxWarmFramesAt48k = 28800;  // 600 ms at 48 kHz

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
}
#endif // LT_ENGINE_HAVE_BUNGEE

} // namespace

// ─── Control-thread rebuilds ─────────────────────────────────────────────

void BungeeVoiceManager::rebuild_for_session(const Session& session,
                                              const SourceManager& sources,
                                              Frame playhead) {
    if (!is_available()) return;

#if LT_ENGINE_HAVE_BUNGEE
    impl_->rebuilds_for_session.fetch_add(1, std::memory_order_relaxed);

    const auto specs = enumerate_voices(session, sources, playhead);

    auto current = std::atomic_load(&impl_->active);
    auto next    = std::make_shared<VoiceMap>();
    next->reserve(specs.size());

    int reused = 0;
    int built  = 0;
    for (const auto& spec : specs) {
        // Reuse the existing voice when its key is unchanged — saves the
        // ~0.15 ms construct cost per voice and keeps Bungee's internal
        // pipeline warm (no re-priming needed). When the effective pitch
        // changed mid-clip, the key differs and we build a fresh voice.
        auto it = current->find(spec.key);
        if (it != current->end()) {
            (*next)[spec.key] = it->second;
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
        (*next)[spec.key] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    const int active_count = static_cast<int>(next->size());
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    std::fprintf(stdout,
        "[BUNGEE] rebuild_for_session playhead=%lld active=%d built=%d reused=%d\n",
        static_cast<long long>(playhead), active_count, built, reused);
    std::fflush(stdout);
#else
    (void)session; (void)sources; (void)playhead;
#endif
}

void BungeeVoiceManager::rebuild_for_seek(Frame target_frame,
                                           const Session& session,
                                           const SourceManager& sources) {
    if (!is_available()) return;

#if LT_ENGINE_HAVE_BUNGEE
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
        (*next)[spec.key] = std::move(voice);
        ++built;
        impl_->voices_built_total.fetch_add(1, std::memory_order_relaxed);
    }

    const int active_count = static_cast<int>(next->size());
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::move(next)));
    std::fprintf(stdout,
        "[BUNGEE] rebuild_for_seek target=%lld active=%d built=%d\n",
        static_cast<long long>(target_frame), active_count, built);
    std::fflush(stdout);
#else
    (void)target_frame; (void)session; (void)sources;
#endif
}

void BungeeVoiceManager::clear() {
    if (!impl_) return;
    std::atomic_store(&impl_->active,
                      std::shared_ptr<const VoiceMap>(std::make_shared<const VoiceMap>()));
}

// ─── Audio-thread lookup ─────────────────────────────────────────────────

BungeePitchVoice* BungeeVoiceManager::voice_for(const Id& clip_id,
                                                 Semitones semitones) noexcept {
    if (!impl_) return nullptr;
    auto snapshot = std::atomic_load(&impl_->active);
    if (!snapshot) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    auto it = snapshot->find(VoiceKey{clip_id, semitones});
    if (it == snapshot->end()) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    impl_->voice_lookups_hit.fetch_add(1, std::memory_order_relaxed);
    return it->second.get();
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
