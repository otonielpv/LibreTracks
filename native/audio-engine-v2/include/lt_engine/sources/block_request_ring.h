#pragma once

// Fixed-size, lock-free, allocation-free queue of block-fill requests, from the
// audio render threads to the fill workers.
//
// Why: SourceManager::request_blocks ran on the audio thread on every
// read-ahead edge (each ~85 ms per track) and urgent re-ask. It took fill_mtx_
// and allocated: the source id copied into a CacheKey (the id is the file
// path, longer than any small-string buffer), a node in queued_blocks_, another
// copy pushed onto the queue. A heap allocation on the audio thread contends
// with import-time allocations on the global heap lock, which is exactly the
// stall the engine has been bitten by before.
//
// Now the render threads only write a slot here. The fill workers drain it under
// the mutex they already hold and apply the very same dedupe / urgent /
// promotion logic as before, so scheduling semantics do not change; only where
// the bookkeeping runs does.
//
// Bounded MPMC queue after Dmitry Vyukov: each slot carries a sequence number,
// producers claim a position with a CAS. Producers are the callback and the
// render-pool workers (several at once in parallel phase A); consumers are the
// fill workers, serialised by fill_mtx_. A full ring or an id that does not fit
// a slot makes try_push return false and the caller falls back to the locked
// path, so a request is never lost.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string_view>

namespace lt {

struct BlockRequest {
    static constexpr std::size_t kMaxIdBytes = 488;
    std::int32_t  first_block = 0;
    std::int32_t  block_count = 0;
    std::uint16_t id_length = 0;
    bool          urgent = false;
    char          id[kMaxIdBytes];

    std::string_view source_id() const noexcept { return {id, id_length}; }
};

class BlockRequestRing {
public:
    static constexpr std::size_t kCapacity = 512;  // power of two
    static_assert((kCapacity & (kCapacity - 1)) == 0, "capacity must be a power of two");

    BlockRequestRing() : slots_(std::make_unique<Slot[]>(kCapacity)) {
        for (std::size_t i = 0; i < kCapacity; ++i)
            slots_[i].sequence.store(i, std::memory_order_relaxed);
    }

    BlockRequestRing(const BlockRequestRing&) = delete;
    BlockRequestRing& operator=(const BlockRequestRing&) = delete;

    // Producer side; realtime-safe (no allocation, no lock, bounded retries
    // only under contention between producers). The publishing store is
    // seq_cst: SourceManager pairs it with the fill workers' sleeper count so a
    // wake-up cannot be missed (see request_blocks).
    bool try_push(std::string_view source_id, int first_block, int block_count,
                  bool urgent) noexcept {
        if (source_id.size() > BlockRequest::kMaxIdBytes)
            return false;
        std::size_t pos = enqueue_pos_.load(std::memory_order_relaxed);
        Slot* slot = nullptr;
        for (;;) {
            slot = &slots_[pos & (kCapacity - 1)];
            const std::size_t seq = slot->sequence.load(std::memory_order_acquire);
            const auto diff = static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos);
            if (diff == 0) {
                if (enqueue_pos_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed))
                    break;
            } else if (diff < 0) {
                return false;  // full
            } else {
                pos = enqueue_pos_.load(std::memory_order_relaxed);
            }
        }
        BlockRequest& r = slot->request;
        r.first_block = first_block;
        r.block_count = block_count;
        r.urgent = urgent;
        r.id_length = static_cast<std::uint16_t>(source_id.size());
        std::memcpy(r.id, source_id.data(), source_id.size());
        slot->sequence.store(pos + 1, std::memory_order_seq_cst);
        return true;
    }

    // Consumer side. Copies the next request into `out`; false when empty.
    bool try_pop(BlockRequest& out) noexcept {
        std::size_t pos = dequeue_pos_.load(std::memory_order_relaxed);
        Slot* slot = nullptr;
        for (;;) {
            slot = &slots_[pos & (kCapacity - 1)];
            const std::size_t seq = slot->sequence.load(std::memory_order_acquire);
            const auto diff = static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos + 1);
            if (diff == 0) {
                if (dequeue_pos_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed))
                    break;
            } else if (diff < 0) {
                return false;  // empty
            } else {
                pos = dequeue_pos_.load(std::memory_order_relaxed);
            }
        }
        const BlockRequest& r = slot->request;
        out.first_block = r.first_block;
        out.block_count = r.block_count;
        out.urgent = r.urgent;
        out.id_length = r.id_length;
        std::memcpy(out.id, r.id, r.id_length);
        slot->sequence.store(pos + kCapacity, std::memory_order_release);
        return true;
    }

    // True when a published request is waiting. seq_cst load: the other half
    // of the no-lost-wake-up handshake (a fill worker checks this after
    // announcing itself as a sleeper).
    bool has_pending() const noexcept {
        const std::size_t pos = dequeue_pos_.load(std::memory_order_seq_cst);
        const Slot& slot = slots_[pos & (kCapacity - 1)];
        return slot.sequence.load(std::memory_order_seq_cst) == pos + 1;
    }

private:
    struct Slot {
        std::atomic<std::size_t> sequence{0};
        BlockRequest             request;
    };

    std::unique_ptr<Slot[]> slots_;
    alignas(64) std::atomic<std::size_t> enqueue_pos_{0};
    alignas(64) std::atomic<std::size_t> dequeue_pos_{0};
};

} // namespace lt
