#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstdio>
#include <fstream>
#include <string>

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
    try {
        if (!create_directories_compat(parent_path_compat(cache_file)))
            return Result<void>::err("Could not create PCM cache directory: " + cache_file);
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
        {
            std::unique_lock lock(fill_mtx_);
            fill_cv_.wait(lock, [this] { return fill_stop_ || !fill_queue_.empty(); });
            if (fill_stop_ && fill_queue_.empty())
                return;
            key = fill_queue_.front();
            fill_queue_.pop();
            queued_blocks_.erase(key);
        }
        if (!block_cache_.has_block(key.source_id, key.block_index))
            fill_block_from_disk(key);
    }
}

void SourceManager::fill_block_from_disk(const CacheKey& key) const {
    Entry entry;
    {
        auto entries = std::atomic_load(&entries_);
        auto it = entries->find(key.source_id);
        if (it == entries->end())
            return;
        entry = it->second;
    }
    if (entry.cache_file_path.empty() || entry.channel_count <= 0)
        return;
    const int block_frames = block_cache_.block_frames();
    const Frame start = static_cast<Frame>(key.block_index) * block_frames;
    if (start >= entry.duration_frames)
        return;
    const int frames = static_cast<int>(
        std::min<Frame>(block_frames, entry.duration_frames - start));
    std::vector<float> data(static_cast<std::size_t>(frames) * entry.channel_count, 0.f);
#if LT_ENGINE_USE_LIBSNDFILE
    SF_INFO info{};
    SNDFILE* sf = sf_open(entry.cache_file_path.c_str(), SFM_READ, &info);
    if (!sf)
        return;
    if (info.channels != entry.channel_count) {
        sf_close(sf);
        return;
    }
    if (sf_seek(sf, static_cast<sf_count_t>(start), SEEK_SET) < 0) {
        sf_close(sf);
        return;
    }
    const int frames_read = static_cast<int>(
        sf_readf_float(sf, data.data(), static_cast<sf_count_t>(frames)));
    sf_close(sf);
#else
    std::ifstream in(entry.cache_file_path, std::ios::binary);
    if (!in)
        return;
    const std::streamoff byte_offset =
        static_cast<std::streamoff>(start * entry.channel_count * sizeof(float));
    in.seekg(byte_offset, std::ios::beg);
    in.read(reinterpret_cast<char*>(data.data()),
            static_cast<std::streamsize>(data.size() * sizeof(float)));
    if (in.gcount() <= 0)
        return;
    const int frames_read = static_cast<int>(
        static_cast<std::size_t>(in.gcount()) / (sizeof(float) * entry.channel_count));
#endif
    if (frames_read > 0)
        block_cache_.fill(key.source_id, key.block_index,
                          data.data(), entry.channel_count, frames_read);
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
    return temp_directory_compat() + native_path_separator() +
           "libretracks-audio-cache" + native_path_separator() +
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
        // fill_block_from_disk reads bytes from `cache_file_path` via
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
