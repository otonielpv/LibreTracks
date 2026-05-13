#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/bypass_pitch_processor.h>
#include <lt_engine/pitch/rubberband_pitch_processor.h>
#include <algorithm>

namespace lt {

namespace {

std::string key_to_string(const PitchCacheKey& key) {
    return key.source_id + ":" + key.track_id + ":" + key.clip_id + ":"
        + std::to_string(key.semitones);
}

} // namespace

PitchProcessor* PitchCache::prepare_processor(const PitchCacheKey& key) {
    std::lock_guard lock(write_mutex_);
    auto current = std::atomic_load(&cache_);
    auto it = current->find(key);
    if (it != current->end())
        return it->second.get();

    std::shared_ptr<PitchProcessor> proc;
    if (key.semitones == 0.0) {
        proc = std::make_shared<BypassPitchProcessor>();
    } else {
        proc = std::make_shared<RubberBandPitchProcessor>(
            key.channel_count, key.sample_rate, key.semitones);
    }

    auto* raw = proc.get();
    auto next = std::make_shared<CacheMap>(*current);
    next->emplace(key, std::move(proc));
    std::atomic_store(&cache_, std::shared_ptr<const CacheMap>(next));
    return raw;
}

PitchProcessor* PitchCache::find_processor(const PitchCacheKey& key) noexcept {
    auto cache = std::atomic_load(&cache_);
    auto it = cache->find(key);
    return it == cache->end() ? nullptr : it->second.get();
}

const PitchProcessor* PitchCache::find_processor(const PitchCacheKey& key) const noexcept {
    auto cache = std::atomic_load(&cache_);
    auto it = cache->find(key);
    return it == cache->end() ? nullptr : it->second.get();
}

void PitchCache::note_missing_processor(const PitchCacheKey& key) noexcept {
    (void)key;
    missing_processor_count_.fetch_add(1, std::memory_order_relaxed);
}

PitchDiagnostics PitchCache::diagnostics() const {
    std::lock_guard lock(write_mutex_);
    auto cache = std::atomic_load(&cache_);
    PitchDiagnostics d;
    d.processors_prepared = cache->size();
    d.processors_missing = missing_processor_count_.load(std::memory_order_relaxed) > 0 ? 1 : 0;
    d.missing_processor_count = missing_processor_count_.load(std::memory_order_relaxed);
    d.active_keys.reserve(cache->size());
    for (const auto& [key, proc] : *cache) {
        d.active_keys.push_back(key_to_string(key));
        d.max_latency_frames = std::max(d.max_latency_frames, proc->latency_frames());
    }
    return d;
}

void PitchCache::clear() {
    std::lock_guard lock(write_mutex_);
    std::atomic_store(&cache_, std::make_shared<const CacheMap>());
    missing_processor_count_.store(0, std::memory_order_relaxed);
}

void PitchCache::evict(const Id& source_id) {
    std::lock_guard lock(write_mutex_);
    auto current = std::atomic_load(&cache_);
    auto next = std::make_shared<CacheMap>();
    for (const auto& [existing_key, existing_proc] : *current) {
        if (existing_key.source_id != source_id)
            next->emplace(existing_key, existing_proc);
    }
    std::atomic_store(&cache_, std::shared_ptr<const CacheMap>(next));
}

} // namespace lt
