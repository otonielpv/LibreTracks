#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>

#if LT_ENGINE_USE_LIBSNDFILE
#include <sndfile.h>
#endif

namespace lt {

SourceManager::SourceManager()
    : entries_(std::make_shared<EntryMap>())
    , block_cache_(kDefaultBlockFrames, 32768) // ~1 GB for stereo float32
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
        std::filesystem::create_directories(std::filesystem::path(cache_file).parent_path());
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
    const int eager_blocks = std::min(total_blocks, 256);
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
    const std::string key = source_id + "|" + file_path + "|" + std::to_string(sample_rate);
    const auto h = std::hash<std::string>{}(key);
    auto dir = std::filesystem::temp_directory_path() / "libretracks-audio-cache";
    return (dir / (std::to_string(h) + ".rf64")).string();
}

} // namespace lt
