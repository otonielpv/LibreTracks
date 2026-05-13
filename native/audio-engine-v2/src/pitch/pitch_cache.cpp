#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/bypass_pitch_processor.h>
#include <lt_engine/pitch/offline_pitch_segment_renderer.h>
#include <lt_engine/pitch/persistent_pitch_proxy_cache.h>
#include <lt_engine/pitch/rubberband_pitch_processor.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <vector>

namespace lt {

namespace {

std::string key_to_string(const PitchCacheKey& key) {
    return key.source_id + ":" + key.track_id + ":" + key.clip_id + ":"
        + std::to_string(key.semitones);
}

bool valid_samples(const std::vector<float>& samples) {
    for (float sample : samples) {
        if (!std::isfinite(sample) || std::abs(sample) > 8.0f)
            return false;
    }
    return true;
}

} // namespace

PitchCache::PitchCache() {
    disk_cache_ = std::make_unique<PersistentPitchProxyCache>();
    worker_ = std::thread([this] { worker_loop(); });
}

PitchCache::~PitchCache() {
    stop_worker_.store(true, std::memory_order_release);
    job_cv_.notify_all();
    if (worker_.joinable())
        worker_.join();
}

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
    missing_proxy_count_.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard reason_lock(reason_mutex_);
    active_pitch_render_path_ = "missing_proxy_silence";
    last_missing_proxy_key_ = key_to_string(key);
    last_missing_proxy_block_index_ = block_index;
}

void PitchCache::note_realtime_fallback_used() noexcept {
    render_path_realtime_fallback_count_.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard reason_lock(reason_mutex_);
    active_pitch_render_path_ = "realtime_fallback";
}

void PitchCache::note_prepared_proxy_used() noexcept {
    std::lock_guard reason_lock(reason_mutex_);
    active_pitch_render_path_ = "prepared_proxy";
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
    d.jobs_queued = jobs_queued_.load(std::memory_order_relaxed);
    d.jobs_running = jobs_running_.load(std::memory_order_relaxed);
    d.jobs_completed = jobs_completed_.load(std::memory_order_relaxed);
    d.jobs_failed = jobs_failed_.load(std::memory_order_relaxed);
    {
        std::lock_guard job_lock(job_mutex_);
        d.jobs_pending = static_cast<std::uint64_t>(jobs_.size());
        d.queued_blocks = static_cast<std::uint64_t>(queued_blocks_.size());
    }
    d.seek_immediate_jobs_queued = seek_immediate_jobs_queued_.load(std::memory_order_relaxed);
    d.seek_immediate_jobs_completed = seek_immediate_jobs_completed_.load(std::memory_order_relaxed);
    d.offline_segments_rendered = offline_segments_rendered_.load(std::memory_order_relaxed);
    d.offline_segment_failures = offline_segment_failures_.load(std::memory_order_relaxed);
    d.offline_latency_frames = offline_latency_frames_.load(std::memory_order_relaxed);
    d.offline_preroll_frames = offline_preroll_frames_.load(std::memory_order_relaxed);
    d.offline_postroll_frames = offline_postroll_frames_.load(std::memory_order_relaxed);
    d.offline_trimmed_frames = offline_trimmed_frames_.load(std::memory_order_relaxed);
    d.offline_render_ms = static_cast<double>(offline_render_us_.load(std::memory_order_relaxed)) / 1000.0;
    {
        std::lock_guard reason_lock(reason_mutex_);
        d.last_offline_error = last_offline_error_;
        d.active_pitch_render_path = active_pitch_render_path_;
        d.last_pitch_proxy_error = last_pitch_proxy_error_;
        d.last_missing_proxy_key = last_missing_proxy_key_;
        d.last_missing_proxy_block_index = last_missing_proxy_block_index_;
    }
    if (disk_cache_) {
        auto disk = disk_cache_->diagnostics();
        d.disk_cache_enabled = disk.enabled;
        d.disk_cache_dir = disk.cache_dir;
        d.disk_cache_hits = disk.hits;
        d.disk_cache_misses = disk.misses;
        d.disk_cache_writes = disk.writes;
        d.disk_cache_invalidations = disk.invalidations;
        d.disk_cache_size_bytes = disk.size_bytes;
        d.last_disk_cache_error = disk.last_error;
    }
    d.prepare_sync_count = prepare_sync_count_.load(std::memory_order_relaxed);
    d.prepare_blocking_ms = static_cast<double>(prepare_blocking_us_.load(std::memory_order_relaxed)) / 1000.0;
    {
        std::lock_guard reason_lock(reason_mutex_);
        d.last_prepare_reason = last_prepare_reason_;
    }
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
    if (is_block_ready(key, block_index)) {
        duplicate_proxy_request_count_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }
    const auto t0 = std::chrono::steady_clock::now();
    bool ok = generate_range(key, source, source_start_frame, kProxyBlockFrames);
    const auto t1 = std::chrono::steady_clock::now();
    prepare_sync_count_.fetch_add(1, std::memory_order_relaxed);
    prepare_blocking_us_.fetch_add(
        static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count()),
        std::memory_order_relaxed);
    return ok;
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

void PitchCache::enqueue_range(const PitchCacheKey& key,
                               const DecodedSource& source,
                               Frame start_frame,
                               Frame frame_count,
                               int priority,
                               std::uint64_t generation,
                               std::string reason) {
    if (key.semitones == 0.0 || frame_count <= 0)
        return;

    const Frame clamped_start = std::max<Frame>(0, start_frame);
    const Frame clamped_end = std::min<Frame>(source.duration_frames(), clamped_start + frame_count);
    if (clamped_end <= clamped_start)
        return;

    const int first = block_index_for(clamped_start);
    const int last = block_index_for(clamped_end - 1);
    bool queued_any = false;
    const std::string reason_copy = reason;
    {
        std::lock_guard lock(job_mutex_);
        for (int block = first; block <= last; ++block) {
            if (is_block_ready(key, block)) {
                duplicate_proxy_request_count_.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            const auto id = block_id(key, block);
            if (!queued_blocks_.insert(id).second) {
                duplicate_proxy_request_count_.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            ProxyJob job;
            job.key = key;
            job.source = &source;
            job.start_frame = static_cast<Frame>(block) * kProxyBlockFrames;
            job.frame_count = kProxyBlockFrames;
            job.priority = priority;
            job.generation = generation;
            job.order = job_order_.fetch_add(1, std::memory_order_relaxed);
            job.reason = reason_copy;
            jobs_.push_back(std::move(job));
            jobs_queued_.fetch_add(1, std::memory_order_relaxed);
            if (reason_copy == "seek_immediate")
                seek_immediate_jobs_queued_.fetch_add(1, std::memory_order_relaxed);
            queued_any = true;
        }
    }
    if (queued_any) {
        {
            std::lock_guard reason_lock(reason_mutex_);
            last_prepare_reason_ = reason_copy;
        }
        job_cv_.notify_one();
    }
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
        if (disk_cache_) {
            PreparedPitchBlock disk_block;
            if (disk_cache_->load_block(key, block_index, disk_block)) {
                auto prepared = std::make_shared<PreparedPitchBlock>(std::move(disk_block));
                {
                    std::lock_guard lock(write_mutex_);
                    auto current = std::atomic_load(&proxy_cache_);
                    auto next = std::make_shared<ProxyMap>(*current);
                    next->emplace(ProxyCacheKey{key, block_index}, prepared);
                    std::atomic_store(&proxy_cache_, std::shared_ptr<const ProxyMap>(next));
                }
                cache = std::atomic_load(&proxy_cache_);
                it = cache->find(ProxyCacheKey{key, block_index});
            }
        }
        if (it == cache->end() || !it->second) {
            note_missing_proxy_block(key, block_index);
            return false;
        }
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
    note_prepared_proxy_used();
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

void PitchCache::set_persistent_cache_dir(const std::filesystem::path& cache_dir) {
    if (disk_cache_)
        disk_cache_->set_cache_dir(cache_dir);
}

void PitchCache::set_persistent_cache_enabled(bool enabled) {
    if (disk_cache_)
        disk_cache_->set_enabled(enabled);
}

PersistentPitchProxyCacheDiagnostics PitchCache::disk_cache_diagnostics() const {
    return disk_cache_ ? disk_cache_->diagnostics() : PersistentPitchProxyCacheDiagnostics{};
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
    jobs_queued_.store(0, std::memory_order_relaxed);
    jobs_running_.store(0, std::memory_order_relaxed);
    jobs_completed_.store(0, std::memory_order_relaxed);
    jobs_failed_.store(0, std::memory_order_relaxed);
    seek_immediate_jobs_queued_.store(0, std::memory_order_relaxed);
    seek_immediate_jobs_completed_.store(0, std::memory_order_relaxed);
    offline_segments_rendered_.store(0, std::memory_order_relaxed);
    offline_segment_failures_.store(0, std::memory_order_relaxed);
    offline_render_us_.store(0, std::memory_order_relaxed);
    prepare_sync_count_.store(0, std::memory_order_relaxed);
    prepare_blocking_us_.store(0, std::memory_order_relaxed);
    {
        std::lock_guard reason_lock(reason_mutex_);
        last_prepare_reason_.clear();
        last_offline_error_.clear();
        active_pitch_render_path_ = "bypass";
        last_pitch_proxy_error_.clear();
        last_missing_proxy_key_.clear();
        last_missing_proxy_block_index_ = -1;
    }
    {
        std::lock_guard job_lock(job_mutex_);
        jobs_.clear();
        queued_blocks_.clear();
    }
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

std::string PitchCache::block_id(const PitchCacheKey& key, int block_index) {
    return key_to_string(key) + ":" + std::to_string(key.sample_rate) + ":"
        + std::to_string(key.channel_count) + ":" + key.quality + ":"
        + std::to_string(key.cache_version) + ":" + std::to_string(block_index);
}

void PitchCache::worker_loop() {
    while (!stop_worker_.load(std::memory_order_acquire)) {
        ProxyJob job;
        {
            std::unique_lock lock(job_mutex_);
            job_cv_.wait(lock, [this] {
                return stop_worker_.load(std::memory_order_acquire) || !jobs_.empty();
            });
            if (stop_worker_.load(std::memory_order_acquire))
                break;
            auto best = std::min_element(jobs_.begin(), jobs_.end(), [](const ProxyJob& a, const ProxyJob& b) {
                if (a.priority != b.priority)
                    return a.priority < b.priority;
                return a.order < b.order;
            });
            job = *best;
            jobs_.erase(best);
        }

        jobs_running_.fetch_add(1, std::memory_order_relaxed);
        bool ok = job.source && generate_range(job.key, *job.source, job.start_frame, job.frame_count);
        {
            std::lock_guard lock(job_mutex_);
            const int first = block_index_for(std::max<Frame>(0, job.start_frame));
            const int last = block_index_for(std::max<Frame>(0, job.start_frame + job.frame_count - 1));
            for (int block = first; block <= last; ++block)
                queued_blocks_.erase(block_id(job.key, block));
        }
        jobs_running_.fetch_sub(1, std::memory_order_relaxed);
        if (ok) {
            jobs_completed_.fetch_add(1, std::memory_order_relaxed);
            if (job.reason == "seek_immediate")
                seek_immediate_jobs_completed_.fetch_add(1, std::memory_order_relaxed);
        } else {
            jobs_failed_.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

bool PitchCache::generate_range(const PitchCacheKey& key,
                                const DecodedSource& source,
                                Frame start_frame,
                                Frame frame_count) {
    if (key.semitones == 0.0 || frame_count <= 0)
        return true;

    const Frame clamped_start = std::max<Frame>(0, start_frame);
    const Frame clamped_end = std::min<Frame>(source.duration_frames(), clamped_start + frame_count);
    if (clamped_end <= clamped_start)
        return false;

    const auto t0 = std::chrono::steady_clock::now();
    OfflinePitchSegmentRenderer renderer;
    auto segment = renderer.render_segment(key, source, clamped_start, clamped_end - clamped_start);
    const auto t1 = std::chrono::steady_clock::now();
    offline_render_us_.fetch_add(
        static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count()),
        std::memory_order_relaxed);
    const std::size_t expected_segment_samples =
        static_cast<std::size_t>(segment.frame_count * segment.channel_count);
    if (!segment.ok || segment.frame_count <= 0 || segment.channel_count <= 0
        || segment.interleaved_samples.size() != expected_segment_samples
        || !valid_samples(segment.interleaved_samples)) {
        offline_segment_failures_.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard reason_lock(reason_mutex_);
        last_offline_error_ = segment.error.empty()
            ? "invalid offline pitch segment"
            : segment.error;
        last_pitch_proxy_error_ = last_offline_error_;
        return false;
    }

    offline_segments_rendered_.fetch_add(1, std::memory_order_relaxed);
    offline_latency_frames_.store(segment.latency_frames, std::memory_order_relaxed);
    offline_preroll_frames_.store(segment.preroll_frames, std::memory_order_relaxed);
    offline_postroll_frames_.store(segment.postroll_frames, std::memory_order_relaxed);
    offline_trimmed_frames_.fetch_add(static_cast<std::uint64_t>(segment.trimmed_frames), std::memory_order_relaxed);

    const int first = block_index_for(segment.start_frame);
    const int last = block_index_for(segment.start_frame + segment.frame_count - 1);
    bool any = false;
    for (int block = first; block <= last; ++block) {
        const Frame block_start = static_cast<Frame>(block) * kProxyBlockFrames;
        const Frame local_start = std::max<Frame>(0, block_start - segment.start_frame);
        const int frames = static_cast<int>(std::min<Frame>(
            kProxyBlockFrames,
            std::max<Frame>(0, segment.frame_count - local_start)));
        if (frames <= 0)
            continue;

        auto prepared = std::make_shared<PreparedPitchBlock>();
        prepared->key = key;
        prepared->source_start_frame = block_start;
        prepared->block_index = block;
        prepared->frame_count = frames;
        prepared->channel_count = segment.channel_count;
        prepared->interleaved_samples.assign(static_cast<std::size_t>(frames * segment.channel_count), 0.0f);
        for (int f = 0; f < frames; ++f) {
            const std::size_t src = static_cast<std::size_t>((local_start + f) * segment.channel_count);
            const std::size_t dst = static_cast<std::size_t>(f * segment.channel_count);
            std::copy(segment.interleaved_samples.begin() + static_cast<std::ptrdiff_t>(src),
                      segment.interleaved_samples.begin() + static_cast<std::ptrdiff_t>(src + segment.channel_count),
                      prepared->interleaved_samples.begin() + static_cast<std::ptrdiff_t>(dst));
        }
        if (prepared->frame_count <= 0 || prepared->channel_count <= 0
            || prepared->interleaved_samples.size()
                != static_cast<std::size_t>(prepared->frame_count * prepared->channel_count)
            || !valid_samples(prepared->interleaved_samples)) {
            offline_segment_failures_.fetch_add(1, std::memory_order_relaxed);
            std::lock_guard reason_lock(reason_mutex_);
            last_offline_error_ = "invalid prepared pitch proxy block";
            last_pitch_proxy_error_ = last_offline_error_;
            continue;
        }

        {
            std::lock_guard lock(write_mutex_);
            auto current = std::atomic_load(&proxy_cache_);
            ProxyCacheKey proxy_key{key, block};
            if (current->find(proxy_key) == current->end()) {
                auto next = std::make_shared<ProxyMap>(*current);
                next->emplace(std::move(proxy_key), prepared);
                std::atomic_store(&proxy_cache_, std::shared_ptr<const ProxyMap>(next));
                proxy_generation_count_.fetch_add(1, std::memory_order_relaxed);
                if (disk_cache_)
                    disk_cache_->store_block(*prepared);
                any = true;
            }
        }
        {
            std::lock_guard lock(job_mutex_);
            queued_blocks_.erase(block_id(key, block));
        }
    }
    if (any)
        return true;
    for (int block = first; block <= last; ++block) {
        if (!is_block_ready(key, block))
            return false;
    }
    return true;
}

bool PitchCache::publish_block(const PitchCacheKey& key,
                               const DecodedSource& source,
                               Frame source_start_frame,
                               int block_index) {
    if (is_block_ready(key, block_index))
        return true;
    return generate_range(key, source, source_start_frame, kProxyBlockFrames);
}

} // namespace lt
