#include <lt_engine/pitch/prearmed_jump_manager.h>

#include <lt_engine/debug/logging.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <cmath>
#include <limits>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  define NOMINMAX  // prevent windows.h min/max macros from clobbering std::min/max
#  include <windows.h>
#elif defined(__APPLE__)
#  include <pthread.h>
#  include <pthread/qos.h>
#elif defined(__linux__)
#  include <sys/resource.h>
#  include <sys/time.h>
#endif

namespace lt {

// ─── PreparedJumpVoiceSet helpers ────────────────────────────────────────

PreparedVoiceMap PreparedJumpVoiceSet::extract_voice_map() {
    PreparedVoiceMap out;
    out.reserve(tracks.size());
    for (auto& t : tracks)
        if (t.voice) out.emplace(t.clip_id, std::move(t.voice));
    return out;
}

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

int prearm_source_wait_ms() {
    static const int value = [] {
        const char* v = std::getenv("LIBRETRACKS_PREARM_SOURCE_WAIT_MS");
        if (!v) return 750;
        const int parsed = std::atoi(v);
        return parsed >= 0 && parsed <= 10000 ? parsed : 750;
    }();
    return value;
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
                        int max_in_frames,
                        double time_ratio = 1.0) {
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
                                  /*pitch_scale*/ 1.0,
                                  time_ratio);
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
                                      double pitch_scale,
                                      double time_ratio = 1.0) {
    if (!voice.is_ready()) return;
    const int latency_frames = static_cast<int>(voice.latency_frames());
    if (latency_frames <= 0) return; // nothing to prefeed; voice not warm
    const int compensation_frames = voice.alignment_compensation_frames(pitch_scale);

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
    Frame  read_cursor   = target_source_frame
        + static_cast<Frame>(compensation_frames); // absolute source frame to read next

    const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
    const bool warp_active = std::abs(safe_ratio - 1.0) > 1.0e-6;
    auto read_source = [&](int frames) {
        std::fill(read_l.begin(), read_l.begin() + frames, 0.0f);
        std::fill(read_r.begin(), read_r.begin() + frames, 0.0f);
        const int dst_offset = read_cursor < 0
            ? static_cast<int>(std::min<Frame>(frames, -read_cursor))
            : 0;
        const Frame read_start = std::max<Frame>(0, read_cursor);
        const int available = (dst_offset >= frames || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                frames - dst_offset, static_cast<long long>(src_end - read_start)));
        if (available > 0) {
            float* read_into[2] = {
                read_l.data() + dst_offset,
                read_r.data() + dst_offset};
            const int got = source.read(read_start, available, read_into,
                                         std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1) {
                std::copy_n(read_l.begin() + dst_offset, got,
                            read_r.begin() + dst_offset);
            }
        }
        read_cursor += frames;
    };

    if (warp_active) {
        // Ratio-aware prefeed: drain enough output to consume Bungee's input
        // latency in source-frame units. The ratio=1 path below can advance
        // input and output by the same amount, but warp must not skip source
        // frames while warming the post-jump stream.
        voice.clear_queued_output();
        const int max_output_per_call = std::max(1, std::min(
            max_in_frames,
            static_cast<int>(std::floor(
                static_cast<double>(max_in_frames) / safe_ratio))));
        int consumed_input = 0;
        while (consumed_input < latency_frames) {
            const int remaining = latency_frames - consumed_input;
            int output_frames = static_cast<int>(std::floor(
                static_cast<double>(remaining) / safe_ratio));
            if (output_frames <= 0)
                break;
            output_frames = std::min(output_frames, max_output_per_call);
            const int input_frames = std::min(
                max_in_frames,
                std::max(1, static_cast<int>(std::ceil(
                    static_cast<double>(output_frames) * safe_ratio))));
            read_source(input_frames);
            (void)voice.render_block(in_ptrs.data(), input_frames,
                                      out_ptrs.data(), output_frames,
                                      pitch_scale,
                                      safe_ratio);
            consumed_input += input_frames;
        }
        voice.clear_queued_output();
        return;
    }

    int    fed           = 0;                   // count of real frames fed
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);

        // Pull `chunk` frames from the source starting at `read_cursor`. Anything
        // past src_end is zero-padded (matches track_renderer's pad-on-EOF).
        read_source(chunk);

        (void)voice.render_block(in_ptrs.data(), chunk,
                                  out_ptrs.data(), chunk,
                                  pitch_scale,
                                  time_ratio);
        fed         += chunk;
    }

    // Prepared jumps must not ask Bungee to synthesize the first audible
    // target block on the realtime thread. If the scheduled trigger lands near
    // the end of the callback, the post-jump span can be only 60-100 frames;
    // serving that from an already-queued Bungee block avoids the first-jump
    // roughness while preserving sample-exact transport.
    const int prime_target_frames = std::max(
        max_in_frames,
        std::min(max_in_frames * 4,
                 std::max(max_in_frames, sample_rate / 20)));
    int primed_total = voice.queued_output_frames();
    int prime_budget = prime_target_frames * 2;
    while (max_in_frames > 0
           && primed_total < prime_target_frames
           && prime_budget > 0) {
        const int prime_frames = std::min(max_in_frames, prime_budget);
        read_source(prime_frames);
        const int before = voice.queued_output_frames();
        (void)voice.prime_output_fifo(in_ptrs.data(), prime_frames,
                                      pitch_scale, time_ratio);
        primed_total = voice.queued_output_frames();
        prime_budget -= prime_frames;
        if (primed_total <= before)
            break;
    }
}

// Per-clip prep spec for a single prearmed target.
struct PrepSpec {
    Id                   clip_id;
    Id                   source_id;
    std::shared_ptr<const DecodedSource> source;
    Frame                target_source_frame = 0;
    Semitones            effective_semitones = 0;
    double               time_ratio = 1.0;
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
    const auto decision = resolve_pitch_render_decision(
        track, clip, song, target_timeline_frame);
    if (decision.path != ClipPathKind::Stretched)
        return out;

    auto src = sources.get_shared(clip.source_id);
    if (!src || !src->is_loaded()) {
        if (out_unloaded_clips) ++*out_unloaded_clips;
        return out;
    }

    PrepSpec spec;
    spec.clip_id              = clip.id;
    spec.source_id            = clip.source_id;
    spec.source               = std::move(src);
    const Frame timeline_offset =
        target_timeline_frame - clip.timeline_start_frame;
    spec.target_source_frame  = clip.source_start_frame
        + (decision.warp_active
            ? static_cast<Frame>(
                static_cast<double>(timeline_offset) * decision.warp_time_ratio)
            : timeline_offset);
    spec.effective_semitones  = decision.effective_semitones;
    spec.time_ratio           = decision.warp_active
        ? decision.warp_time_ratio
        : 1.0;
    out.push_back(spec);
    return out;
}

bool ensure_bungee_jump_read_window_ready(const SourceManager& sources,
                                          const PrepSpec& spec,
                                          int max_in_frames,
                                          int latency_frames,
                                          int compensation_frames) {
    if (!spec.source)
        return false;

    const Frame src_end = spec.source->duration_frames();
    if (src_end <= 0 || spec.target_source_frame >= src_end)
        return false;

    const Frame compensation_start =
        spec.target_source_frame + std::min<Frame>(0, compensation_frames);
    const Frame read_start =
        spec.target_source_frame
        + static_cast<Frame>(latency_frames)
        + static_cast<Frame>(compensation_frames);

    // The prepared FIFO covers the first output block, but the next audio
    // callback immediately feeds Bungee from read_start. Make that future
    // input window part of the readiness contract, otherwise a prepared jump
    // can still feed zeros on the first real post-jump Bungee process().
    const Frame required_start = std::min(compensation_start, read_start);
    const int prepared_read_ahead = std::max(
        std::max(1, max_in_frames) * 2,
        std::max(1, spec.source->sample_rate() / 2));
    const Frame required_end =
        read_start + static_cast<Frame>(prepared_read_ahead);

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
    const int wait_ms = prearm_source_wait_ms();
    if (lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG")) {
        lt_debug_log(
            "[LT_JUMP_DEBUG][prearm] wait_source_window clip=%s source=%s target_source_frame=%lld ready_start=%lld ready_frames=%d latency=%d compensation=%d max_in=%d wait_ms=%d\n",
            spec.clip_id.c_str(),
            spec.source_id.c_str(),
            static_cast<long long>(spec.target_source_frame),
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
        if (spec.source->is_range_ready(clamped_start, required_frames)) {
            if (lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG")) {
                const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - start).count();
                lt_debug_log(
                    "[LT_JUMP_DEBUG][prearm] source_window_ready clip=%s source=%s ready_start=%lld ready_frames=%d elapsed_ms=%lld\n",
                    spec.clip_id.c_str(),
                    spec.source_id.c_str(),
                    static_cast<long long>(clamped_start),
                    required_frames,
                    static_cast<long long>(elapsed));
            }
            return true;
        }
        request_source_range(sources, spec.source_id, clamped_start, required_frames);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG")) {
        lt_debug_log(
            "[LT_JUMP_DEBUG][prearm] source_window_timeout clip=%s source=%s ready_start=%lld ready_frames=%d wait_ms=%d\n",
            spec.clip_id.c_str(),
            spec.source_id.c_str(),
            static_cast<long long>(clamped_start),
            required_frames,
            wait_ms);
    }
    return spec.source->is_range_ready(clamped_start, required_frames);
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

    // Max prepared sets retained. Each prepared set owns Bungee streams, so the
    // cap is a real RAM budget rather than just a lookup-cache size.
    int max_prepared_targets = [] {
        if (const char* v = std::getenv("LIBRETRACKS_PREARM_MAX_TARGETS")) {
            const int n = std::atoi(v);
            if (n > 0 && n < 1024) return n;
        }
        return 16;
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
    std::atomic<bool>        worker_busy{false};
    std::atomic<std::uint64_t> latest_posted_revision{0};
    std::atomic<std::uint64_t> last_completed_revision{0};
    // Monotonic counters that bump on EVERY post / completion. Unlike the
    // revisions above (which may be re-posted with the same value after a
    // source becomes ready), these always increase, so callers can detect
    // "another job came in after the one I was waiting for" cleanly.
    std::atomic<std::uint64_t> posted_count{0};
    std::atomic<std::uint64_t> completed_count{0};
    std::atomic<std::uint64_t> active_target_total{0};
    std::atomic<std::uint64_t> active_target_completed{0};

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
        lt_debug_log("[PREARM] clear discarded=%zu\n", before);
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
    std::vector<PrepSpec> specs_to_prepare;
    for (const auto& track : song.tracks) {
        for (const auto& clip : track.clips) {
            auto specs = enumerate_prep_specs(song, track, clip, sources,
                                               target_frame,
                                               &br.unloaded_clips_skipped);
            specs_to_prepare.insert(specs_to_prepare.end(),
                                    specs.begin(), specs.end());
        }
    }
    if (br.unloaded_clips_skipped > 0) {
        return br;
    }

    for (const auto& spec : specs_to_prepare) {
        auto voice = std::make_shared<BungeePitchVoice>();
        if (!voice->configure(sample_rate, channel_count, max_in_frames)) {
            any_failed = true;
            continue;
        }
        warm_voice_silence(*voice, sample_rate, channel_count, max_in_frames,
                           spec.time_ratio);
        const double pitch_scale =
            semitones_to_pitch_scale(spec.effective_semitones);
        const int latency_frames =
            static_cast<int>(voice->latency_frames());
        const int compensation_frames =
            voice->alignment_compensation_frames(pitch_scale);
        if (!ensure_bungee_jump_read_window_ready(
                sources, spec, max_in_frames,
                latency_frames, compensation_frames)) {
            ++br.unloaded_clips_skipped;
            continue;
        }
        if (spec.source) {
            prefeed_voice_with_target_audio(
                *voice, *spec.source, spec.target_source_frame,
                sample_rate, channel_count, max_in_frames,
                pitch_scale, spec.time_ratio);
        }
        voice->reset_source_cursor(
            static_cast<long long>(spec.target_source_frame));
        // The voice has already been warmed and prefed up to the
        // target. A second per-voice fade here re-shapes the prepared
        // audio after the mixer has already applied the seek de-click
        // ramp, which shows up as roughness on transposed jumps.
        voice->arm_fade_in(0);
        PreparedTrackVoice ptv;
        ptv.clip_id             = spec.clip_id;
        ptv.voice               = std::move(voice);
        ptv.target_source_frame = spec.target_source_frame;
        ptv.ready               = true;
        set->tracks.push_back(std::move(ptv));
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
            lt_debug_log(
                "[PREARM] revision_changed new=%llu discarded=%zu\n",
                static_cast<unsigned long long>(session_revision), before);
        }
    }

    const int sample_rate = impl_->sample_rate;
    const int channel_count = impl_->channel_count;
    const int max_in_frames = impl_->max_in_frames;

    std::unordered_set<PrearmTargetKey, PrearmTargetKeyHash> kept;
    kept.reserve(32);
    std::uint64_t target_total = 0;
    for (const auto& song : session.songs) {
        target_total += static_cast<std::uint64_t>(song.markers.size());
        target_total += static_cast<std::uint64_t>(song.regions.size());
        target_total += 1;
    }
    impl_->active_target_total.store(target_total, std::memory_order_release);
    impl_->active_target_completed.store(0, std::memory_order_release);

    // build_one: prime voices targeting `target_frame` and insert into the
    // prepared_map. Skips if a valid set already exists for the same key.
    auto build_one = [&](PrearmTargetKind kind,
                          const Song& song,
                          const Id& target_id,
                          Frame target_frame) {
        auto build_for_target = [&]() {
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
                return;

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
                    lt_debug_log(
                        "[PREARM] skip_unloaded kind=%s song=%s id=%s frame=%lld unloaded_clips=%d\n",
                        target_kind_label(kind), song.id.c_str(),
                        target_id.c_str(), static_cast<long long>(target_frame),
                        br.unloaded_clips_skipped);
                }
                return;
            }

            if (!set->valid) {
                impl_->prepare_failed_total.fetch_add(1, std::memory_order_relaxed);
                if (prearm_log_enabled()) {
                    lt_debug_log(
                        "[PREARM] prepare_failed kind=%s song=%s id=%s frame=%lld\n",
                        target_kind_label(kind), song.id.c_str(),
                        target_id.c_str(), static_cast<long long>(target_frame));
                }
            } else {
                impl_->prepared_total.fetch_add(1, std::memory_order_relaxed);
                if (prearm_log_enabled()) {
                    lt_debug_log(
                        "[PREARM] prepared kind=%s song=%s id=%s frame=%lld voices=%zu\n",
                        target_kind_label(kind), song.id.c_str(),
                        target_id.c_str(), static_cast<long long>(target_frame),
                        set->tracks.size());
                }
            }

            if (set->valid && set->tracks.empty())
                return;

            impl_->prepared_map[key] = std::move(set);
            impl_->insertion_order.push_back(key);

            // Phase 7: enforce cap. Evict oldest until we're at or below the cap.
            while (static_cast<int>(impl_->prepared_map.size())
                    > impl_->max_prepared_targets) {
                const std::size_t before = impl_->prepared_map.size();
                impl_->evict_one_oldest_locked();
                if (impl_->prepared_map.size() == before) break;
                if (prearm_log_enabled()) {
                    lt_debug_log(
                        "[PREARM] evicted_oldest (over cap=%d, now=%zu)\n",
                        impl_->max_prepared_targets, impl_->prepared_map.size());
                }
            }
        };

        build_for_target();
        impl_->active_target_completed.fetch_add(1, std::memory_order_acq_rel);
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

    impl_->active_target_completed.store(target_total, std::memory_order_release);
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
    for (int attempt = 0; br.unloaded_clips_skipped > 0 && attempt < 10; ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        br = build_prepared_set(kind, *song_ptr, target_id, target_frame,
                                sources, sr, ch, bs, session_revision);
    }
    auto set = std::move(br.set);

    // Update diagnostics; do NOT insert into prepared_map (caller consumes it).
    if (!set->valid) {
        impl_->prepare_failed_total.fetch_add(1, std::memory_order_relaxed);
        if (prearm_log_enabled()) {
            lt_debug_log(
                "[PREARM] prepare_target_now_failed kind=%s song=%s id=%s frame=%lld\n",
                target_kind_label(kind), song_id.c_str(),
                target_id.c_str(), static_cast<long long>(target_frame));
        }
        return nullptr;
    }
    impl_->prepared_total.fetch_add(1, std::memory_order_relaxed);
    if (prearm_log_enabled()) {
        lt_debug_log(
            "[PREARM] prepare_target_now_ok kind=%s song=%s id=%s frame=%lld voices=%zu\n",
            target_kind_label(kind), song_id.c_str(),
            target_id.c_str(), static_cast<long long>(target_frame),
            set->tracks.size());
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
    d.worker_busy = impl_->worker_busy.load(std::memory_order_acquire);
    d.latest_posted_revision =
        impl_->latest_posted_revision.load(std::memory_order_acquire);
    d.last_completed_revision =
        impl_->last_completed_revision.load(std::memory_order_acquire);
    d.posted_count    = impl_->posted_count.load(std::memory_order_acquire);
    d.completed_count = impl_->completed_count.load(std::memory_order_acquire);
    d.active_target_total =
        impl_->active_target_total.load(std::memory_order_acquire);
    d.active_target_completed =
        impl_->active_target_completed.load(std::memory_order_acquire);
    {
        std::lock_guard<std::mutex> wlk(impl_->worker_mtx);
        if (impl_->pending_job.has_value())
            d.worker_busy = true;
    }
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
            // Lower priority so prearm priming (Bungee FFT, ~100ms per voice,
            // ~128 voices per session-revision after a transpose) does NOT
            // compete with the audio thread for CPU. Without this the audio
            // callback misses its deadline → 50-200ms underruns of silence
            // every few seconds for ~10s after a SetSongTranspose /
            // SetRegionTranspose, because the worker grinds through every
            // prearm target rebuilding voices at the new pitch.
#ifdef _WIN32
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#elif defined(__APPLE__) || defined(__linux__)
            // QOS_CLASS_BACKGROUND on macOS biases the scheduler toward
            // I/O / efficiency cores and ensures we never preempt the audio
            // thread. On Linux pthread_set_qos_class_self_np doesn't exist;
            // fall through to setpriority(PRIO_PROCESS, 0, 10) which is the
            // closest equivalent for an in-process nice bump.
  #ifdef __APPLE__
            pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0);
  #else
            setpriority(PRIO_PROCESS, 0, 10);
  #endif
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
                    lt_debug_log(
                        "[PREARM] worker_start revision=%llu\n",
                        static_cast<unsigned long long>(job->revision));
                }
                impl_->worker_busy.store(true, std::memory_order_release);
                prepare_all_targets(*job->session, *job->sources, job->revision);
                impl_->last_completed_revision.store(
                    job->revision, std::memory_order_release);
                impl_->completed_count.fetch_add(1, std::memory_order_acq_rel);
                impl_->worker_busy.store(false, std::memory_order_release);
                if (prearm_log_enabled()) {
                    lt_debug_log(
                        "[PREARM] worker_done revision=%llu\n",
                        static_cast<unsigned long long>(job->revision));
                }
            }
        });
    }

    // Post / replace pending job. Single-slot: if a newer post arrives
    // before the worker picks up an older one, the older one is dropped.
    // This is correct because each job rebuilds EVERYTHING for its revision.
    impl_->latest_posted_revision.store(session_revision,
                                        std::memory_order_release);
    impl_->posted_count.fetch_add(1, std::memory_order_acq_rel);
    {
        std::lock_guard<std::mutex> lk(impl_->worker_mtx);
        impl_->pending_job = Impl::PendingJob{
            std::move(session), sources, session_revision};
    }
    impl_->worker_cv.notify_one();
}

} // namespace lt
