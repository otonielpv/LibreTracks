#include <lt_engine/scheduler/jump_scheduler.h>
#include <algorithm>
#include <mutex>
#include <queue>
#include <vector>

namespace lt {

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
            for (const auto& song : session.songs)
                for (const auto& m : song.markers)
                    if (m.id == *target.id)
                        return Result<Frame>::ok(m.frame);
            return Result<Frame>::err("Marker not found: " + *target.id);
        }

        case Kind::Region: {
            if (!target.id)
                return Result<Frame>::err("JumpTarget::Region has no id");
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
        std::visit([this](auto&& o) {
            using T = std::decay_t<decltype(o)>;
            if constexpr (std::is_same_v<T, OpSchedule>) {
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

std::optional<Frame> JumpScheduler::check_due(const TransportClock& clock,
                                               const Session& session) {
    impl_->due_index.reset();
    Frame cur = clock.position().frame;

    for (std::size_t i = 0; i < impl_->jumps.size(); ++i) {
        auto& j = impl_->jumps[i];
        if (j.status != JumpStatus::Pending && j.status != JumpStatus::Armed)
            continue;

        bool fire = false;
        switch (j.trigger) {
            case JumpTrigger::Immediate:
                fire = (j.status == JumpStatus::Armed);
                break;
            case JumpTrigger::AtSongEnd:
                // Check if the current song ends within this block.
                for (const auto& song : session.songs) {
                    if (cur < song.end_frame && cur + 512 >= song.end_frame) {
                        fire = true; break;
                    }
                }
                break;
            case JumpTrigger::AtRegionEnd:
                for (const auto& song : session.songs)
                    for (const auto& region : song.regions)
                        if (cur < region.end_frame && cur + 512 >= region.end_frame) {
                            fire = true; break;
                        }
                break;
            case JumpTrigger::AtFrame:
                if (j.target.frame && cur >= *j.target.frame)
                    fire = true;
                break;
        }

        if (fire) {
            auto resolved = resolve_jump_target(j.target, session, clock);
            if (resolved.is_ok()) {
                impl_->due_index = i;
                j.status = JumpStatus::Armed;
                return resolved.unwrap();
            }
            j.status         = JumpStatus::Failed;
            j.failure_reason = resolved.error();
        }
    }
    return std::nullopt;
}

void JumpScheduler::mark_executed(Frame from_frame, Frame to_frame) {
    if (!impl_->due_index) return;
    auto& j        = impl_->jumps[*impl_->due_index];
    j.status        = JumpStatus::Executed;
    j.executed_frame = to_frame;
    impl_->due_index.reset();

    if (impl_->on_executed)
        impl_->on_executed(j, from_frame, to_frame);
}

std::vector<ScheduledJump> JumpScheduler::jump_list() const {
    // Audio thread may be writing, but snapshot reads are non-blocking best-effort.
    return impl_->jumps;
}

void JumpScheduler::set_jump_executed_callback(JumpExecutedCallback cb) {
    impl_->on_executed = std::move(cb);
}

} // namespace lt
