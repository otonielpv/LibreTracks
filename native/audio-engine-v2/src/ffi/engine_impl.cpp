#include <lt_engine/engine_impl.h>
#include <lt_engine/core/engine_core.h>
#include <lt_engine/core/events.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
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

// Single source of truth for LIBRETRACKS_AUDIO_DEBUG. Cached on first call so
// we don't getenv() per log line. Anything that wants to print engine internals
// to stdout in dev should check this first; in production builds (no env var)
// the entire diagnostic stream stays silent.
static bool audio_debug_enabled() {
    static const bool on = [] {
        const char* raw = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        if (!raw) return false;
        std::string value = raw;
        std::transform(value.begin(), value.end(), value.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return value == "1" || value == "true" || value == "yes" || value == "on";
    }();
    return on;
}

static bool jump_debug_enabled() {
    static const bool on = audio_debug_enabled() || env_flag_enabled("LIBRETRACKS_JUMP_DEBUG");
    return on;
}

static void debug_log(const char* fmt, ...) {
    if (!audio_debug_enabled() && !jump_debug_enabled()) return;
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

const char* jump_target_kind_name(JumpTarget::Kind kind) noexcept {
    switch (kind) {
        case JumpTarget::Kind::Marker: return "Marker";
        case JumpTarget::Kind::Region: return "Region";
        case JumpTarget::Kind::Song: return "Song";
        case JumpTarget::Kind::NextSong: return "NextSong";
        case JumpTarget::Kind::PreviousSong: return "PreviousSong";
        case JumpTarget::Kind::Frame: return "Frame";
    }
    return "Unknown";
}

const char* jump_trigger_name(JumpTrigger trigger) noexcept {
    switch (trigger) {
        case JumpTrigger::Immediate: return "Immediate";
        case JumpTrigger::AtRegionEnd: return "AtRegionEnd";
        case JumpTrigger::AtSongEnd: return "AtSongEnd";
        case JumpTrigger::AtFrame: return "AtFrame";
    }
    return "Unknown";
}

// Fires the moment the DLL is loaded by Windows, before any exported function is called.
struct DllLoadProbe {
    DllLoadProbe() {
        if (!audio_debug_enabled()) return;
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
    if (mixer) mixer->set_session(next_session, /*preserve_realtime_state=*/true);
    return true;
}

bool session_contains_source(const Session& session, const Id& source_id) {
    return std::any_of(session.sources.begin(), session.sources.end(),
        [&](const Source& source) { return source.id == source_id; });
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
        auto current_session = session_;
        if (!current_session || !session_contains_source(*current_session, source_id))
            return;

        // A source just finished decoding. Rebuild Bungee voices so any clips
        // that needed this source can now be played pitched.
        if (bungee_voices_ && bungee_voices_->is_available() && clock_) {
            bungee_voices_->rebuild_for_session(
                *current_session, *source_manager_, clock_->position().frame);
        }
        // Re-prearm: a source just finished decoding, so any prepared-set
        // that was skipped (unloaded_clips > 0) on its first build can now
        // succeed. Keep the current revision so multiple source-ready events
        // for a multitrack song fill the same cache instead of discarding
        // each other and rebuilding the whole prearm set repeatedly.
        if (prearmed_jumps_) {
            const auto rev = prearm_revision_.load(std::memory_order_relaxed);
            prearmed_jumps_->prepare_all_targets_async(
                current_session, source_manager_.get(), rev);
        }
    });
    bungee_voices_  = std::make_unique<BungeeVoiceManager>();
    prearmed_jumps_ = std::make_unique<PrearmedJumpManager>();
    worker_pool_    = std::make_unique<DecodeWorkerPool>();
    mixer_          = std::make_unique<Mixer>(
        std::shared_ptr<const Session>{},
        source_manager_.get(),
        clock_.get(),
        scheduler_.get());
    mixer_->set_metronome_config(metronome_config_);
    mixer_->set_bungee_voice_manager(bungee_voices_.get());

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

    // Prepare the Bungee voice manager with the negotiated (or default) audio
    // format. Safe to call again later if the device sample rate changes.
    if (bungee_voices_) {
        const int sr  = clock_->sample_rate() > 0 ? clock_->sample_rate() : 48000;
        const int bs  = device_manager_->actual_buffer_size() > 0
                        ? device_manager_->actual_buffer_size()
                        : 1024;  // generous default; tracks the OS buffer size when available
        bungee_voices_->prepare(sr, /*channels=*/2, bs);
        if (prearmed_jumps_) prearmed_jumps_->prepare(sr, /*channels=*/2, bs);
    }

    state_ = State::Initialized;

    // Always log on startup so we can confirm the DLL version and backend regardless
    // of env var inheritance through Tauri's process chain.
    {
        const char* debug_flag = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        const bool bungee_ok = bungee_voices_ && bungee_voices_->is_available();
        debug_log("[LT_PITCH_DEBUG] engine_initialized pitch_backend=bungee "
            "bungee_available=%s debug_flag=%s "
            "log=D:\\Repos\\LibreTracks\\lt_pitch_debug.log\n",
            bungee_ok ? "true" : "false",
            debug_flag ? debug_flag : "(not set)");
    }

    return Result<void>::ok();
}

Result<void> EngineImpl::shutdown() {
    if (state_ != State::Initialized)
        return Result<void>::ok();  // idempotent

    device_manager_->close_device();
    if (mixer_) {
        mixer_->clear_session();
        // Detach the Bungee manager pointer before destroying the manager so
        // the (now silent) mixer cannot dereference a dangling pointer.
        mixer_->set_bungee_voice_manager(nullptr);
    }
    if (prep_queue_) { prep_queue_->cancel_all(); prep_queue_.reset(); }
    if (worker_pool_) { worker_pool_->shutdown(); }
    source_manager_->clear();
    mixer_.reset();
    clock_.reset();
    scheduler_.reset();
    session_.reset();
    bungee_voices_.reset();
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
    // With RubberBand and PitchCache removed, the audio thread is exclusively
    // served by BungeeVoiceManager. Bungee voices are built synchronously on
    // the command thread (LoadSession / SeekAbsolute / etc.) and need no
    // periodic repair or rolling prepare from the control thread. The
    // mixer's pending scheduled-jump signal is now consumed implicitly by
    // the next jump command's prearm path.
    if (mixer_) {
        // Drain the scheduled-jump signal so the latch resets; we no longer
        // act on it because Bungee voices are already kept in sync by the
        // prearmed-jump / rebuild_for_seek paths.
        (void)mixer_->take_pending_scheduled_jump();
    }
}

std::string EngineImpl::poll_event() {
    return event_queue_->pop();
}

std::string EngineImpl::get_snapshot() const {
    EngineSnapshot snap;

    if (clock_) {
        auto pos = clock_->position();
        // Compensate the snapshot frame so the UI playhead / meters reflect
        // what the listener HEARS, not what was last queued.
        //
        // TransportClock::advance() bumps position_.frame by the WHOLE block
        // at the end of each callback, so pos.frame already points to the end
        // of the most-recently-queued block (~one buffer ahead of real time).
        // On top of that the device adds output_latency_samples of driver/OS
        // queuing before samples reach the speakers. Total lead the UI would
        // otherwise display = buffer_size + output_latency_samples.
        //
        // Subtract both during Playing so the displayed frame == the frame the
        // user is currently hearing.
        Frame compensated = pos.frame;
        const int sr = clock_->sample_rate();
        int dbg_latency = 0;
        int dbg_buffer  = 0;
        if (pos.state == TransportState::Playing && device_manager_ && sr > 0) {
            dbg_latency = device_manager_->actual_output_latency_samples();
            dbg_buffer  = device_manager_->actual_buffer_size();
            // JUCE's getOutputLatencyInSamples() already represents the
            // total samples-to-speaker for the queued audio (e.g. DirectSound
            // returns bufferSize * 1.5, which BAKES IN the buffer-ahead term).
            // Subtracting buffer_size again on top of it would overcompensate
            // by one block, making the UI lag the true audio by ~20-50 ms.
            // Trust the JUCE-reported latency only.
            const Frame lead = static_cast<Frame>(dbg_latency);
            compensated = pos.frame > lead ? pos.frame - lead : 0;
        }
        snap.current_frame   = compensated;
        snap.current_seconds = (sr > 0) ? static_cast<double>(compensated) / sr
                                        : pos.seconds;
        snap.transport_pending_start = clock_->pending_start();

        // [SNAP_FRAME] sync instrumentation — only when LIBRETRACKS_SYNC_DEBUG=1.
        // Rate-limited to ~5/sec to keep stdout sane.
        if (pos.state == TransportState::Playing && sr > 0) {
            static const bool sync_debug = []{
                const char* v = std::getenv("LIBRETRACKS_SYNC_DEBUG");
                return v && v[0] == '1';
            }();
            if (sync_debug) {
                static auto last_log = std::chrono::steady_clock::time_point{};
                auto now = std::chrono::steady_clock::now();
                if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_log).count() >= 200) {
                    last_log = now;
                    const auto wall_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now.time_since_epoch()).count();
                    const double raw_s = static_cast<double>(pos.frame) / sr;
                    const double comp_s = static_cast<double>(compensated) / sr;
                    const double lead_ms =
                        (static_cast<double>(dbg_latency) / sr) * 1000.0;
                    std::printf("[SNAP_FRAME] wall_ms=%lld raw_frame=%lld comp_frame=%lld "
                                "raw_s=%.4f comp_s=%.4f buf=%d lat=%d lead_ms=%.2f sr=%d\n",
                                static_cast<long long>(wall_ms),
                                static_cast<long long>(pos.frame),
                                static_cast<long long>(compensated),
                                raw_s, comp_s, dbg_buffer, dbg_latency, lead_ms, sr);
                    std::fflush(stdout);
                }
            }
        }
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
        snap.mixer_scheduled_jump_executed_count =
            mixer_->scheduled_jump_executed_count();
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
    // RubberBand / PitchCache diagnostics removed (Bungee-only pipeline; the
    // PitchSnapshot fields are no longer populated and snapshot.cpp no longer
    // emits a "pitch" object). The mixer scheduled-jump signal is drained by
    // service_control_thread_tasks above; the prearmed-jump fast path keeps
    // Bungee voices in sync after any seek.

    // Bungee voice-manager diagnostics log — enabled by LIBRETRACKS_AUDIO_DEBUG=1.
    if (env_flag_enabled("LIBRETRACKS_AUDIO_DEBUG") && bungee_voices_) {
        static std::chrono::steady_clock::time_point s_last_log;
        const auto now = std::chrono::steady_clock::now();
        if (now - s_last_log >= std::chrono::seconds(1)) {
            s_last_log = now;
            const auto bd = bungee_voices_->diagnostics();
            debug_log("[LT_PITCH_DEBUG] bungee available=%s active_voices=%d "
                "built=%llu rebuilds_session=%llu rebuilds_seek=%llu "
                "lookups_hit=%llu lookups_miss=%llu\n",
                bungee_voices_->is_available() ? "true" : "false",
                bd.active_voice_count,
                static_cast<unsigned long long>(bd.voices_built_total),
                static_cast<unsigned long long>(bd.rebuilds_for_session),
                static_cast<unsigned long long>(bd.rebuilds_for_seek),
                static_cast<unsigned long long>(bd.voice_lookups_hit),
                static_cast<unsigned long long>(bd.voice_lookups_miss));
        }
    }

    // Phase 8: prearmed-jump diagnostics. Cheap (mutex-protected reads).
    if (prearmed_jumps_) {
        const auto pd = prearmed_jumps_->diagnostics();
        snap.prearmed_jumps.ready_count          = pd.ready_count;
        snap.prearmed_jumps.prepared_total       = pd.prepared_total;
        snap.prearmed_jumps.prepare_failed_total = pd.prepare_failed_total;
        snap.prearmed_jumps.take_hit_total       = pd.take_hit_total;
        snap.prearmed_jumps.take_miss_total      = pd.take_miss_total;
        snap.prearmed_jumps.stale_discard_total  = pd.stale_discard_total;
        snap.prearmed_jumps.eviction_total       = pd.eviction_total;
        snap.prearmed_jumps.max_prepared_targets = pd.max_prepared_targets;
    }

    return snapshot_to_json(snap);
}

void EngineImpl::resample_sources_for_new_sample_rate() {
    // When the audio device's sample rate changes (user switches device or
    // explicitly sets a different rate), sources already decoded at the OLD
    // rate would play back at the wrong speed: they'd be consumed at the
    // new device rate while having been resampled to the old rate at
    // decode time. Symptom users see: "audio is slow / fast / desync".
    //
    // The fix is to re-decode every source at the new rate. We re-trigger
    // the existing prep_queue with the new sample rate so the worker pool
    // does the work off the command thread — the UI keeps responding.
    // Pitched / unpitched playback resumes at correct speed once decoding
    // finishes (sub-second per source on typical hardware).
    //
    // Bungee and the prearmed-jumps manager also need re-preparing because
    // their voice dimensions are tied to sample rate.
    if (!clock_) return;
    const int new_sr = clock_->sample_rate();
    if (new_sr <= 0) return;

    debug_log("[LT_PITCH_DEBUG] resample_sources_for_new_sample_rate sr=%d session=%d\n",
        new_sr, session_ ? 1 : 0);

    // ALWAYS re-prepare Bungee + prearmed-jumps with the new dimensions,
    // even when no session is loaded yet. The Tauri startup flow runs:
    //   engine init (opens default device at SR_A)
    //   → apply_settings → SetOutputDevice (negotiates SR_B != SR_A)
    //   → user loads project later
    // Bungee was first prepared at SR_A in engine init. Without this
    // re-prepare it stays at SR_A while the device is at SR_B and the
    // audio thread feeds it samples that drift in time → desync.
    if (bungee_voices_ && device_manager_) {
        const int bs = device_manager_->actual_buffer_size() > 0
            ? device_manager_->actual_buffer_size() : 1024;
        bungee_voices_->prepare(new_sr, /*channels=*/2, bs);
        bungee_voices_->clear(); // voices were built for old dims
        if (prearmed_jumps_) {
            prearmed_jumps_->clear();
            prearmed_jumps_->prepare(new_sr, /*channels=*/2, bs);
            prearm_revision_.fetch_add(1, std::memory_order_relaxed);
        }
    }

    // The source re-decode step is only meaningful when a session exists.
    // Without it there are no sources to re-decode.
    if (!session_ || !source_manager_) return;

    // Cancel any in-flight decode jobs from the previous rate.
    if (prep_queue_) {
        prep_queue_->cancel_all();
        prep_queue_.reset();
    }
    // Drop the cached decoded samples; the renderer will silence the
    // affected clips until they're re-decoded.
    source_manager_->clear();
    // Re-register sources from the live session and enqueue all of them
    // for decode at the new rate.
    for (const auto& src : session_->sources) {
        source_manager_->register_source(src.id, src.file_path);
    }
    prep_queue_ = std::make_unique<SourcePreparationQueue>(
        source_manager_.get(),
        worker_pool_.get(),
        [this](EngineEvent ev){ push_event(std::move(ev)); },
        new_sr);
    prep_queue_->enqueue_session(session_->sources, clock_->position().frame);
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

std::string EngineImpl::get_source_peaks(const std::string& source_id,
                                         int resolution_frames) const {
    json out;
    out["ok"] = false;

    if (!source_manager_) {
        out["error"] = "source manager is not available";
        return out.dump();
    }

    auto source = source_manager_->get_shared(source_id);
    if (!source || !source->is_loaded()) {
        out["error"] = "source is not ready";
        return out.dump();
    }

    const auto overview = source->peaks(resolution_frames);
    out["ok"] = true;
    out["sample_rate"] = overview.sample_rate;
    out["duration_frames"] = overview.duration_frames;
    out["resolution_frames"] = overview.resolution_frames;
    out["min_peaks"] = overview.min_peaks;
    out["max_peaks"] = overview.max_peaks;
    return out.dump();
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
                int track_count = 0;
                int clip_count = 0;
                for (const auto& song : next_session->songs) {
                    track_count += static_cast<int>(song.tracks.size());
                    for (const auto& track : song.tracks)
                        clip_count += static_cast<int>(track.clips.size());
                }
                debug_log("[LT_PITCH_DEBUG] LoadSession name=\"%s\" songs=%d tracks=%d clips=%d regions=%d nonzero_transpose_regions=%d\n",
                    next_session->name.c_str(),
                    static_cast<int>(next_session->songs.size()),
                    track_count, clip_count,
                    region_count, nonzero_regions);
            }
            session_ = next_session;
            (void)session_generation_.fetch_add(1, std::memory_order_relaxed);

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
                // preserve_realtime_state=false: LoadSession is the authoritative source
                // of truth for gain/pan/mute/solo — always load from session, never keep
                // stale Mixer atomics. This eliminates the need for sync_live_mix after load.
                mixer_->set_session(next_session, /*preserve_realtime_state=*/false);
                mixer_->set_bungee_voice_manager(bungee_voices_.get());
            }
            // Build Bungee voices for whatever is currently transposed at playhead.
            // Source data may not be decoded yet — voices for unloaded sources are
            // skipped and rebuilt later when sources become ready.
            if (bungee_voices_ && bungee_voices_->is_available())
                bungee_voices_->rebuild_for_session(
                    *next_session, *source_manager_, clock_->position().frame);

            // Prearm marker / region / song targets on session load. Bumps
            // prearm_revision_ so any previous prepared sets are discarded.
            // Phase 2: posts to PrearmedJumpManager's worker thread so we
            // don't block LoadSession on ~80ms × markers × tracks of warm.
            if (prearmed_jumps_) {
                const auto rev = prearm_revision_.fetch_add(1,
                    std::memory_order_relaxed) + 1;
                prearmed_jumps_->prepare_all_targets_async(
                    next_session, source_manager_.get(), rev);
            }

            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdPlay>) {
            // Bungee is the sole pitch backend; voices for already-loaded
            // clips were built at LoadSession / SeekAbsolute time, so Play
            // is now a pure clock advance with no pitch-priming work.
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
            // Reposition Bungee voices to frame 0 so the next play emits
            // audio aligned with the clock instead of a brief blip from the
            // grain buffers left over by the pre-stop render. Done async so
            // the stop command returns instantly; the mixer outputs silence
            // while state != Playing, so it doesn't matter that the rebuild
            // takes ~600ms — by the time the user presses play the new
            // voice map is already published.
            if (bungee_voices_ && bungee_voices_->is_available() && session_) {
                bungee_voices_->rebuild_for_seek_async(
                    0, *session_, *source_manager_);
            }
            push_event(EvPlaybackStopped{ f });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekAbsolute>) {
            Frame from = clock_->position().frame;

            // No-op seek short-circuit. The Rust play path unconditionally
            // sends SeekAbsolute(current_position) before Play (see
            // audio_engine.rs::play). When the target frame equals where the
            // clock already is, none of the downstream work is needed: voices
            // are already primed here, RubberBand streams are already at this
            // position, pitch cache is already valid. Skipping it removes the
            // ~700ms+ of warm_voice and stream rebuild that was making the
            // play button feel laggy. Still emit EvSeekExecuted so listeners
            // see a consistent event stream.
            if (c.frame == from) {
                push_event(EvSeekExecuted{ from, c.frame });
                return Result<void>::ok();
            }

            clock_->seek(c.frame);
            (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
            if (mixer_) mixer_->trigger_crossfade();
            if (bungee_voices_ && bungee_voices_->is_available() && session_) {
                bungee_voices_->clear();
                bungee_voices_->rebuild_for_seek_async(
                    clock_->position().frame, *session_, *source_manager_);
            }
            push_event(EvSeekExecuted{ from, c.frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekRelative>) {
            Frame from = clock_->position().frame;
            Frame to   = from + c.delta_frames;
            clock_->seek(to);
            (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
            if (mixer_) mixer_->trigger_crossfade();
            if (bungee_voices_ && bungee_voices_->is_available() && session_) {
                bungee_voices_->clear();
                bungee_voices_->rebuild_for_seek_async(
                    clock_->position().frame, *session_, *source_manager_);
            }
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
        else if constexpr (std::is_same_v<T, CmdStartMasterFade>) {
            if (jump_debug_enabled()) {
                debug_log(
                    "[LT_JUMP_DEBUG][native-command] start_master_fade target=%.6f duration=%.9f\n",
                    static_cast<double>(c.target_gain),
                    c.duration_seconds);
            }
            if (mixer_) mixer_->start_master_fade(c.target_gain, c.duration_seconds);
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

            // Prearmed-jump fast path: if PrearmedJumpManager has a fully
            // ready voice set for this marker under the current session
            // revision, atomically swap it into BungeeVoiceManager BEFORE
            // scheduling the seek. The audio thread's next block will see
            // the new voices, eliminating the ~80 ms control-thread voice-
            // construction cost the reactive rebuild_for_seek path pays.
            //
            // Fallback: if no prepared set exists (e.g. revision changed,
            // marker added after last LoadSession), fall through to the
            // legacy reactive path — calling rebuild_for_seek synchronously
            // so the jump still works, just slower.
            if (prearmed_jumps_ && bungee_voices_ && bungee_voices_->is_available()) {
                // Resolve marker frame to build the key.
                Frame target_frame = 0;
                Id song_id;
                for (const auto& song : session_->songs) {
                    for (const auto& m : song.markers) {
                        if (m.id == c.marker_id) {
                            target_frame = m.frame;
                            song_id      = song.id;
                        }
                    }
                }
                if (!song_id.empty()) {
                    PrearmTargetKey key;
                    key.kind             = PrearmTargetKind::Marker;
                    key.song_id          = song_id;
                    key.target_id        = c.marker_id;
                    key.timeline_frame   = target_frame;
                    key.sample_rate      = clock_->sample_rate();
                    key.block_size       = device_manager_
                        ? device_manager_->actual_buffer_size()
                        : 1024;
                    key.session_revision = prearm_revision_.load(
                        std::memory_order_relaxed);

                    if (auto prepared = prearmed_jumps_->take_ready(key)) {
                        bungee_voices_->swap_in_prepared_voices(
                            prepared->extract_voice_map());
                        // Set transport to target immediately so the next
                        // audio block reads from the new playhead with the
                        // freshly-published voices.
                        clock_->seek(target_frame);
                        if (mixer_) mixer_->trigger_crossfade();
                        prearmed_jumps_->prepare_all_targets_async(
                            session_, source_manager_.get(), key.session_revision);
                        push_event(EvJumpScheduled{ jump_id, c.marker_id });
                        return Result<void>::ok();
                    }
                    bungee_voices_->clear();
                    bungee_voices_->rebuild_for_seek_async(
                        target_frame, *session_, *source_manager_);
                }
            }

            auto r = scheduler_->schedule_immediate(jump_id, target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ jump_id, c.marker_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToRegion>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::Region, c.region_id, std::nullopt };
            Id jump_id = "jump-region-" + c.region_id;

            // Prearmed-jump fast path (see CmdJumpToMarker for rationale).
            if (prearmed_jumps_ && bungee_voices_ && bungee_voices_->is_available()) {
                Frame target_frame = 0;
                Id song_id;
                for (const auto& song : session_->songs) {
                    for (const auto& reg : song.regions) {
                        if (reg.id == c.region_id) {
                            target_frame = reg.start_frame;
                            song_id      = song.id;
                        }
                    }
                }
                if (!song_id.empty()) {
                    PrearmTargetKey key;
                    key.kind             = PrearmTargetKind::RegionStart;
                    key.song_id          = song_id;
                    key.target_id        = c.region_id;
                    key.timeline_frame   = target_frame;
                    key.sample_rate      = clock_->sample_rate();
                    key.block_size       = device_manager_
                        ? device_manager_->actual_buffer_size() : 1024;
                    key.session_revision = prearm_revision_.load(
                        std::memory_order_relaxed);
                    if (auto prepared = prearmed_jumps_->take_ready(key)) {
                        bungee_voices_->swap_in_prepared_voices(
                            prepared->extract_voice_map());
                        clock_->seek(target_frame);
                        if (mixer_) mixer_->trigger_crossfade();
                        prearmed_jumps_->prepare_all_targets_async(
                            session_, source_manager_.get(), key.session_revision);
                        push_event(EvJumpScheduled{ jump_id, c.region_id });
                        return Result<void>::ok();
                    }
                    bungee_voices_->clear();
                    bungee_voices_->rebuild_for_seek_async(
                        target_frame, *session_, *source_manager_);
                }
            }

            auto r = scheduler_->schedule_immediate(jump_id, target, *session_, *clock_);
            if (r.is_err()) return Result<void>::err(r.error());
            push_event(EvJumpScheduled{ jump_id, c.region_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdJumpToSong>) {
            if (!session_) return Result<void>::err("No session loaded");
            JumpTarget target{ JumpTarget::Kind::Song, c.song_id, std::nullopt };
            Id jump_id = "jump-song-" + c.song_id;

            // Prearmed-jump fast path (see CmdJumpToMarker for rationale).
            if (prearmed_jumps_ && bungee_voices_ && bungee_voices_->is_available()) {
                Frame target_frame = 0;
                bool found = false;
                for (const auto& song : session_->songs) {
                    if (song.id == c.song_id) {
                        target_frame = song.start_frame;
                        found = true;
                    }
                }
                if (found) {
                    PrearmTargetKey key;
                    key.kind             = PrearmTargetKind::SongStart;
                    key.song_id          = c.song_id;
                    key.target_id        = c.song_id;
                    key.timeline_frame   = target_frame;
                    key.sample_rate      = clock_->sample_rate();
                    key.block_size       = device_manager_
                        ? device_manager_->actual_buffer_size() : 1024;
                    key.session_revision = prearm_revision_.load(
                        std::memory_order_relaxed);
                    if (auto prepared = prearmed_jumps_->take_ready(key)) {
                        bungee_voices_->swap_in_prepared_voices(
                            prepared->extract_voice_map());
                        clock_->seek(target_frame);
                        if (mixer_) mixer_->trigger_crossfade();
                        prearmed_jumps_->prepare_all_targets_async(
                            session_, source_manager_.get(), key.session_revision);
                        push_event(EvJumpScheduled{ jump_id, c.song_id });
                        return Result<void>::ok();
                    }
                    bungee_voices_->clear();
                    bungee_voices_->rebuild_for_seek_async(
                        target_frame, *session_, *source_manager_);
                }
            }

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
                if (prearmed_jumps_ && bungee_voices_ && bungee_voices_->is_available()
                    && source_manager_ && clock_) {
                    auto resolved = resolve_jump_target(c.target, *session_, *clock_);
                    if (resolved.is_ok()) {
                        const Frame target_frame = resolved.unwrap();
                        std::optional<PrearmTargetKind> prearm_kind;
                        Id song_id;
                        Id target_id;

                        switch (c.target.kind) {
                            case JumpTarget::Kind::Marker:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    prearm_kind = PrearmTargetKind::Marker;
                                    for (const auto& song : session_->songs) {
                                        for (const auto& marker : song.markers) {
                                            if (marker.id == target_id) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                        if (!song_id.empty()) break;
                                    }
                                    if (song_id.empty()) {
                                        for (const auto& song : session_->songs) {
                                            if (target_frame >= song.start_frame
                                                && target_frame < song.end_frame) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                    }
                                }
                                break;
                            case JumpTarget::Kind::Region:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    prearm_kind = PrearmTargetKind::RegionStart;
                                    for (const auto& song : session_->songs) {
                                        for (const auto& region : song.regions) {
                                            if (region.id == target_id) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                        if (!song_id.empty()) break;
                                    }
                                    if (song_id.empty()) {
                                        for (const auto& song : session_->songs) {
                                            if (target_frame >= song.start_frame
                                                && target_frame < song.end_frame) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                    }
                                }
                                break;
                            case JumpTarget::Kind::Song:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    song_id = target_id;
                                    prearm_kind = PrearmTargetKind::SongStart;
                                }
                                break;
                            default:
                                break;
                        }

                        if (prearm_kind && !song_id.empty() && !target_id.empty()) {
                            const auto rev = prearm_revision_.load(std::memory_order_relaxed);
                            PrearmTargetKey key;
                            key.kind             = *prearm_kind;
                            key.song_id          = song_id;
                            key.target_id        = target_id;
                            key.timeline_frame   = target_frame;
                            key.sample_rate      = clock_->sample_rate();
                            key.block_size       = device_manager_
                                ? device_manager_->actual_buffer_size() : 1024;
                            key.session_revision = rev;

                            auto refill_prearm_cache = [&] {
                                prearmed_jumps_->prepare_all_targets_async(
                                    session_, source_manager_.get(), rev);
                            };

                            if (auto prepared = prearmed_jumps_->take_ready(key)) {
                                bungee_voices_->swap_in_prepared_voices(
                                    prepared->extract_voice_map());
                                clock_->seek(target_frame);
                                if (mixer_) mixer_->trigger_crossfade();
                                refill_prearm_cache();
                                push_event(EvJumpScheduled{ c.jump_id, c.jump_id });
                                return Result<void>::ok();
                            }

                            bungee_voices_->clear();
                            bungee_voices_->rebuild_for_seek_async(
                                target_frame, *session_, *source_manager_);
                        }
                    }
                }

                auto r = scheduler_->schedule_immediate(c.jump_id, c.target, *session_, *clock_);
                if (r.is_err()) return Result<void>::err(r.error());
            } else {
                ScheduledJump jump;
                jump.jump_id = c.jump_id;
                jump.target = c.target;
                jump.trigger = c.trigger;
                jump.trigger_frame = c.trigger_frame;
                jump.suppress_seek_fade = c.suppress_seek_fade;
                jump.created_frame = clock_->position().frame;
                Frame resolved_target_frame_for_log = -1;
                auto resolved_for_schedule_log = resolve_jump_target(c.target, *session_, *clock_);
                if (resolved_for_schedule_log.is_ok())
                    resolved_target_frame_for_log = resolved_for_schedule_log.unwrap();
                if (prearmed_jumps_ && bungee_voices_ && bungee_voices_->is_available()
                    && source_manager_ && clock_) {
                    auto resolved = resolved_for_schedule_log;
                    if (resolved.is_ok()) {
                        const Frame target_frame = resolved.unwrap();
                        resolved_target_frame_for_log = target_frame;
                        std::optional<PrearmTargetKind> prearm_kind;
                        Id song_id;
                        Id target_id;

                        switch (c.target.kind) {
                            case JumpTarget::Kind::Marker:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    prearm_kind = PrearmTargetKind::Marker;
                                    for (const auto& song : session_->songs) {
                                        for (const auto& marker : song.markers) {
                                            if (marker.id == target_id) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                        if (!song_id.empty()) break;
                                    }
                                    if (song_id.empty()) {
                                        for (const auto& song : session_->songs) {
                                            if (target_frame >= song.start_frame
                                                && target_frame < song.end_frame) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                    }
                                }
                                break;
                            case JumpTarget::Kind::Region:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    prearm_kind = PrearmTargetKind::RegionStart;
                                    for (const auto& song : session_->songs) {
                                        for (const auto& region : song.regions) {
                                            if (region.id == target_id) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                        if (!song_id.empty()) break;
                                    }
                                    if (song_id.empty()) {
                                        for (const auto& song : session_->songs) {
                                            if (target_frame >= song.start_frame
                                                && target_frame < song.end_frame) {
                                                song_id = song.id;
                                                break;
                                            }
                                        }
                                    }
                                }
                                break;
                            case JumpTarget::Kind::Song:
                                if (c.target.id) {
                                    target_id = *c.target.id;
                                    song_id = target_id;
                                    prearm_kind = PrearmTargetKind::SongStart;
                                }
                                break;
                            default:
                                break;
                        }

                        if (prearm_kind && !song_id.empty() && !target_id.empty()) {
                            const auto rev = prearm_revision_.load(std::memory_order_relaxed);
                            PrearmTargetKey key;
                            key.kind             = *prearm_kind;
                            key.song_id          = song_id;
                            key.target_id        = target_id;
                            key.timeline_frame   = target_frame;
                            key.sample_rate      = clock_->sample_rate();
                            key.block_size       = device_manager_
                                ? device_manager_->actual_buffer_size() : 1024;
                            key.session_revision = rev;

                            std::unique_ptr<PreparedJumpVoiceSet> prepared =
                                prearmed_jumps_->take_ready(key);
                            if (!prepared) {
                                prepared = prearmed_jumps_->prepare_target_now(
                                    *session_, *source_manager_, *prearm_kind, song_id,
                                    target_id, target_frame, rev);
                            }
                            if (prepared) {
                                jump.prepared_voice_map =
                                    bungee_voices_->build_prepared_voice_map(
                                        prepared->extract_voice_map());
                                prearmed_jumps_->prepare_all_targets_async(
                                    session_, source_manager_.get(), rev);
                            }
                        }
                    }
                }
                if (jump_debug_enabled()) {
                    debug_log(
                        "[LT_JUMP_DEBUG][native-command] schedule jump_id=%s trigger=%s target_kind=%s target_id=%s target_frame=%lld trigger_frame=%lld current_frame=%lld prepared=%d suppress_seek_fade=%d\n",
                        c.jump_id.c_str(),
                        jump_trigger_name(c.trigger),
                        jump_target_kind_name(c.target.kind),
                        c.target.id ? c.target.id->c_str() : "",
                        static_cast<long long>(resolved_target_frame_for_log),
                        static_cast<long long>(jump.trigger_frame.value_or(-1)),
                        static_cast<long long>(clock_->position().frame),
                        jump.prepared_voice_map ? 1 : 0,
                        jump.suppress_seek_fade ? 1 : 0);
                }
                auto r = scheduler_->schedule(jump);
                if (r.is_err()) return r;
                // (RubberBand pre-prepare removed — Bungee voices are kept
                // current by the prearmed-jump path / rebuild_for_seek.)
            }
            push_event(EvJumpScheduled{ c.jump_id, c.jump_id });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdReplaceScheduledJump>) {
            auto r = scheduler_->replace(c.jump_id, c.new_target, c.new_trigger);
            return r;
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
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
                if (bungee_voices_ && bungee_voices_->is_available() && clock_) {
                    bungee_voices_->rebuild_for_seek_async(
                        clock_->position().frame, *next_session, *source_manager_);
                }
                // Prearm: pitch decision changed → re-prearm all targets
                // under a new revision (auto-invalidates existing cache).
                if (prearmed_jumps_) {
                    const auto rev = prearm_revision_.fetch_add(1,
                        std::memory_order_relaxed) + 1;
                    prearmed_jumps_->prepare_all_targets_async(
                        next_session, source_manager_.get(), rev);
                }
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
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
                if (bungee_voices_ && bungee_voices_->is_available() && clock_) {
                    bungee_voices_->rebuild_for_seek_async(
                        clock_->position().frame, *next_session, *source_manager_);
                }
                // Prearm: song transpose changed → re-prearm all targets.
                if (prearmed_jumps_) {
                    const auto rev = prearm_revision_.fetch_add(1,
                        std::memory_order_relaxed) + 1;
                    prearmed_jumps_->prepare_all_targets_async(
                        next_session, source_manager_.get(), rev);
                }
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
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
                if (bungee_voices_ && bungee_voices_->is_available() && clock_) {
                    bungee_voices_->rebuild_for_seek_async(
                        clock_->position().frame, *next_session, *source_manager_);
                }
                // Prearm: region transpose changed → re-prearm all targets.
                if (prearmed_jumps_) {
                    const auto rev = prearm_revision_.fetch_add(1,
                        std::memory_order_relaxed) + 1;
                    prearmed_jumps_->prepare_all_targets_async(
                        next_session, source_manager_.get(), rev);
                }
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetSongRegions>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                bool changed = false;
                for (auto& song : next_session->songs) {
                    if (song.id != c.song_id) continue;
                    song.regions.clear();
                    song.regions.reserve(c.regions.size());
                    for (const auto& update : c.regions) {
                        Region region;
                        region.id = update.id;
                        region.name = update.name;
                        region.start_frame = update.start_frame;
                        region.end_frame = update.end_frame;
                        region.transpose_semitones = update.transpose_semitones;
                        song.regions.push_back(std::move(region));
                    }
                    changed = true;
                    break;
                }
                if (changed) {
                    session_ = next_session;
                    (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                    if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                    if (prearmed_jumps_) {
                        const auto rev = prearm_revision_.fetch_add(1,
                            std::memory_order_relaxed) + 1;
                        prearmed_jumps_->prepare_all_targets_async(
                            next_session, source_manager_.get(), rev);
                    }
                }
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetOutputDevice>) {
            DeviceOpenRequest req;
            req.device_id = c.device_id;
            req.sample_rate = current_device_request_.sample_rate;
            req.buffer_size = current_device_request_.buffer_size;
            bool was_playing = clock_ && clock_->position().state == TransportState::Playing;
            const int prev_sr = clock_ ? clock_->sample_rate() : 0;
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
            // If the new device negotiated a different sample rate than what
            // we had before, every already-decoded source is at the wrong
            // rate. Re-decode them — see resample_sources_for_new_sample_rate.
            // Without this, switching 48k → 44.1k makes audio play ~9% slow.
            const int new_sr = clock_ ? clock_->sample_rate() : 0;
            if (prev_sr > 0 && new_sr > 0 && new_sr != prev_sr) {
                resample_sources_for_new_sample_rate();
            }
            // Prearm: device change can alter the negotiated sample rate /
            // buffer size, which changes prepared voice dimensions. Clear
            // the cache and reconfigure with new params; the next prearm
            // pass will rebuild voices with matching dimensions. We do NOT
            // automatically re-prearm here — that happens on the next
            // LoadSession or transpose change. Audio stays glitch-free
            // because jumps will fall back to reactive rebuild_for_seek.
            if (prearmed_jumps_) {
                prearmed_jumps_->clear();
                const int sr = device_manager_->actual_sample_rate() > 0
                    ? device_manager_->actual_sample_rate() : 48000;
                const int bs = device_manager_->actual_buffer_size() > 0
                    ? device_manager_->actual_buffer_size() : 1024;
                prearmed_jumps_->prepare(sr, /*channels=*/2, bs);
                prearm_revision_.fetch_add(1, std::memory_order_relaxed);
            }
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
            const int prev_sr = clock_ ? clock_->sample_rate() : 0;
            auto* callback = mixer_ ? static_cast<AudioRenderCallback*>(mixer_.get())
                                    : static_cast<AudioRenderCallback*>(silent_callback_.get());
            auto r = device_manager_->open_device(req, callback);
            if (r.is_ok()) {
                current_device_request_ = req;
                if (clock_ && device_manager_->actual_sample_rate() > 0)
                    clock_->set_sample_rate(device_manager_->actual_sample_rate());
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                // Re-decode sources if SR actually changed. resample_sources_…
                // also re-prepares Bungee + prearmed_jumps, so the explicit
                // re-prepare code below is now subsumed when the SR diff hits.
                const int new_sr = clock_ ? clock_->sample_rate() : 0;
                if (prev_sr > 0 && new_sr > 0 && new_sr != prev_sr) {
                    resample_sources_for_new_sample_rate();
                } else if (prearmed_jumps_) {
                    // SR didn't actually change; just keep the existing
                    // prearm-clear behaviour for safety.
                    prearmed_jumps_->clear();
                    const int sr = device_manager_->actual_sample_rate() > 0
                        ? device_manager_->actual_sample_rate() : 48000;
                    const int bs = device_manager_->actual_buffer_size() > 0
                        ? device_manager_->actual_buffer_size() : 1024;
                    prearmed_jumps_->prepare(sr, /*channels=*/2, bs);
                    prearm_revision_.fetch_add(1, std::memory_order_relaxed);
                }
            }
            return r;
        }
        else if constexpr (std::is_same_v<T, CmdSetBufferSize>) {
            DeviceOpenRequest req;
            req.device_id = current_device_request_.device_id;
            req.sample_rate = current_device_request_.sample_rate;
            req.buffer_size = c.buffer_size;
            const int prev_sr = clock_ ? clock_->sample_rate() : 0;
            auto* callback = mixer_ ? static_cast<AudioRenderCallback*>(mixer_.get())
                                    : static_cast<AudioRenderCallback*>(silent_callback_.get());
            auto r = device_manager_->open_device(req, callback);
            if (r.is_ok()) {
                current_device_request_ = req;
                if (clock_ && device_manager_->actual_sample_rate() > 0)
                    clock_->set_sample_rate(device_manager_->actual_sample_rate());
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                // Buffer-size change rarely affects SR but devices can
                // renegotiate it; handle SR-change identically to SetSampleRate.
                const int new_sr = clock_ ? clock_->sample_rate() : 0;
                if (prev_sr > 0 && new_sr > 0 && new_sr != prev_sr) {
                    resample_sources_for_new_sample_rate();
                } else if (prearmed_jumps_) {
                    prearmed_jumps_->clear();
                    const int sr = device_manager_->actual_sample_rate() > 0
                        ? device_manager_->actual_sample_rate() : 48000;
                    const int bs = device_manager_->actual_buffer_size() > 0
                        ? device_manager_->actual_buffer_size() : 1024;
                    prearmed_jumps_->prepare(sr, /*channels=*/2, bs);
                    prearm_revision_.fetch_add(1, std::memory_order_relaxed);
                }
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
