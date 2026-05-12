#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/audio_decoder.h>

namespace lt {

SourceManager::SourceManager()  = default;
SourceManager::~SourceManager() = default;

void SourceManager::register_source(const Id& source_id,
                                     const std::string& file_path) {
    auto& entry    = entries_[source_id];
    entry.file_path = file_path;
    entry.status    = "unloaded";
}

Result<void> SourceManager::load_source(const Id& source_id,
                                         int engine_sample_rate) {
    auto it = entries_.find(source_id);
    if (it == entries_.end())
        return Result<void>::err("Source not registered: " + source_id);

    auto& entry  = it->second;
    entry.status  = "loading";

    int    channel_count   = 0;
    Frame  duration_frames = 0;

    auto result = decode_file_to_float32(entry.file_path,
                                          engine_sample_rate,
                                          &channel_count,
                                          &duration_frames);
    if (result.is_err()) {
        entry.status        = "failed";
        entry.error_message = result.error();
        return Result<void>::err(result.error());
    }

    std::atomic_store(&entry.source, std::make_shared<DecodedSource>(
        result.take(), channel_count, engine_sample_rate, duration_frames));
    entry.status = "ready";
    return Result<void>::ok();
}

Result<void> SourceManager::store_decoded_source(const Id& source_id,
                                                 std::vector<float> samples,
                                                 int channel_count,
                                                 int sample_rate,
                                                 Frame duration_frames) {
    auto it = entries_.find(source_id);
    if (it == entries_.end())
        return Result<void>::err("Source not registered: " + source_id);

    auto& entry = it->second;
    std::atomic_store(&entry.source, std::make_shared<DecodedSource>(
        std::move(samples), channel_count, sample_rate, duration_frames));
    entry.status = "ready";
    entry.error_message.clear();
    return Result<void>::ok();
}

const DecodedSource* SourceManager::get(const Id& source_id) const noexcept {
    auto it = entries_.find(source_id);
    if (it == entries_.end()) return nullptr;
    auto source = std::atomic_load(&it->second.source);
    return source ? source.get() : nullptr;
}

std::vector<SourceDiagnostics> SourceManager::diagnostics() const {
    std::vector<SourceDiagnostics> out;
    out.reserve(entries_.size());
    for (const auto& [id, entry] : entries_) {
        SourceDiagnostics d;
        d.source_id     = id;
        d.file_path     = entry.file_path;
        d.status        = entry.status;
        d.error_message = entry.error_message;
        auto source = std::atomic_load(&entry.source);
        if (source) {
            d.channel_count   = source->channel_count();
            d.sample_rate     = source->sample_rate();
            d.duration_frames = source->duration_frames();
            d.memory_bytes    = source->duration_frames()
                              * source->channel_count()
                              * sizeof(float);
        }
        out.push_back(std::move(d));
    }
    return out;
}

void SourceManager::clear() {
    entries_.clear();
}

} // namespace lt
