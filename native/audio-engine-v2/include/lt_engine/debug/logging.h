#pragma once

#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
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
