// ---------------------------------------------------------------------------
// C ABI entry points — lt_engine.h implementation.
//
// LtEngine* is a type-erased pointer to lt::EngineImpl.
// No C++ exceptions cross the ABI boundary.
// ---------------------------------------------------------------------------

#include <lt_engine/lt_engine.h>
#include <lt_engine/engine_impl.h>

static lt::EngineImpl* as_impl(LtEngine* e) {
    return reinterpret_cast<lt::EngineImpl*>(e);
}

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
    thread_local std::string buf;
    buf = as_impl(engine)->poll_event();
    return buf.empty() ? nullptr : buf.c_str();
}

LT_API const char* lt_audio_engine_get_snapshot(LtEngine* engine) {
    if (!engine) return "{}";
    thread_local std::string buf;
    buf = as_impl(engine)->get_snapshot();
    return buf.c_str();
}

LT_API const char* lt_audio_engine_list_devices(LtEngine* engine) {
    if (!engine) return "[]";
    thread_local std::string buf;
    buf = as_impl(engine)->list_devices();
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

} // extern "C"
