#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
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
#include <sndfile.h>
#endif

namespace lt {

namespace {

size_t source_cache_blocks_from_env() {
    constexpr size_t kDefaultCacheMb = 512;
    size_t cache_mb = kDefaultCacheMb;
    if (const char* raw = std::getenv("LIBRETRACKS_SOURCE_CACHE_MB")) {
        const int parsed = std::atoi(raw);
        if (parsed >= 64 && parsed <= 4096)
            cache_mb = static_cast<size_t>(parsed);
    }
    const size_t bytes_per_block =
        static_cast<size_t>(kDefaultBlockFrames) * sizeof(float) * 2;
    return std::max<size_t>(1, (cache_mb * 1024 * 1024) / bytes_per_block);
}

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
    if (const char* override_dir = std::getenv("LIBRETRACKS_CACHE_DIR")) {
        if (override_dir[0] != '\0') {
            std::string out(override_dir);
            while (out.size() > 1 && is_path_separator(out.back()))
                out.pop_back();
            return out;
        }
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
    if (const char* raw = std::getenv("LIBRETRACKS_SOURCE_DISK_CACHE_MB")) {
        const long long parsed = std::atoll(raw);
        if (parsed >= 0 && parsed <= 1024ll * 1024ll) // sanity 1 TiB
            return static_cast<size_t>(parsed) * 1024ull * 1024ull;
    }

    constexpr unsigned long long kMinBytes = 4ull * 1024ull * 1024ull * 1024ull; // 4 GiB
    const std::string dir = source_cache_dir();
    const unsigned long long free_bytes = free_disk_bytes_for(parent_path_compat(dir));
    // 10% of free disk. If the stat failed (free_bytes == 0) we land on the
    // minimum, which keeps the policy safe on weird filesystems.
    const unsigned long long ten_percent = free_bytes / 10ull;
    const unsigned long long budget = ten_percent > kMinBytes ? ten_percent : kMinBytes;
    return static_cast<size_t>(budget);
}

struct CacheEntryStat {
    std::string path;
    long long   size_bytes = 0;
    long long   mtime      = 0;
};

bool ends_with_rf64(const std::string& name) {
    constexpr const char* kExt = ".rf64";
    constexpr std::size_t kLen = 5;
    if (name.size() < kLen) return false;
    return name.compare(name.size() - kLen, kLen, kExt) == 0;
}

std::vector<CacheEntryStat> list_cache_entries(const std::string& dir) {
    std::vector<CacheEntryStat> out;
#if defined(_WIN32)
    WIN32_FIND_DATAA fd{};
    const std::string pattern = dir + "\\*.rf64";
    HANDLE h = FindFirstFileA(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE)
        return out;
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
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
        if (!ends_with_rf64(name)) continue;
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

SourceManager::SourceManager()
    : entries_(std::make_shared<EntryMap>())
    , block_cache_(kDefaultBlockFrames, source_cache_blocks_from_env())
{
    fill_thread_ = std::thread([this] { fill_worker_loop(); });
}

SourceManager::~SourceManager() {
    {
        std::lock_guard lock(fill_mtx_);
        fill_stop_ = true;
    }
    fill_cv_.notify_all();
    if (fill_thread_.joinable())
        fill_thread_.join();
}

void SourceManager::set_source_ready_callback(SourceReadyCallback callback) {
    std::lock_guard lock(write_mutex_);
    source_ready_callback_ = std::move(callback);
}

void SourceManager::publish_locked(EntryMap entries) {
    auto previous = std::atomic_load(&entries_);
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
    std::atomic_store(&entries_, std::make_shared<const EntryMap>(std::move(entries)));
}

void SourceManager::register_source(const Id& source_id,
                                     const std::string& file_path) {
    std::lock_guard lock(write_mutex_);
    EntryMap next = *std::atomic_load(&entries_);
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
        EntryMap next = *std::atomic_load(&entries_);
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
        EntryMap next = *std::atomic_load(&entries_);
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
                                                 Frame duration_frames) {
    SourceReadyCallback ready_callback;
    std::string file_path;
    {
        auto entries = std::atomic_load(&entries_);
        auto it = entries->find(source_id);
        if (it == entries->end())
            return Result<void>::err("Source not registered: " + source_id);
        file_path = it->second.file_path;
    }

    if (file_path.empty()) {
        SourceReadyCallback ready_callback;
        {
            std::lock_guard lock(write_mutex_);
            EntryMap next = *std::atomic_load(&entries_);
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
        info.format = SF_FORMAT_RF64 | SF_FORMAT_FLOAT;
        SNDFILE* sf = sf_open(cache_file.c_str(), SFM_WRITE, &info);
        if (!sf)
            return Result<void>::err(std::string("Could not create PCM cache: ") + sf_strerror(nullptr));
        const sf_count_t written = sf_writef_float(
            sf, samples.data(), static_cast<sf_count_t>(duration_frames));
        sf_close(sf);
        if (written != static_cast<sf_count_t>(duration_frames))
            return Result<void>::err("Could not write complete PCM cache: " + cache_file);
#else
        std::ofstream out(cache_file, std::ios::binary | std::ios::trunc);
        if (!out)
            return Result<void>::err("Could not create PCM cache: " + cache_file);
        if (!samples.empty()) {
            out.write(reinterpret_cast<const char*>(samples.data()),
                      static_cast<std::streamsize>(samples.size() * sizeof(float)));
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
        EntryMap next = *std::atomic_load(&entries_);
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
            [this](const Id& id, int block_index) {
                request_block(id, block_index);
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

void SourceManager::request_block(const Id& source_id, int block_index) const noexcept {
    if (block_index < 0 || block_cache_.has_block(source_id, block_index))
        return;
    CacheKey key{source_id, block_index};
    {
        std::lock_guard lock(fill_mtx_);
        if (queued_blocks_.find(key) != queued_blocks_.end())
            return;
        queued_blocks_[key] = true;
        fill_queue_.push(key);
    }
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
    for (int block = first; block <= last; ++block)
        request_block(source_id, block);
}

CacheDiagnostics SourceManager::cache_diagnostics() const {
    return block_cache_.diagnostics();
}

SourcePeakOverview SourceManager::source_peaks(const Id& source_id,
                                               int resolution_frames) const {
    SourcePeakOverview overview;
    overview.resolution_frames = std::max(1, resolution_frames);

    Entry entry;
    {
        auto entries = std::atomic_load(&entries_);
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

    if (entry.cache_file_path.empty())
        return entry.source->peaks(overview.resolution_frames);

    const Frame bucket_width = static_cast<Frame>(overview.resolution_frames);
    const std::size_t bucket_count = static_cast<std::size_t>(
        (entry.duration_frames + bucket_width - 1) / bucket_width);
    std::vector<float> min_peaks(bucket_count, 0.f);
    std::vector<float> max_peaks(bucket_count, 0.f);
    std::vector<bool> initialized(bucket_count, false);

    constexpr int kChunkFrames = 16384;
    std::vector<float> data(static_cast<std::size_t>(kChunkFrames)
                            * static_cast<std::size_t>(entry.channel_count),
                            0.f);

    Frame cursor = 0;
#if LT_ENGINE_USE_LIBSNDFILE
    SF_INFO info{};
    SNDFILE* sf = sf_open(entry.cache_file_path.c_str(), SFM_READ, &info);
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
            float value = 0.f;
            const float* row = data.data()
                + static_cast<std::size_t>(frame) * entry.channel_count;
            for (int ch = 0; ch < entry.channel_count; ++ch)
                value += row[ch];
            value /= static_cast<float>(entry.channel_count);
            value = std::clamp(value, -1.f, 1.f);
            if (!initialized[bucket]) {
                min_peaks[bucket] = value;
                max_peaks[bucket] = value;
                initialized[bucket] = true;
            } else {
                min_peaks[bucket] = std::min(min_peaks[bucket], value);
                max_peaks[bucket] = std::max(max_peaks[bucket], value);
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
    return overview;
}

const DecodedSource* SourceManager::get(const Id& source_id) const noexcept {
    auto entries = std::atomic_load(&entries_);
    auto it = entries->find(source_id);
    if (it == entries->end()) return nullptr;
    auto source = it->second.source;
    return source ? source.get() : nullptr;
}

std::shared_ptr<const DecodedSource>
SourceManager::get_shared(const Id& source_id) const noexcept {
    auto entries = std::atomic_load(&entries_);
    auto it = entries->find(source_id);
    if (it == entries->end()) return {};
    return it->second.source;
}

std::vector<SourceDiagnostics> SourceManager::diagnostics() const {
    std::vector<SourceDiagnostics> out;
    auto entries = std::atomic_load(&entries_);
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

void SourceManager::clear() {
    std::lock_guard lock(write_mutex_);
    publish_locked(EntryMap{});
    {
        std::lock_guard fill_lock(fill_mtx_);
        std::queue<CacheKey> empty;
        fill_queue_.swap(empty);
        queued_blocks_.clear();
    }
}

void SourceManager::fill_worker_loop() const {
    while (true) {
        CacheKey key;
        std::vector<int> block_batch;
        {
            std::unique_lock lock(fill_mtx_);
            fill_cv_.wait(lock, [this] { return fill_stop_ || !fill_queue_.empty(); });
            if (fill_stop_ && fill_queue_.empty())
                return;
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
        fill_blocks_from_disk(key.source_id, block_batch);
    }
}

void SourceManager::fill_blocks_from_disk(const Id& source_id,
                                          const std::vector<int>& block_indices) const {
    if (block_indices.empty())
        return;

    std::vector<int> missing;
    missing.reserve(block_indices.size());
    for (int block_index : block_indices) {
        if (block_index >= 0 && !block_cache_.has_block(source_id, block_index))
            missing.push_back(block_index);
    }
    if (missing.empty())
        return;

    Entry entry;
    {
        auto entries = std::atomic_load(&entries_);
        auto it = entries->find(source_id);
        if (it == entries->end())
            return;
        entry = it->second;
    }
    if (entry.cache_file_path.empty() || entry.channel_count <= 0)
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

        std::vector<float> data(
            static_cast<std::size_t>(frames) * entry.channel_count, 0.f);
        int frames_read = 0;
#if LT_ENGINE_USE_LIBSNDFILE
        SF_INFO info{};
        SNDFILE* sf = sf_open(entry.cache_file_path.c_str(), SFM_READ, &info);
        if (!sf)
            continue;
        if (info.channels != entry.channel_count) {
            sf_close(sf);
            continue;
        }
        if (sf_seek(sf, static_cast<sf_count_t>(start), SEEK_SET) >= 0) {
            frames_read = static_cast<int>(
                sf_readf_float(sf, data.data(), static_cast<sf_count_t>(frames)));
        }
        sf_close(sf);
#else
        std::ifstream in(entry.cache_file_path, std::ios::binary);
        if (!in)
            continue;
        const std::streamoff byte_offset =
            static_cast<std::streamoff>(start * entry.channel_count * sizeof(float));
        in.seekg(byte_offset, std::ios::beg);
        in.read(reinterpret_cast<char*>(data.data()),
                static_cast<std::streamsize>(data.size() * sizeof(float)));
        frames_read = static_cast<int>(
            static_cast<std::size_t>(in.gcount()) / (sizeof(float) * entry.channel_count));
#endif
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
    const std::string key = source_id + "|" + file_path + "|" +
        std::to_string(sample_rate) + "|" +
        std::to_string(st.size_bytes) + "|" +
        std::to_string(st.mtime);
    const auto h = std::hash<std::string>{}(key);
    return source_cache_dir() + native_path_separator() +
           std::to_string(h) + ".rf64";
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
        auto entries = std::atomic_load(&entries_);
        auto it = entries->find(source_id);
        if (it == entries->end())
            return false;
        file_path = it->second.file_path;
    }
    if (file_path.empty())
        return false;

    SF_INFO info{};
    SNDFILE* sf = sf_open(file_path.c_str(), SFM_READ, &info);
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
        EntryMap next = *std::atomic_load(&entries_);
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
            [this](const Id& id, int block_index) {
                request_block(id, block_index);
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
        auto entries = std::atomic_load(&entries_);
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
    SNDFILE* sf = sf_open(cache_file.c_str(), SFM_READ, &info);
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
        EntryMap next = *std::atomic_load(&entries_);
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
            [this](const Id& id, int block_index) {
                request_block(id, block_index);
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
