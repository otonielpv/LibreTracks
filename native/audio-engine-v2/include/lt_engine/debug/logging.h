#pragma once

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <mutex>
#include <string>

#if defined(_WIN32)
// Forward-declare the one Win32 call we need instead of pulling in <windows.h>,
// which would leak the min/max macros into every TU that includes this header
// (breaks std::min/std::max in decoded_source.cpp etc.). Signature matches the
// Windows SDK (DWORD = unsigned long, LPSTR = char*, LPCSTR = const char*).
extern "C" __declspec(dllimport) unsigned long __stdcall GetEnvironmentVariableA(
    const char* lpName, char* lpBuffer, unsigned long nSize);
#endif

namespace lt {

// Read an env var via the live Win32 block on Windows (GetEnvironmentVariableA),
// not the MSVC CRT's frozen getenv copy. Rust sets LIBRETRACKS_AUDIO_DEBUG_LOG
// at runtime via SetEnvironmentVariableW; getenv would NOT see it in the same
// process, so the log would fall back to a CWD-relative path. See the
// "Windows env FFI desync" note / read_env() in source_manager.cpp.
inline std::string lt_read_runtime_env(const char* name) {
#if defined(_WIN32)
    unsigned long needed = GetEnvironmentVariableA(name, nullptr, 0);
    if (needed == 0) return {};
    std::string value(needed, '\0');
    unsigned long written = GetEnvironmentVariableA(name, value.data(), needed);
    value.resize(written);
    return value;
#else
    const char* raw = std::getenv(name);
    return raw ? std::string(raw) : std::string();
#endif
}

inline bool lt_env_flag_enabled(const char* name) {
    const char* raw = std::getenv(name);
    if (!raw) return false;
    std::string value = raw;
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

inline const char* lt_debug_log_path() {
    // Cached once; the path is set at startup by the Rust side and doesn't change
    // during a run. Read via the live Win32 block (not getenv) so the value Rust
    // sets at runtime is honored on Windows.
    static const std::string s_path = [] {
        std::string from_env = lt_read_runtime_env("LIBRETRACKS_AUDIO_DEBUG_LOG");
        return from_env.empty() ? std::string("lt_audio_debug.log") : from_env;
    }();
    return s_path.c_str();
}

inline void lt_reset_debug_log_file() {
    FILE* f = std::fopen(lt_debug_log_path(), "w");
    if (f) std::fclose(f);
}

// Local wall-clock stamp "HH:MM:SS.mmm " for the start of a log line. The log
// is append-only across sessions (never truncated in release), so without a
// time on each line it is impossible to tell one playback from another or to
// measure how fast [LT_STARVATION] frames accumulate. The date/app-version go
// in the per-session [LT_SESSION] banner; per-line we only need the time.
inline std::string lt_debug_timestamp() {
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto secs = time_point_cast<seconds>(now);
    const auto ms = duration_cast<milliseconds>(now - secs).count();
    const std::time_t t = system_clock::to_time_t(now);
    std::tm tm{};
#if defined(_WIN32)
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d.%03d ",
                  tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
    return std::string(buf);
}

// Full local date+time "YYYY-MM-DD HH:MM:SS" for the per-session banner, so a
// reader can pin a run to a wall-clock moment even though per-line stamps carry
// only the time-of-day.
inline std::string lt_debug_datetime() {
    const std::time_t t = std::time(nullptr);
    std::tm tm{};
#if defined(_WIN32)
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d",
                  tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec);
    return std::string(buf);
}

inline void lt_debug_vlog(const char* fmt, va_list args) {
    static std::mutex mtx;
    std::lock_guard<std::mutex> g(mtx);

    const std::string stamp = lt_debug_timestamp();

    FILE* f = std::fopen(lt_debug_log_path(), "a");
    if (f) {
        va_list copy;
        va_copy(copy, args);
        std::fputs(stamp.c_str(), f);
        std::vfprintf(f, fmt, copy);
        std::fflush(f);
        va_end(copy);
        std::fclose(f);
    }

    if (lt_env_flag_enabled("LIBRETRACKS_DEBUG_STDOUT")) {
        std::fputs(stamp.c_str(), stdout);
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
