#include <lt_engine/sources/io_throttle.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <mutex>
#include <thread>

namespace lt {

namespace {

std::atomic<bool> g_playback_active{false};

// Serializes the heavy decode/resample section while playing — see
// DecodeMemoryGate. A plain mutex: at most one decode holds it at a time.
std::mutex g_decode_memory_mutex;

int playing_yield_ms() {
    // Tunable so we can dial the trade-off (smoothness vs. decode speed during
    // playback) from the field without a rebuild.
    static const int value = [] {
        if (const char* raw = std::getenv("LIBRETRACKS_DECODE_PLAYING_YIELD_MS")) {
            const int parsed = std::atoi(raw);
            if (parsed >= 1 && parsed <= 100)
                return parsed;
        }
        return 6;
    }();
    return value;
}

} // namespace

void set_playback_active(bool active) noexcept {
    g_playback_active.store(active, std::memory_order_relaxed);
}

bool playback_active() noexcept {
    return g_playback_active.load(std::memory_order_relaxed);
}

void decode_background_yield() noexcept {
    const int ms = g_playback_active.load(std::memory_order_relaxed)
                       ? playing_yield_ms()
                       : 1;
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

DecodeMemoryGate::DecodeMemoryGate() noexcept {
    // Only serialize while playing: cold opens (stopped) keep full decode
    // parallelism. Opt-out via LIBRETRACKS_DECODE_GATE=0 for benchmarking.
    static const bool enabled = [] {
        const char* v = std::getenv("LIBRETRACKS_DECODE_GATE");
        return !(v && v[0] == '0' && v[1] == '\0');
    }();
    if (enabled && g_playback_active.load(std::memory_order_relaxed)) {
        g_decode_memory_mutex.lock();
        held_ = true;
    }
}

DecodeMemoryGate::~DecodeMemoryGate() noexcept {
    if (held_)
        g_decode_memory_mutex.unlock();
}

} // namespace lt
