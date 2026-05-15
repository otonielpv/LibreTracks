#include <lt_engine/engine_impl.h>
#include <lt_engine/core/engine_core.h>
#include <lt_engine/core/events.h>
#include <lt_engine/render/pitch_resolution.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace lt {

using json = nlohmann::json;

namespace {

bool env_flag_enabled(const char* name) {
    const char* raw = std::getenv(name);
    if (!raw) return false;
    std::string value = raw;
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

// Debug log: writes to both stdout AND a temp file so output survives Tauri's stdio routing.
// File: %TEMP%\lt_pitch_debug.log  (or /tmp/lt_pitch_debug.log on non-Windows)
static FILE* debug_log_file() {
    static FILE* s_file = nullptr;
    static bool  s_tried = false;
    if (!s_tried) {
        s_tried = true;
        // Try several locations in order so at least one succeeds.
        const char* candidates[] = {
            "D:\\Repos\\LibreTracks\\lt_pitch_debug.log",
            "C:\\lt_pitch_debug.log",
            nullptr
        };
        for (int i = 0; candidates[i] != nullptr; ++i) {
            s_file = std::fopen(candidates[i], "w");
            if (s_file) break;
        }
    }
    return s_file;
}

static void debug_log(const char* fmt, ...) {
    va_list args1, args2;
    va_start(args1, fmt);
    va_copy(args2, args1);
    std::vfprintf(stdout, fmt, args1);
    std::fflush(stdout);
    va_end(args1);
    FILE* f = debug_log_file();
    if (f) {
        std::vfprintf(f, fmt, args2);
        std::fflush(f);
    }
    va_end(args2);
}

// Fires the moment the DLL is loaded by Windows, before any exported function is called.
struct DllLoadProbe {
    DllLoadProbe() {
        FILE* f = debug_log_file();
        if (f) {
            std::fprintf(f, "[LT_PITCH_DEBUG] DLL_LOADED lt_audio_engine_v2\n");
            std::fflush(f);
        }
        std::fprintf(stdout, "[LT_PITCH_DEBUG] DLL_LOADED lt_audio_engine_v2\n");
        std::fflush(stdout);
    }
};
static DllLoadProbe s_dll_load_probe;

template <typename Update>
bool update_track_session(std::shared_ptr<const Session>& session,
                          Mixer* mixer,
                          const Id& track_id,
                          Update update) {
    if (!session) return false;
    auto next_session = std::make_shared<Session>(*session);
    bool changed = false;
    for (auto& song : next_session->songs) {
        for (auto& track : song.tracks) {
            if (track.id == track_id) {
                update(track);
                changed = true;
            }
        }
    }
    if (!changed) return false;
    session = next_session;
    if (mixer) mixer->set_session(next_session);
    return true;
}

} // namespace

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------
struct EngineImpl::EventQueue {
    std::mutex            mtx;
    std::queue<std::string> events;   // JSON strings

    void push(const std::string& ev_json) {
        std::lock_guard lock(mtx);
        events.push(ev_json);
    }

    std::string pop() {
        std::lock_guard lock(mtx);
        if (events.empty()) return "";
        auto front = std::move(events.front());
        events.pop();
        return front;
    }
};

// ---------------------------------------------------------------------------
// Silent audio callback (Phases 1-5: device open but no audio output)
// ---------------------------------------------------------------------------
class EngineImpl::SilentCallback : public AudioRenderCallback {
public:
    void render(float** output_channels,
                int     num_channels,
                int     num_frames,
                double  /*sample_rate*/) noexcept override {
        for (int ch = 0; ch < num_channels; ++ch)
            std::fill(output_channels[ch], output_channels[ch] + num_frames, 0.f);
    }
};

// ---------------------------------------------------------------------------
// EngineImpl
// ---------------------------------------------------------------------------
EngineImpl::EngineImpl()
    : device_manager_(std::make_unique<AudioDeviceManager>())
    , event_queue_(std::make_unique<EventQueue>())
    , silent_callback_(std::make_unique<SilentCallback>())
{}

EngineImpl::~EngineImpl() {
    if (state_ == State::Initialized)
        shutdown();
}

Result<void> EngineImpl::initialize() {
    if (state_ == State::Initialized)
        return Result<void>::err("Engine already initialized");

    clock_          = std::make_unique<TransportClock>(48000);
    scheduler_      = std::make_unique<JumpScheduler>();
    source_manager_ = std::make_unique<SourceManager>();
    source_manager_->set_source_ready_callback([this](const Id& source_id) {
        source_ready_pitch_prepare_count_.fetch_add(1, std::memory_order_relaxed);
        if (prepare_pitch_processors_for_source(source_id) > 0)
            pitch_prepare_on_source_ready_count_.fetch_add(1, std::memory_order_relaxed);
    });
    pitch_cache_    = std::make_unique<PitchCache>();
    pitch_cache_->set_realtime_fallback_enabled(false);
    realtime_pitch_engine_ = std::make_unique<RealtimePitchEngine>();
    worker_pool_    = std::make_unique<DecodeWorkerPool>();
    mixer_          = std::make_unique<Mixer>(
        std::shared_ptr<const Session>{},
        source_manager_.get(),
        clock_.get(),
        scheduler_.get(),
        pitch_cache_.get(),
        realtime_pitch_engine_.get());
    mixer_->set_metronome_config(metronome_config_);

    // Open the default audio device with the silent callback.
    auto open_result = device_manager_->open_device(current_device_request_, mixer_.get());
    if (open_result.is_err()) {
        // Non-fatal: engine works without a device (useful in tests).
        push_event(EvDeviceError{ "Could not open default device: " + open_result.error() });
    } else {
        // Update clock sample rate to the negotiated device rate.
        int sr = device_manager_->actual_sample_rate();
        if (sr > 0)
            clock_->set_sample_rate(sr);

        push_event(EvDeviceChanged{
            device_manager_->actual_device_name(),
            device_manager_->actual_device_name(),
            device_manager_->actual_sample_rate(),
            device_manager_->actual_buffer_size(),
        });
    }

    state_ = State::Initialized;

    // Always log on startup so we can confirm the DLL version and backend regardless
    // of env var inheritance through Tauri's process chain.
    {
        PitchStreamDiagnostics startup_diag = realtime_pitch_engine_
            ? realtime_pitch_engine_->diagnostics()
            : PitchStreamDiagnostics{};
        const char* debug_flag = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        debug_log("[LT_PITCH_DEBUG] engine_initialized pitch_backend=%s runtime_enabled=%s "
            "debug_flag=%s log=D:\\Repos\\LibreTracks\\lt_pitch_debug.log\n",
            startup_diag.pitch_backend.empty() ? "(unknown)" : startup_diag.pitch_backend.c_str(),
            startup_diag.pitch_runtime_enabled ? "true" : "false",
            debug_flag ? debug_flag : "(not set)");
    }

    return Result<void>::ok();
}

Result<void> EngineImpl::shutdown() {
    if (state_ != State::Initialized)
        return Result<void>::ok();  // idempotent

    device_manager_->close_device();
    if (mixer_) mixer_->clear_session();
    if (prep_queue_) { prep_queue_->cancel_all(); prep_queue_.reset(); }
    if (worker_pool_) { worker_pool_->shutdown(); }
    source_manager_->clear();
    if (pitch_cache_) pitch_cache_->clear();
    mixer_.reset();
    clock_.reset();
    scheduler_.reset();
    session_.reset();
    pitch_cache_.reset();
    realtime_pitch_engine_.reset();
    state_ = State::ShutDown;
    return Result<void>::ok();
}

std::string EngineImpl::version() const {
    return engine_version_string();
}

std::string EngineImpl::diagnostics() const {
    return get_snapshot();
}

Result<void> EngineImpl::send_command(const std::string& cmd_json) {
    try {
        auto cmd = command_from_json(cmd_json);
        return dispatch_command(cmd);
    } catch (const std::exception& ex) {
        return Result<void>::err(std::string("command parse error: ") + ex.what());
    }
}

void EngineImpl::service_control_thread_tasks() {
    service_pitch_repair_requests();
}


std::string EngineImpl::poll_event() {
    return event_queue_->pop();
}

std::string EngineImpl::get_snapshot() const {
    maybe_enqueue_rolling_pitch_prepare();

    EngineSnapshot snap;

    // Backend identity is derived at runtime from the actual stream diagnostics,
    // so it reflects what is truly compiled in — not just what the CMake flags say.
    {
        auto realtime_diag = realtime_pitch_engine_
            ? realtime_pitch_engine_->diagnostics()
            : PitchStreamDiagnostics{};
        if (!realtime_diag.pitch_backend.empty()) {
            snap.pitch.pitch_backend = realtime_diag.pitch_backend;
            snap.pitch.pitch_runtime_enabled = realtime_diag.pitch_runtime_enabled;
            snap.pitch.pitch_engine_available = realtime_diag.pitch_runtime_enabled;
            if (!realtime_diag.pitch_muted_or_bypassed_reason.empty())
                snap.pitch.pitch_muted_or_bypassed_reason = realtime_diag.pitch_muted_or_bypassed_reason;
        } else {
#if LT_ENGINE_USE_RUBBERBAND && LT_ENGINE_PITCH_BACKEND_RUBBERBAND
            snap.pitch.pitch_engine_available = true;
            snap.pitch.pitch_backend = "rubberband";
            snap.pitch.pitch_runtime_enabled = true;
#elif LT_ENGINE_ALLOW_PITCH_STUB || LT_ENGINE_PITCH_BACKEND_STUB
            snap.pitch.pitch_engine_available = false;
            snap.pitch.pitch_backend = "stub";
            snap.pitch.pitch_runtime_enabled = false;
            snap.pitch.pitch_muted_or_bypassed_reason = "pitch stub enabled explicitly";
#else
            snap.pitch.pitch_engine_available = false;
            snap.pitch.pitch_backend = "disabled";
            snap.pitch.pitch_runtime_enabled = false;
#endif
        }
    }

    if (clock_) {
        auto pos = clock_->position();
        snap.current_frame   = pos.frame;
        snap.current_seconds = pos.seconds;
        snap.playback_state  = [&] {
            switch (pos.state) {
                case TransportState::Playing: return PlaybackState::Playing;
                case TransportState::Paused:  return PlaybackState::Paused;
                default:                      return PlaybackState::Stopped;
            }
        }();
        snap.current_song_id   = pos.song_id;
        snap.current_region_id = pos.region_id;
        snap.current_marker_id = pos.marker_id;
    }

    if (scheduler_) {
        for (const auto& j : scheduler_->jump_list()) {
            if (j.status != JumpStatus::Pending && j.status != JumpStatus::Armed)
                continue;
            PendingJumpInfo info;
            info.jump_id       = j.jump_id;
            info.created_frame = j.created_frame;
            switch (j.status) {
                case JumpStatus::Pending:   info.status = "pending";   break;
                case JumpStatus::Armed:     info.status = "armed";     break;
                case JumpStatus::Cancelled: info.status = "cancelled"; break;
                case JumpStatus::Executed:  info.status = "executed";  break;
                case JumpStatus::Failed:    info.status = "failed";    break;
            }
            snap.pending_jumps.push_back(info);
        }
    }

    snap.device = device_manager_->device_info();

    if (mixer_) {
        auto m = mixer_->meters();
        snap.meters.left_peak  = m.left_peak;
        snap.meters.right_peak = m.right_peak;
        snap.meters.left_rms   = m.left_rms;
        snap.meters.right_rms  = m.right_rms;
        snap.track_meters      = mixer_->track_meters();
        snap.cpu.callback_duration_ms = mixer_->callback_duration_ms();
        snap.cpu.callback_duration_max_ms = mixer_->callback_duration_max_ms();
        snap.cpu.callback_count       = mixer_->callback_count();
        snap.cpu.callback_over_budget_count = mixer_->callback_over_budget_count();
        snap.cpu.mixer_rendered_track_count = mixer_->rendered_track_count();
        snap.cpu.mixer_skipped_track_count = mixer_->skipped_track_count();
        auto tr = TrackRenderer::diagnostics();
        snap.cpu.track_renderer_prepare_count = tr.prepare_count;
        snap.cpu.track_renderer_scratch_resize_count = tr.scratch_resize_count;
        snap.cpu.track_renderer_scratch_resize_in_audio_thread_count =
            tr.scratch_resize_in_audio_thread_count;
        snap.cpu.track_renderer_block_too_large_count = tr.block_too_large_count;
        snap.cpu.track_renderer_scratch_capacity_frames = tr.scratch_capacity_frames;
        auto metro = mixer_->metronome_diagnostics();
        snap.metronome.enabled = metro.enabled;
        snap.metronome.volume = metro.volume;
        snap.metronome.output = metro.output;
        snap.metronome.last_beat_frame = metro.last_beat_frame;
        snap.metronome.next_beat_frame = metro.next_beat_frame;
        snap.metronome.current_bar = metro.current_bar;
        snap.metronome.current_beat = metro.current_beat;
        snap.metronome.route_resolved = metro.route_resolved;
        snap.metronome.rendered_clicks_count = metro.rendered_clicks_count;
        snap.metronome.muted_reason = metro.muted_reason;
        snap.metronome.current_gain = metro.current_gain;
        snap.metronome.target_gain = metro.target_gain;
        snap.metronome.toggle_count = metro.toggle_count;
    }

    if (prep_queue_) {
        snap.source_states = prep_queue_->preparation_states();
    } else if (source_manager_) {
        for (const auto& d : source_manager_->diagnostics()) {
            SourcePreparationInfo info;
            info.source_id = d.source_id;
            info.status    = d.status;
            info.error_message = d.error_message;
            snap.source_states.push_back(std::move(info));
        }
    }
    if (pitch_cache_) {
        auto pitch = pitch_cache_->diagnostics();
        auto realtime_pitch = realtime_pitch_engine_
            ? realtime_pitch_engine_->diagnostics()
            : PitchStreamDiagnostics{};
        snap.pitch.pitch_processors_prepared = pitch.processors_prepared;
        snap.pitch.pitch_processors_missing = pitch.processors_missing;
        snap.pitch.pitch_missing_processor_count = pitch.missing_processor_count;
        snap.pitch.pitch_prepare_on_source_ready_count =
            pitch_prepare_on_source_ready_count_.load(std::memory_order_relaxed);
        snap.pitch.source_ready_pitch_prepare_count =
            source_ready_pitch_prepare_count_.load(std::memory_order_relaxed);
        snap.pitch.pitch_latency_frames = pitch.max_latency_frames;
        snap.pitch.active_pitch_keys = pitch.active_keys;
        snap.pitch.pitch_jobs_queued = 0;
        snap.pitch.pitch_jobs_pending = 0;
        snap.pitch.pitch_jobs_running = pitch.jobs_running;
        snap.pitch.pitch_jobs_completed = pitch.jobs_completed;
        snap.pitch.pitch_jobs_failed = pitch.jobs_failed;
        snap.pitch.seek_immediate_jobs_queued = pitch.seek_immediate_jobs_queued;
        snap.pitch.seek_immediate_jobs_completed = pitch.seek_immediate_jobs_completed;
        snap.pitch.pitch_proxy_blocks_ready = 0;
        snap.pitch.pitch_proxy_blocks_missing = 0;
        snap.pitch.pitch_proxy_blocks_pending = 0;
        snap.pitch.pitch_prepare_queue_length = 0;
        snap.pitch.pitch_prepare_pending = false;
        snap.pitch.pitch_prepare_active = false;
        snap.pitch.pitch_prepare_progress = snap.pitch.pitch_prepare_active ? 0.0 : 1.0;
        snap.pitch.pitch_proxy_prepare_sync_count = pitch.prepare_sync_count;
        snap.pitch.pitch_proxy_prepare_blocking_ms = pitch.prepare_blocking_ms;
        snap.pitch.last_pitch_prepare_reason = pitch.last_prepare_reason;
        snap.pitch.active_pitch_render_path = realtime_pitch.active_render_path;
        snap.pitch.last_pitch_proxy_error = pitch.last_pitch_proxy_error;
        snap.pitch.last_missing_proxy_key = pitch.last_missing_proxy_key;
        snap.pitch.last_missing_proxy_block_index = pitch.last_missing_proxy_block_index;
        snap.pitch.active_pitch_mode = "realtime_stream";
        snap.pitch.realtime_seek_safe_resets = realtime_pitch.reset_count;
        snap.pitch.realtime_pitch_underflow_count = realtime_pitch.underflow_count;
        snap.pitch.realtime_pitch_discontinuities = realtime_pitch.reset_count;
        snap.pitch.realtime_seek_safe_preroll_frames = realtime_pitch.preroll_frames;
        snap.pitch.realtime_pitch_start_pad_frames = 0;
        snap.pitch.realtime_pitch_start_delay_frames = realtime_pitch.start_delay_frames;
        snap.pitch.realtime_pitch_preroll_frames = realtime_pitch.preroll_frames;
        snap.pitch.realtime_pitch_discarded_frames = realtime_pitch.discarded_frames;
        snap.pitch.realtime_seek_safe_render_count = realtime_pitch.render_count;
        snap.pitch.prepared_proxy_render_count = 0;
        snap.pitch.emergency_silence_render_count = realtime_pitch.emergency_silence_count;
        snap.pitch.active_stream_set_generation = realtime_pitch.active_stream_set_generation;
        snap.pitch.active_pitch_stream_count = realtime_pitch.active_pitch_stream_count;
        snap.pitch.pitch_timeline_mismatch_count = realtime_pitch.pitch_timeline_mismatch_count;
        snap.pitch.pitch_stream_not_aligned_count = realtime_pitch.pitch_stream_not_aligned_count;
        snap.pitch.pitch_audio_thread_reset_count = realtime_pitch.pitch_audio_thread_reset_count;
        snap.pitch.pitch_audio_thread_prime_count = realtime_pitch.pitch_audio_thread_prime_count;
        snap.pitch.stream_generation = realtime_pitch.stream_generation;
        snap.pitch.stream_reset_thread_id = realtime_pitch.stream_reset_thread_id;
        snap.pitch.stream_render_thread_id = realtime_pitch.stream_render_thread_id;
        snap.pitch.unsafe_cross_thread_reset_count = realtime_pitch.unsafe_cross_thread_reset_count;
        snap.pitch.concurrent_stream_mutation_detected = realtime_pitch.concurrent_stream_mutation_detected;
        snap.pitch.active_stream_swap_count = realtime_pitch.active_stream_swap_count;
        snap.pitch.long_seek_count = realtime_pitch.long_seek_count;
        snap.pitch.last_transport_discontinuity_target_frame =
            realtime_pitch.last_transport_discontinuity_target_frame;
        snap.pitch.last_transport_discontinuity_reason =
            realtime_pitch.last_transport_discontinuity_reason;
        snap.pitch.stale_proxy_jobs_skipped = pitch.stale_proxy_jobs_skipped;
        snap.pitch.current_pitch_epoch = pitch.current_pitch_epoch;
        snap.pitch.disk_cache_audio_thread_load_attempts =
            pitch.disk_cache_audio_thread_load_attempts;
        snap.pitch.offline_pitch_segments_rendered = pitch.offline_segments_rendered;
        snap.pitch.offline_pitch_segment_failures = pitch.offline_segment_failures;
        snap.pitch.offline_pitch_latency_frames = pitch.offline_latency_frames;
        snap.pitch.offline_pitch_preroll_frames = pitch.offline_preroll_frames;
        snap.pitch.offline_pitch_postroll_frames = pitch.offline_postroll_frames;
        snap.pitch.offline_pitch_render_ms = pitch.offline_render_ms;
        snap.pitch.last_offline_pitch_error = pitch.last_offline_error;
        snap.pitch.pitch_disk_cache_enabled = pitch.disk_cache_enabled;
        snap.pitch.pitch_disk_cache_dir = pitch.disk_cache_dir;
        snap.pitch.pitch_disk_cache_hits = pitch.disk_cache_hits;
        snap.pitch.pitch_disk_cache_misses = pitch.disk_cache_misses;
        snap.pitch.pitch_disk_cache_writes = pitch.disk_cache_writes;
        snap.pitch.pitch_disk_cache_invalidations = pitch.disk_cache_invalidations;
        snap.pitch.pitch_disk_cache_size_bytes = pitch.disk_cache_size_bytes;
        snap.pitch.last_pitch_disk_cache_error = pitch.last_disk_cache_error;
        if (pitch.offline_segment_failures > 0 && !pitch.last_offline_error.empty()) {
            snap.pitch.pitch_prepare_status = "failed";
            snap.pitch.pitch_prepare_message = pitch.last_offline_error;
        } else if (snap.pitch.pitch_prepare_active) {
            snap.pitch.pitch_prepare_status = "preparing";
            snap.pitch.pitch_prepare_message = "Preparing pitch-shifted audio";
        } else {
            snap.pitch.pitch_prepare_status = "idle";
            snap.pitch.pitch_prepare_message.clear();
        }
        if (pitch.missing_processor_count > 0)
            snap.pitch.pitch_muted_or_bypassed_reason = "Pitch processor missing; bypassed instead of muting.";
        // Phase 1 new fields
        auto tr_diag = TrackRenderer::diagnostics();
        snap.pitch.pitch_missing_stream_silence_count = tr_diag.pitch_missing_stream_silence_count;
        snap.pitch.pitch_requested_but_backend_unavailable_count = realtime_pitch.backend_unavailable_count;
        snap.pitch.pitch_stub_passthrough_count = realtime_pitch.stub_passthrough_count;
        snap.pitch.pitch_stub_passthrough_blocked_count = realtime_pitch.stub_passthrough_blocked_count;
        // Backend-level reason from streams (may override the CMake-level reason above).
        if (!realtime_pitch.pitch_muted_or_bypassed_reason.empty())
            snap.pitch.pitch_muted_or_bypassed_reason = realtime_pitch.pitch_muted_or_bypassed_reason;
        snap.pitch.pitch_backend_detail = snap.pitch.pitch_backend;
        if (!snap.pitch.pitch_runtime_enabled && snap.pitch.pitch_stub_passthrough_blocked_count > 0)
            snap.pitch.last_pitch_reason = "stub passthrough blocked — RubberBand unavailable at compile time";
        else if (snap.pitch.pitch_stub_passthrough_count > 0)
            snap.pitch.last_pitch_reason = "stub passthrough active — test/stub build, not real pitch";
    }

    // Phase 1 debug logging — enabled by LIBRETRACKS_AUDIO_DEBUG=1
    if (env_flag_enabled("LIBRETRACKS_AUDIO_DEBUG")) {
        static std::chrono::steady_clock::time_point s_last_log;
        const auto now = std::chrono::steady_clock::now();
        if (now - s_last_log >= std::chrono::seconds(1)) {
            s_last_log = now;
            auto _rb_diag = realtime_pitch_engine_
                ? realtime_pitch_engine_->diagnostics()
                : PitchStreamDiagnostics{};
            debug_log("[LT_PITCH_DEBUG] pitch_backend=%s runtime_enabled=%s "
                "active_streams=%llu last_st=%d "
                "missing_stream=%llu mismatch=%llu not_aligned=%llu "
                "missing_silence=%llu backend_unavailable=%llu "
                "stub_pass=%llu stub_blocked=%llu "
                "render=%llu underflow=%llu repair_req=%llu repair_done=%llu "
                "muted_reason=%s\n",
                snap.pitch.pitch_backend.c_str(),
                snap.pitch.pitch_runtime_enabled ? "true" : "false",
                static_cast<unsigned long long>(snap.pitch.active_pitch_stream_count),
                static_cast<int>(snap.pitch.last_effective_semitones),
                static_cast<unsigned long long>(_rb_diag.missing_stream_count),
                static_cast<unsigned long long>(snap.pitch.pitch_timeline_mismatch_count),
                static_cast<unsigned long long>(snap.pitch.pitch_stream_not_aligned_count),
                static_cast<unsigned long long>(snap.pitch.pitch_missing_stream_silence_count),
                static_cast<unsigned long long>(snap.pitch.pitch_requested_but_backend_unavailable_count),
                static_cast<unsigned long long>(snap.pitch.pitch_stub_passthrough_count),
                static_cast<unsigned long long>(snap.pitch.pitch_stub_passthrough_blocked_count),
                static_cast<unsigned long long>(snap.pitch.realtime_seek_safe_render_count),
                static_cast<unsigned long long>(snap.pitch.realtime_pitch_underflow_count),
                static_cast<unsigned long long>(_rb_diag.pitch_repair_requested_count),
                static_cast<unsigned long long>(_rb_diag.pitch_repair_completed_count),
                snap.pitch.pitch_muted_or_bypassed_reason.empty()
                    ? "(none)"
                    : snap.pitch.pitch_muted_or_bypassed_reason.c_str());
        }
    }

    return snapshot_to_json(snap);
}

std::size_t EngineImpl::prepare_pitch_processors_for_source(const Id& source_id) {
    if (!session_ || !source_manager_ || !pitch_cache_ || !clock_)
        return 0;
    if (!source_manager_->get(source_id))
        return 0;
    if (realtime_pitch_engine_) {
        // Prime at the current playhead so the new source's stream is immediately aligned.
        // Using prepare_for_transport_discontinuity instead of prepare_for_session(-1) avoids
        // publishing unprimed streams that cause mismatch silence on the audio thread.
        const Frame playhead = clock_->position().frame;
        realtime_pitch_engine_->prepare_for_transport_discontinuity(
            playhead, "source_ready", *session_, *source_manager_);
    }
    return prepare_pitch_processors_for_session(*session_);
}

std::size_t EngineImpl::enqueue_pitch_window(const Session& session,
                                             Frame timeline_start,
                                             Frame frame_count,
                                             int priority,
                                             const std::string& reason) const {
    if (!source_manager_ || !pitch_cache_ || !clock_)
        return 0;
    if (frame_count <= 0)
        return 0;

    const int sample_rate = clock_->sample_rate();
    const Frame timeline_end = timeline_start + frame_count;
    std::size_t prepared = 0;
    for (const auto& song : session.songs) {
        if (timeline_end <= song.start_frame || timeline_start >= song.end_frame)
            continue;
        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                const auto* source = source_manager_->get(clip.source_id);
                if (!source || !source->is_loaded())
                    continue;
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                if (timeline_end <= clip.timeline_start_frame || timeline_start >= clip_end)
                    continue;
                const Frame overlap_start = std::max(timeline_start, clip.timeline_start_frame);
                const Frame overlap_end = std::min(timeline_end, clip_end);
                Semitones semitones = resolve_effective_semitones(
                    track, clip, song, overlap_start);
                if (semitones == 0)
                    continue;
                (void)sample_rate;
                (void)priority;
                (void)reason;
                ++prepared;
            }
        }
    }
    return prepared;
}

std::size_t EngineImpl::prepare_pitch_processors_for_session(const Session& session) {
    if (!clock_)
        return 0;
    const int sample_rate = clock_->sample_rate();
    const Frame playhead = clock_->position().frame;
    const Frame immediate_frames = std::max<Frame>(PitchCache::kProxyBlockFrames, sample_rate);
    const Frame rolling_frames = static_cast<Frame>(sample_rate) * 10;
    std::size_t prepared = 0;
    prepared += enqueue_pitch_window(session, playhead, immediate_frames, 0, "pitch_immediate");
    prepared += enqueue_pitch_window(session, playhead + immediate_frames,
                                     rolling_frames - immediate_frames, 1, "pitch_rolling");
    return prepared;
}

void EngineImpl::prepare_pitch_processors_for_session() {
    if (!session_ || !source_manager_ || !pitch_cache_ || !clock_)
        return;
    if (realtime_pitch_engine_) {
        // Always prime at the current playhead so the published stream set is aligned.
        const Frame playhead = clock_->position().frame;
        realtime_pitch_engine_->prepare_for_session(*session_, *source_manager_, clock_->sample_rate());
        realtime_pitch_engine_->prepare_for_play(playhead, *session_, *source_manager_);
    }
    prepare_pitch_processors_for_session(*session_);
}

void EngineImpl::service_pitch_repair_requests() {
    if (!realtime_pitch_engine_ || !session_ || !source_manager_ || !clock_)
        return;
    Frame target_frame = -1;
    if (realtime_pitch_engine_->take_repair_request(target_frame)) {
        // Repair: rebuild and prime streams at the requested frame outside the audio callback.
        realtime_pitch_engine_->prepare_for_pitch_repair(target_frame, *session_, *source_manager_);
    }
}

void EngineImpl::maybe_enqueue_rolling_pitch_prepare() const {
    if (!session_ || !source_manager_ || !pitch_cache_ || !clock_)
        return;
    if (clock_->position().state != TransportState::Playing)
        return;

    const int sample_rate = clock_->sample_rate();
    const Frame playhead = clock_->position().frame;
    const Frame retrigger_distance = std::max<Frame>(PitchCache::kProxyBlockFrames, sample_rate / 2);
    const auto now = std::chrono::steady_clock::now();
    {
        std::lock_guard lock(pitch_prepare_mutex_);
        const Frame last = last_pitch_prepare_playhead_.load(std::memory_order_relaxed);
        const bool moved_enough = last < 0 || std::llabs(playhead - last) >= retrigger_distance;
        const bool time_elapsed = last_pitch_prepare_time_ == std::chrono::steady_clock::time_point{}
            || now - last_pitch_prepare_time_ >= std::chrono::milliseconds(300);
        if (!moved_enough && !time_elapsed)
            return;
        last_pitch_prepare_playhead_.store(playhead, std::memory_order_relaxed);
        last_pitch_prepare_time_ = now;
    }
    const Frame immediate_frames = std::max<Frame>(PitchCache::kProxyBlockFrames, sample_rate);
    const Frame rolling_frames = static_cast<Frame>(sample_rate) * 10;
    enqueue_pitch_window(*session_, playhead, immediate_frames, 0, "pitch_immediate");
    enqueue_pitch_window(*session_, playhead + immediate_frames,
                         rolling_frames - immediate_frames, 1, "pitch_rolling");
}

std::string EngineImpl::list_devices() const {
    json arr = json::array();
    for (const auto& d : device_manager_->list_devices()) {
        arr.push_back({
            {"device_id",   d.id},
            {"device_name", d.name},
            {"backend",     d.backend},
            {"output_channel_count", d.output_channel_count},
            {"output_channel_names", d.output_channel_names},
            {"sample_rate", 0},
            {"buffer_size", 0},
            {"last_error",  ""},
        });
    }
    return arr.dump();
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
Result<void> EngineImpl::dispatch_command(const EngineCommand& cmd) {
    if (state_ != State::Initialized)
        return Result<void>::err("Engine not initialized");

    return std::visit([this](auto&& c) -> Result<void> {
        using T = std::decay_t<decltype(c)>;

        if constexpr (std::is_same_v<T, CmdLoadSession>) {
            // Parse and validate session.
            int sr = clock_ ? clock_->sample_rate() : 48000;
            auto result = session_from_project_json(c.project_json, sr);
            if (result.is_err())
                return Result<void>::err(result.error());

            if (prep_queue_) {
                prep_queue_->cancel_all();
                prep_queue_.reset();
            }

            auto next_session = std::make_shared<Session>(result.take());
            // Log parsed session for pitch diagnostics.
            {
                int region_count = 0;
                int nonzero_regions = 0;
                for (const auto& song : next_session->songs) {
                    region_count += static_cast<int>(song.regions.size());
                    for (const auto& region : song.regions)
                        if (region.transpose_semitones != 0) ++nonzero_regions;
                }
                debug_log("[LT_PITCH_DEBUG] LoadSession songs=%d regions=%d nonzero_transpose_regions=%d\n",
                    static_cast<int>(next_session->songs.size()), region_count, nonzero_regions);
            }
            session_ = next_session;
            const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (pitch_cache_) pitch_cache_->set_current_generation(generation);

            // Register all sources, then hand off to the async worker pool.
            source_manager_->clear();

            prep_queue_ = std::make_unique<SourcePreparationQueue>(
                source_manager_.get(),
                worker_pool_.get(),
                [this](EngineEvent ev){ push_event(std::move(ev)); },
                sr
            );
            prep_queue_->enqueue_session(session_->sources,
                                          clock_->position().frame);

            if (mixer_) {
                mixer_->set_session(next_session);
                mixer_->set_pitch_cache(pitch_cache_.get());
                mixer_->set_pitch_engine(realtime_pitch_engine_.get());
            }
            if (realtime_pitch_engine_)
                realtime_pitch_engine_->prepare_for_session(*next_session, *source_manager_, sr);

            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdPlay>) {
            prepare_pitch_processors_for_session();
            clock_->play();
            push_event(EvPlaybackStarted{ clock_->position().frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdPause>) {
            clock_->pause();
            push_event(EvPlaybackPaused{ clock_->position().frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdStop>) {
            Frame f = clock_->position().frame;
            clock_->stop();
            push_event(EvPlaybackStopped{ f });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekAbsolute>) {
            Frame from = clock_->position().frame;
            clock_->seek(c.frame);
            const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (pitch_cache_) pitch_cache_->set_current_generation(generation);
            if (session_) {
                const Frame immediate = std::max<Frame>(PitchCache::kProxyBlockFrames, clock_->sample_rate());
                const Frame forward = static_cast<Frame>(clock_->sample_rate()) * 10;
                enqueue_pitch_window(*session_, clock_->position().frame, immediate, 0, "seek_immediate");
                enqueue_pitch_window(*session_, clock_->position().frame + immediate,
                                     forward - immediate, 1, "seek_forward_prebuffer");
            }
            if (mixer_) mixer_->trigger_crossfade();
            if (realtime_pitch_engine_ && session_)
                realtime_pitch_engine_->prepare_for_transport_discontinuity(
                    clock_->position().frame, "seek_absolute", *session_, *source_manager_);
            push_event(EvSeekExecuted{ from, c.frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekRelative>) {
            Frame from = clock_->position().frame;
            Frame to   = from + c.delta_frames;
            clock_->seek(to);
            const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (pitch_cache_) pitch_cache_->set_current_generation(generation);
            if (session_) {
                const Frame immediate = std::max<Frame>(PitchCache::kProxyBlockFrames, clock_->sample_rate());
                const Frame forward = static_cast<Frame>(clock_->sample_rate()) * 10;
                enqueue_pitch_window(*session_, clock_->position().frame, immediate, 0, "seek_immediate");
                enqueue_pitch_window(*session_, clock_->position().frame + immediate,
                                     forward - immediate, 1, "seek_forward_prebuffer");
            }
            if (mixer_) mixer_->trigger_crossfade();
            if (realtime_pitch_engine_ && session_)
                realtime_pitch_engine_->prepare_for_transport_discontinuity(
                    clock_->position().frame, "seek_relative", *session_, *source_manager_);
            push_event(EvSeekExecuted{ from, to });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdCancelScheduledJump>) {
            auto r = scheduler_->cancel(c.jump_id);
            if (r.is_ok()) push_event(EvJumpCancelled{ c.jump_id });
            return r;
        }
        else if constexpr (std::is_same_v<T, CmdCancelAllScheduledJumps>) {
            scheduler_->cancel_all();
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackGain>) {
            if (mixer_) mixer_->set_track_gain(c.track_id, c.gain);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackPan>) {
            if (mixer_) mixer_->set_track_pan(c.track_id, c.pan);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackMute>) {
            if (mixer_) mixer_->set_track_mute(c.track_id, c.mute);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackSolo>) {
            if (mixer_) mixer_->set_track_solo(c.track_id, c.solo);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackAudioRoute>) {
            update_track_session(session_, mixer_.get(), c.track_id, [route = c.audio_to](Track& track) {
                track.audio_to = route.empty() ? std::string("master") : route;
            });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeEnabled>) {
            metronome_config_.enabled = c.enabled;
            if (mixer_) mixer_->set_metronome_enabled(c.enabled);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeVolume>) {
            metronome_config_.volume = std::clamp(c.volume, 0.0f, 1.0f);
            if (mixer_) mixer_->set_metronome_volume(metronome_config_.volume);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeOutputRoute>) {
            metronome_config_.output_route = c.route.empty() ? std::string("master") : c.route;
            if (mixer_) mixer_->set_metronome_config(metronome_config_);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeConfig>) {
            metronome_config_.enabled = c.enabled;
            metronome_config_.volume = std::clamp(c.volume, 0.0f, 1.0f);
            metronome_config_.output_route = c.route.empty() ? std::string("master") : c.route;
            if (mixer_) mixer_->set_metronome_config(metronome_config_);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToMarker>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::Marker, c.marker_id, std::nullopt };
            Id jump_id = "jump-marker-" + c.marker_id;
            auto r = scheduler_->schedule_immediate(jump_id, target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ jump_id, c.marker_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToRegion>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::Region, c.region_id, std::nullopt };
            Id jump_id = "jump-region-" + c.region_id;
            auto r = scheduler_->schedule_immediate(jump_id, target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ jump_id, c.region_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToSong>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::Song, c.song_id, std::nullopt };
            Id jump_id = "jump-song-" + c.song_id;
            auto r = scheduler_->schedule_immediate(jump_id, target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ jump_id, c.song_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToNextSong>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::NextSong, std::nullopt, std::nullopt };
            auto r = scheduler_->schedule_immediate("jump-next-song", target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ "jump-next-song", "next-song" });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToPreviousSong>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::PreviousSong, std::nullopt, std::nullopt };
            auto r = scheduler_->schedule_immediate("jump-previous-song", target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ "jump-previous-song", "previous-song" });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdScheduleJump>) {
            if (!session_) return Result<void>::err("No session loaded");
            if (c.trigger == JumpTrigger::Immediate) {
                auto r = scheduler_->schedule_immediate(c.jump_id, c.target, *session_, *clock_);
                if (r.is_err()) return Result<void>::err(r.error());
            } else {
                ScheduledJump jump;
                jump.jump_id = c.jump_id;
                jump.target = c.target;
                jump.trigger = c.trigger;
                jump.created_frame = clock_->position().frame;
                auto r = scheduler_->schedule(jump);
                if (r.is_err()) return r;
            }
            push_event(EvJumpScheduled{ c.jump_id, c.jump_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdReplaceScheduledJump>) {
            return scheduler_->replace(c.jump_id, c.new_target, c.new_trigger);
        }
        else if constexpr (std::is_same_v<T, CmdSetTrackTransposeEnabled>) {
            if (!session_)
                return Result<void>::ok();
            auto next_session = std::make_shared<Session>(*session_);
            bool changed = false;
            for (auto& song : next_session->songs) {
                for (auto& track : song.tracks) {
                    if (track.id == c.track_id) {
                        track.transpose_behavior = c.enabled
                            ? TransposeBehavior::FollowsSongOrRegion
                            : TransposeBehavior::NeverTranspose;
                        changed = true;
                    }
                }
            }
            if (changed) {
                session_ = next_session;
                const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (pitch_cache_) pitch_cache_->set_current_generation(generation);
                if (mixer_) mixer_->set_session(next_session);
                // Prime at current playhead so published streams are aligned.
                if (realtime_pitch_engine_) {
                    const Frame playhead = clock_->position().frame;
                    realtime_pitch_engine_->prepare_for_transport_discontinuity(
                        playhead, "set_transpose_enabled", *next_session, *source_manager_);
                }
                if (mixer_) mixer_->trigger_crossfade();
                prepare_pitch_processors_for_session(*next_session);
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetSongTranspose>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                for (auto& song : next_session->songs)
                    if (song.id == c.song_id)
                        song.transpose_semitones = c.semitones;
                session_ = next_session;
                const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (pitch_cache_) pitch_cache_->set_current_generation(generation);
                if (mixer_) mixer_->set_session(next_session);
                // Prime at current playhead so published streams are aligned.
                if (realtime_pitch_engine_) {
                    const Frame playhead = clock_->position().frame;
                    realtime_pitch_engine_->prepare_for_transport_discontinuity(
                        playhead, "set_song_transpose", *next_session, *source_manager_);
                }
                if (mixer_) mixer_->trigger_crossfade();
                prepare_pitch_processors_for_session(*next_session);
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetRegionTranspose>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                for (auto& song : next_session->songs)
                    for (auto& region : song.regions)
                        if (region.id == c.region_id)
                            region.transpose_semitones = c.semitones;
                session_ = next_session;
                const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (pitch_cache_) pitch_cache_->set_current_generation(generation);
                if (mixer_) mixer_->set_session(next_session);
                // Prime at current playhead so published streams are aligned.
                if (realtime_pitch_engine_) {
                    const Frame playhead = clock_->position().frame;
                    realtime_pitch_engine_->prepare_for_transport_discontinuity(
                        playhead, "set_region_transpose", *next_session, *source_manager_);
                }
                if (mixer_) mixer_->trigger_crossfade();
                prepare_pitch_processors_for_session(*next_session);
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetOutputDevice>) {
            DeviceOpenRequest req;
            req.device_id = c.device_id;
            req.sample_rate = current_device_request_.sample_rate;
            req.buffer_size = current_device_request_.buffer_size;
            bool was_playing = clock_ && clock_->position().state == TransportState::Playing;
            auto* callback = mixer_ ? static_cast<AudioRenderCallback*>(mixer_.get())
                                    : static_cast<AudioRenderCallback*>(silent_callback_.get());
            auto r = device_manager_->open_device(req, callback);
            if (r.is_err()) {
                push_event(EvDeviceError{ r.error() });
                if (was_playing && clock_) clock_->play();
                return r;
            }
            current_device_request_ = req;
            if (clock_ && device_manager_->actual_sample_rate() > 0)
                clock_->set_sample_rate(device_manager_->actual_sample_rate());
            if (was_playing && clock_) clock_->play();
            push_event(EvDeviceChanged{
                device_manager_->actual_device_name(),
                device_manager_->actual_device_name(),
                device_manager_->actual_sample_rate(),
                device_manager_->actual_buffer_size(),
            });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetSampleRate>) {
            DeviceOpenRequest req;
            req.device_id = current_device_request_.device_id;
            req.sample_rate = c.sample_rate;
            req.buffer_size = current_device_request_.buffer_size;
            auto* callback = mixer_ ? static_cast<AudioRenderCallback*>(mixer_.get())
                                    : static_cast<AudioRenderCallback*>(silent_callback_.get());
            auto r = device_manager_->open_device(req, callback);
            if (r.is_ok()) {
                current_device_request_ = req;
                if (clock_ && device_manager_->actual_sample_rate() > 0)
                    clock_->set_sample_rate(device_manager_->actual_sample_rate());
                const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (pitch_cache_) pitch_cache_->set_current_generation(generation);
            }
            return r;
        }
        else if constexpr (std::is_same_v<T, CmdSetBufferSize>) {
            DeviceOpenRequest req;
            req.device_id = current_device_request_.device_id;
            req.sample_rate = current_device_request_.sample_rate;
            req.buffer_size = c.buffer_size;
            auto* callback = mixer_ ? static_cast<AudioRenderCallback*>(mixer_.get())
                                    : static_cast<AudioRenderCallback*>(silent_callback_.get());
            auto r = device_manager_->open_device(req, callback);
            if (r.is_ok()) {
                current_device_request_ = req;
                if (clock_ && device_manager_->actual_sample_rate() > 0)
                    clock_->set_sample_rate(device_manager_->actual_sample_rate());
                const auto generation = session_generation_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (pitch_cache_) pitch_cache_->set_current_generation(generation);
            }
            return r;
        }
        else {
            // Track gain/mute/solo, pitch, scheduler jumps — handled in later phases.
            return Result<void>::ok();
        }
    }, cmd);
}

void EngineImpl::push_event(EngineEvent ev) {
    event_queue_->push(event_to_json(ev));
}

} // namespace lt
