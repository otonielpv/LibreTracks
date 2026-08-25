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
 *  Each element has: { "id": "...", "name": "...", "backend": "..." }
 *  When `force_rescan` is non-zero, re-scans every backend (including the one
 *  driving the live stream) and reopens the active device afterwards, so hot
 *  (un)plugged devices appear — at the cost of a brief audio dropout while
 *  playing. Pass 0 for the cheap, dropout-free path used on Settings open. */
LT_API const char* lt_audio_engine_list_devices(LtEngine* engine,
                                                int32_t force_rescan);

/** JSON object with downsampled peaks for a loaded source.
 *  Returns { "ok": false, "error": "..." } when the source is not ready. */
LT_API const char* lt_audio_engine_get_source_peaks(LtEngine* engine,
                                                    const char* source_id,
                                                    int32_t resolution_frames);

/** Borrowed binary view of an exact source interval. `data` contains little-
 *  endian float32 planes in this order: min-left, max-left, then (for stereo)
 *  min-right, max-right. The pointer remains valid until the next call on the
 *  same thread and must not be freed. This API is additive; the JSON overview
 *  endpoint above remains available to older hosts. */
typedef struct LtSourcePeaksWindowView {
    const uint8_t* data;
    uint64_t data_len;
    int32_t sample_rate;
    int32_t channel_count;
    int64_t start_frame;
    int64_t end_frame;
    int32_t bucket_count;
    int32_t ok;
} LtSourcePeaksWindowView;

LT_API LtSourcePeaksWindowView lt_audio_engine_get_source_peaks_window(
    LtEngine* engine,
    const char* source_id,
    int64_t start_frame,
    int64_t end_frame,
    int32_t bucket_count);

/** E2E-only output capture. Returns an error unless its build flag is enabled. */
LT_API const char* lt_audio_engine_capture_output_samples(LtEngine* engine);

/** JSON object with downsampled peaks for an audio file decoded directly by
 *  the native decoder stack. Does not require a live engine handle. */
LT_API const char* lt_audio_engine_analyze_file_peaks(const char* file_path,
                                                      int32_t resolution_frames);

/** Background worker count recommended for `role` on this machine, from the
 *  same thread policy the engine's own pools use (scaled by cores and RAM).
 *  Roles: 0 = decode, 1 = fill, 2 = waveform analysis. Unknown roles answer 1.
 *  Exposed so a host-side pool (the waveform queue) follows one policy instead
 *  of restating it and drifting. Needs no engine handle. */
LT_API int32_t lt_audio_engine_recommend_worker_threads(int32_t role);

/** Partial peaks reported while `lt_audio_engine_analyze_file_peaks_progressive`
 *  is still reading the file. The pointers are the analyser's own buffers and
 *  are valid ONLY for the duration of the call, for `bucket_count` entries —
 *  copy what you need before returning. `bucket_count` counts complete buckets
 *  only. The right-channel pointers are null for mono sources.
 *  Called on the calling thread; must not block. */
typedef void (*LtPeakProgressCallback)(void* ctx,
                                       int32_t sample_rate,
                                       int64_t analyzed_frames,
                                       int64_t total_frames,
                                       int32_t resolution_frames,
                                       const float* min_peaks,
                                       const float* max_peaks,
                                       const float* min_peaks_right,
                                       const float* max_peaks_right,
                                       int32_t bucket_count);

/** Same as `lt_audio_engine_analyze_file_peaks`, but reports partial peaks
 *  every ~150 ms so the host can paint the waveform as it is analysed instead
 *  of blocking on a placeholder until the whole file is done. Passing a null
 *  callback is equivalent to the non-progressive call. */
LT_API const char* lt_audio_engine_analyze_file_peaks_progressive(
    const char* file_path,
    int32_t resolution_frames,
    LtPeakProgressCallback on_progress,
    void* progress_ctx);

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

/**
 * Release cached audio blocks from RAM when the OS reports memory pressure
 * (Android's onTrimMemory). Keeps `keep_per_source` freshest blocks per source
 * so playback in progress survives — pass 0 to drop everything. Returns bytes
 * freed. Unlike purge_source_cache this touches memory, not the disk cache.
 */
LT_API uint64_t lt_audio_engine_release_cached_audio(LtEngine* engine,
                                                     uint32_t keep_per_source);

#ifdef __cplusplus
} // extern "C"
#endif
