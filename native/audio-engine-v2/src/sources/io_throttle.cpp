#include <lt_engine/sources/io_throttle.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <thread>

namespace lt {

namespace {

std::atomic<bool> g_playback_active{false};

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

} // namespace lt
