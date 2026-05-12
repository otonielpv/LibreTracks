#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/bypass_pitch_processor.h>
#include <lt_engine/pitch/rubberband_pitch_processor.h>

namespace lt {

PitchProcessor* PitchCache::get_or_create(const Id&  source_id,
                                           double     semitones,
                                           int        sample_rate,
                                           int        channel_count) {
    PitchCacheKey key{ source_id, semitones, sample_rate, channel_count };

    auto it = cache_.find(key);
    if (it != cache_.end())
        return it->second.get();

    std::unique_ptr<PitchProcessor> proc;
    if (semitones == 0.0) {
        proc = std::make_unique<BypassPitchProcessor>();
    } else {
        proc = std::make_unique<RubberBandPitchProcessor>(
            channel_count, sample_rate, semitones);
    }

    auto* raw = proc.get();
    cache_.emplace(key, std::move(proc));
    return raw;
}

void PitchCache::clear() {
    cache_.clear();
}

void PitchCache::evict(const Id& source_id) {
    for (auto it = cache_.begin(); it != cache_.end(); ) {
        if (it->first.source_id == source_id)
            it = cache_.erase(it);
        else
            ++it;
    }
}

} // namespace lt
