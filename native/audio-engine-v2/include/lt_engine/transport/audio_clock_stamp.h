#pragma once

// ---------------------------------------------------------------------------
// AudioClockStamp — WHEN the transport was at a given frame
// (docs/plans/redundancy/02-reloj-de-audio.md).
//
// The audio thread publishes, at the top of every rendered block, the trio
// (steady_clock instant, transport frame at the start of the block, moving).
// Any other thread reads it without locks. A seqlock: the writer bumps the
// sequence to odd, stores the fields, bumps it to even; a reader retries while
// the sequence is odd or changed under it, so it never sees a mixed trio.
//
// Realtime rules for publish(): no allocation, no lock, no I/O, bounded (a
// handful of relaxed atomic stores and two fences). Every field is an atomic
// so the concurrent read is not a data race under the C++ memory model.
//
// One writer (the audio thread, or the fallback pump while it drives render)
// and any number of readers.
// ---------------------------------------------------------------------------

#include <atomic>
#include <cstdint>

namespace lt {

struct AudioClockStampData {
    // steady_clock::now() at the start of the block, in ns since its epoch.
    std::int64_t  steady_ns    = 0;
    // Hardware instant from the driver (CoreAudio hostTimeNs), 0 when the
    // backend does not provide one.
    std::uint64_t host_time_ns = 0;
    // Transport frame (timeline scale, the clock's rate) at the start of the
    // block, BEFORE the block advances it.
    std::int64_t  frame        = 0;
    std::int32_t  sample_rate  = 0;
    // Playing AND advancing (not held by the pending-start gate).
    bool          moving       = false;
    // Number of blocks published so far; 0 = never.
    std::uint64_t blocks       = 0;
};

class AudioClockStamp {
public:
    void publish(std::int64_t steady_ns, std::uint64_t host_time_ns,
                 std::int64_t frame, std::int32_t sample_rate, bool moving) noexcept {
        const std::uint64_t seq = seq_.load(std::memory_order_relaxed);
        seq_.store(seq + 1, std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_release);
        steady_ns_.store(steady_ns, std::memory_order_relaxed);
        host_time_ns_.store(host_time_ns, std::memory_order_relaxed);
        frame_.store(frame, std::memory_order_relaxed);
        sample_rate_.store(sample_rate, std::memory_order_relaxed);
        moving_.store(moving, std::memory_order_relaxed);
        blocks_.store(blocks_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_release);
        seq_.store(seq + 2, std::memory_order_relaxed);
    }

    // Consistent copy of the last published block. Returns false only if the
    // writer kept it busy for every attempt (it publishes once per block, so
    // in practice the first or second attempt wins).
    bool read(AudioClockStampData& out) const noexcept {
        for (int attempt = 0; attempt < 64; ++attempt) {
            const std::uint64_t before = seq_.load(std::memory_order_acquire);
            if (before & 1u)
                continue;
            AudioClockStampData copy;
            copy.steady_ns    = steady_ns_.load(std::memory_order_relaxed);
            copy.host_time_ns = host_time_ns_.load(std::memory_order_relaxed);
            copy.frame        = frame_.load(std::memory_order_relaxed);
            copy.sample_rate  = sample_rate_.load(std::memory_order_relaxed);
            copy.moving       = moving_.load(std::memory_order_relaxed);
            copy.blocks       = blocks_.load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            if (seq_.load(std::memory_order_relaxed) == before) {
                out = copy;
                return true;
            }
        }
        return false;
    }

private:
    std::atomic<std::uint64_t> seq_{0};
    std::atomic<std::int64_t>  steady_ns_{0};
    std::atomic<std::uint64_t> host_time_ns_{0};
    std::atomic<std::int64_t>  frame_{0};
    std::atomic<std::int32_t>  sample_rate_{0};
    std::atomic<bool>          moving_{false};
    std::atomic<std::uint64_t> blocks_{0};
};

} // namespace lt
