// ---------------------------------------------------------------------------
// C ABI entry points — lt_engine.h implementation.
//
// LtEngine* is a type-erased pointer to lt::EngineImpl.
// No C++ exceptions cross the ABI boundary.
// ---------------------------------------------------------------------------

#include <lt_engine/lt_engine.h>
#include <lt_engine/engine_impl.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/core/thread_policy.h>
#include <nlohmann/json.hpp>
#include <cstring>
#include <vector>

namespace {

using json = nlohmann::json;

static lt::EngineImpl* as_impl(LtEngine* e) {
    return reinterpret_cast<lt::EngineImpl*>(e);
}

std::string peaks_to_json(const lt::SourcePeakOverview& overview) {
    json out;
    out["ok"] = false;
    if (overview.sample_rate <= 0 || overview.duration_frames <= 0
        || overview.min_peaks.empty() || overview.max_peaks.empty()) {
        out["error"] = "source peaks are not ready";
        return out.dump();
    }

    out["ok"] = true;
    out["sample_rate"] = overview.sample_rate;
    out["duration_frames"] = overview.duration_frames;
    out["resolution_frames"] = overview.resolution_frames;
    out["min_peaks"] = overview.min_peaks;
    out["max_peaks"] = overview.max_peaks;
    if (!overview.min_peaks_right.empty() && !overview.max_peaks_right.empty()) {
        out["min_peaks_right"] = overview.min_peaks_right;
        out["max_peaks_right"] = overview.max_peaks_right;
    }
    return out.dump();
}

} // namespace

extern "C" {

LT_API LtEngine* lt_audio_engine_create(void) {
    try {
        return reinterpret_cast<LtEngine*>(new lt::EngineImpl());
    } catch (...) {
        return nullptr;
    }
}

LT_API void lt_audio_engine_destroy(LtEngine* engine) {
    if (!engine) return;
    delete as_impl(engine);
}

LT_API LtResult lt_audio_engine_initialize(LtEngine* engine) {
    if (!engine) return LT_ERR_INVALID_HANDLE;
    auto r = as_impl(engine)->initialize();
    return r.is_ok() ? LT_OK : LT_ERR_INTERNAL;
}

LT_API LtResult lt_audio_engine_shutdown(LtEngine* engine) {
    if (!engine) return LT_ERR_INVALID_HANDLE;
    auto r = as_impl(engine)->shutdown();
    return r.is_ok() ? LT_OK : LT_ERR_INTERNAL;
}

LT_API const char* lt_audio_engine_get_version(LtEngine* engine) {
    if (!engine) return "0.0.0";
    // Store in static to satisfy "valid until next call" contract.
    thread_local std::string buf;
    buf = as_impl(engine)->version();
    return buf.c_str();
}

LT_API const char* lt_audio_engine_get_diagnostics(LtEngine* engine) {
    if (!engine) return "{}";
    as_impl(engine)->service_control_thread_tasks();
    thread_local std::string buf;
    buf = as_impl(engine)->diagnostics();
    return buf.c_str();
}

LT_API LtResult lt_audio_engine_send_command(LtEngine* engine,
                                               const char* command_json) {
    if (!engine || !command_json) return LT_ERR_INVALID_HANDLE;
    auto r = as_impl(engine)->send_command(command_json);
    if (r.is_ok()) return LT_OK;
    return LT_ERR_INVALID_COMMAND;
}

LT_API void lt_audio_engine_service_control_thread(LtEngine* engine) {
    if (!engine) return;
    as_impl(engine)->service_control_thread_tasks();
}

LT_API const char* lt_audio_engine_poll_event(LtEngine* engine) {
    if (!engine) return nullptr;
    as_impl(engine)->service_control_thread_tasks();
    thread_local std::string buf;
    buf = as_impl(engine)->poll_event();
    return buf.empty() ? nullptr : buf.c_str();
}

LT_API const char* lt_audio_engine_get_snapshot(LtEngine* engine) {
    if (!engine) return "{}";
    as_impl(engine)->service_control_thread_tasks();
    thread_local std::string buf;
    buf = as_impl(engine)->get_snapshot();
    return buf.c_str();
}

LT_API const char* lt_audio_engine_list_devices(LtEngine* engine,
                                                int32_t force_rescan) {
    if (!engine) return "[]";
    thread_local std::string buf;
    buf = as_impl(engine)->list_devices(force_rescan != 0);
    return buf.c_str();
}

LT_API const char* lt_audio_engine_get_source_peaks(LtEngine* engine,
                                                    const char* source_id,
                                                    int32_t resolution_frames) {
    if (!engine || !source_id) return "{\"ok\":false,\"error\":\"invalid handle\"}";
    thread_local std::string buf;
    buf = as_impl(engine)->get_source_peaks(source_id, static_cast<int>(resolution_frames));
    return buf.c_str();
}

LT_API LtSourcePeaksWindowView lt_audio_engine_get_source_peaks_window(
    LtEngine* engine,
    const char* source_id,
    int64_t start_frame,
    int64_t end_frame,
    int32_t bucket_count) {
    LtSourcePeaksWindowView view{};
    if (!engine || !source_id || bucket_count <= 0 || end_frame <= start_frame)
        return view;

    try {
        const auto window = as_impl(engine)->get_source_peaks_window(
            source_id, static_cast<lt::Frame>(start_frame),
            static_cast<lt::Frame>(end_frame), static_cast<int>(bucket_count));
        if (window.sample_rate <= 0 || window.bucket_count <= 0
            || window.min_peaks.size() != static_cast<std::size_t>(window.bucket_count)
            || window.max_peaks.size() != static_cast<std::size_t>(window.bucket_count)) {
            return view;
        }

        thread_local std::vector<uint8_t> bytes;
        const bool stereo = window.min_peaks_right.size() == window.min_peaks.size()
                         && window.max_peaks_right.size() == window.max_peaks.size();
        const std::size_t plane_bytes = window.min_peaks.size() * sizeof(float);
        bytes.resize(plane_bytes * (stereo ? 4u : 2u));
        std::size_t offset = 0;
        auto append = [&](const std::vector<float>& plane) {
            // LibreTracks targets little-endian desktop/Android ABIs. Keeping
            // the payload as raw f32 avoids a multi-megabyte JSON float parse.
            std::memcpy(bytes.data() + offset, plane.data(), plane_bytes);
            offset += plane_bytes;
        };
        append(window.min_peaks);
        append(window.max_peaks);
        if (stereo) {
            append(window.min_peaks_right);
            append(window.max_peaks_right);
        }

        view.data = bytes.data();
        view.data_len = static_cast<uint64_t>(bytes.size());
        view.sample_rate = window.sample_rate;
        view.channel_count = stereo ? 2 : 1;
        view.start_frame = window.start_frame;
        view.end_frame = window.end_frame;
        view.bucket_count = window.bucket_count;
        view.ok = 1;
        return view;
    } catch (...) {
        return view;
    }
}

LT_API const char* lt_audio_engine_capture_output_samples(LtEngine* engine) {
    if (!engine) return "{\"ok\":false,\"error\":\"invalid handle\"}";
    thread_local std::string buf;
    buf = as_impl(engine)->capture_output_samples();
    return buf.c_str();
}

LT_API const char* lt_audio_engine_analyze_file_peaks(const char* file_path,
                                                      int32_t resolution_frames) {
    if (!file_path) return "{\"ok\":false,\"error\":\"invalid file path\"}";
    thread_local std::string buf;
    try {
        buf = peaks_to_json(lt::analyze_file_peaks(
            file_path,
            static_cast<int>(resolution_frames)));
    } catch (...) {
        buf = "{\"ok\":false,\"error\":\"native waveform analysis failed\"}";
    }
    return buf.c_str();
}

LT_API int32_t lt_audio_engine_recommend_worker_threads(int32_t role) {
    lt::WorkerRole worker_role;
    switch (role) {
        case 0:  worker_role = lt::WorkerRole::Decode;   break;
        case 1:  worker_role = lt::WorkerRole::Fill;     break;
        case 2:  worker_role = lt::WorkerRole::Waveform; break;
        default: return 1;
    }
    try {
        return static_cast<int32_t>(lt::lt_recommend_worker_threads(worker_role));
    } catch (...) {
        return 1;
    }
}

namespace {
// Adapts the C callback pair (fn, ctx) to the C++ PeakProgressFn the analyser
// takes. Lives on the analysing thread's stack for the duration of the call.
struct PeakProgressBridge {
    LtPeakProgressCallback fn  = nullptr;
    void*                  ctx = nullptr;
};

void forward_peak_progress(void* bridge_ptr, const lt::PeakProgress& progress) {
    auto* bridge = static_cast<PeakProgressBridge*>(bridge_ptr);
    if (!bridge || !bridge->fn)
        return;
    bridge->fn(bridge->ctx,
               static_cast<int32_t>(progress.sample_rate),
               static_cast<int64_t>(progress.analyzed_frames),
               static_cast<int64_t>(progress.total_frames),
               static_cast<int32_t>(progress.resolution_frames),
               progress.min_peaks,
               progress.max_peaks,
               progress.min_peaks_right,
               progress.max_peaks_right,
               static_cast<int32_t>(progress.bucket_count));
}
}  // namespace

LT_API const char* lt_audio_engine_analyze_file_peaks_progressive(
    const char* file_path,
    int32_t resolution_frames,
    LtPeakProgressCallback on_progress,
    void* progress_ctx) {
    if (!file_path) return "{\"ok\":false,\"error\":\"invalid file path\"}";
    thread_local std::string buf;
    PeakProgressBridge bridge{on_progress, progress_ctx};
    try {
        buf = peaks_to_json(lt::analyze_file_peaks(
            file_path,
            static_cast<int>(resolution_frames),
            on_progress ? &forward_peak_progress : nullptr,
            &bridge));
    } catch (...) {
        buf = "{\"ok\":false,\"error\":\"native waveform analysis failed\"}";
    }
    return buf.c_str();
}

LT_API void lt_audio_engine_load_pad_clip(LtEngine* engine,
                                          const char* pads_dir,
                                          const char* pad_id,
                                          int32_t key,
                                          int32_t sample_rate) {
    if (!engine || !pads_dir || !pad_id) return;
    try {
        as_impl(engine)->load_pad_clip_now(pads_dir, pad_id,
                                           static_cast<int>(key),
                                           static_cast<int>(sample_rate));
    } catch (...) {
        // A failed decode leaves the previous clip untouched; never throw across
        // the FFI boundary.
    }
}

// ---------------------------------------------------------------------------
// Cache maintenance — no engine handle required. These operate on the
// env-resolved PCM cache directory ($LIBRETRACKS_CACHE_DIR), so the UI can
// report / clear the decoding cache without a live engine instance.
// ---------------------------------------------------------------------------

LT_API const char* lt_audio_engine_source_cache_dir(void) {
    thread_local std::string buf;
    try {
        buf = lt::source_cache_directory();
    } catch (...) {
        buf.clear();
    }
    return buf.c_str();
}

LT_API uint64_t lt_audio_engine_source_cache_size_bytes(void) {
    try {
        return static_cast<uint64_t>(lt::source_cache_dir_size_bytes());
    } catch (...) {
        return 0;
    }
}

LT_API uint64_t lt_audio_engine_release_cached_audio(LtEngine* engine,
                                                     uint32_t keep_per_source) {
    try {
        auto* impl = as_impl(engine);
        if (!impl)
            return 0;
        return static_cast<uint64_t>(
            impl->release_cached_audio_under_pressure(keep_per_source));
    } catch (...) {
        return 0;
    }
}

LT_API uint64_t lt_audio_engine_purge_source_cache(void) {
    try {
        return static_cast<uint64_t>(lt::purge_source_cache());
    } catch (...) {
        return 0;
    }
}

// Same purge, but reports how many files could not be deleted. `out_failed` may
// be null. A nonzero count means the files are held open (a loaded session
// streams from them), which the host surfaces instead of claiming success.
LT_API uint64_t lt_audio_engine_purge_source_cache_ex(uint32_t* out_failed) {
    try {
        unsigned int failed = 0;
        const uint64_t freed = static_cast<uint64_t>(lt::purge_source_cache(&failed));
        if (out_failed)
            *out_failed = static_cast<uint32_t>(failed);
        return freed;
    } catch (...) {
        if (out_failed)
            *out_failed = 0;
        return 0;
    }
}

} // extern "C"
