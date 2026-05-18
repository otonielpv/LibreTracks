#pragma once

#include <lt_engine/pitch/realtime_pitch_stream.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace lt {

struct PitchStreamKey {
    Id source_id;
    Id track_id;
    Id clip_id;
    double semitones = 0.0;
    int sample_rate = 0;
    int channel_count = 0;
    Frame source_start_frame = 0;
    std::uint64_t options_version = 1;

    bool operator==(const PitchStreamKey& o) const noexcept {
        return source_id == o.source_id && track_id == o.track_id && clip_id == o.clip_id
            && semitones == o.semitones && sample_rate == o.sample_rate
            && channel_count == o.channel_count && source_start_frame == o.source_start_frame
            && options_version == o.options_version;
    }
};

// Number of consecutive mismatch blocks before requesting repair.
// Must be large enough to absorb normal underflow gaps without triggering false repairs,
// but small enough to catch genuine sustained desync.
static constexpr int kPitchMismatchRepairThreshold = 64;

struct PitchRepairRequest {
    Frame target_frame = -1;
    bool pending = false;
};

class RealtimePitchEngine {
public:
    RealtimePitchEngine();
    ~RealtimePitchEngine();

    void prepare_for_session(const Session& session, const SourceManager& sources, int sample_rate);
    void prepare_for_play(Frame playhead_frame, const Session& session, const SourceManager& sources);
    void set_max_block_size_hint(int max_block_size) noexcept { max_block_size_hint_ = std::max(1, max_block_size); }
    void prepare_for_transport_discontinuity(Frame target_frame,
                                             const std::string& reason,
                                             const Session& session,
                                             const SourceManager& sources);

    // Called periodically from the control thread while playing.
    // Adds streams for clips entering the lookahead window without disturbing existing streams.
    // Returns the number of new streams added (0 = already up to date).
    int extend_for_playhead(Frame playhead_frame,
                            const Session& session,
                            const SourceManager& sources);

    // Pre-build a pitch graph at jump_target_frame so it's ready before the jump fires.
    // Call from the control thread immediately after scheduling a jump.
    // When the jump fires, call publish_pending_jump_graph() to atomically swap it in.
    void pre_prepare_for_scheduled_jump(Frame jump_target_frame,
                                        const Session& session,
                                        const SourceManager& sources);

    // Called from control thread when a scheduled jump fires (via service_pending_scheduled_jump_pitch).
    // Publishes the pre-built graph if it matches jump_target_frame; otherwise rebuilds.
    void publish_pending_jump_graph(Frame jump_target_frame,
                                    const Session& session,
                                    const SourceManager& sources);

    // Called from control thread (not audio callback) to repair mismatched streams.
    void prepare_for_pitch_repair(Frame target_frame, const Session& session, const SourceManager& sources);

    // Returns true if a repair was pending and clears the flag. Call from control thread.
    bool take_repair_request(Frame& out_target_frame) noexcept;

    int render_pitched_clip(const Clip& clip,
                            const Id& track_id,
                            const DecodedSource& source,
                            Frame source_frame,
                            Frame timeline_frame,
                            int frame_count,
                            double semitones,
                            float** out,
                            int out_channels) noexcept;
    PitchStreamDiagnostics diagnostics() const noexcept;
    void reset_diagnostics() noexcept;

private:
    struct ActivePitchStreamHandle {
        PitchStreamKey key;
        std::shared_ptr<RealtimePitchStream> stream;
    };
    struct ActivePitchStreamSet {
        std::vector<ActivePitchStreamHandle> streams;
        int   min_ready_frames = 0;
        Frame target_frame     = 0;
        Frame build_lookahead  = 0;
    };

    void publish_stream_set(std::shared_ptr<ActivePitchStreamSet> set);
    void prepare_window(Frame target_frame, const Session& session, const SourceManager& sources,
                        bool reset_streams, int max_block_size = 512);
    std::shared_ptr<ActivePitchStreamSet> build_stream_set_for_target(Frame target_frame,
                                                                      const Session& session,
                                                                      const SourceManager& sources,
                                                                      bool prime_target_streams,
                                                                      int max_block_size = 512,
                                                                      Frame lookahead_override = 0);

    int sample_rate_ = 48000;
    int max_block_size_hint_ = 512;
    std::mutex control_mutex_;
    std::shared_ptr<const ActivePitchStreamSet> active_;
    SourceReadAheadCache source_cache_;
    std::atomic<std::uint64_t> active_stream_set_generation_{0};
    std::atomic<std::uint64_t> active_stream_swap_count_{0};
    std::atomic<std::uint64_t> long_seek_count_{0};
    std::atomic<Frame> last_transport_discontinuity_target_frame_{0};
    std::atomic<std::uint64_t> render_count_{0};
    std::atomic<std::uint64_t> missing_stream_count_{0};
    std::atomic<std::uint64_t> stream_not_ready_count_{0};
    std::atomic<std::uint64_t> emergency_silence_count_{0};
    std::atomic<std::uint64_t> unsafe_cross_thread_reset_count_{0};
    std::atomic<std::uint64_t> concurrent_stream_mutation_detected_{0};
    std::atomic<std::uint64_t> pitch_timeline_mismatch_count_{0};
    std::atomic<std::uint64_t> pitch_stream_not_aligned_count_{0};
    std::atomic<std::uint64_t> pitch_audio_thread_reset_count_{0};
    std::atomic<std::uint64_t> pitch_audio_thread_prime_count_{0};
    std::atomic<std::uint64_t> pitch_repair_requested_count_{0};
    std::atomic<std::uint64_t> pitch_repair_completed_count_{0};
    std::string last_reason_;

    // Repair request set from audio thread, consumed from control thread.
    // Uses relaxed atomics; worst case is one extra or missed repair cycle — acceptable.
    std::atomic<bool>  repair_pending_{false};
    std::atomic<Frame> repair_target_frame_{-1};

    // After a seek/discontinuity, suppress repair requests for this many render blocks.
    // The stream self-heals via reset_for_seek() in render() — repair is only for sustained
    // production mismatches, not normal post-seek frame transitions.
    static constexpr int kPostSeekRepairSuppressionBlocks = 64;
    std::atomic<int> post_seek_repair_suppression_remaining_{0};

    // Per-stream soft mismatch counter (indexed by stream slot, bounded by active set size).
    // Written only from audio thread; used to throttle repair requests.
    static constexpr int kMaxStreamSlots = 64;
    std::atomic<int> stream_mismatch_counts_[kMaxStreamSlots];

    // Debounce for transpose/region changes: skip expensive rebuild if called again
    // within this window for non-seek reasons. Seeks always go through immediately.
    static constexpr int kDebounceMs = 80;
    std::chrono::steady_clock::time_point last_discontinuity_time_{};
    std::string last_discontinuity_reason_{};

    // Pre-built graph for the next scheduled jump. Only accessed from the control thread.
    // Set by pre_prepare_for_scheduled_jump(); consumed by publish_pending_jump_graph().
    std::shared_ptr<ActivePitchStreamSet> pending_jump_graph_;
    Frame pending_jump_target_frame_ = -1;

    // Rolling extend: last playhead position at which extend_for_playhead extended the set.
    // Compared against the current playhead to decide if a new extension is needed.
    // Only accessed from the control thread.
    Frame last_extend_playhead_ = -1;
};

} // namespace lt
