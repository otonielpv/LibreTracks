#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/result.h>
#include <lt_engine/sources/decoded_source.h>
#include <memory>
#include <string>
#include <unordered_map>

namespace lt {

struct SourceDiagnostics {
    Id          source_id;
    std::string file_path;
    std::string status;          // "unloaded" | "loading" | "ready" | "failed"
    std::string error_message;
    int         channel_count   = 0;
    int         sample_rate     = 0;
    Frame       duration_frames = 0;
    size_t      memory_bytes    = 0;
};

// ---------------------------------------------------------------------------
// SourceManager — owns all DecodedSources for a session.
//
// Thread model (Phases 6-9): all operations are called from the main/command
// thread before playback begins.  Phase 10 adds worker-thread loading.
// ---------------------------------------------------------------------------
class SourceManager {
public:
    SourceManager();
    ~SourceManager();

    // Register a source file.  Does not decode yet.
    void register_source(const Id& source_id, const std::string& file_path);

    // Synchronously decode and resample the source to engine sample rate.
    // Called from command thread only.
    Result<void> load_source(const Id& source_id, int engine_sample_rate);

    // Get a loaded source.  Returns nullptr if not loaded.
    // Safe to call from audio thread (read-only once loaded).
    const DecodedSource* get(const Id& source_id) const noexcept;

    // Diagnostics for snapshot.
    std::vector<SourceDiagnostics> diagnostics() const;

    // Unload all sources (e.g. session close).
    void clear();

private:
    struct Entry {
        std::string              file_path;
        std::unique_ptr<DecodedSource> source;
        std::string              status;
        std::string              error_message;
    };

    std::unordered_map<Id, Entry> entries_;
};

} // namespace lt
