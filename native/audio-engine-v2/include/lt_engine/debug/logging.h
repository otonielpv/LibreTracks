#pragma once

#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>

namespace lt {

inline bool lt_env_flag_enabled(const char* name) {
    const char* raw = std::getenv(name);
    if (!raw) return false;
    std::string value = raw;
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

// Fase 0 / Warp test hook: when LT_WARP_TEST_RATIO is set to a positive
// double, every clip in the session is forced through the Bungee path with
// pitch_scale = 1.0 and time_ratio = <env value>. Returns 1.0 (= no warp,
// engine should behave normally) when unset, malformed, or out of range.
// Reasonable range enforced: [0.25, 4.0].
inline double lt_warp_test_ratio() {
    static const double ratio = [] {
        const char* raw = std::getenv("LT_WARP_TEST_RATIO");
        if (!raw || !*raw) return 1.0;
        try {
            const double v = std::stod(raw);
            if (!(v > 0.25 && v < 4.0)) return 1.0;
            return v;
        } catch (...) {
            return 1.0;
        }
    }();
    return ratio;
}

inline bool lt_warp_test_active() {
    return lt_warp_test_ratio() != 1.0;
}

inline const char* lt_debug_log_path() {
    if (const char* path = std::getenv("LIBRETRACKS_AUDIO_DEBUG_LOG")) {
        if (*path) return path;
    }
    return "lt_audio_debug.log";
}

inline void lt_reset_debug_log_file() {
    FILE* f = std::fopen(lt_debug_log_path(), "w");
    if (f) std::fclose(f);
}

inline void lt_debug_vlog(const char* fmt, va_list args) {
    static std::mutex mtx;
    std::lock_guard<std::mutex> g(mtx);

    FILE* f = std::fopen(lt_debug_log_path(), "a");
    if (f) {
        va_list copy;
        va_copy(copy, args);
        std::vfprintf(f, fmt, copy);
        std::fflush(f);
        va_end(copy);
        std::fclose(f);
    }

    if (lt_env_flag_enabled("LIBRETRACKS_DEBUG_STDOUT")) {
        std::vfprintf(stdout, fmt, args);
        std::fflush(stdout);
    }
}

inline void lt_debug_log(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

} // namespace lt
