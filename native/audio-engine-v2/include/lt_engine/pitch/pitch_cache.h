#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/pitch_processor.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace lt {

struct PitchCacheKey {
    Id source_id;
    Id track_id;
    Id clip_id;
    double semitones = 0.0;
    int sample_rate = 0;
    int channel_count = 0;
    std::string quality = "realtime";

    bool operator==(const PitchCacheKey& o) const noexcept {
        return source_id == o.source_id
            && track_id == o.track_id
            && clip_id == o.clip_id
            && semitones == o.semitones
            && sample_rate == o.sample_rate
            && channel_count == o.channel_count
            && quality == o.quality;
    }
};

struct PitchCacheKeyHash {
    std::size_t operator()(const PitchCacheKey& k) const noexcept {
        std::size_t h = std::hash<std::string>{}(k.source_id);
        h ^= std::hash<std::string>{}(k.track_id) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<std::string>{}(k.clip_id) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<double>{}(k.semitones) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(k.sample_rate) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(k.channel_count) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<std::string>{}(k.quality) + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

struct PitchDiagnostics {
    std::size_t processors_prepared = 0;
    std::size_t processors_missing = 0;
    std::uint64_t missing_processor_count = 0;
    std::vector<PitchCacheKey> missing_keys;
};

class PitchCache {
public:
    PitchCache() = default;

    PitchProcessor* prepare_processor(const PitchCacheKey& key);
    PitchProcessor* find_processor(const PitchCacheKey& key) noexcept;
    const PitchProcessor* find_processor(const PitchCacheKey& key) const noexcept;
    void note_missing_processor(const PitchCacheKey& key) noexcept;
    PitchDiagnostics diagnostics() const;

    void clear();
    void evict(const Id& source_id);

private:
    using CacheMap = std::unordered_map<PitchCacheKey, std::shared_ptr<PitchProcessor>, PitchCacheKeyHash>;

    mutable std::mutex write_mutex_;
    std::shared_ptr<const CacheMap> cache_{std::make_shared<const CacheMap>()};
    std::atomic<std::uint64_t> missing_processor_count_{0};
};

} // namespace lt
