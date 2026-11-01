#pragma once

// ---------------------------------------------------------------------------
// Filesystem path helpers.
//
// All paths inside the engine are carried as UTF-8 std::string (they come from
// the Rust/Tauri layer, which is UTF-8 end to end).  On Windows the C runtime's
// narrow file APIs (fopen, sf_open, drmp3_init_file, …) interpret a const char*
// path as the active ANSI codepage, NOT UTF-8.  A path with accented characters
// (e.g. "canción.wav") therefore fails to open even though the file exists.
//
// to_wide() converts a UTF-8 path to UTF-16 so the wide ("…_w") file APIs can be
// used on Windows.  On other platforms narrow APIs are already UTF-8 and these
// helpers are unused.
// ---------------------------------------------------------------------------

#include <string>

#if defined(_WIN32)
// Keep <windows.h> from defining the min/max macros (they break std::min/max in
// any TU that includes this header before its own NOMINMAX guard) and trim the
// include to the bits we need.
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>

namespace lt {

inline std::wstring to_wide(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    const int len = MultiByteToWideChar(CP_UTF8, 0, utf8.data(),
                                        static_cast<int>(utf8.size()),
                                        nullptr, 0);
    if (len <= 0) return std::wstring();
    std::wstring out(static_cast<std::size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                        out.data(), len);
    return out;
}

// The inverse: a UTF-16 string from a wide Win32 API back to engine UTF-8.
inline std::string from_wide(const wchar_t* wide, int length = -1) {
    if (!wide || length == 0) return std::string();
    const int len = WideCharToMultiByte(CP_UTF8, 0, wide, length,
                                        nullptr, 0, nullptr, nullptr);
    if (len <= 0) return std::string();
    std::string out(static_cast<std::size_t>(len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide, length, out.data(), len,
                        nullptr, nullptr);
    if (length < 0 && !out.empty() && out.back() == '\0')
        out.pop_back();
    return out;
}

} // namespace lt

#endif // _WIN32
