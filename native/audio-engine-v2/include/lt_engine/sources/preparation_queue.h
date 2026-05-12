#pragma once

// ---------------------------------------------------------------------------
// SourcePreparationQueue — coordinates async loading of all session sources.
//
// Wraps DecodeWorkerPool with:
//   - Priority ordering (sources near playhead first).
//   - Integration with SourceManager (writes result into it on completion).
//   - Event emission (EvSourcePrepared / EvDiagnosticWarning) via callback.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/core/events.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/worker_pool.h>
#include <functional>
#include <memory>

namespace lt {

using EventPushCallback = std::function<void(EngineEvent)>;

class SourcePreparationQueue {
public:
    SourcePreparationQueue(SourceManager*     source_manager,
                           DecodeWorkerPool*  pool,
                           EventPushCallback  push_event,
                           int                engine_sample_rate);
    ~SourcePreparationQueue();

    // Enqueue all sources in the session that are not yet loaded.
    // Sources near `playhead_frame` are prioritized.
    void enqueue_session(const std::vector<Source>& sources,
                         Frame playhead_frame);

    // Enqueue a single source (e.g. newly imported file).
    void enqueue_source(const Source& source);

    // Cancel everything (e.g. session unload).
    void cancel_all();

    // Summary for EngineSnapshot source_states field.
    std::vector<SourcePreparationInfo> preparation_states() const;

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

} // namespace lt
