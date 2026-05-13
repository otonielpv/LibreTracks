#include <lt_engine/pitch/persistent_pitch_proxy_cache.h>

#include <fstream>
#include <sstream>

namespace lt {

namespace {

std::string safe_hash(const std::string& value) {
    return std::to_string(std::hash<std::string>{}(value));
}

std::string key_string(const PitchCacheKey& key, int block_index) {
    std::ostringstream os;
    os << key.source_id << '|' << key.track_id << '|' << key.clip_id << '|'
       << key.semitones << '|' << key.sample_rate << '|' << key.channel_count << '|'
       << key.quality << '|' << key.rubberband_version << '|' << key.cache_version
       << '|' << PitchCache::kProxyBlockFrames << '|' << block_index;
    return os.str();
}

} // namespace

PersistentPitchProxyCache::PersistentPitchProxyCache()
    : cache_dir_(std::filesystem::temp_directory_path() / "LibreTracks" / "pitch-proxy-v1") {}

PersistentPitchProxyCache::PersistentPitchProxyCache(std::filesystem::path cache_dir)
    : cache_dir_(std::move(cache_dir)) {}

void PersistentPitchProxyCache::set_cache_dir(std::filesystem::path cache_dir) {
    std::lock_guard lock(mtx_);
    cache_dir_ = std::move(cache_dir);
}

std::filesystem::path PersistentPitchProxyCache::block_path(const PitchCacheKey& key, int block_index) const {
    return cache_dir_ / (safe_hash(key_string(key, block_index)) + ".ltppb");
}

bool PersistentPitchProxyCache::load_block(const PitchCacheKey& key, int block_index, PreparedPitchBlock& out) {
    if (!enabled_)
        return false;
    std::lock_guard lock(mtx_);
    const auto path = block_path(key, block_index);
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        ++misses_;
        return false;
    }

    char magic[8] = {};
    in.read(magic, sizeof(magic));
    if (std::string(magic, sizeof(magic)) != "LTPPB001") {
        ++invalidations_;
        ++misses_;
        return false;
    }

    PreparedPitchBlock block;
    block.key = key;
    in.read(reinterpret_cast<char*>(&block.source_start_frame), sizeof(block.source_start_frame));
    in.read(reinterpret_cast<char*>(&block.block_index), sizeof(block.block_index));
    in.read(reinterpret_cast<char*>(&block.frame_count), sizeof(block.frame_count));
    in.read(reinterpret_cast<char*>(&block.channel_count), sizeof(block.channel_count));
    std::uint64_t sample_count = 0;
    in.read(reinterpret_cast<char*>(&sample_count), sizeof(sample_count));
    if (!in || block.block_index != block_index || sample_count > 1024ull * 1024ull * 128ull) {
        ++invalidations_;
        ++misses_;
        return false;
    }
    block.interleaved_samples.resize(static_cast<std::size_t>(sample_count));
    in.read(reinterpret_cast<char*>(block.interleaved_samples.data()),
            static_cast<std::streamsize>(sample_count * sizeof(float)));
    if (!in) {
        ++invalidations_;
        ++misses_;
        return false;
    }
    out = std::move(block);
    ++hits_;
    return true;
}

bool PersistentPitchProxyCache::store_block(const PreparedPitchBlock& block) {
    if (!enabled_)
        return false;
    std::lock_guard lock(mtx_);
    try {
        std::filesystem::create_directories(cache_dir_);
        const auto path = block_path(block.key, block.block_index);
        const auto tmp = path.string() + ".tmp";
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out)
            return false;
        const char magic[8] = {'L','T','P','P','B','0','0','1'};
        out.write(magic, sizeof(magic));
        out.write(reinterpret_cast<const char*>(&block.source_start_frame), sizeof(block.source_start_frame));
        out.write(reinterpret_cast<const char*>(&block.block_index), sizeof(block.block_index));
        out.write(reinterpret_cast<const char*>(&block.frame_count), sizeof(block.frame_count));
        out.write(reinterpret_cast<const char*>(&block.channel_count), sizeof(block.channel_count));
        const std::uint64_t sample_count = static_cast<std::uint64_t>(block.interleaved_samples.size());
        out.write(reinterpret_cast<const char*>(&sample_count), sizeof(sample_count));
        out.write(reinterpret_cast<const char*>(block.interleaved_samples.data()),
                  static_cast<std::streamsize>(sample_count * sizeof(float)));
        out.close();
        if (!out)
            return false;
        std::filesystem::rename(tmp, path);
        ++writes_;
        return true;
    } catch (const std::exception& e) {
        last_error_ = e.what();
        return false;
    }
}

void PersistentPitchProxyCache::clear() {
    std::lock_guard lock(mtx_);
    try {
        if (std::filesystem::exists(cache_dir_))
            std::filesystem::remove_all(cache_dir_);
    } catch (const std::exception& e) {
        last_error_ = e.what();
    }
}

PersistentPitchProxyCacheDiagnostics PersistentPitchProxyCache::diagnostics() const {
    std::lock_guard lock(mtx_);
    PersistentPitchProxyCacheDiagnostics d;
    d.enabled = enabled_;
    d.cache_dir = cache_dir_.string();
    d.hits = hits_;
    d.misses = misses_;
    d.writes = writes_;
    d.invalidations = invalidations_;
    d.evictions = evictions_;
    d.last_error = last_error_;
    try {
        if (std::filesystem::exists(cache_dir_)) {
            for (const auto& entry : std::filesystem::recursive_directory_iterator(cache_dir_)) {
                if (entry.is_regular_file())
                    d.size_bytes += entry.file_size();
            }
        }
    } catch (...) {
    }
    return d;
}

} // namespace lt
