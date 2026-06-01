#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <queue>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

namespace lt {

namespace {

bool jump_debug_enabled() {
    static const bool on = [] {
        const char* raw = std::getenv("LIBRETRACKS_JUMP_DEBUG");
        if (!raw) raw = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        if (!raw) return false;
        std::string value = raw;
        std::transform(value.begin(), value.end(), value.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return value == "1" || value == "true" || value == "yes" || value == "on";
    }();
    return on;
}

const char* trigger_name(JumpTrigger trigger) noexcept {
    switch (trigger) {
        case JumpTrigger::Immediate: return "Immediate";
        case JumpTrigger::AtRegionEnd: return "AtRegionEnd";
        case JumpTrigger::AtSongEnd: return "AtSongEnd";
        case JumpTrigger::AtFrame: return "AtFrame";
    }
    return "Unknown";
}

void jump_debug_log(const char* fmt, ...) {
    if (!jump_debug_enabled()) return;
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

} // namespace

// ---------------------------------------------------------------------------
// resolve_jump_target — pure function, callable from both threads (read-only)
// ---------------------------------------------------------------------------
Result<Frame> resolve_jump_target(const JumpTarget& target,
                                   const Session& session,
                                   const TransportClock& clock) {
    using Kind = JumpTarget::Kind;
    switch (target.kind) {
        case Kind::Frame:
            if (!target.frame)
                return Result<Frame>::err("JumpTarget::Frame has no frame value");
            return Result<Frame>::ok(*target.frame);

        case Kind::Marker: {
            if (!target.id)
                return Result<Frame>::err("JumpTarget::Marker has no id");
            if (target.frame)
                return Result<Frame>::ok(*target.frame);
            for (const auto& song : session.songs)
                for (const auto& m : song.markers)
                    if (m.id == *target.id)
                        return Result<Frame>::ok(m.frame);
            return Result<Frame>::err("Marker not found: " + *target.id);
        }

        case Kind::Region: {
            if (!target.id)
                return Result<Frame>::err("JumpTarget::Region has no id");
            if (target.frame)
                return Result<Frame>::ok(*target.frame);
            for (const auto& song : session.songs)
                for (const auto& r : song.regions)
                    if (r.id == *target.id)
                        return Result<Frame>::ok(r.start_frame);
            return Result<Frame>::err("Region not found: " + *target.id);
        }

        case Kind::Song: {
            if (!target.id)
                return Result<Frame>::err("JumpTarget::Song has no id");
            for (const auto& s : session.songs)
                if (s.id == *target.id)
                    return Result<Frame>::ok(s.start_frame);
            return Result<Frame>::err("Song not found: " + *target.id);
        }

        case Kind::NextSong: {
            Frame cur = clock.position().frame;
            for (std::size_t i = 0; i < session.songs.size(); ++i) {
                if (session.songs[i].end_frame > cur) {
                    // We're inside this song — next is i+1.
                    if (i + 1 < session.songs.size())
                        return Result<Frame>::ok(session.songs[i + 1].start_frame);
                    return Result<Frame>::err("No next song");
                }
            }
            return Result<Frame>::err("Could not find current song for NextSong");
        }

        case Kind::PreviousSong: {
            Frame cur = clock.position().frame;
            for (std::size_t i = 0; i < session.songs.size(); ++i) {
                if (session.songs[i].end_frame > cur) {
                    if (i > 0)
                        return Result<Frame>::ok(session.songs[i - 1].start_frame);
                    return Result<Frame>::ok(session.songs[0].start_frame);
                }
            }
            return Result<Frame>::err("Could not find current song for PreviousSong");
        }
    }
    return Result<Frame>::err("Unhandled JumpTarget kind");
}

// ---------------------------------------------------------------------------
// Pending operation types (command thread → audio thread queue)
// ---------------------------------------------------------------------------
struct OpSchedule  { ScheduledJump jump; };
struct OpCancel    { Id jump_id; };
struct OpCancelAll {};
struct OpReplace   { Id jump_id; JumpTarget new_target; JumpTrigger new_trigger; };

using PendingOp = std::variant<OpSchedule, OpCancel, OpCancelAll, OpReplace>;

// ---------------------------------------------------------------------------
// JumpScheduler::Impl
// ---------------------------------------------------------------------------
struct JumpScheduler::Impl {
    // Command thread writes here; audio thread drains.
    std::mutex              pending_mutex;
    std::queue<PendingOp>   pending_ops;

    // Audio thread owns this vector.
    mutable std::mutex live_mutex;
    std::vector<ScheduledJump> jumps;

    // The jump that check_due() identified as due, waiting for mark_executed().
    std::optional<std::size_t> due_index;

    JumpExecutedCallback on_executed;
};

// ---------------------------------------------------------------------------
JumpScheduler::JumpScheduler() : impl_(std::make_unique<Impl>()) {}
JumpScheduler::~JumpScheduler() = default;

// ── Command thread ──────────────────────────────────────────────────────────

Result<Frame> JumpScheduler::schedule_immediate(const Id& jump_id,
                                                 const JumpTarget& target,
                                                 const Session& session,
                                                 const TransportClock& clock) {
    auto frame_result = resolve_jump_target(target, session, clock);
    if (frame_result.is_err())
        return frame_result;

    ScheduledJump j;
    j.jump_id       = jump_id;
    j.target        = target;
    j.trigger       = JumpTrigger::Immediate;
    j.status        = JumpStatus::Armed;   // immediate = armed immediately
    j.created_frame = clock.position().frame;

    std::lock_guard lock(impl_->pending_mutex);
    impl_->pending_ops.push(OpSchedule{j});
    return frame_result;
}

Result<void> JumpScheduler::schedule(const ScheduledJump& jump) {
    jump_debug_log(
        "[LT_JUMP_DEBUG][scheduler] enqueue jump_id=%s trigger=%s created_frame=%lld trigger_frame=%lld prepared=%d suppress_seek_fade=%d\n",
        jump.jump_id.c_str(),
        trigger_name(jump.trigger),
        static_cast<long long>(jump.created_frame),
        static_cast<long long>(jump.trigger_frame.value_or(-1)),
        jump.prepared_voice_map ? 1 : 0,
        jump.suppress_seek_fade ? 1 : 0);
    std::lock_guard lock(impl_->pending_mutex);
    impl_->pending_ops.push(OpSchedule{jump});
    return Result<void>::ok();
}

Result<void> JumpScheduler::cancel(const Id& jump_id) {
    std::lock_guard lock(impl_->pending_mutex);
    impl_->pending_ops.push(OpCancel{jump_id});
    return Result<void>::ok();
}

void JumpScheduler::cancel_all() {
    std::lock_guard lock(impl_->pending_mutex);
    impl_->pending_ops.push(OpCancelAll{});
}

Result<void> JumpScheduler::replace(const Id& jump_id,
                                     const JumpTarget& new_target,
                                     JumpTrigger new_trigger) {
    std::lock_guard lock(impl_->pending_mutex);
    impl_->pending_ops.push(OpReplace{jump_id, new_target, new_trigger});
    return Result<void>::ok();
}

// ── Audio thread ────────────────────────────────────────────────────────────

void JumpScheduler::drain_pending() {
    std::queue<PendingOp> local;
    {
        std::lock_guard lock(impl_->pending_mutex);
        std::swap(local, impl_->pending_ops);
    }

    while (!local.empty()) {
        auto& op = local.front();
        std::lock_guard live_lock(impl_->live_mutex);
        std::visit([this](auto&& o) {
            using T = std::decay_t<decltype(o)>;
            if constexpr (std::is_same_v<T, OpSchedule>) {
                jump_debug_log(
                    "[LT_JUMP_DEBUG][scheduler] drain_schedule jump_id=%s trigger=%s status=%d trigger_frame=%lld prepared=%d suppress_seek_fade=%d live_before=%zu\n",
                    o.jump.jump_id.c_str(),
                    trigger_name(o.jump.trigger),
                    static_cast<int>(o.jump.status),
                    static_cast<long long>(o.jump.trigger_frame.value_or(-1)),
                    o.jump.prepared_voice_map ? 1 : 0,
                    o.jump.suppress_seek_fade ? 1 : 0,
                    impl_->jumps.size());
                if (o.jump.trigger == JumpTrigger::Immediate) {
                    impl_->jumps.erase(
                        std::remove_if(impl_->jumps.begin(), impl_->jumps.end(),
                            [](const ScheduledJump& j) {
                                return j.trigger == JumpTrigger::Immediate &&
                                    (j.status == JumpStatus::Pending || j.status == JumpStatus::Armed);
                            }),
                        impl_->jumps.end());
                }
                impl_->jumps.push_back(o.jump);
            }
            else if constexpr (std::is_same_v<T, OpCancel>) {
                for (auto& j : impl_->jumps) {
                    if (j.jump_id == o.jump_id && j.status == JumpStatus::Pending) {
                        j.status = JumpStatus::Cancelled;
                    }
                }
            }
            else if constexpr (std::is_same_v<T, OpCancelAll>) {
                for (auto& j : impl_->jumps) {
                    if (j.status == JumpStatus::Pending ||
                        j.status == JumpStatus::Armed) {
                        j.status = JumpStatus::Cancelled;
                    }
                }
            }
            else if constexpr (std::is_same_v<T, OpReplace>) {
                for (auto& j : impl_->jumps) {
                    if (j.jump_id == o.jump_id &&
                        (j.status == JumpStatus::Pending || j.status == JumpStatus::Armed)) {
                        j.target  = o.new_target;
                        j.trigger = o.new_trigger;
                        j.status  = JumpStatus::Pending;
                    }
                }
            }
        }, op);
        local.pop();
    }
}

std::optional<DueJump> JumpScheduler::check_due(const TransportClock& clock,
                                                const Session& session,
                                                int block_frames) {
    std::lock_guard live_lock(impl_->live_mutex);
    impl_->due_index.reset();
    Frame cur = clock.position().frame;
    const Frame block_end = cur + std::max(0, block_frames);

    for (std::size_t i = 0; i < impl_->jumps.size(); ++i) {
        auto& j = impl_->jumps[i];
        if (j.status != JumpStatus::Pending && j.status != JumpStatus::Armed)
            continue;

        bool fire = false;
        Frame trigger_frame = cur;
        switch (j.trigger) {
            case JumpTrigger::Immediate:
                fire = (j.status == JumpStatus::Armed);
                trigger_frame = cur;
                break;
            case JumpTrigger::AtSongEnd:
                // Check if the current song ends within this block.
                for (const auto& song : session.songs) {
                    if (cur <= song.end_frame && block_end >= song.end_frame) {
                        fire = true;
                        trigger_frame = song.end_frame;
                        break;
                    }
                }
                break;
            case JumpTrigger::AtRegionEnd:
                for (const auto& song : session.songs) {
                    for (const auto& region : song.regions) {
                        if (cur <= region.end_frame && block_end >= region.end_frame) {
                            fire = true;
                            trigger_frame = region.end_frame;
                            break;
                        }
                    }
                    if (fire) break;
                }
                break;
            case JumpTrigger::AtFrame:
                if (j.trigger_frame && cur <= *j.trigger_frame && block_end >= *j.trigger_frame) {
                    fire = true;
                    trigger_frame = *j.trigger_frame;
                }
                break;
        }

        if (fire) {
            auto resolved = resolve_jump_target(j.target, session, clock);
            if (resolved.is_ok()) {
                const Frame target_frame = resolved.unwrap();
                impl_->due_index = i;
                j.status = JumpStatus::Armed;
                jump_debug_log(
                    "[LT_JUMP_DEBUG][scheduler] due jump_id=%s trigger=%s block_start=%lld block_end=%lld trigger_frame=%lld target_frame=%lld prepared=%d suppress_seek_fade=%d\n",
                    j.jump_id.c_str(),
                    trigger_name(j.trigger),
                    static_cast<long long>(cur),
                    static_cast<long long>(block_end),
                    static_cast<long long>(trigger_frame),
                    static_cast<long long>(target_frame),
                    j.prepared_voice_map ? 1 : 0,
                    j.suppress_seek_fade ? 1 : 0);
                return DueJump{target_frame, trigger_frame,
                               j.prepared_voice_map,
                               j.suppress_seek_fade};
            }
            j.status         = JumpStatus::Failed;
            j.failure_reason = resolved.error();
        }
    }
    return std::nullopt;
}

void JumpScheduler::mark_executed(Frame from_frame, Frame to_frame) {
    std::lock_guard live_lock(impl_->live_mutex);
    if (!impl_->due_index) return;
    auto& j        = impl_->jumps[*impl_->due_index];
    j.status        = JumpStatus::Executed;
    j.executed_frame = to_frame;
    impl_->due_index.reset();

    if (impl_->on_executed)
        impl_->on_executed(j, from_frame, to_frame);

    constexpr std::size_t kMaxJumpHistory = 32;
    std::size_t finished = 0;
    for (const auto& jump : impl_->jumps) {
        if (jump.status == JumpStatus::Executed ||
            jump.status == JumpStatus::Cancelled ||
            jump.status == JumpStatus::Failed) {
            ++finished;
        }
    }
    if (finished > kMaxJumpHistory) {
        std::size_t to_remove = finished - kMaxJumpHistory;
        impl_->jumps.erase(
            std::remove_if(impl_->jumps.begin(), impl_->jumps.end(),
                [&to_remove](const ScheduledJump& jump) {
                    if (to_remove == 0) return false;
                    if (jump.status == JumpStatus::Executed ||
                        jump.status == JumpStatus::Cancelled ||
                        jump.status == JumpStatus::Failed) {
                        --to_remove;
                        return true;
                    }
                    return false;
                }),
            impl_->jumps.end());
    }
}

std::vector<ScheduledJump> JumpScheduler::jump_list() const {
    std::lock_guard live_lock(impl_->live_mutex);
    return impl_->jumps;
}

void JumpScheduler::set_jump_executed_callback(JumpExecutedCallback cb) {
    impl_->on_executed = std::move(cb);
}

} // namespace lt
