#pragma once

#include <lt_engine/pitch/pitch_cache.h>

#include <filesystem>
#include <optional>
#include <string>

namespace lt {

struct PersistentPitchProxyCacheDiagnostics {
    bool enabled = false;
    std::string cache_dir;
    std::uint64_t hits = 0;
    std::uint64_t misses = 0;
    std::uint64_t writes = 0;
    std::uint64_t invalidations = 0;
    std::uint64_t evictions = 0;
    std::uint64_t size_bytes = 0;
    std::string last_error;
};

class PersistentPitchProxyCache {
public:
    PersistentPitchProxyCache();
    explicit PersistentPitchProxyCache(std::filesystem::path cache_dir);

    void set_enabled(bool enabled) noexcept { enabled_ = enabled; }
    bool enabled() const noexcept { return enabled_; }
    void set_cache_dir(std::filesystem::path cache_dir);

    bool load_block(const PitchCacheKey& key, int block_index, PreparedPitchBlock& out);
    bool store_block(const PreparedPitchBlock& block);
    void clear();

    PersistentPitchProxyCacheDiagnostics diagnostics() const;

private:
    bool enabled_ = false;
    std::filesystem::path cache_dir_;
    mutable std::mutex mtx_;
    std::uint64_t hits_ = 0;
    std::uint64_t misses_ = 0;
    std::uint64_t writes_ = 0;
    std::uint64_t invalidations_ = 0;
    std::uint64_t evictions_ = 0;
    mutable std::string last_error_;

    std::filesystem::path block_path(const PitchCacheKey& key, int block_index) const;
};

} // namespace lt
