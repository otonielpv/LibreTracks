#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/io_throttle.h>
#include <lt_engine/sources/resampler.h>
#include <lt_engine/core/device_profile.h>
#include <lt_engine/core/thread_policy.h>
#include <lt_engine/core/fs_path.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <shlobj.h>
#else
#  include <dirent.h>
#  include <sys/statvfs.h>
#  include <sys/time.h>
#  include <unistd.h>
#endif

#if defined(_WIN32)
#include <direct.h>
#include <sys/stat.h>
#include <sys/types.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#endif

#if LT_ENGINE_USE_LIBSNDFILE
// Must be set before <sndfile.h> so it declares sf_wchar_open() (the UTF-16
// path entry point lt_sf_open() uses on Windows for accented file names).
#define ENABLE_SNDFILE_WINDOWS_PROTOTYPES 1
#include <sndfile.h>
#endif

namespace lt {

namespace {

// Read an environment variable in a way that reflects live updates made by the
// host process. On Windows, Rust's std::env::set_var calls SetEnvironmentVariableW
// (the Win32 block), but the MSVC CRT's getenv() reads a *separate* copy that is
// snapshotted at startup and only refreshed by _putenv — so getenv() would not
// see a folder the user just picked. Querying the Win32 block directly keeps the
// C++ side in sync with what Rust wrote. Returns empty when unset.
std::string read_env(const char* name) {
#if defined(_WIN32)
    DWORD needed = GetEnvironmentVariableA(name, nullptr, 0);
    if (needed == 0)
        return {};
    std::string value(needed, '\0');
    DWORD written = GetEnvironmentVariableA(name, value.data(), needed);
    value.resize(written);
    return value;
#else
    const char* raw = std::getenv(name);
    return raw ? std::string(raw) : std::string();
#endif
}

void yield_to_ui_scheduler() {
    // Cede disk bandwidth to the live block-fill thread while playing so the
    // PCM cache write of a freshly-imported source can't starve the already-
    // playing tracks. See io_throttle.h.
    decode_background_yield();
}

// Total streaming-block cache budget (MB). The cache is GLOBAL across all
// sources, so a fixed 512 MB starved playback once several songs/tracks shared
// it. Scaling gives machines with more RAM proportionally more headroom. On
// 8 GB it stays at 512 (there is no room to grow without paging — the
// working-set pressure thread_policy.h documents); the 8 GB case is fixed by
// the per-source eviction guard in BlockCache, not by this budget.
//
// The tiers now live in device_profile.h, which also handles the case installed
// RAM cannot: a phone. 512 MB is roughly half of everything available on a
// 2.58 GB device, and claiming it is what made the low-memory killer take the
// system down mid-import.
size_t source_cache_mb_for_ram() {
    return lt::lt_device_profile().source_cache_mb;
}

size_t source_cache_blocks_from_env() {
    size_t cache_mb = source_cache_mb_for_ram();
    // Explicit override always wins (A/B testing, constrained deployments).
    // The floor is 16 rather than 64 so a handheld budget can be dialled below
    // the desktop minimum while measuring.
    if (const char* raw = std::getenv("LIBRETRACKS_SOURCE_CACHE_MB")) {
        const int parsed = std::atoi(raw);
        if (parsed >= 16 && parsed <= 4096)
            cache_mb = static_cast<size_t>(parsed);
    }
    const size_t bytes_per_block =
        static_cast<size_t>(kDefaultBlockFrames) * sizeof(float) * 2;
    return std::max<size_t>(1, (cache_mb * 1024 * 1024) / bytes_per_block);
}

#if LT_ENGINE_USE_LIBSNDFILE
// Open a UTF-8 path with libsndfile. On Windows sf_open() treats the narrow
// path as the ANSI codepage, so accented names (the user's "canción.wav" or a
// "C:\Users\José\..." cache path) fail to open; sf_wchar_open() with a UTF-16
// path fixes that. See lt_engine/core/fs_path.h.
inline SNDFILE* lt_sf_open(const std::string& path, int mode, SF_INFO* info) {
#if defined(_WIN32)
    return sf_wchar_open(to_wide(path).c_str(), mode, info);
#else
    return sf_open(path.c_str(), mode, info);
#endif
}

// PCM cache file format. We store 16-bit PCM in a standard WAV container — the
// same as Ableton's decoding cache: half the size (and disk I/O) of float32,
// and int16 is plenty for playback. libsndfile transparently converts between
// the on-disk int16 and the float buffers we read/write, so only the format
// flag changes. Files ≥ ~3.9 GB of audio data fall back to RF64 (WAV's 4 GB
// container limit). Set LIBRETRACKS_CACHE_FLOAT=1 to keep float32 (debug/AB).
int cache_sample_format() {
    static const bool want_float = [] {
        const char* v = std::getenv("LIBRETRACKS_CACHE_FLOAT");
        return v && v[0] == '1' && v[1] == '\0';
    }();
    return want_float ? SF_FORMAT_FLOAT : SF_FORMAT_PCM_16;
}

// Major (container) flag: WAV unless the PCM payload would exceed the WAV 4 GB
// limit, in which case RF64 (a WAV superset for huge files).
int cache_container_format(Frame out_frames, int channel_count) {
    const int bytes_per_sample =
        (cache_sample_format() == SF_FORMAT_FLOAT) ? 4 : 2;
    const unsigned long long payload =
        static_cast<unsigned long long>(out_frames) *
        static_cast<unsigned long long>(std::max(1, channel_count)) * bytes_per_sample;
    constexpr unsigned long long kWavLimit = 4000ull * 1024 * 1024;  // ~3.9 GB
    return payload >= kWavLimit ? SF_FORMAT_RF64 : SF_FORMAT_WAV;
}
#endif

int eager_source_blocks_from_env() {
    if (const char* raw = std::getenv("LIBRETRACKS_SOURCE_EAGER_BLOCKS")) {
        const int parsed = std::atoi(raw);
        if (parsed >= 0 && parsed <= 1024)
            return parsed;
    }
    return 64;
}

char native_path_separator() {
#if defined(_WIN32)
    return '\\';
#else
    return '/';
#endif
}

bool is_path_separator(char c) {
    return c == '/' || c == '\\';
}

bool is_root_path(const std::string& path) {
    if (path == "/" || path == "\\")
        return true;
    return path.size() == 3 &&
           path[1] == ':' &&
           is_path_separator(path[2]);
}

bool create_directory_if_missing(const std::string& path) {
    if (path.empty())
        return false;
    if (is_root_path(path))
        return true;
#if defined(_WIN32)
    if (_mkdir(path.c_str()) == 0)
        return true;
#else
    if (::mkdir(path.c_str(), 0755) == 0)
        return true;
#endif
    return errno == EEXIST;
}

bool create_directories_compat(const std::string& path) {
    if (path.empty())
        return true;

    std::string current;
    current.reserve(path.size());

    for (std::size_t i = 0; i < path.size(); ++i) {
        current.push_back(path[i]);
        if (!is_path_separator(path[i]) || current.size() <= 1)
            continue;

        while (i + 1 < path.size() && is_path_separator(path[i + 1])) {
            current.push_back(path[++i]);
        }

        if (current.size() > 1 && !create_directory_if_missing(current))
            return false;
    }

    return create_directory_if_missing(path);
}

std::string parent_path_compat(const std::string& path) {
    const auto pos = path.find_last_of("/\\");
    if (pos == std::string::npos)
        return {};
    if (pos == 0)
        return path.substr(0, 1);
    return path.substr(0, pos);
}

std::string temp_directory_compat() {
#if defined(_WIN32)
    const char* candidates[] = {std::getenv("TEMP"), std::getenv("TMP")};
#else
    const char* candidates[] = {std::getenv("TMPDIR"), std::getenv("TEMP"), std::getenv("TMP")};
#endif
    for (const char* candidate : candidates) {
        if (candidate && candidate[0] != '\0') {
            std::string dir(candidate);
            while (dir.size() > 1 && is_path_separator(dir.back()))
                dir.pop_back();
            return dir;
        }
    }
    return
#if defined(_WIN32)
        ".";
#else
        "/tmp";
#endif
}

// Resolve the per-user persistent cache directory for the engine. Unlike
// %TEMP%, the contents survive reboots so the cross-session PCM cache stays
// useful — and unlike %TEMP%, Windows won't clean it behind our back.
// Honours $LIBRETRACKS_CACHE_DIR for tests and power users.
std::string resolve_app_cache_dir() {
    if (std::string override_dir = read_env("LIBRETRACKS_CACHE_DIR"); !override_dir.empty()) {
        std::string out(std::move(override_dir));
        while (out.size() > 1 && is_path_separator(out.back()))
            out.pop_back();
        return out;
    }
#if defined(_WIN32)
    PWSTR path = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &path)) && path) {
        const int len = WideCharToMultiByte(CP_UTF8, 0, path, -1,
                                             nullptr, 0, nullptr, nullptr);
        std::string out;
        if (len > 1) {
            out.resize(static_cast<std::size_t>(len - 1));
            WideCharToMultiByte(CP_UTF8, 0, path, -1, out.data(), len,
                                 nullptr, nullptr);
        }
        CoTaskMemFree(path);
        if (!out.empty())
            return out + "\\LibreTracks";
    }
    return temp_directory_compat();
#elif defined(__APPLE__)
    if (const char* home = std::getenv("HOME")) {
        if (home[0] != '\0')
            return std::string(home) + "/Library/Caches/LibreTracks";
    }
    return temp_directory_compat();
#else
    if (const char* xdg = std::getenv("XDG_CACHE_HOME")) {
        if (xdg[0] != '\0')
            return std::string(xdg) + "/LibreTracks";
    }
    if (const char* home = std::getenv("HOME")) {
        if (home[0] != '\0')
            return std::string(home) + "/.cache/LibreTracks";
    }
    return temp_directory_compat();
#endif
}

std::string source_cache_dir() {
    return resolve_app_cache_dir() + native_path_separator() + "source-cache";
}

// Free space on the filesystem hosting `dir`. Returns 0 if the query fails
// (we then fall back to the fixed minimum below).
unsigned long long free_disk_bytes_for(const std::string& dir) {
#if defined(_WIN32)
    ULARGE_INTEGER free_bytes_caller{};
    ULARGE_INTEGER total_bytes{};
    ULARGE_INTEGER total_free{};
    if (GetDiskFreeSpaceExA(dir.c_str(),
                             &free_bytes_caller,
                             &total_bytes,
                             &total_free)) {
        return static_cast<unsigned long long>(free_bytes_caller.QuadPart);
    }
    return 0ull;
#else
    struct statvfs st{};
    if (::statvfs(dir.c_str(), &st) == 0) {
        return static_cast<unsigned long long>(st.f_bavail) *
               static_cast<unsigned long long>(st.f_frsize);
    }
    return 0ull;
#endif
}

// LRU eviction budget. Default policy mirrors Ableton: take 10% of free disk
// space on the cache volume, clamped to a 4 GiB minimum so a nearly-full
// drive still has a usable working set. Honour LIBRETRACKS_SOURCE_DISK_CACHE_MB
// as an explicit override (0 disables eviction entirely; any positive value
// fixes the cap to that many MiB).
size_t source_disk_cache_limit_bytes() {
    if (std::string raw = read_env("LIBRETRACKS_SOURCE_DISK_CACHE_MB"); !raw.empty()) {
        const long long parsed = std::atoll(raw.c_str());
        if (parsed >= 0 && parsed <= 1024ll * 1024ll) // sanity 1 TiB
            return static_cast<size_t>(parsed) * 1024ull * 1024ull;
    }

    const std::string dir = source_cache_dir();
    const unsigned long long free_bytes = free_disk_bytes_for(parent_path_compat(dir));
    return lt::lt_disk_cache_limit_for(free_bytes, lt::lt_device_profile().device_class);
}

struct CacheEntryStat {
    std::string path;
    long long   size_bytes = 0;
    long long   mtime      = 0;
};

bool ends_with(const std::string& name, const char* ext) {
    const std::size_t len = std::strlen(ext);
    if (name.size() < len) return false;
    return name.compare(name.size() - len, len, ext) == 0;
}

// A PCM cache file is either the int16 WAV (current) or the legacy float RF64.
bool is_pcm_cache_file(const std::string& name) {
    return ends_with(name, ".wav") || ends_with(name, ".rf64");
}

std::vector<CacheEntryStat> list_cache_entries(const std::string& dir) {
    std::vector<CacheEntryStat> out;
#if defined(_WIN32)
    WIN32_FIND_DATAA fd{};
    const std::string pattern = dir + "\\*";  // filter by extension below
    HANDLE h = FindFirstFileA(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE)
        return out;
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
            continue;
        if (!is_pcm_cache_file(fd.cFileName))
            continue;
        CacheEntryStat e;
        e.path = dir + "\\" + fd.cFileName;
        LARGE_INTEGER sz{};
        sz.LowPart = fd.nFileSizeLow;
        sz.HighPart = static_cast<LONG>(fd.nFileSizeHigh);
        e.size_bytes = static_cast<long long>(sz.QuadPart);
        // FILETIME → unix-ish seconds for ordering only (not absolute).
        ULARGE_INTEGER ft{};
        ft.LowPart = fd.ftLastWriteTime.dwLowDateTime;
        ft.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        e.mtime = static_cast<long long>(ft.QuadPart);
        out.push_back(std::move(e));
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR* d = ::opendir(dir.c_str());
    if (!d) return out;
    while (auto* ent = ::readdir(d)) {
        const std::string name(ent->d_name);
        if (!is_pcm_cache_file(name)) continue;
        const std::string full = dir + "/" + name;
        struct stat st{};
        if (::stat(full.c_str(), &st) != 0) continue;
        CacheEntryStat e;
        e.path = full;
        e.size_bytes = static_cast<long long>(st.st_size);
        e.mtime      = static_cast<long long>(st.st_mtime);
        out.push_back(std::move(e));
    }
    ::closedir(d);
#endif
    return out;
}

// Ensure cache dir + the projected new file size stay below the configured
// budget. Deletes the oldest .rf64 files (by mtime) until the projected total
// fits. Always preserves the file at `protect_path` — the one we're about to
// reuse — so a re-open can't evict its own cache mid-flight.
void evict_cache_lru(const std::string& dir,
                      size_t projected_new_bytes,
                      const std::string& protect_path) {
    const size_t limit = source_disk_cache_limit_bytes();
    if (limit == 0)
        return; // user-disabled (LIBRETRACKS_SOURCE_DISK_CACHE_MB=0)
    auto entries = list_cache_entries(dir);
    long long total = static_cast<long long>(projected_new_bytes);
    for (const auto& e : entries) total += e.size_bytes;
    if (total <= static_cast<long long>(limit))
        return;

    std::sort(entries.begin(), entries.end(),
              [](const CacheEntryStat& a, const CacheEntryStat& b) {
                  return a.mtime < b.mtime; // oldest first
              });
    for (const auto& e : entries) {
        if (total <= static_cast<long long>(limit))
            break;
        if (!protect_path.empty() && e.path == protect_path)
            continue;
        if (std::remove(e.path.c_str()) == 0)
            total -= e.size_bytes;
    }
}

// File metadata used to invalidate the PCM cache when the source file
// changes on disk. size_bytes = -1 / mtime = 0 means "stat failed".
struct FileStat {
    long long size_bytes = -1;
    long long mtime      = 0;
};

FileStat stat_file(const std::string& path) {
    FileStat out;
    if (path.empty())
        return out;
#if defined(_WIN32)
    struct _stat64 st{};
    if (_stat64(path.c_str(), &st) == 0) {
        out.size_bytes = static_cast<long long>(st.st_size);
        out.mtime      = static_cast<long long>(st.st_mtime);
    }
#else
    struct stat st{};
    if (::stat(path.c_str(), &st) == 0) {
        out.size_bytes = static_cast<long long>(st.st_size);
        out.mtime      = static_cast<long long>(st.st_mtime);
    }
#endif
    return out;
}

} // namespace

// ---------------------------------------------------------------------------
// Free-function cache maintenance API.
//
// These operate purely on the env-resolved cache directory (source_cache_dir())
// and do NOT require a live SourceManager / Engine instance — the UI can call
// them to report or clear the on-disk PCM cache without any source loaded. They
// honour LIBRETRACKS_CACHE_DIR exactly like the rest of the cache machinery, so
// changing the configured folder is reflected immediately.
// ---------------------------------------------------------------------------

// The env-resolved cache directory the engine writes .rf64 files into. Mirrors
// what the cache machinery uses, so a host can display the effective path.
std::string source_cache_directory() {
    return source_cache_dir();
}

// Total size in bytes of every .rf64 PCM cache file currently on disk.
unsigned long long source_cache_dir_size_bytes() {
    const std::string dir = source_cache_dir();
    unsigned long long total = 0;
    for (const auto& e : list_cache_entries(dir)) {
        if (e.size_bytes > 0)
            total += static_cast<unsigned long long>(e.size_bytes);
    }
    return total;
}

// Delete every .rf64 PCM cache file. Returns the number of bytes freed (only
// files actually removed are counted) and, via `out_failed`, how many files
// could not be deleted.
//
// Reporting the failures matters: on Windows a file that is open without
// FILE_SHARE_DELETE cannot be unlinked, and the engine holds every streaming
// source's cache file open while a session is loaded. So "Clear cache" with a
// session open deletes NOTHING and used to report 0 bytes freed, which reads as
// "the cache was already empty" instead of "the files are in use". Callers use
// the failure count to tell the user to close the session.
unsigned long long purge_source_cache(unsigned int* out_failed) {
    const std::string dir = source_cache_dir();
    unsigned long long freed = 0;
    unsigned int failed = 0;
    for (const auto& e : list_cache_entries(dir)) {
        if (std::remove(e.path.c_str()) == 0) {
            if (e.size_bytes > 0)
                freed += static_cast<unsigned long long>(e.size_bytes);
        } else {
            ++failed;
        }
    }
    if (out_failed)
        *out_failed = failed;
    return freed;
}

SourcePeakOverview analyze_file_peaks(const std::string& file_path,
                                      int resolution_frames,
                                      PeakProgressFn on_progress,
                                      void* progress_ctx) {
    SourcePeakOverview overview;
    overview.resolution_frames = std::max(1, resolution_frames);

    auto decoder = make_decoder(file_path);
    if (!decoder)
        return overview;

    auto opened = decoder->open(file_path);
    if (opened.is_err())
        return overview;

    const AudioFileInfo info = decoder->info();
    if (info.channel_count <= 0 || info.original_sample_rate <= 0
        || info.duration_frames <= 0) {
        decoder->close();
        return overview;
    }

    overview.sample_rate = info.original_sample_rate;

    const Frame bucket_width = static_cast<Frame>(overview.resolution_frames);
    std::size_t bucket_count = static_cast<std::size_t>(
        (info.duration_frames + bucket_width - 1) / bucket_width);
    std::vector<float> min_peaks(bucket_count, 0.f);
    std::vector<float> max_peaks(bucket_count, 0.f);
    const bool has_right_channel = info.channel_count >= 2;
    std::vector<float> min_peaks_right(has_right_channel ? bucket_count : 0, 0.f);
    std::vector<float> max_peaks_right(has_right_channel ? bucket_count : 0, 0.f);
    std::vector<bool> initialized(bucket_count, false);

    constexpr int kChunkFrames = 65536;
    std::vector<float> data(static_cast<std::size_t>(kChunkFrames)
                            * static_cast<std::size_t>(info.channel_count),
                            0.f);

    // Progress cadence. A stem takes on the order of 260 ms to analyse, so at
    // 150 ms the waveform arrived in two jumps — technically progressive, and
    // indistinguishable from appearing at once. 60 ms gives a handful of steps
    // on a short file and a steady sweep on a long one, while staying far above
    // the cost of one callback (a coarse summary over the FFI, ~15 KB).
    constexpr auto kProgressInterval = std::chrono::milliseconds(60);
    // Backdated so the FIRST chunk publishes immediately: the point of this is
    // that the user sees the waveform start appearing at once, and waiting out
    // an interval before the first one would leave a short file with no
    // progress at all.
    auto last_progress = std::chrono::steady_clock::now() - kProgressInterval;

    Frame cursor = 0;
    while (cursor < info.duration_frames) {
        const int frames_to_read = static_cast<int>(
            std::min<Frame>(kChunkFrames, info.duration_frames - cursor));
        if (frames_to_read <= 0)
            break;
        const int frames_read = decoder->read_frames(data.data(), frames_to_read);
        if (frames_read <= 0)
            break;

        for (int frame = 0; frame < frames_read; ++frame) {
            const Frame absolute = cursor + frame;
            const std::size_t bucket = static_cast<std::size_t>(absolute / bucket_width);
            if (bucket >= bucket_count)
                continue;

            const float* row = data.data()
                + static_cast<std::size_t>(frame) * info.channel_count;
            const float left = std::clamp(row[0], -1.f, 1.f);
            const float right = has_right_channel ? std::clamp(row[1], -1.f, 1.f) : 0.f;

            if (!initialized[bucket]) {
                min_peaks[bucket] = left;
                max_peaks[bucket] = left;
                if (has_right_channel) {
                    min_peaks_right[bucket] = right;
                    max_peaks_right[bucket] = right;
                }
                initialized[bucket] = true;
            } else {
                min_peaks[bucket] = std::min(min_peaks[bucket], left);
                max_peaks[bucket] = std::max(max_peaks[bucket], left);
                if (has_right_channel) {
                    min_peaks_right[bucket] = std::min(min_peaks_right[bucket], right);
                    max_peaks_right[bucket] = std::max(max_peaks_right[bucket], right);
                }
            }
        }

        cursor += frames_read;

        // Publish what is finished so far. Only COMPLETE buckets are handed
        // over: the bucket the cursor is sitting inside is still accumulating,
        // and shipping it would make the waveform's leading edge flicker as its
        // peak grows.
        if (on_progress) {
            const auto now = std::chrono::steady_clock::now();
            if (now - last_progress >= kProgressInterval) {
                last_progress = now;
                const std::size_t complete = static_cast<std::size_t>(cursor / bucket_width);
                if (complete > 0) {
                    PeakProgress progress;
                    progress.sample_rate       = overview.sample_rate;
                    progress.analyzed_frames   = static_cast<long long>(
                        complete * static_cast<std::size_t>(bucket_width));
                    progress.total_frames      = static_cast<long long>(info.duration_frames);
                    progress.resolution_frames = overview.resolution_frames;
                    progress.min_peaks         = min_peaks.data();
                    progress.max_peaks         = max_peaks.data();
                    progress.min_peaks_right   = has_right_channel ? min_peaks_right.data() : nullptr;
                    progress.max_peaks_right   = has_right_channel ? max_peaks_right.data() : nullptr;
                    progress.bucket_count      = static_cast<int>(
                        std::min(complete, bucket_count));
                    on_progress(progress_ctx, progress);
                }
            }
        }
    }
    decoder->close();

    if (cursor <= 0)
        return overview;

    bucket_count = static_cast<std::size_t>(
        (cursor + bucket_width - 1) / bucket_width);
    min_peaks.resize(bucket_count);
    max_peaks.resize(bucket_count);
    if (has_right_channel) {
        min_peaks_right.resize(bucket_count);
        max_peaks_right.resize(bucket_count);
    }

    overview.duration_frames = cursor;
    overview.min_peaks = std::move(min_peaks);
    overview.max_peaks = std::move(max_peaks);
    overview.min_peaks_right = std::move(min_peaks_right);
    overview.max_peaks_right = std::move(max_peaks_right);
    return overview;
}

// How many block-fill worker threads to run. Scaled to the machine (cores AND
// RAM) by the shared thread policy so a modest / low-RAM PC stays conservative
// (keeps a core for the audio callback + UI) while a bigger box refills several
// tracks in parallel. Override with LIBRETRACKS_FILL_THREADS for A/B testing.
static unsigned fill_thread_count_from_env() {
    if (std::string raw = read_env("LIBRETRACKS_FILL_THREADS"); !raw.empty()) {
        try {
            int n = std::stoi(raw);
            if (n >= 1) return static_cast<unsigned>(n);
        } catch (...) {
        }
    }
    return static_cast<unsigned>(lt::lt_device_profile().fill_threads);
}

SourceManager::SourceManager()
    : entries_(std::make_shared<EntryMap>())
    , block_cache_(kDefaultBlockFrames,
                   source_cache_blocks_from_env(),
                   // Read-ahead window per source. Streaming playback spends
                   // its memory here — window x playing tracks — so on a phone
                   // this, not the total budget, is what decides how many
                   // tracks fit. Flash storage needs far less lead than the
                   // desktop default assumes.
                   lt::lt_device_profile().protected_blocks_per_source)
{
    const unsigned count = fill_thread_count_from_env();
    lt_debug_log(
        "[LT_THREADS] fill pool: %u worker(s) (cores=%u, ram=%.1fGB)\n",
        count,
        std::thread::hardware_concurrency(),
        lt_physical_ram_bytes() / (1024.0 * 1024.0 * 1024.0));
    fill_threads_.reserve(count);
    for (unsigned i = 0; i < count; ++i)
        fill_threads_.emplace_back([this] { fill_worker_loop(); });
}

SourceManager::~SourceManager() {
    {
        std::lock_guard lock(fill_mtx_);
        fill_stop_ = true;
    }
    fill_cv_.notify_all();
    for (auto& t : fill_threads_)
        if (t.joinable())
            t.join();
}

void SourceManager::set_source_ready_callback(SourceReadyCallback callback) {
    std::lock_guard lock(write_mutex_);
    source_ready_callback_ = std::move(callback);
}

void SourceManager::publish_locked(EntryMap entries) {
    auto previous = load_entries();
    if (previous) {
        retired_entries_.push_back(std::move(previous));
        // Audio-thread get() returns a borrowed pointer, so keep recent
        // snapshots alive across rapid clear/register/store publish bursts.
        // Async builders use get_shared(); this retention is just for one
        // render block worth of borrowed raw pointers.
        constexpr std::size_t kMaxRetiredSnapshots = 32;
        while (retired_entries_.size() > kMaxRetiredSnapshots)
            retired_entries_.pop_front();
    }
    store_entries(std::make_shared<const EntryMap>(std::move(entries)));
}

std::shared_ptr<const SourceManager::EntryMap> SourceManager::load_entries() const noexcept {
#if !defined(_MSC_VER)
    return std::atomic_load_explicit(&entries_, std::memory_order_acquire);
#else
    return entries_.load(std::memory_order_acquire);
#endif
}

void SourceManager::store_entries(std::shared_ptr<const EntryMap> entries) noexcept {
#if !defined(_MSC_VER)
    std::atomic_store_explicit(&entries_, std::move(entries), std::memory_order_release);
#else
    entries_.store(std::move(entries), std::memory_order_release);
#endif
}

void SourceManager::register_source(const Id& source_id,
                                     const std::string& file_path) {
    std::lock_guard lock(write_mutex_);
    EntryMap next = *load_entries();
    auto& entry    = next[source_id];
    entry.file_path = file_path;
    entry.status    = "unloaded";
    publish_locked(std::move(next));
}

Result<void> SourceManager::load_source(const Id& source_id,
                                         int engine_sample_rate) {
    std::string file_path;
    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end())
            return Result<void>::err("Source not registered: " + source_id);
        it->second.status = "loading";
        file_path = it->second.file_path;
        publish_locked(std::move(next));
    }


    int    channel_count   = 0;
    Frame  duration_frames = 0;

    auto result = decode_file_to_float32(file_path,
                                          engine_sample_rate,
                                          &channel_count,
                                          &duration_frames);
    if (result.is_err()) {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        if (auto it = next.find(source_id); it != next.end()) {
            it->second.status        = "failed";
            it->second.error_message = result.error();
            publish_locked(std::move(next));
        }
        return Result<void>::err(result.error());
    }

    return store_decoded_source(source_id, result.take(), channel_count, engine_sample_rate, duration_frames);
}

Result<void> SourceManager::store_decoded_source(const Id& source_id,
                                                 std::vector<float> samples,
                                                 int channel_count,
                                                 int sample_rate,
                                                 Frame duration_frames,
                                                 SourceStoreProgressCallback on_progress) {
    auto report_progress = [&](int progress_pct) {
        if (on_progress)
            on_progress(std::clamp(progress_pct, 0, 100));
    };
    SourceReadyCallback ready_callback;
    std::string file_path;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return Result<void>::err("Source not registered: " + source_id);
        file_path = it->second.file_path;
    }

    if (file_path.empty()) {
        SourceReadyCallback ready_callback;
        {
            std::lock_guard lock(write_mutex_);
            EntryMap next = *load_entries();
            auto it = next.find(source_id);
            if (it == next.end())
                return Result<void>::err("Source not registered: " + source_id);
            auto& entry = it->second;
            entry.channel_count = channel_count;
            entry.sample_rate = sample_rate;
            entry.duration_frames = duration_frames;
            entry.disk_cache_bytes = 0;
            entry.source = std::make_shared<DecodedSource>(
                std::move(samples), channel_count, sample_rate, duration_frames);
            entry.status = "ready";
            entry.error_message.clear();
            publish_locked(std::move(next));
            ready_callback = source_ready_callback_;
        }
        if (ready_callback)
            ready_callback(source_id);
        return Result<void>::ok();
    }

    const std::string cache_file = cache_file_for(source_id, file_path, sample_rate);
    const size_t projected_bytes = samples.size() * sizeof(float);
    try {
        report_progress(86);
        if (!create_directories_compat(parent_path_compat(cache_file)))
            return Result<void>::err("Could not create PCM cache directory: " + cache_file);
        // Keep the on-disk cache under the configured budget before we add
        // another file to it. Protects the path we're about to write so it
        // can't be evicted by itself if it happened to be the oldest entry.
        evict_cache_lru(parent_path_compat(cache_file), projected_bytes, cache_file);
#if LT_ENGINE_USE_LIBSNDFILE
        SF_INFO info{};
        info.channels = channel_count;
        info.samplerate = sample_rate;
        info.format = cache_container_format(duration_frames, channel_count)
                    | cache_sample_format();
        SNDFILE* sf = lt_sf_open(cache_file, SFM_WRITE, &info);
        if (!sf)
            return Result<void>::err(std::string("Could not create PCM cache: ") + sf_strerror(nullptr));
        // CRITICAL for the int16 cache: without clipping enabled, libsndfile
        // WRAPS float samples beyond ±1.0 (e.g. -1.002 → +32694), so the
        // resampler's Gibbs overshoot on hot masters turns transients into
        // full-scale sign-flip crackles baked into the cache. Found on a
        // full-scale acoustic-guitar stem resampled 44.1→48 k.
        sf_command(sf, SFC_SET_CLIPPING, nullptr, SF_TRUE);
        sf_count_t written = 0;
        constexpr sf_count_t kWriteChunkFrames = 65536;
        while (written < static_cast<sf_count_t>(duration_frames)) {
            const sf_count_t frames = std::min<sf_count_t>(
                kWriteChunkFrames,
                static_cast<sf_count_t>(duration_frames) - written);
            const float* ptr = samples.data()
                + static_cast<std::size_t>(written) * channel_count;
            const sf_count_t chunk_written = sf_writef_float(sf, ptr, frames);
            if (chunk_written <= 0)
                break;
            written += chunk_written;
            if (duration_frames > 0) {
                const int pct = 86 + static_cast<int>(
                    (std::min<sf_count_t>(written, static_cast<sf_count_t>(duration_frames)) * 13)
                        / static_cast<sf_count_t>(duration_frames));
                report_progress(pct);
            }
            yield_to_ui_scheduler();
        }
        sf_close(sf);
        if (written != static_cast<sf_count_t>(duration_frames))
            return Result<void>::err("Could not write complete PCM cache: " + cache_file);
#else
        std::ofstream out(cache_file, std::ios::binary | std::ios::trunc);
        if (!out)
            return Result<void>::err("Could not create PCM cache: " + cache_file);
        if (!samples.empty()) {
            constexpr std::size_t kWriteChunkSamples = 65536 * 2;
            std::size_t written_samples = 0;
            while (written_samples < samples.size()) {
                const std::size_t chunk_samples = std::min<std::size_t>(
                    kWriteChunkSamples, samples.size() - written_samples);
                out.write(
                    reinterpret_cast<const char*>(samples.data() + written_samples),
                    static_cast<std::streamsize>(chunk_samples * sizeof(float)));
                if (!out)
                    break;
                written_samples += chunk_samples;
                const int pct = 86 + static_cast<int>(
                    (written_samples * 13) / samples.size());
                report_progress(pct);
                yield_to_ui_scheduler();
            }
        }
        if (!out)
            return Result<void>::err("Could not write PCM cache: " + cache_file);
#endif
    } catch (const std::exception& ex) {
        return Result<void>::err(std::string("PCM cache write failed: ") + ex.what());
    }

    const int block_frames = block_cache_.block_frames();
    const int total_blocks = static_cast<int>((duration_frames + block_frames - 1) / block_frames);
    const int eager_blocks = std::min(total_blocks, eager_source_blocks_from_env());
    for (int block = 0; block < eager_blocks; ++block) {
        const Frame start = static_cast<Frame>(block) * block_frames;
        const int frames = static_cast<int>(
            std::min<Frame>(block_frames, duration_frames - start));
        if (frames <= 0)
            continue;
        const float* ptr = samples.data() + static_cast<std::size_t>(start) * channel_count;
        block_cache_.fill(source_id, block, ptr, channel_count, frames);
    }
    const size_t disk_cache_bytes = samples.size() * sizeof(float);
    samples.clear();
    samples.shrink_to_fit();

    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end())
            return Result<void>::err("Source not registered: " + source_id);

        auto& entry = it->second;
        entry.cache_file_path = cache_file;
        entry.channel_count = channel_count;
        entry.sample_rate = sample_rate;
        entry.duration_frames = duration_frames;
        entry.disk_cache_bytes = disk_cache_bytes;
        entry.source = std::make_shared<DecodedSource>(
            source_id,
            channel_count,
            sample_rate,
            duration_frames,
            &block_cache_,
            [this](const Id& id, int first_block, int block_count, bool urgent) {
                request_blocks(id, first_block, block_count, urgent);
            });
        entry.status = "cache_ready";
        entry.error_message.clear();
        publish_locked(std::move(next));
        ready_callback = source_ready_callback_;
    }
    if (ready_callback)
        ready_callback(source_id);
    return Result<void>::ok();
}

Result<void> SourceManager::decode_and_store_streaming(
    const Id& source_id,
    const std::string& file_path,
    int target_sample_rate,
    SourceStoreProgressCallback on_progress) {
#if LT_ENGINE_USE_LIBSNDFILE
    auto report_progress = [&](int pct) {
        if (on_progress) on_progress(std::clamp(pct, 0, 100));
    };

    auto decoder = make_decoder(file_path);
    if (!decoder)
        return Result<void>::err("No decoder available for: " + file_path);
    report_progress(1);
    auto open_result = decoder->open(file_path);
    if (open_result.is_err())
        return Result<void>::err(open_result.error());

    const AudioFileInfo fi = decoder->info();
    if (fi.duration_frames <= 0 || fi.channel_count <= 0)
        return Result<void>::err("Invalid audio file info: " + file_path);

    const int channel_count = fi.channel_count;
    const int sample_rate = target_sample_rate;
    auto resampler = make_streaming_resampler(
        channel_count, fi.original_sample_rate, target_sample_rate);

    const std::string cache_file = cache_file_for(source_id, file_path, sample_rate);
    // Rough projected size for the LRU pre-eviction (output frames ~ input *
    // ratio); good enough to keep the budget honoured.
    const double ratio = fi.original_sample_rate > 0
        ? static_cast<double>(target_sample_rate) / fi.original_sample_rate : 1.0;
    const Frame projected_out_frames =
        static_cast<Frame>(std::ceil(static_cast<double>(fi.duration_frames) * ratio));
    const size_t projected_bytes =
        static_cast<size_t>(projected_out_frames) * channel_count * sizeof(float);

    if (!create_directories_compat(parent_path_compat(cache_file)))
        return Result<void>::err("Could not create PCM cache directory: " + cache_file);
    evict_cache_lru(parent_path_compat(cache_file), projected_bytes, cache_file);

    SF_INFO info{};
    info.channels = channel_count;
    info.samplerate = sample_rate;
    info.format = cache_container_format(projected_out_frames, channel_count)
                | cache_sample_format();
    SNDFILE* sf = lt_sf_open(cache_file, SFM_WRITE, &info);
    if (!sf)
        return Result<void>::err(std::string("Could not create PCM cache: ") + sf_strerror(nullptr));
    // See the sibling writer above: clipping must be ON or out-of-range floats
    // (resampler overshoot on hot masters) WRAP in the int16 cache as
    // full-scale crackles.
    sf_command(sf, SFC_SET_CLIPPING, nullptr, SF_TRUE);

    const int block_frames = block_cache_.block_frames();
    const int eager_blocks = eager_source_blocks_from_env();
    constexpr int kReadChunkFrames = 65536;

    // R5 progressive availability: publish the source as PLAYABLE up front, with
    // the projected duration, before the whole file is decoded. The decode loop
    // fills blocks into the RAM cache as it produces them and advances
    // `decoded_frames`; the play gate (playback_audio_window_ready) only waits on
    // the playhead window's blocks, so playback starts on the decoded head while
    // the tail keeps filling. Blocks past `decoded_frames` are absent → silence
    // (Ableton's "decoded part plays, rest silent"). The disk fill worker is
    // gated to not read past `decoded_frames` while status=="streaming" because
    // the WAV header/data-chunk size isn't finalized until sf_close.
    auto decoded_frames = std::make_shared<std::atomic<Frame>>(0);
    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end()) {
            sf_close(sf);
            return Result<void>::err("Source not registered: " + source_id);
        }
        auto& entry = it->second;
        entry.cache_file_path = cache_file;
        entry.channel_count = channel_count;
        entry.sample_rate = sample_rate;
        entry.duration_frames = projected_out_frames;
        entry.decoded_frames = decoded_frames;
        entry.source = std::make_shared<DecodedSource>(
            source_id, channel_count, sample_rate, projected_out_frames,
            &block_cache_,
            [this](const Id& id, int first_block, int block_count, bool urgent) {
                request_blocks(id, first_block, block_count, urgent);
            });
        entry.status = "streaming";
        entry.error_message.clear();
        publish_locked(std::move(next));
    }

    std::vector<float> in_chunk(static_cast<std::size_t>(kReadChunkFrames) * channel_count);
    std::vector<float> out_chunk;  // resampled interleaved output, reused per chunk
    Frame in_done = 0;
    Frame out_written = 0;   // frames written to the cache so far
    bool decode_ok = true;
    // Exact target output length (matches the whole-file resample). We collect
    // exactly this many output frames, feeding silence after real input ends to
    // flush the resampler's internal latency tail (r8brain emits output with an
    // internal delay; the oneshot helper does the same zero-feed trick).
    const Frame target_out_frames = projected_out_frames;

    // Accumulate waveform peaks in the SAME pass (Ableton-style single decode),
    // at the UI's waveform resolution, so the UI never re-decodes the file.
    constexpr Frame kPeakBucketWidth = 256;  // ENGINE_WAVEFORM_RESOLUTION_FRAMES
    const std::size_t peak_buckets = static_cast<std::size_t>(
        (target_out_frames + kPeakBucketWidth - 1) / kPeakBucketWidth);
    const bool has_right = channel_count >= 2;
    auto peaks = std::make_shared<SourcePeakOverview>();
    peaks->sample_rate = sample_rate;
    peaks->resolution_frames = static_cast<int>(kPeakBucketWidth);
    peaks->min_peaks.assign(peak_buckets, 0.f);
    peaks->max_peaks.assign(peak_buckets, 0.f);
    if (has_right) {
        peaks->min_peaks_right.assign(peak_buckets, 0.f);
        peaks->max_peaks_right.assign(peak_buckets, 0.f);
    }
    std::vector<bool> peak_init(peak_buckets, false);
    auto accumulate_peaks = [&](const float* interleaved, Frame start_frame, Frame n) {
        for (Frame i = 0; i < n; ++i) {
            const std::size_t b = static_cast<std::size_t>((start_frame + i) / kPeakBucketWidth);
            if (b >= peak_buckets) break;
            const float* row = interleaved + static_cast<std::size_t>(i) * channel_count;
            const float l = std::clamp(row[0], -1.f, 1.f);
            const float r = has_right ? std::clamp(row[1], -1.f, 1.f) : 0.f;
            if (!peak_init[b]) {
                peaks->min_peaks[b] = l; peaks->max_peaks[b] = l;
                if (has_right) { peaks->min_peaks_right[b] = r; peaks->max_peaks_right[b] = r; }
                peak_init[b] = true;
            } else {
                peaks->min_peaks[b] = std::min(peaks->min_peaks[b], l);
                peaks->max_peaks[b] = std::max(peaks->max_peaks[b], l);
                if (has_right) {
                    peaks->min_peaks_right[b] = std::min(peaks->min_peaks_right[b], r);
                    peaks->max_peaks_right[b] = std::max(peaks->max_peaks_right[b], r);
                }
            }
        }
    };

    // Write `produced` interleaved frames from `out_chunk` to the cache + eager
    // blocks, capped so the total never exceeds target_out_frames. Returns the
    // number of frames actually written (post-cap).
    auto write_output = [&](Frame produced) -> bool {
        if (produced <= 0) return true;
        const Frame remaining = target_out_frames - out_written;
        if (remaining <= 0) return true;  // already have the full output
        const Frame n = std::min<Frame>(produced, remaining);
        const sf_count_t w = sf_writef_float(sf, out_chunk.data(),
                                             static_cast<sf_count_t>(n));
        if (w <= 0) return false;
        accumulate_peaks(out_chunk.data(), out_written, n);  // same-pass waveform
        // R5: fill only the first `eager_blocks` into RAM as they're decoded, so
        // the progressively published source is instantly audible from its head
        // without a disk round-trip. The rest are pulled on demand by the fill
        // worker from the cache file (gated by decoded_frames so it never reads
        // unwritten data). We deliberately do NOT fill the whole file into RAM:
        // the block cache is a SHARED bounded LRU (512 MB across all sources), so
        // eagerly filling every block of several concurrently-imported songs
        // blows the budget → constant eviction churn + disk re-reads contending
        // with the decode writers = the import-while-playing stutter.
        const Frame chunk_start = out_written;
        for (Frame local = 0; local < n; ) {
            const Frame abs_frame = chunk_start + local;
            const int block_index = static_cast<int>(abs_frame / block_frames);
            if (block_index >= eager_blocks) break;
            const Frame block_start = static_cast<Frame>(block_index) * block_frames;
            const int offset_in_block = static_cast<int>(abs_frame - block_start);
            const int frames_this_block = std::min(
                block_frames - offset_in_block, static_cast<int>(n - local));
            if (offset_in_block == 0 && frames_this_block == block_frames) {
                const float* ptr = out_chunk.data() +
                    static_cast<std::size_t>(local) * channel_count;
                block_cache_.fill(source_id, block_index, ptr, channel_count, block_frames);
            }
            local += frames_this_block;
        }
        out_written += n;
        // Publish the new valid extent AFTER writing so readers/fill worker never
        // see frames that aren't on disk yet (release so the writes above are
        // visible to the audio/fill threads that acquire it).
        decoded_frames->store(out_written, std::memory_order_release);
        return true;
    };

    // Cede the disk to the live block-fill thread between chunks. This is the
    // heavy disk-WRITE loop, and it runs on a decode worker WHILE playback may be
    // streaming OTHER tracks' blocks off the same disk — without yielding here,
    // a first-time (uncached) import starves the live fill thread and the playing
    // tracks glitch (the user's "petardeo on first import while playing"). The
    // streaming rewrite had dropped this throttle in favour of a fixed 1ms/16-
    // chunk breather, which doesn't back off while playing; restore the
    // playback-aware yield (decode_background_yield sleeps ~6ms while playing,
    // ~1ms idle) so cold opens stay fast but live playback wins the disk. R3 made
    // this matter more: several decode workers can write concurrently now.
    auto light_yield = []() { decode_background_yield(); };

    // Phase 1: feed real decoded input.
    while (in_done < fi.duration_frames && out_written < target_out_frames) {
        const int want = static_cast<int>(std::min<Frame>(
            kReadChunkFrames, fi.duration_frames - in_done));
        const int got = decoder->read_frames(in_chunk.data(), want);
        if (got <= 0) break;  // unexpected EOF; flush handles the rest
        in_done += got;
        out_chunk.clear();
        const Frame produced = resampler->process_chunk(
            in_chunk.data(), got, /*end_of_input=*/false, out_chunk);
        if (produced < 0 || !write_output(produced)) { decode_ok = false; break; }
        if (fi.duration_frames > 0) {
            report_progress(1 + static_cast<int>((in_done * 98) / fi.duration_frames));
        }
        light_yield();
    }

    // Phase 2: flush the resampler's latency tail. The tail is only a few hundred
    // frames, so feed SMALL silence blocks (not 64k!) and stop the moment the
    // resampler stops producing — otherwise we'd resample millions of silence
    // frames (huge slowdown) chasing a target_out_frames that ceil() rounding can
    // leave 1-2 frames above what the resampler will ever emit.
    if (decode_ok) {
        constexpr int kFlushBlock = 1024;
        std::fill(in_chunk.begin(), in_chunk.begin() + kFlushBlock * channel_count, 0.0f);
        int empty_runs = 0;
        int guard = 0;
        const int kMaxFlush = 256;  // « 256k input frames of latency is impossible
        while (out_written < target_out_frames && guard++ < kMaxFlush) {
            out_chunk.clear();
            const Frame produced = resampler->process_chunk(
                in_chunk.data(), kFlushBlock, /*end_of_input=*/true, out_chunk);
            if (produced < 0) { decode_ok = false; break; }
            if (produced == 0) {
                if (++empty_runs >= 2) break;  // resampler drained; stop chasing
                continue;
            }
            empty_runs = 0;
            if (!write_output(produced)) { decode_ok = false; break; }
        }
    }

    sf_close(sf);
    decoder->close();

    if (!decode_ok || out_written <= 0)
        return Result<void>::err("Streaming decode failed: " + file_path);

    const Frame duration_frames = out_written;
    const size_t disk_cache_bytes =
        static_cast<size_t>(out_written) * channel_count * sizeof(float);
    peaks->duration_frames = duration_frames;
    // Trim the peak arrays to the actual bucket count (out_written may be a hair
    // under target_out_frames after the latency flush).
    {
        const std::size_t used = static_cast<std::size_t>(
            (duration_frames + kPeakBucketWidth - 1) / kPeakBucketWidth);
        if (used < peaks->min_peaks.size()) {
            peaks->min_peaks.resize(used);
            peaks->max_peaks.resize(used);
            if (has_right) {
                peaks->min_peaks_right.resize(used);
                peaks->max_peaks_right.resize(used);
            }
        }
    }

    SourceReadyCallback ready_callback;
    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end())
            return Result<void>::err("Source not registered: " + source_id);
        auto& entry = it->second;
        entry.cache_file_path = cache_file;
        entry.channel_count = channel_count;
        entry.sample_rate = sample_rate;
        entry.duration_frames = duration_frames;
        entry.disk_cache_bytes = disk_cache_bytes;
        entry.cached_peaks = peaks;  // same-pass waveform; UI skips re-decode
        entry.source = std::make_shared<DecodedSource>(
            source_id, channel_count, sample_rate, duration_frames,
            &block_cache_,
            [this](const Id& id, int first_block, int block_count, bool urgent) {
                request_blocks(id, first_block, block_count, urgent);
            });
        // R5: the cache file is now closed and finalized — open the disk gate to
        // the full length so the fill worker can fetch any (incl. evicted) block.
        decoded_frames->store(duration_frames, std::memory_order_release);
        entry.decoded_frames = decoded_frames;
        entry.status = "cache_ready";
        entry.error_message.clear();
        publish_locked(std::move(next));
        ready_callback = source_ready_callback_;
    }
    if (ready_callback)
        ready_callback(source_id);
    return Result<void>::ok();
#else
    (void)source_id; (void)file_path; (void)target_sample_rate; (void)on_progress;
    return Result<void>::err("streaming decode requires libsndfile");
#endif
}

void SourceManager::request_block(const Id& source_id,
                                  int block_index,
                                  bool urgent) const noexcept {
    request_blocks(source_id, block_index, 1, urgent);
}

void SourceManager::request_blocks(const Id& source_id,
                                   int first_block,
                                   int block_count,
                                   bool urgent) const noexcept {
    if (first_block < 0 || block_count <= 0)
        return;
    fill_requests_.fetch_add(static_cast<uint64_t>(block_count),
                             std::memory_order_relaxed);

    // Deliberately NOT calling block_cache_.has_block() here. Most callers are
    // the AUDIO THREAD (DecodedSource::read read-ahead), and has_block takes
    // the very mutex the callback reads its samples under — one extra
    // acquisition per read-ahead block, on every track, forever. The
    // already-cached blocks that now reach the queue are dropped by
    // fill_blocks_from_disk, which filters a whole batch under a single lock
    // held off the audio thread.
    //
    // One CacheKey is reused across the window so the source id is copied once
    // rather than per block: Id is a std::string longer than the small-string
    // buffer, so a copy per block is a malloc per block on the audio thread.
    CacheKey key{source_id, first_block};
    int enqueued = 0;
    {
        std::lock_guard lock(fill_mtx_);
        for (int offset = 0; offset < block_count; ++offset) {
            key.block_index = first_block + offset;
            auto it = queued_blocks_.find(key);
            if (it != queued_blocks_.end()) {
                // Already queued. If it was read-ahead and the audio thread is
                // now starving for it, promote it: push onto the urgent side
                // and leave the read-ahead entry where it is. The stale entry
                // costs nothing — fill_blocks_from_disk filters out blocks that
                // are already cached by the time it runs.
                if (!urgent || it->second)
                    continue;
                it->second = true;
                fill_queue_urgent_.push_back(key);
                ++enqueued;
                continue;
            }
            queued_blocks_[key] = urgent;
            if (urgent)
                fill_queue_urgent_.push_back(key);
            else
                fill_queue_.push(key);
            ++enqueued;
            fill_enqueued_.fetch_add(1, std::memory_order_relaxed);
        }
    }
    // Only when there is new work. The unconditional notify woke a worker for
    // every already-queued block too, which on a starving session is a futex
    // storm raised by the audio thread against the very threads meant to feed
    // it. A whole window's worth of new work wakes the entire pool, though:
    // waking one would leave the other workers asleep on work they could take.
    if (enqueued > 1)
        fill_cv_.notify_all();
    else if (enqueued == 1)
        fill_cv_.notify_one();
}

void SourceManager::request_range(const Id& source_id, Frame source_frame, int frame_count) const noexcept {
    if (frame_count <= 0)
        return;
    const auto source = get_shared(source_id);
    if (!source || !source->is_streaming())
        return;
    const Frame start = std::max<Frame>(0, source_frame);
    if (start >= source->duration_frames())
        return;
    const Frame end = std::min<Frame>(
        source->duration_frames() - 1,
        start + static_cast<Frame>(frame_count) - 1);
    const int first = block_cache_.block_index_for(start);
    const int last = block_cache_.block_index_for(end);

    std::vector<int> missing_blocks;
    missing_blocks.reserve(static_cast<std::size_t>(last - first + 1));
    block_cache_.append_missing_blocks(source_id, first, last, missing_blocks);
    if (missing_blocks.empty())
        return;

    bool queued_any = false;
    {
        std::lock_guard lock(fill_mtx_);
        for (int block : missing_blocks) {
            CacheKey key{source_id, block};
            if (queued_blocks_.find(key) != queued_blocks_.end())
                continue;
            queued_blocks_[key] = true;
            fill_queue_.push(key);
            queued_any = true;
        }
    }
    if (queued_any)
        fill_cv_.notify_one();
}

CacheDiagnostics SourceManager::cache_diagnostics() const {
    return block_cache_.diagnostics();
}

FillIoStats SourceManager::take_fill_io_stats() noexcept {
    FillIoStats stats;
    stats.open_count = fill_open_count_.exchange(0, std::memory_order_relaxed);
    stats.open_failures = fill_open_failures_.exchange(0, std::memory_order_relaxed);
    stats.open_max_us = fill_open_max_us_.exchange(0, std::memory_order_relaxed);
    stats.read_count = fill_read_count_.exchange(0, std::memory_order_relaxed);
    stats.read_failures = fill_read_failures_.exchange(0, std::memory_order_relaxed);
    stats.read_max_us = fill_read_max_us_.exchange(0, std::memory_order_relaxed);
    stats.frames_read = fill_frames_read_.exchange(0, std::memory_order_relaxed);
    stats.requests = fill_requests_.exchange(0, std::memory_order_relaxed);
    stats.enqueued = fill_enqueued_.exchange(0, std::memory_order_relaxed);
    {
        std::lock_guard lock(fill_mtx_);
        stats.queue_urgent = fill_queue_urgent_.size();
        stats.queue_normal = fill_queue_.size();
    }
    stats.active_readers = fill_readers_open_.load(std::memory_order_acquire);
    return stats;
}

void SourceManager::preload_clip_heads(
        const std::vector<std::pair<Id, Frame>>& clip_starts,
        size_t max_blocks) const {
    // Replace the whole set: the caller owns the policy and passes the song it
    // is on, so anything pinned for a previous song must stop being pinned.
    block_cache_.unpin_all();

    size_t pinned = 0;
    for (const auto& [source_id, start_frame] : clip_starts) {
        if (pinned >= max_blocks) break;
        const auto source = get_shared(source_id);
        if (!source || !source->is_streaming())
            continue;  // a fully-resident source needs no preload
        if (start_frame < 0 || start_frame >= source->duration_frames())
            continue;
        const int block = block_cache_.block_index_for(start_frame);
        block_cache_.pin(source_id, block);
        // Pinning only records intent; the block still has to be fetched. Mark
        // it urgent so it lands before any read-ahead already in flight.
        request_block(source_id, block, /*urgent=*/true);
        ++pinned;
    }

    if (lt_env_flag_enabled("LIBRETRACKS_AUDIO_DIAG")) {
        lt_debug_log(
            "[LT_PRELOAD] pinned %zu clip head(s) of %zu requested (cap %zu, %.1f MB)\n",
            pinned, clip_starts.size(), max_blocks,
            double(pinned) * kDefaultBlockFrames * 2 * sizeof(float) / (1024.0 * 1024.0));
    }
}

size_t SourceManager::fill_queue_depth() const noexcept {
    std::lock_guard lock(fill_mtx_);
    return fill_queue_urgent_.size() + fill_queue_.size();
}

SourcePeakOverview SourceManager::source_peaks(const Id& source_id,
                                               int resolution_frames) const {
    SourcePeakOverview overview;
    overview.resolution_frames = std::max(1, resolution_frames);

    Entry entry;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return overview;
        entry = it->second;
    }

    overview.sample_rate = entry.sample_rate;
    overview.duration_frames = entry.duration_frames;
    if (!entry.source || !entry.source->is_loaded()
        || entry.channel_count <= 0 || entry.duration_frames <= 0) {
        return overview;
    }

    // Fast path: peaks were computed in the same pass as the streaming decode.
    // Return them directly — no cache re-read, no MP3 re-decode for the UI.
    if (entry.cached_peaks &&
        entry.cached_peaks->resolution_frames == overview.resolution_frames) {
        return *entry.cached_peaks;
    }

    // R5: while a streaming decode is still in flight (status "streaming"), the
    // cache file is only partially written and its WAV data-chunk size isn't
    // finalized — reading it now yields a HALF waveform (or garbage) keyed to the
    // projected full duration, which the caller would then cache as if complete.
    // The same-pass peaks (cached_peaks) are published atomically at the end, so
    // return no peaks now (duration is known) and let the UI poll until they land.
    if (entry.status == "streaming")
        return overview;

    if (entry.cache_file_path.empty())
        return entry.source->peaks(overview.resolution_frames);

    const Frame bucket_width = static_cast<Frame>(overview.resolution_frames);
    const std::size_t bucket_count = static_cast<std::size_t>(
        (entry.duration_frames + bucket_width - 1) / bucket_width);
    std::vector<float> min_peaks(bucket_count, 0.f);
    std::vector<float> max_peaks(bucket_count, 0.f);
    const bool has_right_channel = entry.channel_count >= 2;
    std::vector<float> min_peaks_right(has_right_channel ? bucket_count : 0, 0.f);
    std::vector<float> max_peaks_right(has_right_channel ? bucket_count : 0, 0.f);
    std::vector<bool> initialized(bucket_count, false);

    constexpr int kChunkFrames = 16384;
    std::vector<float> data(static_cast<std::size_t>(kChunkFrames)
                            * static_cast<std::size_t>(entry.channel_count),
                            0.f);

    Frame cursor = 0;
#if LT_ENGINE_USE_LIBSNDFILE
    SF_INFO info{};
    SNDFILE* sf = lt_sf_open(entry.cache_file_path, SFM_READ, &info);
    if (!sf)
        return overview;
    if (info.channels != entry.channel_count) {
        sf_close(sf);
        return overview;
    }
    while (cursor < entry.duration_frames) {
        const int frames_to_read = static_cast<int>(
            std::min<Frame>(kChunkFrames, entry.duration_frames - cursor));
        const int frames_read = static_cast<int>(
            sf_readf_float(sf, data.data(), static_cast<sf_count_t>(frames_to_read)));
        if (frames_read <= 0)
            break;
#else
    std::ifstream in(entry.cache_file_path, std::ios::binary);
    if (!in)
        return overview;
    while (cursor < entry.duration_frames) {
        const int frames_to_read = static_cast<int>(
            std::min<Frame>(kChunkFrames, entry.duration_frames - cursor));
        const std::size_t sample_count =
            static_cast<std::size_t>(frames_to_read) * entry.channel_count;
        in.read(reinterpret_cast<char*>(data.data()),
                static_cast<std::streamsize>(sample_count * sizeof(float)));
        const int frames_read = static_cast<int>(
            static_cast<std::size_t>(in.gcount())
            / (sizeof(float) * static_cast<std::size_t>(entry.channel_count)));
        if (frames_read <= 0)
            break;
#endif
        for (int frame = 0; frame < frames_read; ++frame) {
            const Frame absolute = cursor + frame;
            const std::size_t bucket = static_cast<std::size_t>(absolute / bucket_width);
            if (bucket >= bucket_count)
                continue;
            const float* row = data.data()
                + static_cast<std::size_t>(frame) * entry.channel_count;
            const float value = std::clamp(row[0], -1.f, 1.f);
            const float right = has_right_channel ? std::clamp(row[1], -1.f, 1.f) : 0.f;
            if (!initialized[bucket]) {
                min_peaks[bucket] = value;
                max_peaks[bucket] = value;
                if (has_right_channel) {
                    min_peaks_right[bucket] = right;
                    max_peaks_right[bucket] = right;
                }
                initialized[bucket] = true;
            } else {
                min_peaks[bucket] = std::min(min_peaks[bucket], value);
                max_peaks[bucket] = std::max(max_peaks[bucket], value);
                if (has_right_channel) {
                    min_peaks_right[bucket] = std::min(min_peaks_right[bucket], right);
                    max_peaks_right[bucket] = std::max(max_peaks_right[bucket], right);
                }
            }
        }
        cursor += frames_read;
    }
#if LT_ENGINE_USE_LIBSNDFILE
    sf_close(sf);
#endif

    if (cursor <= 0)
        return overview;

    overview.min_peaks = std::move(min_peaks);
    overview.max_peaks = std::move(max_peaks);
    overview.min_peaks_right = std::move(min_peaks_right);
    overview.max_peaks_right = std::move(max_peaks_right);
    return overview;
}

SourcePeakWindow SourceManager::source_peaks_window(const Id& source_id,
                                                    Frame start_frame,
                                                    Frame end_frame,
                                                    int bucket_count) const {
    SourcePeakWindow window;

    Entry entry;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return window;
        entry = it->second;
    }

    window.sample_rate = entry.sample_rate;
    if (!entry.source || !entry.source->is_loaded() || entry.channel_count <= 0
        || entry.duration_frames <= 0 || entry.status == "streaming") {
        return window;
    }

    const Frame clamped_start = std::clamp<Frame>(start_frame, 0, entry.duration_frames);
    const Frame clamped_end = std::clamp<Frame>(end_frame, clamped_start,
                                                entry.duration_frames);
    const Frame span = clamped_end - clamped_start;
    if (span <= 0 || bucket_count <= 0)
        return window;

    // Bound hostile/accidental requests while preserving one bucket per source
    // frame. Normal callers request roughly one bucket per physical pixel.
    constexpr int kMaxBuckets = 1 << 20;
    const int actual_buckets = static_cast<int>(std::min<Frame>(
        span, std::min(bucket_count, kMaxBuckets)));
    const bool stereo = entry.channel_count >= 2;

    window.start_frame = clamped_start;
    window.end_frame = clamped_end;
    window.bucket_count = actual_buckets;
    window.min_peaks.assign(static_cast<std::size_t>(actual_buckets), 0.f);
    window.max_peaks.assign(static_cast<std::size_t>(actual_buckets), 0.f);
    if (stereo) {
        window.min_peaks_right.assign(static_cast<std::size_t>(actual_buckets), 0.f);
        window.max_peaks_right.assign(static_cast<std::size_t>(actual_buckets), 0.f);
    }
    std::vector<bool> initialized(static_cast<std::size_t>(actual_buckets), false);

    auto consume = [&](Frame relative, float left, float right) {
        const auto bucket = static_cast<std::size_t>(std::min<Frame>(
            actual_buckets - 1,
            (relative * static_cast<Frame>(actual_buckets)) / span));
        left = std::clamp(left, -1.f, 1.f);
        right = std::clamp(right, -1.f, 1.f);
        if (!initialized[bucket]) {
            window.min_peaks[bucket] = window.max_peaks[bucket] = left;
            if (stereo)
                window.min_peaks_right[bucket] = window.max_peaks_right[bucket] = right;
            initialized[bucket] = true;
            return;
        }
        window.min_peaks[bucket] = std::min(window.min_peaks[bucket], left);
        window.max_peaks[bucket] = std::max(window.max_peaks[bucket], left);
        if (stereo) {
            window.min_peaks_right[bucket] = std::min(window.min_peaks_right[bucket], right);
            window.max_peaks_right[bucket] = std::max(window.max_peaks_right[bucket], right);
        }
    };

    constexpr int kChunkFrames = 16384;
    Frame cursor = clamped_start;
    if (entry.cache_file_path.empty()) {
        std::vector<float> left(static_cast<std::size_t>(kChunkFrames), 0.f);
        std::vector<float> right(stereo ? static_cast<std::size_t>(kChunkFrames) : 0, 0.f);
        while (cursor < clamped_end) {
            const int wanted = static_cast<int>(
                std::min<Frame>(kChunkFrames, clamped_end - cursor));
            float* outputs[2] = {left.data(), stereo ? right.data() : nullptr};
            const int read = entry.source->read(cursor, wanted, outputs, stereo ? 2 : 1);
            if (read <= 0)
                break;
            for (int frame = 0; frame < read; ++frame)
                consume(cursor + frame - clamped_start, left[frame],
                        stereo ? right[frame] : 0.f);
            cursor += read;
        }
    } else {
        std::vector<float> interleaved(static_cast<std::size_t>(kChunkFrames)
                                       * static_cast<std::size_t>(entry.channel_count), 0.f);
#if LT_ENGINE_USE_LIBSNDFILE
        SF_INFO info{};
        SNDFILE* sf = lt_sf_open(entry.cache_file_path, SFM_READ, &info);
        if (!sf || info.channels != entry.channel_count
            || sf_seek(sf, static_cast<sf_count_t>(clamped_start), SEEK_SET) < 0) {
            if (sf) sf_close(sf);
            window.min_peaks.clear();
            window.max_peaks.clear();
            window.min_peaks_right.clear();
            window.max_peaks_right.clear();
            return window;
        }
#else
        std::ifstream in(entry.cache_file_path, std::ios::binary);
        if (!in) {
            window.min_peaks.clear();
            window.max_peaks.clear();
            window.min_peaks_right.clear();
            window.max_peaks_right.clear();
            return window;
        }
        in.seekg(static_cast<std::streamoff>(clamped_start)
                 * entry.channel_count * sizeof(float), std::ios::beg);
#endif
        while (cursor < clamped_end) {
            const int wanted = static_cast<int>(
                std::min<Frame>(kChunkFrames, clamped_end - cursor));
#if LT_ENGINE_USE_LIBSNDFILE
            const int read = static_cast<int>(sf_readf_float(
                sf, interleaved.data(), static_cast<sf_count_t>(wanted)));
#else
            const std::size_t sample_count = static_cast<std::size_t>(wanted)
                                           * entry.channel_count;
            in.read(reinterpret_cast<char*>(interleaved.data()),
                    static_cast<std::streamsize>(sample_count * sizeof(float)));
            const int read = static_cast<int>(static_cast<std::size_t>(in.gcount())
                / (sizeof(float) * static_cast<std::size_t>(entry.channel_count)));
#endif
            if (read <= 0)
                break;
            for (int frame = 0; frame < read; ++frame) {
                const float* row = interleaved.data()
                    + static_cast<std::size_t>(frame) * entry.channel_count;
                consume(cursor + frame - clamped_start, row[0], stereo ? row[1] : 0.f);
            }
            cursor += read;
        }
#if LT_ENGINE_USE_LIBSNDFILE
        sf_close(sf);
#endif
    }

    // Never expose a partial window under a cache key that implies completeness.
    if (cursor != clamped_end) {
        window.min_peaks.clear();
        window.max_peaks.clear();
        window.min_peaks_right.clear();
        window.max_peaks_right.clear();
    }
    return window;
}

const DecodedSource* SourceManager::get(const Id& source_id) const noexcept {
    auto entries = load_entries();
    auto it = entries->find(source_id);
    if (it == entries->end()) return nullptr;
    auto source = it->second.source;
    return source ? source.get() : nullptr;
}

std::shared_ptr<const DecodedSource>
SourceManager::get_shared(const Id& source_id) const noexcept {
    auto entries = load_entries();
    auto it = entries->find(source_id);
    if (it == entries->end()) return {};
    return it->second.source;
}

std::vector<SourceDiagnostics> SourceManager::diagnostics() const {
    std::vector<SourceDiagnostics> out;
    auto entries = load_entries();
    out.reserve(entries->size());
    for (const auto& [id, entry] : *entries) {
        SourceDiagnostics d;
        d.source_id     = id;
        d.file_path     = entry.file_path;
        d.status        = entry.status;
        d.error_message = entry.error_message;
        auto source = entry.source;
        if (source) {
            d.channel_count   = source->channel_count();
            d.sample_rate     = source->sample_rate();
            d.duration_frames = source->duration_frames();
            d.memory_bytes    = source->memory_bytes();
            d.disk_cache_bytes = entry.disk_cache_bytes;
            d.storage_kind = source->is_streaming() ? "disk_cache" : "memory";
        }
        out.push_back(std::move(d));
    }
    return out;
}

Frame SourceManager::total_cache_miss_frames() const noexcept {
    Frame total = 0;
    auto entries = load_entries();
    for (const auto& [id, entry] : *entries) {
        if (entry.source)
            total += entry.source->cache_miss_frames();
    }
    return total;
}

std::size_t SourceManager::release_cached_blocks_under_pressure(std::size_t keep_per_source) {
    // Deliberately does NOT take write_mutex_: this runs on whatever thread the
    // OS delivers the low-memory warning on, and blocking behind a session load
    // would defeat the point of reacting quickly. BlockCache does its own
    // locking, and it is the only thing we touch.
    const std::size_t freed = block_cache_.release_unprotected(keep_per_source);
    lt_debug_log("[LT_MEMPRESSURE] released %zu MB from the block cache (keep=%zu/source)\n",
                 freed / (1024 * 1024), keep_per_source);
    return freed;
}

void SourceManager::clear() {
    std::lock_guard lock(write_mutex_);
    // Invalidate every fill worker's cached file handle (see FillReader).
    fill_generation_.fetch_add(1, std::memory_order_release);
    publish_locked(EntryMap{});
    {
        std::lock_guard fill_lock(fill_mtx_);
        std::queue<CacheKey> empty;
        fill_queue_.swap(empty);
        fill_queue_urgent_.clear();
        queued_blocks_.clear();
    }
    // Wake every fill worker so it releases its cache-file handle, and wait
    // until none is held. Callers clear() precisely because they are about to
    // delete or rewrite these files (purge_source_cache, a re-decode at a new
    // sample rate); returning while a worker still has one open would make the
    // unlink fail on Windows. Workers block only on fill_mtx_ and lock-free
    // entry loads, never on write_mutex_, so waiting here cannot deadlock.
    {
        std::unique_lock fill_lock(fill_mtx_);
        fill_cv_.notify_all();
        fill_idle_cv_.wait_for(fill_lock, std::chrono::seconds(2), [this] {
            return fill_readers_open_.load(std::memory_order_acquire) == 0;
        });
    }

    // Drop all decoded PCM blocks too. They are keyed by source_id+block_index
    // only (NOT by sample rate), so after a device SR change re-decodes the
    // sources, the audio thread would otherwise keep serving stale blocks from
    // the OLD rate for any region already buffered — heard as a sudden pitch /
    // speed jump partway through playback. Clearing entries alone is not enough.
    block_cache_.clear();
}

// --- FillReader: one long-lived cache-file handle per fill worker -----------

SourceManager::FillReader::~FillReader() {
    close();
}

void SourceManager::FillReader::close() noexcept {
    if (!handle)
        return;
#if LT_ENGINE_USE_LIBSNDFILE
    sf_close(static_cast<SNDFILE*>(handle));
#else
    delete static_cast<std::ifstream*>(handle);
#endif
    handle = nullptr;
    if (open_counter)
        open_counter->fetch_sub(1, std::memory_order_release);
    source_id.clear();
    path.clear();
    channel_count = 0;
}

bool SourceManager::FillReader::open_for(const Id& id,
                                         const std::string& file_path,
                                         int channels) {
    // Same source AND same file → reuse. The path is compared too because a
    // source re-decoded at a new sample rate writes a different cache file
    // under the same id; reusing the stale handle would serve old-rate audio.
    if (handle && source_id == id && path == file_path && channel_count == channels)
        return true;

    const uint64_t gen = generation;
    close();
    generation = gen;

    if (open_count)
        open_count->fetch_add(1, std::memory_order_relaxed);
    const auto open_started = std::chrono::steady_clock::now();
    const auto finish_open = [this, open_started](bool success) {
        const auto elapsed = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - open_started).count());
        if (open_max_us) {
            uint64_t previous = open_max_us->load(std::memory_order_relaxed);
            while (previous < elapsed &&
                   !open_max_us->compare_exchange_weak(
                       previous, elapsed, std::memory_order_relaxed)) {}
        }
        if (!success && open_failures)
            open_failures->fetch_add(1, std::memory_order_relaxed);
        return success;
    };

#if LT_ENGINE_USE_LIBSNDFILE
    SF_INFO info{};
    SNDFILE* sf = lt_sf_open(file_path, SFM_READ, &info);
    if (!sf)
        return finish_open(false);
    if (info.channels != channels) {
        sf_close(sf);
        return finish_open(false);
    }
    handle = sf;
#else
    auto in = std::make_unique<std::ifstream>(file_path, std::ios::binary);
    if (!in || !*in)
        return finish_open(false);
    handle = in.release();
#endif
    source_id = id;
    path = file_path;
    channel_count = channels;
    if (open_counter)
        open_counter->fetch_add(1, std::memory_order_release);
    return finish_open(true);
}

void SourceManager::fill_worker_loop() const {
#if defined(_WIN32)
    // This thread serves the blocks the *playing* tracks need right now. Lift it
    // above the decode workers (THREAD_PRIORITY_BELOW_NORMAL) so a heavy decode
    // of a freshly-imported source can't preempt the live stream's disk reads.
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
#endif
    // Owned by this thread only — see FillReader's comment.
    //
    // A single retained reader thrashes when the queue alternates across stems:
    // every switch closed one cache file and opened another, so a 27-stem
    // session paid an open per block instead of an open per file. The pool
    // keeps one handle per source instead.
    //
    // The bound is a file-descriptor budget, not a memory one: iOS gives a
    // process 256 descriptors by default and the WebView wants its share, so
    // two workers must not be able to hold more than a fraction of that.
    constexpr std::size_t kMaxReadersPerWorker = 32;
    std::unordered_map<Id, std::unique_ptr<FillReader>> readers;
    uint64_t reader_generation = fill_generation_.load(std::memory_order_acquire);
    const auto close_all_readers = [&] {
        for (auto& [id, reader] : readers)
            reader->close();
        readers.clear();
    };
    while (true) {
        CacheKey key;
        std::vector<int> block_batch;
        {
            std::unique_lock lock(fill_mtx_);
            fill_cv_.wait(lock, [this, &reader_generation] {
                return fill_stop_ || !fill_queue_urgent_.empty() || !fill_queue_.empty()
                    || reader_generation !=
                           fill_generation_.load(std::memory_order_acquire);
            });
            if (fill_stop_ && fill_queue_urgent_.empty() && fill_queue_.empty()) {
                close_all_readers();
                return;
            }
            // Sources were invalidated (clear()): drop the handle NOW, while we
            // are awake, rather than on the next batch. Callers that clear in
            // order to delete or rewrite the cache files (purge_source_cache,
            // a re-decode at a new sample rate) need the file released
            // promptly — on Windows an open handle blocks the unlink outright.
            const uint64_t generation =
                fill_generation_.load(std::memory_order_acquire);
            if (reader_generation != generation) {
                close_all_readers();
                reader_generation = generation;
                fill_idle_cv_.notify_all();
                if (fill_queue_urgent_.empty() && fill_queue_.empty())
                    continue;
            }
            if (!fill_queue_urgent_.empty()) {
                // Starving block: take exactly one and go. Batching would only
                // delay it behind material the renderer does not need yet, and
                // every block on this side is wanted by a different track.
                key = fill_queue_urgent_.front();
                fill_queue_urgent_.pop_front();
                queued_blocks_.erase(key);
                block_batch.push_back(key.block_index);
            } else {
                key = fill_queue_.front();
                fill_queue_.pop();
                queued_blocks_.erase(key);

                block_batch.push_back(key.block_index);
                constexpr std::size_t kMaxBatchBlocks = 64;
                while (!fill_queue_.empty() && block_batch.size() < kMaxBatchBlocks) {
                    const CacheKey& next = fill_queue_.front();
                    if (next.source_id != key.source_id ||
                        next.block_index != block_batch.back() + 1) {
                        break;
                    }
                    block_batch.push_back(next.block_index);
                    queued_blocks_.erase(next);
                    fill_queue_.pop();
                }
            }
        }
        auto reader_it = readers.find(key.source_id);
        if (reader_it == readers.end()) {
            if (readers.size() >= kMaxReadersPerWorker)
                readers.erase(readers.begin());
            auto reader = std::make_unique<FillReader>();
            reader->generation = reader_generation;
            reader->open_counter = &fill_readers_open_;
            reader->open_count = &fill_open_count_;
            reader->open_failures = &fill_open_failures_;
            reader->open_max_us = &fill_open_max_us_;
            reader_it = readers.emplace(key.source_id, std::move(reader)).first;
        }
        fill_blocks_from_disk(key.source_id, block_batch, *reader_it->second);
    }
}

void SourceManager::fill_blocks_from_disk(const Id& source_id,
                                          const std::vector<int>& block_indices,
                                          FillReader& reader) const {
    if (block_indices.empty())
        return;

    std::vector<int> missing;
    missing.reserve(block_indices.size());
    block_cache_.append_missing_blocks(source_id, block_indices, missing);
    if (missing.empty())
        return;

    Entry entry;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return;
        entry = it->second;
    }
    if (entry.cache_file_path.empty() || entry.channel_count <= 0)
        return;

    // Sources were invalidated since this handle was opened — release it before
    // touching disk so the stale cache file can be deleted/replaced.
    const uint64_t generation = fill_generation_.load(std::memory_order_acquire);
    if (reader.handle && reader.generation != generation)
        reader.close();
    reader.generation = generation;

    // R5: never read past the frames actually written so far. While a streaming
    // decode is in flight the WAV's data-chunk size isn't finalized, so reading
    // beyond `decoded_frames` would return garbage/short reads. Blocks past it
    // simply stay absent (→ silence) until the decode catches up or finishes.
    const Frame readable_frames = entry.decoded_frames
        ? entry.decoded_frames->load(std::memory_order_acquire)
        : entry.duration_frames;

    // One open per BATCH (and reused across batches on the same file) instead of
    // one per contiguous run. This is the disk-I/O spike on seeks: a jump can
    // queue dozens of runs, and each used to pay a full file open + close.
    if (!reader.open_for(source_id, entry.cache_file_path, entry.channel_count))
        return;

    const int block_frames = block_cache_.block_frames();
    std::size_t cursor_index = 0;
    while (cursor_index < missing.size()) {
        const int first_block = missing[cursor_index];
        int last_block = first_block;
        ++cursor_index;
        while (cursor_index < missing.size() &&
               missing[cursor_index] == last_block + 1) {
            last_block = missing[cursor_index];
            ++cursor_index;
        }

        const Frame start = static_cast<Frame>(first_block) * block_frames;
        if (start >= entry.duration_frames)
            continue;
        const Frame end = std::min<Frame>(
            entry.duration_frames,
            (static_cast<Frame>(last_block) + 1) * block_frames);
        const int frames = static_cast<int>(end - start);
        if (frames <= 0)
            continue;
        // R5: only fetch the contiguous run that is fully decoded on disk. A run
        // that extends past `readable_frames` is skipped entirely (rather than
        // partially filled) so the audio thread never sees a block marked present
        // with stale/zero tail — it stays absent (silence) until decode advances.
        // The final block (which legitimately ends at duration < a full block) is
        // covered because at cache_ready `readable_frames == duration_frames`.
        if (end > readable_frames)
            continue;

        std::vector<float> data(
            static_cast<std::size_t>(frames) * entry.channel_count, 0.f);
        int frames_read = 0;
        const auto read_started = std::chrono::steady_clock::now();
        // Reopen if a failed read above dropped the handle mid-batch.
        if (!reader.handle
            && !reader.open_for(source_id, entry.cache_file_path, entry.channel_count))
            continue;
#if LT_ENGINE_USE_LIBSNDFILE
        SNDFILE* sf = static_cast<SNDFILE*>(reader.handle);
        if (sf_seek(sf, static_cast<sf_count_t>(start), SEEK_SET) >= 0) {
            frames_read = static_cast<int>(
                sf_readf_float(sf, data.data(), static_cast<sf_count_t>(frames)));
        }
        // A failed read can leave the handle's position undefined; drop it so
        // the next batch starts from a clean open rather than a bad offset.
        if (frames_read <= 0)
            reader.close();
#else
        auto& in = *static_cast<std::ifstream*>(reader.handle);
        const std::streamoff byte_offset =
            static_cast<std::streamoff>(start * entry.channel_count * sizeof(float));
        in.clear();
        in.seekg(byte_offset, std::ios::beg);
        in.read(reinterpret_cast<char*>(data.data()),
                static_cast<std::streamsize>(data.size() * sizeof(float)));
        frames_read = static_cast<int>(
            static_cast<std::size_t>(in.gcount()) / (sizeof(float) * entry.channel_count));
        if (frames_read <= 0)
            reader.close();
#endif
        {
            const auto elapsed = static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(
                    std::chrono::steady_clock::now() - read_started).count());
            fill_read_count_.fetch_add(1, std::memory_order_relaxed);
            uint64_t previous = fill_read_max_us_.load(std::memory_order_relaxed);
            while (previous < elapsed &&
                   !fill_read_max_us_.compare_exchange_weak(
                       previous, elapsed, std::memory_order_relaxed)) {}
            if (frames_read <= 0)
                fill_read_failures_.fetch_add(1, std::memory_order_relaxed);
            else
                fill_frames_read_.fetch_add(static_cast<uint64_t>(frames_read),
                                            std::memory_order_relaxed);
        }
        if (frames_read <= 0)
            continue;

        for (int block = first_block; block <= last_block; ++block) {
            const Frame block_start = static_cast<Frame>(block) * block_frames;
            if (block_start >= start + frames_read)
                break;
            const int offset = static_cast<int>(block_start - start);
            const int block_read_frames = static_cast<int>(std::min<Frame>(
                block_frames,
                static_cast<Frame>(frames_read) - offset));
            if (block_read_frames <= 0)
                continue;
            block_cache_.fill(
                source_id,
                block,
                data.data() + static_cast<std::size_t>(offset) * entry.channel_count,
                entry.channel_count,
                block_read_frames);
        }
    }
}

std::string SourceManager::cache_file_for(const Id& source_id,
                                          const std::string& file_path,
                                          int sample_rate) const {
    // Cache key includes the source file's size + mtime so editing or
    // replacing the original (even with the same path) invalidates the
    // cached PCM automatically. The orphaned old .rf64 stays on disk until
    // the LRU eviction sweep reclaims it.
    const FileStat st = stat_file(file_path);
#if LT_ENGINE_USE_LIBSNDFILE
    // Include the cache sample format in the key so switching float32<->int16
    // regenerates rather than reusing a mismatched cache. Extension follows the
    // container: WAV (int16, like Ableton) vs the legacy .rf64.
    const int fmt = cache_sample_format();
    const char* ext = (fmt == SF_FORMAT_FLOAT) ? ".rf64" : ".wav";
#else
    const int fmt = 0;
    const char* ext = ".rf64";
#endif
    const std::string key = source_id + "|" + file_path + "|" +
        std::to_string(sample_rate) + "|" +
        std::to_string(st.size_bytes) + "|" +
        std::to_string(st.mtime) + "|fmt" + std::to_string(fmt);
    const auto h = std::hash<std::string>{}(key);
    return source_cache_dir() + native_path_separator() +
           std::to_string(h) + ext;
}

bool SourceManager::try_install_native_file(const Id& source_id,
                                             int engine_sample_rate) {
#if !LT_ENGINE_USE_LIBSNDFILE
    (void)source_id;
    (void)engine_sample_rate;
    return false;
#else
    std::string file_path;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return false;
        file_path = it->second.file_path;
    }
    if (file_path.empty())
        return false;

    SF_INFO info{};
    SNDFILE* sf = lt_sf_open(file_path, SFM_READ, &info);
    if (!sf)
        return false;

    // Only short-circuit when libsndfile can stream the file as-is at the
    // engine's working rate. Mismatched SR → resample → still need decode.
    // Channel counts beyond 2 go through the decode path so the existing
    // downmix logic in the worker handles them.
    const bool eligible =
        info.samplerate == engine_sample_rate &&
        info.frames > 0 &&
        (info.channels == 1 || info.channels == 2);
    if (!eligible) {
        sf_close(sf);
        return false;
    }
    const int channel_count = info.channels;
    const Frame duration_frames = static_cast<Frame>(info.frames);
    sf_close(sf);

    SourceReadyCallback ready_callback;
    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end())
            return false;

        auto& entry = it->second;
        // The cache-fill worker reads bytes from `cache_file_path` via
        // libsndfile, so pointing it at the original file is enough — no
        // separate code path needed.
        entry.cache_file_path = file_path;
        entry.channel_count = channel_count;
        entry.sample_rate = engine_sample_rate;
        entry.duration_frames = duration_frames;
        // disk_cache_bytes counts bytes the engine has *itself* written to
        // its cache directory. Native files we stream in place don't take any
        // extra disk space, so we leave this at 0 — the user shouldn't see
        // the loading screen lie about cache growth.
        entry.disk_cache_bytes = 0;
        entry.source = std::make_shared<DecodedSource>(
            source_id,
            channel_count,
            engine_sample_rate,
            duration_frames,
            &block_cache_,
            [this](const Id& id, int first_block, int block_count, bool urgent) {
                request_blocks(id, first_block, block_count, urgent);
            });
        entry.status = "cache_ready";
        entry.error_message.clear();
        publish_locked(std::move(next));
        ready_callback = source_ready_callback_;
    }
    if (ready_callback)
        ready_callback(source_id);
    return true;
#endif
}

bool SourceManager::try_install_from_cache_file(const Id& source_id,
                                                int engine_sample_rate) {
#if !LT_ENGINE_USE_LIBSNDFILE
    (void)source_id;
    (void)engine_sample_rate;
    return false;
#else
    std::string file_path;
    {
        auto entries = load_entries();
        auto it = entries->find(source_id);
        if (it == entries->end())
            return false;
        file_path = it->second.file_path;
    }
    if (file_path.empty())
        return false;

    const std::string cache_file =
        cache_file_for(source_id, file_path, engine_sample_rate);
    SF_INFO info{};
    SNDFILE* sf = lt_sf_open(cache_file, SFM_READ, &info);
    if (!sf)
        return false;
    if (info.samplerate != engine_sample_rate ||
        info.channels <= 0 || info.frames <= 0) {
        sf_close(sf);
        return false;
    }
    const int channel_count = info.channels;
    const Frame duration_frames = static_cast<Frame>(info.frames);
    sf_close(sf);

    // Touch the cache file so LRU sees it as recently used. Otherwise an
    // open project whose stems haven't been re-decoded for months would be
    // the first thing evicted the next time someone imports new audio.
#if defined(_WIN32)
    HANDLE h = CreateFileA(cache_file.c_str(), FILE_WRITE_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        FILETIME ft{};
        SYSTEMTIME st{};
        GetSystemTime(&st);
        SystemTimeToFileTime(&st, &ft);
        SetFileTime(h, nullptr, nullptr, &ft);
        CloseHandle(h);
    }
#else
    (void)::utimes(cache_file.c_str(), nullptr);
#endif

    // We don't preload eager blocks here — the block cache fill worker will
    // pull them on demand once playback starts. The big win is skipping the
    // ~hundreds of MB of decode CPU work on every project open.
    const size_t disk_cache_bytes =
        static_cast<size_t>(duration_frames) *
        static_cast<size_t>(channel_count) * sizeof(float);

    SourceReadyCallback ready_callback;
    {
        std::lock_guard lock(write_mutex_);
        EntryMap next = *load_entries();
        auto it = next.find(source_id);
        if (it == next.end())
            return false;

        auto& entry = it->second;
        entry.cache_file_path = cache_file;
        entry.channel_count = channel_count;
        entry.sample_rate = engine_sample_rate;
        entry.duration_frames = duration_frames;
        entry.disk_cache_bytes = disk_cache_bytes;
        entry.source = std::make_shared<DecodedSource>(
            source_id,
            channel_count,
            engine_sample_rate,
            duration_frames,
            &block_cache_,
            [this](const Id& id, int first_block, int block_count, bool urgent) {
                request_blocks(id, first_block, block_count, urgent);
            });
        entry.status = "cache_ready";
        entry.error_message.clear();
        publish_locked(std::move(next));
        ready_callback = source_ready_callback_;
    }
    if (ready_callback)
        ready_callback(source_id);
    return true;
#endif
}

} // namespace lt
