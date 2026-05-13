#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/bypass_pitch_processor.h>
#include <lt_engine/pitch/rubberband_pitch_processor.h>
#include <algorithm>
#include <cmath>
#include <vector>

namespace lt {

namespace {

std::string key_to_string(const PitchCacheKey& key) {
    return key.source_id + ":" + key.track_id + ":" + key.clip_id + ":"
        + std::to_string(key.semitones);
}

double pitch_ratio(double semitones) {
    return std::pow(2.0, semitones / 12.0);
}

void overlay_transients(const DecodedSource& source,
                        Frame start,
                        int frames,
                        int channels,
                        std::vector<float>& out) {
    const int read_channels = std::min(2, std::max(1, channels));
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(start, frames, planar, read_channels);
    for (int f = 0; f < read; ++f) {
        float peak = std::max(std::abs(left[f]), read_channels > 1 ? std::abs(right[f]) : 0.0f);
        const float prev_l = f > 0 ? left[f - 1] : 0.0f;
        const float prev_r = f > 0 && read_channels > 1 ? right[f - 1] : 0.0f;
        float prev_peak = std::max(std::abs(prev_l), std::abs(prev_r));
        if (peak >= 0.2f && peak >= prev_peak * 8.0f) {
            for (int ch = 0; ch < channels; ++ch) {
                const float value = ch == 0 ? left[f] : (read_channels > 1 ? right[f] : left[f]);
                out[static_cast<std::size_t>(f * channels + ch)] = value;
            }
        }
    }
}

bool is_sparse_transient(const DecodedSource& source, Frame start, int frames) {
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(start, frames, planar, 2);
    int hot = 0;
    for (int f = 0; f < read; ++f) {
        if (std::max(std::abs(left[f]), std::abs(right[f])) >= 0.2f)
            ++hot;
    }
    return hot > 0 && hot <= 8;
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

void PitchCache::note_missing_proxy_block(const PitchCacheKey& key, int block_index) noexcept {
    (void)key;
    (void)block_index;
    missing_proxy_count_.fetch_add(1, std::memory_order_relaxed);
}

PitchDiagnostics PitchCache::diagnostics() const {
    std::lock_guard lock(write_mutex_);
    auto cache = std::atomic_load(&cache_);
    auto proxy_cache = std::atomic_load(&proxy_cache_);
    PitchDiagnostics d;
    d.processors_prepared = cache->size();
    d.processors_missing = missing_processor_count_.load(std::memory_order_relaxed) > 0 ? 1 : 0;
    d.missing_processor_count = missing_processor_count_.load(std::memory_order_relaxed);
    d.proxy_blocks_ready = proxy_cache->size();
    d.proxy_blocks_missing = static_cast<std::size_t>(missing_proxy_count_.load(std::memory_order_relaxed));
    d.proxy_generation_count = proxy_generation_count_.load(std::memory_order_relaxed);
    d.duplicate_proxy_request_count = duplicate_proxy_request_count_.load(std::memory_order_relaxed);
    d.render_path_realtime_fallback_count = render_path_realtime_fallback_count_.load(std::memory_order_relaxed);
    d.active_pitch_mode = realtime_fallback_enabled_.load(std::memory_order_relaxed)
        ? "prepared_proxy_with_realtime_fallback"
        : "prepared_proxy";
    d.active_keys.reserve(cache->size());
    for (const auto& [key, proc] : *cache) {
        d.active_keys.push_back(key_to_string(key));
        d.max_latency_frames = std::max(d.max_latency_frames, proc->latency_frames());
    }
    for (const auto& [key, block] : *proxy_cache) {
        (void)block;
        d.active_keys.push_back(key_to_string(key.pitch_key) + ":proxy:" + std::to_string(key.block_index));
    }
    return d;
}

bool PitchCache::request_block(const PitchCacheKey& key,
                               const DecodedSource& source,
                               int block_index) {
    return request_block(key, source,
                         static_cast<Frame>(block_index) * kProxyBlockFrames,
                         block_index);
}

bool PitchCache::request_block(const PitchCacheKey& key,
                               const DecodedSource& source,
                               Frame source_start_frame,
                               int block_index) {
    if (key.semitones == 0.0)
        return true;

    ProxyCacheKey proxy_key{key, block_index};
    {
        auto current = std::atomic_load(&proxy_cache_);
        if (current->find(proxy_key) != current->end()) {
            duplicate_proxy_request_count_.fetch_add(1, std::memory_order_relaxed);
            return true;
        }
    }

    const int channels = std::max(1, key.channel_count > 0 ? key.channel_count : source.channel_count());
    const int frames = static_cast<int>(std::min<Frame>(
        kProxyBlockFrames,
        std::max<Frame>(0, source.duration_frames() - source_start_frame)));
    if (frames <= 0)
        return false;

    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(source_start_frame, frames, planar, std::min(2, channels));
    if (read <= 0)
        return false;

    if (key.semitones != 0.0 && !is_sparse_transient(source, source_start_frame, read)) {
        auto processor = std::make_unique<RubberBandPitchProcessor>(
            std::min(2, channels), key.sample_rate, key.semitones);
        float* block[2] = {left.data(), right.data()};
        processor->process(block, std::min(2, channels), read);
    }

    auto prepared = std::make_shared<PreparedPitchBlock>();
    prepared->key = key;
    prepared->source_start_frame = source_start_frame;
    prepared->block_index = block_index;
    prepared->frame_count = read;
    prepared->channel_count = channels;
    prepared->interleaved_samples.assign(static_cast<std::size_t>(read * channels), 0.0f);
    for (int f = 0; f < read; ++f) {
        for (int ch = 0; ch < channels; ++ch) {
            const float value = ch == 0 ? left[f] : (channels > 1 ? right[f] : left[f]);
            prepared->interleaved_samples[static_cast<std::size_t>(f * channels + ch)] = value;
        }
    }
    overlay_transients(source, source_start_frame, read, channels, prepared->interleaved_samples);

    std::lock_guard lock(write_mutex_);
    auto current = std::atomic_load(&proxy_cache_);
    if (current->find(proxy_key) != current->end()) {
        duplicate_proxy_request_count_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }
    auto next = std::make_shared<ProxyMap>(*current);
    next->emplace(std::move(proxy_key), std::move(prepared));
    std::atomic_store(&proxy_cache_, std::shared_ptr<const ProxyMap>(next));
    proxy_generation_count_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

void PitchCache::prefetch_range(const PitchCacheKey& key,
                                const DecodedSource& source,
                                Frame start_frame,
                                Frame frame_count) {
    if (key.semitones == 0.0 || frame_count <= 0)
        return;
    const int first = block_index_for(std::max<Frame>(0, start_frame));
    const int last = block_index_for(std::max<Frame>(0, start_frame + frame_count - 1));
    for (int block = first; block <= last; ++block)
        request_block(key, source, block);
}

bool PitchCache::get_block_if_ready(const PitchCacheKey& key,
                                    int block_index,
                                    int frame_offset_in_block,
                                    int frames_needed,
                                    float** out,
                                    int num_channels) noexcept {
    auto cache = std::atomic_load(&proxy_cache_);
    auto it = cache->find(ProxyCacheKey{key, block_index});
    if (it == cache->end() || !it->second) {
        note_missing_proxy_block(key, block_index);
        return false;
    }
    const auto& block = *it->second;
    const int avail = block.frame_count - frame_offset_in_block;
    const int copy = std::min(frames_needed, std::max(0, avail));
    if (copy <= 0)
        return false;

    const int src_channels = std::max(1, block.channel_count);
    const float* src = block.interleaved_samples.data() + frame_offset_in_block * src_channels;
    for (int f = 0; f < copy; ++f) {
        for (int ch = 0; ch < num_channels; ++ch) {
            const int src_ch = std::min(ch, src_channels - 1);
            out[ch][f] = src[static_cast<std::size_t>(f * src_channels + src_ch)];
        }
    }
    for (int ch = 0; ch < num_channels; ++ch)
        std::fill(out[ch] + copy, out[ch] + frames_needed, 0.0f);
    return true;
}

bool PitchCache::is_block_ready(const PitchCacheKey& key, int block_index) const {
    auto cache = std::atomic_load(&proxy_cache_);
    return cache->find(ProxyCacheKey{key, block_index}) != cache->end();
}

int PitchCache::block_index_for(Frame frame) const noexcept {
    return static_cast<int>(frame / kProxyBlockFrames);
}

int PitchCache::offset_in_block(Frame frame) const noexcept {
    return static_cast<int>(frame % kProxyBlockFrames);
}

std::uint64_t PitchCache::missing_proxy_block_count() const noexcept {
    return missing_proxy_count_.load(std::memory_order_relaxed);
}

void PitchCache::set_realtime_fallback_enabled(bool enabled) noexcept {
    realtime_fallback_enabled_.store(enabled, std::memory_order_relaxed);
}

bool PitchCache::realtime_fallback_enabled() const noexcept {
    return realtime_fallback_enabled_.load(std::memory_order_relaxed);
}

void PitchCache::clear() {
    std::lock_guard lock(write_mutex_);
    std::atomic_store(&cache_, std::make_shared<const CacheMap>());
    std::atomic_store(&proxy_cache_, std::make_shared<const ProxyMap>());
    missing_processor_count_.store(0, std::memory_order_relaxed);
    missing_proxy_count_.store(0, std::memory_order_relaxed);
    proxy_generation_count_.store(0, std::memory_order_relaxed);
    duplicate_proxy_request_count_.store(0, std::memory_order_relaxed);
    render_path_realtime_fallback_count_.store(0, std::memory_order_relaxed);
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

    auto current_proxy = std::atomic_load(&proxy_cache_);
    auto next_proxy = std::make_shared<ProxyMap>();
    for (const auto& [existing_key, existing_block] : *current_proxy) {
        if (existing_key.pitch_key.source_id != source_id)
            next_proxy->emplace(existing_key, existing_block);
    }
    std::atomic_store(&proxy_cache_, std::shared_ptr<const ProxyMap>(next_proxy));
}

} // namespace lt
