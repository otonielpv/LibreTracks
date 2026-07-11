#pragma once

// ---------------------------------------------------------------------------
// LibreTracks Audio Engine v2 — public C ABI
//
// All functions use the "lt_audio_engine_" prefix.
// Opaque handle pattern: callers receive LtEngine* and pass it back.
// All strings are UTF-8.  Caller owns nothing: the engine manages memory for
// returned strings.  A returned string pointer is valid until the next call
// that returns a string on the same engine instance, or until destroy().
// ---------------------------------------------------------------------------

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------------------
// Platform visibility
// ---------------------------------------------------------------------------
#if defined(_WIN32)
#  if defined(LT_ENGINE_EXPORT)
#    define LT_API __declspec(dllexport)
#  else
#    define LT_API __declspec(dllimport)
#  endif
#else
#  define LT_API __attribute__((visibility("default")))
#endif

// ---------------------------------------------------------------------------
// Opaque engine handle
// ---------------------------------------------------------------------------
typedef struct LtEngine LtEngine;

// ---------------------------------------------------------------------------
// Result codes
// ---------------------------------------------------------------------------
typedef enum LtResult {
    LT_OK                  = 0,
    LT_ERR_INVALID_HANDLE  = 1,
    LT_ERR_ALREADY_INIT    = 2,
    LT_ERR_NOT_INIT        = 3,
    LT_ERR_INVALID_COMMAND = 4,
    LT_ERR_DEVICE          = 5,
    LT_ERR_INTERNAL        = 99,
} LtResult;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Allocate and return a new engine instance.  Returns NULL on OOM. */
LT_API LtEngine* lt_audio_engine_create(void);

/** Release all resources held by the engine.  Safe to call after shutdown. */
LT_API void lt_audio_engine_destroy(LtEngine* engine);

/** Initialize the engine.  May open audio devices.  Call once per instance.
 *  Returns LT_ERR_ALREADY_INIT if called again without shutdown(). */
LT_API LtResult lt_audio_engine_initialize(LtEngine* engine);

/** Gracefully shut down the engine.  Safe to call multiple times. */
LT_API LtResult lt_audio_engine_shutdown(LtEngine* engine);

// ---------------------------------------------------------------------------
// Version / diagnostics
// ---------------------------------------------------------------------------

/** "MAJOR.MINOR.PATCH" version string of the engine library. */
LT_API const char* lt_audio_engine_get_version(LtEngine* engine);

/** JSON diagnostics snapshot.  See EngineSnapshot in the C++ headers for
 *  the schema.  Returned pointer is engine-owned, valid until next call. */
LT_API const char* lt_audio_engine_get_diagnostics(LtEngine* engine);

// ---------------------------------------------------------------------------
// Command / event pipeline
// ---------------------------------------------------------------------------

/** Send a JSON-encoded EngineCommand to the engine.
 *  Returns LT_ERR_INVALID_COMMAND if JSON is malformed or command unknown. */
LT_API LtResult lt_audio_engine_send_command(LtEngine* engine,
                                              const char* command_json);

/** Service control-thread housekeeping tasks (e.g. pitch stream repair).
 *  Call this once on the command thread before dispatching a batch of
 *  send_command() calls.  Never call from the audio callback. */
LT_API void lt_audio_engine_service_control_thread(LtEngine* engine);

/** Poll for the next pending EngineEvent as a JSON string.
 *  Returns NULL when the event queue is empty.
 *  The pointer is valid until the next call to poll_event on this instance. */
LT_API const char* lt_audio_engine_poll_event(LtEngine* engine);

/** Read the current EngineSnapshot as a JSON string.
 *  Always returns a valid JSON object even before Initialize(). */
LT_API const char* lt_audio_engine_get_snapshot(LtEngine* engine);

// ---------------------------------------------------------------------------
// Device enumeration helpers (convenience wrappers)
// ---------------------------------------------------------------------------

/** JSON array of available output devices.
 *  Each element has: { "id": "...", "name": "...", "backend": "..." } */
LT_API const char* lt_audio_engine_list_devices(LtEngine* engine);

/** JSON object with downsampled peaks for a loaded source.
 *  Returns { "ok": false, "error": "..." } when the source is not ready. */
LT_API const char* lt_audio_engine_get_source_peaks(LtEngine* engine,
                                                    const char* source_id,
                                                    int32_t resolution_frames);

/** JSON object with downsampled peaks for an audio file decoded directly by
 *  the native decoder stack. Does not require a live engine handle. */
LT_API const char* lt_audio_engine_analyze_file_peaks(const char* file_path,
                                                      int32_t resolution_frames);

/** Decode a pad key (`<pads_dir>/<pad_id>/<key>.<ext>`) and swap it into the
 *  ambient-pad renderer immediately, on the calling thread. Intended to be
 *  called WITHOUT holding the host's engine lock, so the multi-second MP3
 *  decode of a long pad never stalls playback. `sample_rate <= 0` uses the
 *  current device rate. The swap itself is realtime-safe. */
LT_API void lt_audio_engine_load_pad_clip(LtEngine* engine,
                                          const char* pads_dir,
                                          const char* pad_id,
                                          int32_t key,
                                          int32_t sample_rate);

// ---------------------------------------------------------------------------
// Decoding cache maintenance (no engine handle required)
//
// These operate on the env-resolved on-disk PCM cache directory
// ($LIBRETRACKS_CACHE_DIR), so the host UI can report or clear the cache
// without a live engine instance. Both honour the configured folder.
// ---------------------------------------------------------------------------

/** Effective on-disk decoded-PCM cache directory (honours $LIBRETRACKS_CACHE_DIR).
 *  Returned pointer is valid until the next string-returning call on this thread. */
LT_API const char* lt_audio_engine_source_cache_dir(void);

/** Total bytes occupied by the on-disk decoded-PCM cache (.rf64 files). */
LT_API uint64_t lt_audio_engine_source_cache_size_bytes(void);

/** Delete all on-disk decoded-PCM cache files. Returns bytes freed. */
LT_API uint64_t lt_audio_engine_purge_source_cache(void);

#ifdef __cplusplus
} // extern "C"
#endif
