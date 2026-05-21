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
