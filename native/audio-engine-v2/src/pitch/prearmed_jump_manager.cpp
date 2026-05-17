#include <lt_engine/pitch/prearmed_jump_manager.h>

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unordered_set>

namespace lt {

// ─── PreparedJumpVoiceSet helpers ────────────────────────────────────────

std::unordered_map<Id, std::shared_ptr<BungeePitchVoice>>
PreparedJumpVoiceSet::extract_voice_map() {
    std::unordered_map<Id, std::shared_ptr<BungeePitchVoice>> out;
    out.reserve(tracks.size());
    for (auto& t : tracks)
        if (t.voice) out.emplace(t.clip_id, std::move(t.voice));
    return out;
}

namespace {

bool prearm_log_enabled() {
    static const bool on = [] {
        const char* v = std::getenv("LIBRETRACKS_PREARM_LOG");
        return v && (std::strcmp(v, "1") == 0 || std::strcmp(v, "true") == 0);
    }();
    return on;
}

// Warm a freshly-constructed voice by feeding zero input on the control
// thread until Bungee's analysis pipeline is full. Mirrors
// BungeeVoiceManager::warm_voice — duplicated rather than refactored to keep
// the MVP self-contained and trivially revertible.
//
// See memory [[project-bungee-warm-voice]]: skipping this loop causes
// STATUS_ACCESS_VIOLATION on the audio thread's first Stream::process call.
constexpr int kWarmFramesAt48k = 28800; // 600 ms safety cap

void warm_voice_silence(BungeePitchVoice& voice,
                         int sample_rate,
                         int channel_count,
                         int max_in_frames) {
    if (!voice.is_ready()) return;
    const int max_warm = std::max(0,
        static_cast<int>(static_cast<long long>(kWarmFramesAt48k) * sample_rate / 48000));
    if (max_warm <= 0) return;

    std::vector<std::vector<float>> in_planes(
        static_cast<std::size_t>(channel_count),
        std::vector<float>(static_cast<std::size_t>(max_in_frames), 0.0f));
    std::vector<std::vector<float>> out_planes(
        static_cast<std::size_t>(channel_count),
        std::vector<float>(static_cast<std::size_t>(max_in_frames), 0.0f));
    std::vector<const float*> in_ptrs(static_cast<std::size_t>(channel_count), nullptr);
    std::vector<float*>       out_ptrs(static_cast<std::size_t>(channel_count), nullptr);
    for (int c = 0; c < channel_count; ++c) {
        in_ptrs[static_cast<std::size_t>(c)]  = in_planes[static_cast<std::size_t>(c)].data();
        out_ptrs[static_cast<std::size_t>(c)] = out_planes[static_cast<std::size_t>(c)].data();
    }

    int fed = 0;
    while (fed < max_warm) {
        const int chunk = std::min(max_in_frames, max_warm - fed);
        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  /*pitch_scale*/ 1.0);
        fed += chunk;
        if (voice.is_warm()) break;
    }
}

// Real-audio prefeed for prearmed voices.
//
// AFTER warm_voice_silence has filled Bungee's analysis pipeline with zeros,
// feed `latency()` frames of REAL source audio starting at `target_source_frame`
// while concurrently discarding the same number of output frames. The discarded
// output covers Bungee's transition from "all silence" to "real audio" — that
// transition is artefact-rich and we don't want the audio thread to hear it.
//
// After prefeed, the voice's next render_block call will return output that
// corresponds to source position `target_source_frame` in the listener's
// timeline. The audio thread, which feeds source from
// `(target_source_frame + latency())` per render block, gets uninterrupted
// real-audio continuation: prefeed covered [target, target+latency), audio
// thread covers [target+latency, …).
//
// Math:
//   pre-warm:           input_pos = W,         output_pos = W - L  (silence)
//   feed L real:        input_pos = W + L,     output_pos still ≈ W - L
//   drain L output:     input_pos = W + L,     output_pos = W      (= start of
//                                                                    real audio)
//   audio thread's 1st  input_pos = W + L + 480, output_pos = W + 480
//   render_block call:  → output corresponds to source[target..target+480) ✓
//
// We pad with silence if `target_source_frame` is near the source end or before
// the source start (matches what TrackRenderer does on the audio thread).
//
// Pitch_scale = 1.0 for prefeed (identity); the audio thread sets the real
// pitch on its first call via render_block(pitch_scale=…) and Bungee picks
// it up on the next grain.
void prefeed_voice_with_target_audio(BungeePitchVoice& voice,
                                      const DecodedSource& source,
                                      Frame target_source_frame,
                                      int sample_rate,
                                      int channel_count,
                                      int max_in_frames) {
    if (!voice.is_ready()) return;
    const int latency_frames = static_cast<int>(voice.latency_frames());
    if (latency_frames <= 0) return; // nothing to prefeed; voice not warm

    // Buffers reused across iterations.
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

    const Frame src_end  = source.duration_frames();
    Frame  read_cursor   = target_source_frame; // absolute source frame to read next
    int    fed           = 0;                   // count of real frames fed
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);

        // Pull `chunk` frames from the source starting at `read_cursor`. Anything
        // past src_end is zero-padded (matches track_renderer's pad-on-EOF).
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
            if (got > 0 && source.channel_count() == 1) {
                std::copy_n(read_l.begin(), got, read_r.begin());
            }
        }

        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  /*pitch_scale*/ 1.0);
        read_cursor += chunk;
        fed         += chunk;
    }
}

// Per-clip prep spec for a single prearmed target.
struct PrepSpec {
    Id                   clip_id;
    const DecodedSource* source = nullptr;
    Frame                target_source_frame = 0;
    Semitones            effective_semitones = 0;
};

std::vector<PrepSpec> enumerate_prep_specs(const Song& song,
                                            const Track& track,
                                            const Clip& clip,
                                            const SourceManager& sources,
                                            Frame target_timeline_frame) {
    std::vector<PrepSpec> out;

    const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (target_timeline_frame < clip.timeline_start_frame
        || target_timeline_frame >= clip_end)
        return out;
    if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
        return out;

    const auto* src = sources.get(clip.source_id);
    if (!src || !src->is_loaded()) return out;

    const auto decision = resolve_pitch_render_decision(
        track, clip, song, target_timeline_frame);

    PrepSpec spec;
    spec.clip_id              = clip.id;
    spec.source               = src;
    spec.target_source_frame  = clip.source_start_frame
                                + (target_timeline_frame - clip.timeline_start_frame);
    spec.effective_semitones  = decision.effective_semitones;
    out.push_back(spec);
    return out;
}

} // namespace

// ─── Impl ────────────────────────────────────────────────────────────────

struct PrearmedJumpManager::Impl {
    bool prepared      = false;
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;

    mutable std::mutex mtx;
    std::unordered_map<PrearmTargetKey,
                       std::unique_ptr<PreparedJumpVoiceSet>,
                       PrearmTargetKeyHash>                  prepared_map;

    // Revision the current prepared_map was built for. Bumping it invalidates
    // the whole cache. Phase 6 adds finer-grained revisions.
    std::uint64_t current_revision = 0;

    std::atomic<std::uint64_t> prepared_total       {0};
    std::atomic<std::uint64_t> prepare_failed_total {0};
    std::atomic<std::uint64_t> take_hit_total       {0};
    std::atomic<std::uint64_t> take_miss_total      {0};
    std::atomic<std::uint64_t> stale_discard_total  {0};

    // Drop the cache; caller must hold mtx. Bumps stale_discard_total.
    void clear_prepared_map_locked() {
        if (!prepared_map.empty()) {
            stale_discard_total.fetch_add(prepared_map.size(),
                                          std::memory_order_relaxed);
            prepared_map.clear();
        }
    }
};

// ─── Lifecycle ───────────────────────────────────────────────────────────

PrearmedJumpManager::PrearmedJumpManager() : impl_(std::make_unique<Impl>()) {}
PrearmedJumpManager::~PrearmedJumpManager() = default;

bool PrearmedJumpManager::prepare(int sample_rate,
                                   int channel_count,
                                   int max_input_frames) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames <= 0)
        return false;
    std::lock_guard<std::mutex> g(impl_->mtx);
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    impl_->clear_prepared_map_locked();
    return true;
}

void PrearmedJumpManager::clear() {
    if (!impl_) return;
    std::lock_guard<std::mutex> g(impl_->mtx);
    const std::size_t before = impl_->prepared_map.size();
    impl_->clear_prepared_map_locked();
    if (prearm_log_enabled() && before > 0) {
        std::fprintf(stdout, "[PREARM] clear discarded=%zu\n", before);
        std::fflush(stdout);
    }
}

// ─── Prearming ───────────────────────────────────────────────────────────

void PrearmedJumpManager::prepare_all_markers(const Session& session,
                                                const SourceManager& sources,
                                                std::uint64_t session_revision) {
    if (!impl_ || !impl_->prepared) return;

    std::lock_guard<std::mutex> g(impl_->mtx);

    if (session_revision != impl_->current_revision) {
        const std::size_t before = impl_->prepared_map.size();
        impl_->clear_prepared_map_locked();
        impl_->current_revision = session_revision;
        if (prearm_log_enabled()) {
            std::fprintf(stdout,
                "[PREARM] revision_changed new=%llu discarded=%zu\n",
                static_cast<unsigned long long>(session_revision), before);
            std::fflush(stdout);
        }
    }

    std::unordered_set<PrearmTargetKey, PrearmTargetKeyHash> kept;
    kept.reserve(16);

    for (const auto& song : session.songs) {
        for (const auto& marker : song.markers) {
            PrearmTargetKey key;
            key.kind             = PrearmTargetKind::Marker;
            key.song_id          = song.id;
            key.marker_id        = marker.id;
            key.timeline_frame   = marker.frame;
            key.sample_rate      = impl_->sample_rate;
            key.block_size       = impl_->max_in_frames;
            key.session_revision = session_revision;
            kept.insert(key);

            auto it = impl_->prepared_map.find(key);
            if (it != impl_->prepared_map.end() && it->second && it->second->valid)
                continue; // already prepared

            // Build a fresh prepared set.
            auto set = std::make_unique<PreparedJumpVoiceSet>();
            set->key                   = key;
            set->target_timeline_frame = marker.frame;
            set->valid                 = false;
            bool any_failed = false;

            for (const auto& track : song.tracks) {
                for (const auto& clip : track.clips) {
                    auto specs = enumerate_prep_specs(
                        song, track, clip, sources, marker.frame);
                    for (const auto& spec : specs) {
                        auto voice = std::make_shared<BungeePitchVoice>();
                        if (!voice->configure(impl_->sample_rate,
                                              impl_->channel_count,
                                              impl_->max_in_frames)) {
                            any_failed = true;
                            continue;
                        }
                        warm_voice_silence(*voice,
                                            impl_->sample_rate,
                                            impl_->channel_count,
                                            impl_->max_in_frames);
                        // Real-audio prefeed: feed `latency()` frames of source
                        // around target_source_frame so the audio thread's first
                        // post-jump render block emits true target audio instead
                        // of the silence-to-real-audio FFT transition. See
                        // prefeed_voice_with_target_audio() for the alignment
                        // derivation.
                        if (spec.source) {
                            prefeed_voice_with_target_audio(
                                *voice, *spec.source,
                                spec.target_source_frame,
                                impl_->sample_rate,
                                impl_->channel_count,
                                impl_->max_in_frames);
                        }
                        // Re-arm fade AFTER prefeed (prefeed's render_block
                        // calls consume the default fade window). The 5 ms
                        // ramp now applies to the audio thread's first real
                        // frames.
                        voice->arm_fade_in();

                        PreparedTrackVoice ptv;
                        ptv.clip_id             = spec.clip_id;
                        ptv.voice               = std::move(voice);
                        ptv.target_source_frame = spec.target_source_frame;
                        ptv.ready               = true;
                        set->tracks.push_back(std::move(ptv));
                    }
                }
            }

            // Transactional: any voice failed → whole set is invalid.
            if (any_failed) {
                impl_->prepare_failed_total.fetch_add(1, std::memory_order_relaxed);
                set->valid = false;
                if (prearm_log_enabled()) {
                    std::fprintf(stdout,
                        "[PREARM] prepare_failed song=%s marker=%s frame=%lld\n",
                        song.id.c_str(), marker.id.c_str(),
                        static_cast<long long>(marker.frame));
                    std::fflush(stdout);
                }
            } else {
                set->valid = true;
                impl_->prepared_total.fetch_add(1, std::memory_order_relaxed);
                if (prearm_log_enabled()) {
                    std::fprintf(stdout,
                        "[PREARM] prepared song=%s marker=%s frame=%lld voices=%zu\n",
                        song.id.c_str(), marker.id.c_str(),
                        static_cast<long long>(marker.frame), set->tracks.size());
                    std::fflush(stdout);
                }
            }

            impl_->prepared_map[key] = std::move(set);
        }
    }

    // Evict prepared sets whose target no longer exists (defensive — most
    // structural edits also bump session_revision, which already cleared).
    for (auto it = impl_->prepared_map.begin(); it != impl_->prepared_map.end(); ) {
        if (kept.find(it->first) == kept.end()) {
            impl_->stale_discard_total.fetch_add(1, std::memory_order_relaxed);
            it = impl_->prepared_map.erase(it);
        } else {
            ++it;
        }
    }
}

std::unique_ptr<PreparedJumpVoiceSet>
PrearmedJumpManager::take_ready(const PrearmTargetKey& key) {
    if (!impl_) return nullptr;
    std::lock_guard<std::mutex> g(impl_->mtx);
    auto it = impl_->prepared_map.find(key);
    if (it == impl_->prepared_map.end() || !it->second || !it->second->valid) {
        impl_->take_miss_total.fetch_add(1, std::memory_order_relaxed);
        return nullptr;
    }
    impl_->take_hit_total.fetch_add(1, std::memory_order_relaxed);
    auto out = std::move(it->second);
    impl_->prepared_map.erase(it);
    return out;
}

PrearmedJumpManager::Diagnostics
PrearmedJumpManager::diagnostics() const noexcept {
    Diagnostics d;
    if (!impl_) return d;
    std::lock_guard<std::mutex> g(impl_->mtx);
    d.ready_count = 0;
    for (const auto& kv : impl_->prepared_map)
        if (kv.second && kv.second->valid) ++d.ready_count;
    d.prepared_total       = impl_->prepared_total.load(std::memory_order_relaxed);
    d.prepare_failed_total = impl_->prepare_failed_total.load(std::memory_order_relaxed);
    d.take_hit_total       = impl_->take_hit_total.load(std::memory_order_relaxed);
    d.take_miss_total      = impl_->take_miss_total.load(std::memory_order_relaxed);
    d.stale_discard_total  = impl_->stale_discard_total.load(std::memory_order_relaxed);
    return d;
}

} // namespace lt
