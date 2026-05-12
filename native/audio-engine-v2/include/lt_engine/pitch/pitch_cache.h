#pragma once

// ---------------------------------------------------------------------------
// PitchCache — factory/cache for PitchProcessor instances.
//
// Keyed by (source_id, semitones, sample_rate, channel_count).
// Constructed once per unique key and reused across blocks.
//
// Thread model: all access from the audio thread only — no mutex needed
// because the audio callback is single-threaded.  The cache is rebuilt at
// session load time (command thread), before the audio thread is running.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/pitch_processor.h>
#include <memory>
#include <string>
#include <unordered_map>

namespace lt {

struct PitchCacheKey {
    Id     source_id;
    double semitones    = 0.0;
    int    sample_rate  = 0;
    int    channel_count = 0;

    bool operator==(const PitchCacheKey& o) const noexcept {
        return source_id     == o.source_id
            && semitones     == o.semitones
            && sample_rate   == o.sample_rate
            && channel_count == o.channel_count;
    }
};

struct PitchCacheKeyHash {
    std::size_t operator()(const PitchCacheKey& k) const noexcept {
        std::size_t h = std::hash<std::string>{}(k.source_id);
        h ^= std::hash<double>{}(k.semitones)      + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(k.sample_rate)        + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(k.channel_count)      + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

class PitchCache {
public:
    PitchCache() = default;

    // Get or create a PitchProcessor for this key.
    // If semitones == 0 → returns a BypassPitchProcessor (zero cost).
    // Otherwise returns a RubberBandPitchProcessor.
    PitchProcessor* get_or_create(const Id&  source_id,
                                  double     semitones,
                                  int        sample_rate,
                                  int        channel_count);

    // Discard all processors (called at session unload).
    void clear();

    // Evict a specific source (called when source is removed).
    void evict(const Id& source_id);

private:
    std::unordered_map<PitchCacheKey,
                       std::unique_ptr<PitchProcessor>,
                       PitchCacheKeyHash> cache_;
};

} // namespace lt
