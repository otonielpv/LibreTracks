#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/pitch_processor.h>
#include <lt_engine/sources/decoded_source.h>
#include <lt_engine/sources/block_cache.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace lt {

class PersistentPitchProxyCache;
struct PersistentPitchProxyCacheDiagnostics;

struct PitchCacheKey {
    Id source_id;
    Id track_id;
    Id clip_id;
    double semitones = 0.0;
    int sample_rate = 0;
    int channel_count = 0;
    std::string quality = "realtime";
    std::string rubberband_version;
    std::uint64_t cache_version = 1;

    bool operator==(const PitchCacheKey& o) const noexcept {
        return source_id == o.source_id
            && track_id == o.track_id
            && clip_id == o.clip_id
            && semitones == o.semitones
            && sample_rate == o.sample_rate
            && channel_count == o.channel_count
            && quality == o.quality
            && rubberband_version == o.rubberband_version
            && cache_version == o.cache_version;
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
        h ^= std::hash<std::string>{}(k.rubberband_version) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= std::hash<std::uint64_t>{}(k.cache_version) + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

struct PitchDiagnostics {
    std::size_t processors_prepared = 0;
    std::size_t processors_missing = 0;
    std::uint64_t missing_processor_count = 0;
    std::size_t proxy_blocks_ready = 0;
    std::size_t proxy_blocks_missing = 0;
    std::uint64_t proxy_generation_count = 0;
    std::uint64_t duplicate_proxy_request_count = 0;
    std::uint64_t render_path_realtime_fallback_count = 0;
    std::uint64_t jobs_queued = 0;
    std::uint64_t jobs_running = 0;
    std::uint64_t jobs_completed = 0;
    std::uint64_t jobs_failed = 0;
    std::uint64_t offline_segments_rendered = 0;
    std::uint64_t offline_segment_failures = 0;
    int offline_latency_frames = 0;
    int offline_preroll_frames = 0;
    int offline_postroll_frames = 0;
    std::uint64_t offline_trimmed_frames = 0;
    double offline_render_ms = 0.0;
    std::string last_offline_error;
    bool disk_cache_enabled = false;
    std::string disk_cache_dir;
    std::uint64_t disk_cache_hits = 0;
    std::uint64_t disk_cache_misses = 0;
    std::uint64_t disk_cache_writes = 0;
    std::uint64_t disk_cache_invalidations = 0;
    std::uint64_t disk_cache_size_bytes = 0;
    std::string last_disk_cache_error;
    std::uint64_t prepare_sync_count = 0;
    double prepare_blocking_ms = 0.0;
    std::string last_prepare_reason;
    std::string active_pitch_mode = "prepared_proxy";
    int max_latency_frames = 0;
    std::vector<std::string> active_keys;
    std::vector<PitchCacheKey> missing_keys;
};

struct PreparedPitchBlock {
    PitchCacheKey key;
    Frame source_start_frame = 0;
    int block_index = 0;
    int frame_count = 0;
    int channel_count = 0;
    std::vector<float> interleaved_samples;
};

class PitchCache {
public:
    PitchCache();
    ~PitchCache();

    static constexpr int kProxyBlockFrames = kDefaultBlockFrames;

    PitchProcessor* prepare_processor(const PitchCacheKey& key);
    PitchProcessor* find_processor(const PitchCacheKey& key) noexcept;
    const PitchProcessor* find_processor(const PitchCacheKey& key) const noexcept;
    void note_missing_processor(const PitchCacheKey& key) noexcept;
    void note_missing_proxy_block(const PitchCacheKey& key, int block_index) noexcept;
    void note_realtime_fallback_used() noexcept;
    PitchDiagnostics diagnostics() const;

    bool request_block(const PitchCacheKey& key,
                       const DecodedSource& source,
                       int block_index);
    bool request_block(const PitchCacheKey& key,
                       const DecodedSource& source,
                       Frame source_start_frame,
                       int block_index);
    void prefetch_range(const PitchCacheKey& key,
                        const DecodedSource& source,
                        Frame start_frame,
                        Frame frame_count);
    void enqueue_range(const PitchCacheKey& key,
                       const DecodedSource& source,
                       Frame start_frame,
                       Frame frame_count,
                       int priority,
                       std::uint64_t generation,
                       std::string reason);
    bool get_block_if_ready(const PitchCacheKey& key,
                            int block_index,
                            int frame_offset_in_block,
                            int frames_needed,
                            float** out,
                            int num_channels) noexcept;
    bool is_block_ready(const PitchCacheKey& key, int block_index) const;
    int block_index_for(Frame frame) const noexcept;
    int offset_in_block(Frame frame) const noexcept;
    std::uint64_t missing_proxy_block_count() const noexcept;

    void set_realtime_fallback_enabled(bool enabled) noexcept;
    bool realtime_fallback_enabled() const noexcept;
    void set_persistent_cache_dir(const std::filesystem::path& cache_dir);
    void set_persistent_cache_enabled(bool enabled);
    PersistentPitchProxyCacheDiagnostics disk_cache_diagnostics() const;

    void clear();
    void evict(const Id& source_id);

private:
    using CacheMap = std::unordered_map<PitchCacheKey, std::shared_ptr<PitchProcessor>, PitchCacheKeyHash>;
    struct ProxyCacheKey {
        PitchCacheKey pitch_key;
        int block_index = 0;

        bool operator==(const ProxyCacheKey& o) const noexcept {
            return block_index == o.block_index && pitch_key == o.pitch_key;
        }
    };

    struct ProxyCacheKeyHash {
        std::size_t operator()(const ProxyCacheKey& k) const noexcept {
            std::size_t h = PitchCacheKeyHash{}(k.pitch_key);
            h ^= std::hash<int>{}(k.block_index) + 0x9e3779b9u + (h << 6) + (h >> 2);
            return h;
        }
    };

    using ProxyMap = std::unordered_map<ProxyCacheKey, std::shared_ptr<PreparedPitchBlock>, ProxyCacheKeyHash>;

    struct ProxyJob {
        PitchCacheKey key;
        const DecodedSource* source = nullptr;
        Frame start_frame = 0;
        Frame frame_count = 0;
        int priority = 0;
        std::uint64_t generation = 0;
        std::uint64_t order = 0;
        std::string reason;
    };

    mutable std::mutex write_mutex_;
    mutable std::mutex job_mutex_;
    std::condition_variable job_cv_;
    std::deque<ProxyJob> jobs_;
    std::set<std::string> queued_blocks_;
    std::thread worker_;
    std::atomic<bool> stop_worker_{false};
    std::atomic<std::uint64_t> job_order_{0};
    std::shared_ptr<const CacheMap> cache_{std::make_shared<const CacheMap>()};
    std::shared_ptr<const ProxyMap> proxy_cache_{std::make_shared<const ProxyMap>()};
    std::atomic<std::uint64_t> missing_processor_count_{0};
    std::atomic<std::uint64_t> missing_proxy_count_{0};
    std::atomic<std::uint64_t> proxy_generation_count_{0};
    std::atomic<std::uint64_t> duplicate_proxy_request_count_{0};
    std::atomic<std::uint64_t> render_path_realtime_fallback_count_{0};
    std::atomic<std::uint64_t> jobs_queued_{0};
    std::atomic<std::uint64_t> jobs_running_{0};
    std::atomic<std::uint64_t> jobs_completed_{0};
    std::atomic<std::uint64_t> jobs_failed_{0};
    std::atomic<std::uint64_t> offline_segments_rendered_{0};
    std::atomic<std::uint64_t> offline_segment_failures_{0};
    std::atomic<int> offline_latency_frames_{0};
    std::atomic<int> offline_preroll_frames_{0};
    std::atomic<int> offline_postroll_frames_{0};
    std::atomic<std::uint64_t> offline_trimmed_frames_{0};
    std::atomic<std::uint64_t> offline_render_us_{0};
    std::atomic<std::uint64_t> prepare_sync_count_{0};
    std::atomic<std::uint64_t> prepare_blocking_us_{0};
    std::atomic<bool> realtime_fallback_enabled_{false};
    mutable std::mutex reason_mutex_;
    std::string last_prepare_reason_;
    std::string last_offline_error_;
    std::unique_ptr<PersistentPitchProxyCache> disk_cache_;

    void worker_loop();
    bool generate_range(const PitchCacheKey& key,
                        const DecodedSource& source,
                        Frame start_frame,
                        Frame frame_count);
    bool publish_block(const PitchCacheKey& key,
                       const DecodedSource& source,
                       Frame source_start_frame,
                       int block_index);
    static std::string block_id(const PitchCacheKey& key, int block_index);
};

} // namespace lt
