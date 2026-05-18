#include <lt_engine/pitch/prearmed_jump_manager.h>

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <cmath>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  define NOMINMAX  // prevent windows.h min/max macros from clobbering std::min/max
#  include <windows.h>
#endif

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

// Kill switch: set LIBRETRACKS_PREARMED_JUMPS=0 to disable all prearming.
// All prepare_* calls become no-ops, take_ready always misses, the engine
// falls through to the legacy reactive seek path everywhere. Useful for
// A/B testing and as an escape hatch if prearm causes a regression in
// production. Read once at process start.
bool prearm_globally_enabled() {
    static const bool on = [] {
        const char* v = std::getenv("LIBRETRACKS_PREARMED_JUMPS");
        if (!v) return true; // default ON
        return !(std::strcmp(v, "0") == 0 || std::strcmp(v, "false") == 0);
    }();
    return on;
}

double semitones_to_pitch_scale(Semitones semitones) {
    return std::pow(2.0, static_cast<double>(semitones) / 12.0);
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
// Prefeed with the same pitch scale the audio thread will use after the jump,
// so Bungee's first audible grain is already in the target transpose state.
void prefeed_voice_with_target_audio(BungeePitchVoice& voice,
                                      const DecodedSource& source,
                                      Frame target_source_frame,
                                      int sample_rate,
                                      int channel_count,
                                      int max_in_frames,
                                      double pitch_scale) {
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
                                  pitch_scale);
        read_cursor += chunk;
        fed         += chunk;
    }
}

// Per-clip prep spec for a single prearmed target.
struct PrepSpec {
    Id                   clip_id;
    std::shared_ptr<const DecodedSource> source;
    Frame                target_source_frame = 0;
    Semitones            effective_semitones = 0;
};

// `out_unloaded_clips` is incremented when a clip at the target frame would
// need a voice but its source isn't decoded yet. Caller uses this to decide
// whether to mark the prepared set as valid (every audible clip primed) vs
// "not ready yet" (some sources still loading — retry on source-ready).
std::vector<PrepSpec> enumerate_prep_specs(const Song& song,
                                            const Track& track,
                                            const Clip& clip,
                                            const SourceManager& sources,
                                            Frame target_timeline_frame,
                                            int* out_unloaded_clips = nullptr) {
    std::vector<PrepSpec> out;

    const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (target_timeline_frame < clip.timeline_start_frame
        || target_timeline_frame >= clip_end)
        return out;
    if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
        return out;

    auto src = sources.get_shared(clip.source_id);
    if (!src || !src->is_loaded()) {
        if (out_unloaded_clips) ++*out_unloaded_clips;
        return out;
    }

    const auto decision = resolve_pitch_render_decision(
        track, clip, song, target_timeline_frame);

    PrepSpec spec;
    spec.clip_id              = clip.id;
    spec.source               = std::move(src);
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

    // Insertion order for FIFO eviction. Front = oldest, back = newest.
    // Phase 7 keeps a deque parallel to prepared_map; both are mutated
    // together under `mtx`.
    std::deque<PrearmTargetKey>                              insertion_order;

    // Revision the current prepared_map was built for. Bumping it invalidates
    // the whole cache. Phase 6 adds finer-grained revisions.
    std::uint64_t current_revision = 0;

    // Phase 7: max prepared sets retained. Initial default reads env var
    // LIBRETRACKS_PREARM_MAX_TARGETS, falling back to 8 (spec default).
    int max_prepared_targets = [] {
        if (const char* v = std::getenv("LIBRETRACKS_PREARM_MAX_TARGETS")) {
            const int n = std::atoi(v);
            if (n > 0 && n < 1024) return n;
        }
        return 8;
    }();

    std::atomic<std::uint64_t> prepared_total       {0};
    std::atomic<std::uint64_t> prepare_failed_total {0};
    std::atomic<std::uint64_t> take_hit_total       {0};
    std::atomic<std::uint64_t> take_miss_total      {0};
    std::atomic<std::uint64_t> stale_discard_total  {0};
    std::atomic<std::uint64_t> eviction_total       {0};

    // Drop the cache; caller must hold mtx. Bumps stale_discard_total.
    void clear_prepared_map_locked() {
        if (!prepared_map.empty()) {
            stale_discard_total.fetch_add(prepared_map.size(),
                                          std::memory_order_relaxed);
            prepared_map.clear();
        }
        insertion_order.clear();
    }

    // ── Phase 2: async worker ────────────────────────────────────────────
    //
    // Single worker thread + a 1-slot pending job (newer requests overwrite
    // older ones — we don't need a full queue because every job rebuilds
    // EVERYTHING for a given revision; an older job is wasted CPU once a
    // newer one arrives).
    struct PendingJob {
        std::shared_ptr<const Session> session;
        const SourceManager*           sources;
        std::uint64_t                  revision;
    };
    std::mutex               worker_mtx;
    std::condition_variable  worker_cv;
    std::optional<PendingJob> pending_job;
    std::atomic<bool>        worker_should_exit{false};
    std::thread              worker_thread;
    std::atomic<bool>        worker_started{false};

    // Drop one prepared set (the oldest by insertion order). Caller holds mtx.
    void evict_one_oldest_locked() {
        while (!insertion_order.empty()) {
            const auto& key = insertion_order.front();
            auto it = prepared_map.find(key);
            insertion_order.pop_front();
            if (it != prepared_map.end()) {
                prepared_map.erase(it);
                eviction_total.fetch_add(1, std::memory_order_relaxed);
                return; // evicted one
            }
            // Key was already gone (e.g. removed by take_ready). Keep popping.
        }
    }
};

// ─── Lifecycle ───────────────────────────────────────────────────────────

PrearmedJumpManager::PrearmedJumpManager() : impl_(std::make_unique<Impl>()) {}

PrearmedJumpManager::~PrearmedJumpManager() {
    // Stop worker thread cleanly. Must happen BEFORE impl_ is destroyed so
    // the worker doesn't touch dangling members.
    if (impl_ && impl_->worker_started.load()) {
        impl_->worker_should_exit.store(true);
        impl_->worker_cv.notify_all();
        if (impl_->worker_thread.joinable())
            impl_->worker_thread.join();
    }
}

bool PrearmedJumpManager::prepare(int sample_rate,
                                   int channel_count,
                                   int max_input_frames) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames <= 0)
        return false;
    std::unique_lock<std::mutex> g(impl_->mtx);
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames;
    impl_->prepared      = true;
    impl_->clear_prepared_map_locked();
    return true;
}

void PrearmedJumpManager::clear() {
    if (!impl_) return;
    std::unique_lock<std::mutex> g(impl_->mtx);
    const std::size_t before = impl_->prepared_map.size();
    impl_->clear_prepared_map_locked();
    if (prearm_log_enabled() && before > 0) {
        std::fprintf(stdout, "[PREARM] clear discarded=%zu\n", before);
        std::fflush(stdout);
    }
}

// ─── Prearming ───────────────────────────────────────────────────────────

namespace {

const char* target_kind_label(PrearmTargetKind k) {
    switch (k) {
        case PrearmTargetKind::Marker:      return "marker";
        case PrearmTargetKind::RegionStart: return "region";
        case PrearmTargetKind::SongStart:   return "song";
    }
    return "unknown";
}

// Build a PreparedJumpVoiceSet for a single (song, target_frame). Pure
// computation — no map mutation. Caller decides how to publish the result.
//
// Sets `set->valid = false` if (a) any voice failed to configure, OR
// (b) any audible-at-target clip's source isn't decoded yet. The second
// case means "retry once sources finish loading" — caller can detect it
// via the `unloaded_clips_skipped` out-param to know whether to re-post
// when source_ready fires.
struct BuildResult {
    std::unique_ptr<PreparedJumpVoiceSet> set;
    int  unloaded_clips_skipped = 0;
};

BuildResult build_prepared_set(
        PrearmTargetKind kind,
        const Song& song,
        const Id& target_id,
        Frame target_frame,
        const SourceManager& sources,
        int sample_rate,
        int channel_count,
        int max_in_frames,
        std::uint64_t session_revision) {
    BuildResult br;
    br.set = std::make_unique<PreparedJumpVoiceSet>();
    auto& set = br.set;
    set->key.kind             = kind;
    set->key.song_id          = song.id;
    set->key.target_id        = target_id;
    set->key.timeline_frame   = target_frame;
    set->key.sample_rate      = sample_rate;
    set->key.block_size       = max_in_frames;
    set->key.session_revision = session_revision;
    set->target_timeline_frame = target_frame;
    set->valid                 = false;

    bool any_failed = false;
    for (const auto& track : song.tracks) {
        for (const auto& clip : track.clips) {
            auto specs = enumerate_prep_specs(song, track, clip, sources,
                                               target_frame,
                                               &br.unloaded_clips_skipped);
            for (const auto& spec : specs) {
                auto voice = std::make_shared<BungeePitchVoice>();
                if (!voice->configure(sample_rate, channel_count, max_in_frames)) {
                    any_failed = true;
                    continue;
                }
                warm_voice_silence(*voice, sample_rate, channel_count, max_in_frames);
                if (spec.source) {
                    prefeed_voice_with_target_audio(
                        *voice, *spec.source, spec.target_source_frame,
                        sample_rate, channel_count, max_in_frames,
                        semitones_to_pitch_scale(spec.effective_semitones));
                }
                voice->arm_fade_in(2);
                PreparedTrackVoice ptv;
                ptv.clip_id             = spec.clip_id;
                ptv.voice               = std::move(voice);
                ptv.target_source_frame = spec.target_source_frame;
                ptv.ready               = true;
                set->tracks.push_back(std::move(ptv));
            }
        }
    }
    // Set is valid ONLY if every audible-at-target clip got a voice.
    // 0-voice sets where no clip is audible (e.g. all NeverTranspose) are
    // still "valid" — the audio thread just doesn't need pitched voices.
    set->valid = !any_failed && (br.unloaded_clips_skipped == 0);
    return br;
}

} // namespace

void PrearmedJumpManager::prepare_all_targets(const Session& session,
                                                const SourceManager& sources,
                                                std::uint64_t session_revision) {
    if (!impl_ || !impl_->prepared) return;
    if (!prearm_globally_enabled()) return; // kill switch

    std::unique_lock<std::mutex> g(impl_->mtx);

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

    const int sample_rate = impl_->sample_rate;
    const int channel_count = impl_->channel_count;
    const int max_in_frames = impl_->max_in_frames;

    std::unordered_set<PrearmTargetKey, PrearmTargetKeyHash> kept;
    kept.reserve(32);

    // build_one: prime voices targeting `target_frame` and insert into the
    // prepared_map. Skips if a valid set already exists for the same key.
    auto build_one = [&](PrearmTargetKind kind,
                          const Song& song,
                          const Id& target_id,
                          Frame target_frame) {
        PrearmTargetKey key;
        key.kind             = kind;
        key.song_id          = song.id;
        key.target_id        = target_id;
        key.timeline_frame   = target_frame;
        key.sample_rate      = sample_rate;
        key.block_size       = max_in_frames;
        key.session_revision = session_revision;
        kept.insert(key);

        auto it = impl_->prepared_map.find(key);
        if (it != impl_->prepared_map.end() && it->second && it->second->valid)
            return; // already prepared

        g.unlock();
        auto br  = build_prepared_set(kind, song, target_id, target_frame,
                                       sources, sample_rate,
                                       channel_count,
                                       max_in_frames, session_revision);
        g.lock();
        if (session_revision != impl_->current_revision)
            return;
        it = impl_->prepared_map.find(key);
        if (it != impl_->prepared_map.end() && it->second && it->second->valid)
            return;
        auto set = std::move(br.set);

        // If sources weren't loaded for some audible clips, skip inserting
        // this set entirely so source_ready can retry cleanly without a
        // stale empty entry sitting in the cache. The user's jump will fall
        // through to prepare_target_now (also misses) → reactive rebuild.
        if (br.unloaded_clips_skipped > 0) {
            if (prearm_log_enabled()) {
                std::fprintf(stdout,
                    "[PREARM] skip_unloaded kind=%s song=%s id=%s frame=%lld unloaded_clips=%d\n",
                    target_kind_label(kind), song.id.c_str(),
                    target_id.c_str(), static_cast<long long>(target_frame),
                    br.unloaded_clips_skipped);
                std::fflush(stdout);
            }
            return;
        }

        if (!set->valid) {
            impl_->prepare_failed_total.fetch_add(1, std::memory_order_relaxed);
            if (prearm_log_enabled()) {
                std::fprintf(stdout,
                    "[PREARM] prepare_failed kind=%s song=%s id=%s frame=%lld\n",
                    target_kind_label(kind), song.id.c_str(),
                    target_id.c_str(), static_cast<long long>(target_frame));
                std::fflush(stdout);
            }
        } else {
            impl_->prepared_total.fetch_add(1, std::memory_order_relaxed);
            if (prearm_log_enabled()) {
                std::fprintf(stdout,
                    "[PREARM] prepared kind=%s song=%s id=%s frame=%lld voices=%zu\n",
                    target_kind_label(kind), song.id.c_str(),
                    target_id.c_str(), static_cast<long long>(target_frame),
                    set->tracks.size());
                std::fflush(stdout);
            }
        }

        impl_->prepared_map[key] = std::move(set);
        impl_->insertion_order.push_back(key);

        // Phase 7: enforce cap. Evict oldest until we're at or below the cap.
        while (static_cast<int>(impl_->prepared_map.size())
                > impl_->max_prepared_targets) {
            const std::size_t before = impl_->prepared_map.size();
            impl_->evict_one_oldest_locked();
            if (impl_->prepared_map.size() == before) break; // safety
            if (prearm_log_enabled()) {
                std::fprintf(stdout,
                    "[PREARM] evicted_oldest (over cap=%d, now=%zu)\n",
                    impl_->max_prepared_targets, impl_->prepared_map.size());
                std::fflush(stdout);
            }
        }
    };

    for (const auto& song : session.songs) {
        // Markers
        for (const auto& marker : song.markers)
            build_one(PrearmTargetKind::Marker, song, marker.id, marker.frame);

        // Region starts
        for (const auto& region : song.regions)
            build_one(PrearmTargetKind::RegionStart, song, region.id, region.start_frame);

        // Song start
        build_one(PrearmTargetKind::SongStart, song, song.id, song.start_frame);
    }

    // Evict prepared sets whose target no longer exists (defensive — most
    // structural edits also bump session_revision, which already cleared).
    for (auto it = impl_->prepared_map.begin(); it != impl_->prepared_map.end(); ) {
        if (kept.find(it->first) == kept.end()) {
            impl_->stale_discard_total.fetch_add(1, std::memory_order_relaxed);
            // Remove from insertion_order too. O(N) where N ≤ max cap.
            const auto dit = std::find(impl_->insertion_order.begin(),
                                        impl_->insertion_order.end(),
                                        it->first);
            if (dit != impl_->insertion_order.end())
                impl_->insertion_order.erase(dit);
            it = impl_->prepared_map.erase(it);
        } else {
            ++it;
        }
    }
}

std::unique_ptr<PreparedJumpVoiceSet>
PrearmedJumpManager::prepare_target_now(const Session& session,
                                          const SourceManager& sources,
                                          PrearmTargetKind kind,
                                          const Id& song_id,
                                          const Id& target_id,
                                          Frame target_frame,
                                          std::uint64_t session_revision) {
    if (!impl_ || !impl_->prepared) return nullptr;
    if (!prearm_globally_enabled()) return nullptr; // kill switch

    // Find the song in the session.
    const Song* song_ptr = nullptr;
    for (const auto& s : session.songs) {
        if (s.id == song_id) { song_ptr = &s; break; }
    }
    if (!song_ptr) return nullptr;

    // Build the set without holding the manager mutex — voice priming is
    // ~13 ms and we don't want to block other threads' diagnostics reads.
    int sr, ch, bs;
    {
        std::lock_guard<std::mutex> g(impl_->mtx);
        sr = impl_->sample_rate;
        ch = impl_->channel_count;
        bs = impl_->max_in_frames;
    }
    auto br  = build_prepared_set(kind, *song_ptr, target_id, target_frame,
                                   sources, sr, ch, bs, session_revision);
    auto set = std::move(br.set);

    // Update diagnostics; do NOT insert into prepared_map (caller consumes it).
    if (!set->valid) {
        impl_->prepare_failed_total.fetch_add(1, std::memory_order_relaxed);
        if (prearm_log_enabled()) {
            std::fprintf(stdout,
                "[PREARM] prepare_target_now_failed kind=%s song=%s id=%s frame=%lld\n",
                target_kind_label(kind), song_id.c_str(),
                target_id.c_str(), static_cast<long long>(target_frame));
            std::fflush(stdout);
        }
        return nullptr;
    }
    impl_->prepared_total.fetch_add(1, std::memory_order_relaxed);
    if (prearm_log_enabled()) {
        std::fprintf(stdout,
            "[PREARM] prepare_target_now_ok kind=%s song=%s id=%s frame=%lld voices=%zu\n",
            target_kind_label(kind), song_id.c_str(),
            target_id.c_str(), static_cast<long long>(target_frame),
            set->tracks.size());
        std::fflush(stdout);
    }
    return set;
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
    // Remove from insertion_order too so eviction tracking stays consistent.
    const auto dit = std::find(impl_->insertion_order.begin(),
                                impl_->insertion_order.end(), key);
    if (dit != impl_->insertion_order.end())
        impl_->insertion_order.erase(dit);
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
    d.eviction_total       = impl_->eviction_total.load(std::memory_order_relaxed);
    d.max_prepared_targets = impl_->max_prepared_targets;
    return d;
}

void PrearmedJumpManager::set_max_prepared_targets(int max_targets) noexcept {
    if (!impl_ || max_targets <= 0) return;
    std::lock_guard<std::mutex> g(impl_->mtx);
    impl_->max_prepared_targets = max_targets;
    // Evict down to the new cap immediately.
    while (static_cast<int>(impl_->prepared_map.size()) > max_targets) {
        const std::size_t before = impl_->prepared_map.size();
        impl_->evict_one_oldest_locked();
        if (impl_->prepared_map.size() == before) break;
    }
}

int PrearmedJumpManager::max_prepared_targets() const noexcept {
    if (!impl_) return 0;
    std::lock_guard<std::mutex> g(impl_->mtx);
    return impl_->max_prepared_targets;
}

// ─── Phase 2: background worker ──────────────────────────────────────────

void PrearmedJumpManager::prepare_all_targets_async(
        std::shared_ptr<const Session> session,
        const SourceManager* sources,
        std::uint64_t session_revision) {
    if (!impl_ || !session || !sources) return;
    if (!prearm_globally_enabled()) return; // kill switch

    // Lazy-start worker thread on first async call.
    if (!impl_->worker_started.exchange(true)) {
        impl_->worker_thread = std::thread([this] {
#ifdef _WIN32
            // Lower priority below normal so prearm priming (Bungee FFT, ~100ms
            // per voice) does NOT compete with the audio thread for CPU. Was
            // causing audible glitches + playhead/audio desync on real
            // sessions where the worker grinds through several targets in the
            // background while the user is seeking/transposing.
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#endif
            for (;;) {
                std::optional<Impl::PendingJob> job;
                {
                    std::unique_lock<std::mutex> lk(impl_->worker_mtx);
                    impl_->worker_cv.wait(lk, [this] {
                        return impl_->worker_should_exit.load()
                            || impl_->pending_job.has_value();
                    });
                    if (impl_->worker_should_exit.load()) return;
                    job = std::move(impl_->pending_job);
                    impl_->pending_job.reset();
                }
                if (!job) continue;
                // Pre-check: revision still current? If a newer revision was
                // posted while we were waiting, we'd still run this one (job
                // got swapped in worker_mtx). But if user clears via the
                // sync path, current_revision moved. Run anyway; the sync
                // clear will discard our results on next revision bump.
                if (prearm_log_enabled()) {
                    std::fprintf(stdout,
                        "[PREARM] worker_start revision=%llu\n",
                        static_cast<unsigned long long>(job->revision));
                    std::fflush(stdout);
                }
                prepare_all_targets(*job->session, *job->sources, job->revision);
                if (prearm_log_enabled()) {
                    std::fprintf(stdout,
                        "[PREARM] worker_done revision=%llu\n",
                        static_cast<unsigned long long>(job->revision));
                    std::fflush(stdout);
                }
            }
        });
    }

    // Post / replace pending job. Single-slot: if a newer post arrives
    // before the worker picks up an older one, the older one is dropped.
    // This is correct because each job rebuilds EVERYTHING for its revision.
    {
        std::lock_guard<std::mutex> lk(impl_->worker_mtx);
        impl_->pending_job = Impl::PendingJob{
            std::move(session), sources, session_revision};
    }
    impl_->worker_cv.notify_one();
}

} // namespace lt
