#pragma once

// ---------------------------------------------------------------------------
// JumpScheduler — manages pending and armed jumps.
//
// Concurrency model:
//   - schedule/cancel/replace: called from the COMMAND thread.
//   - check_due / execute_due:  called from the AUDIO thread.
//
// Lock-free design: the command thread appends to a SPSC queue; the audio
// thread drains it at the start of each block.  No mutex in the hot path.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/core/commands.h>
#include <lt_engine/core/events.h>
#include <lt_engine/core/result.h>
#include <lt_engine/pitch/prepared_voice_map.h>
#include <lt_engine/pitch/warp_voice.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/session/session.h>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Jump status lifecycle:
//   Pending → Armed (trigger condition met) → Executed
//                                           ↘ Failed
//          ↘ Cancelled (explicit cancel)
// ---------------------------------------------------------------------------
enum class JumpStatus { Pending, Armed, Cancelled, Executed, Failed };

// Map type for prepared warp voices carried alongside the pitched ones in
// a scheduled jump. Same shape as WarpVoiceManager::VoiceMap.
using PreparedWarpVoiceMap = std::unordered_map<Id, std::shared_ptr<WarpVoice>>;

struct ScheduledJump {
    Id          jump_id;
    JumpTarget  target;
    JumpTrigger trigger;
    JumpStatus  status          = JumpStatus::Pending;

    Frame       created_frame   = 0;
    Frame       executed_frame  = 0;
    Frame       cancelled_frame = 0;
    std::optional<Frame> trigger_frame;
    std::shared_ptr<const PreparedVoiceMap>     prepared_voice_map;
    // Optional. When non-null, the audio thread also swaps in this warp
    // voice map at jump time so warp/cascade clips don't reuse the
    // pre-jump stretcher state (which causes a metallic burst on Bungee
    // warp because the analysis window needs ~4864 frames to settle).
    std::shared_ptr<const PreparedWarpVoiceMap> prepared_warp_voice_map;
    bool suppress_seek_fade = false;
    std::string failure_reason;
};

struct DueJump {
    Frame target_frame = 0;
    Frame trigger_frame = 0;
    std::shared_ptr<const PreparedVoiceMap>     prepared_voice_map;
    std::shared_ptr<const PreparedWarpVoiceMap> prepared_warp_voice_map;
    bool suppress_seek_fade = false;
};

// Callback fired by audio thread when a jump executes.
// Must be realtime-safe (no alloc, no lock, no I/O).
using JumpExecutedCallback = std::function<void(const ScheduledJump&, Frame /*from*/, Frame /*to*/)>;

class JumpScheduler {
public:
    JumpScheduler();
    ~JumpScheduler();

    // ── Command thread ────────────────────────────────────────────────────

    // Immediate jump: resolves a JumpTarget to a frame and posts it to the
    // audio thread.  Returns the resolved target frame or error.
    Result<Frame> schedule_immediate(const Id& jump_id,
                                     const JumpTarget& target,
                                     const Session& session,
                                     const TransportClock& clock);

    Result<void>  schedule(const ScheduledJump& jump);
    Result<void>  cancel(const Id& jump_id);
    void          cancel_all();
    Result<void>  replace(const Id& jump_id,
                          const JumpTarget& new_target,
                          JumpTrigger new_trigger);

    // ── Audio thread ──────────────────────────────────────────────────────

    // Drain pending command-thread operations into the live jump list.
    // Call at the top of each audio callback block.
    void drain_pending();

    // Check whether any armed jump should fire this block.
    // Returns the target frame and the exact trigger frame, else nullopt.
    std::optional<DueJump> check_due(const TransportClock& clock,
                                     const Session& session,
                                     int block_frames = 512);

    // Mark the last due jump as executed.
    void mark_executed(Frame from_frame, Frame to_frame);

    // Read-only copy of the current jump list for snapshot.
    std::vector<ScheduledJump> jump_list() const;

    void set_jump_executed_callback(JumpExecutedCallback cb);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Resolve a JumpTarget to an absolute frame given the current session and clock.
Result<Frame> resolve_jump_target(const JumpTarget& target,
                                   const Session& session,
                                   const TransportClock& clock);

} // namespace lt
