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

// Iterate the session and collect (clip_id, source, source_frame) tuples for
// every transposed-and-currently-playing voice at `playhead`. We enumerate by
// clip rather than by (clip, semitones) — the same voice handles arbitrary
// live pitch changes via the per-block pitch_scale parameter.
struct VoiceSpec {
    Id                   clip_id;
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

                // A clip needs a Bungee voice if pitch CAN be applied. We
                // intentionally do NOT filter on the current effective
                // semitones being non-zero: keeping the voice alive across
                // a "set to zero, then change again" sequence avoids the
                // ~200 ms rebuild gap. The audio thread skips the pitched
                // path when effective_semitones==0 anyway.
                if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
                    continue;

                VoiceSpec spec;
                spec.clip_id      = clip.id;
                spec.source       = src;
                // Source frame the audio thread will request first after the
                // playhead lands here. We will prime up to this position.
                spec.source_frame = clip.source_start_frame
                                    + (playhead - clip.timeline_start_frame);
                out.push_back(spec);
            }
        }
    }
    return out;
}

// (warm_voice removed.)
//
// We previously fed up to 600 ms of zero input on the control thread to try
// to "skip past" Bungee's analysis-pipeline startup. Empirically (per the
// [BUNGEE] warm_voice fed=28800 ... warm=0 log lines), it never succeeded:
// Bungee::Stream's latency() reflects the wrapper's structural
// maxInputFrameCount/2 lookbehind, which is constant per stretcher and
// cannot be drained by feeding more input. The compensation that actually
// keeps transposed audio aligned with non-transposed lives in
// track_renderer.cpp, which reads source from (source_frame +
// latency_frames()) on every block. With log2SynthesisHopAdjust=-1 that
// latency is ~85 ms — and we cannot shrink it from inside the wrapper. So
// the warm_voice loop was just wasted CPU; deleting it does not change
// audible behaviour.

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
        // Voice is left "cold" intentionally. track_renderer compensates for
        // Bungee's structural latency on every render block, so the first
        // audio-thread call already produces timeline-aligned output.
        (*next)[spec.clip_id] = std::move(voice);
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
        // Voice is left "cold" intentionally. track_renderer compensates for
        // Bungee's structural latency on every render block, so the first
        // audio-thread call already produces timeline-aligned output.
        (*next)[spec.clip_id] = std::move(voice);
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

BungeePitchVoice* BungeeVoiceManager::voice_for(const Id& clip_id) noexcept {
    if (!impl_) return nullptr;
    auto snapshot = std::atomic_load(&impl_->active);
    if (!snapshot) {
        impl_->voice_lookups_miss.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    auto it = snapshot->find(clip_id);
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
