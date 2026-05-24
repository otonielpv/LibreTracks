#include <lt_engine/engine_impl.h>
#include <lt_engine/core/engine_core.h>
#include <lt_engine/core/events.h>
#include <lt_engine/debug/logging.h>
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
#include <limits>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

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
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

struct PreparedVoiceDebugSummary {
    int voices = 0;
    int queued_min = 0;
    int queued_max = 0;
    int queued_total = 0;
};

PreparedVoiceDebugSummary summarize_prepared_voice_map(
    const std::shared_ptr<const PreparedVoiceMap>& voices) {
    PreparedVoiceDebugSummary out;
    if (!voices || voices->empty())
        return out;
    out.queued_min = std::numeric_limits<int>::max();
    for (const auto& kv : *voices) {
        if (!kv.second) continue;
        const int queued = kv.second->queued_output_frames();
        ++out.voices;
        out.queued_total += queued;
        out.queued_min = std::min(out.queued_min, queued);
        out.queued_max = std::max(out.queued_max, queued);
    }
    if (out.voices == 0)
        out.queued_min = 0;
    return out;
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

void request_jump_target_audio(SourceManager& sources,
                               const Session& session,
                               Frame target_frame,
                               int window_frames) noexcept {
    for (const auto& song : session.songs) {
        if (target_frame < song.start_frame || target_frame >= song.end_frame)
            continue;
        for (const auto& track : song.tracks) {
            if (track.kind != TrackKind::Audio)
                continue;
            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                if (target_frame < clip.timeline_start_frame || target_frame >= clip_end)
                    continue;
                const Frame source_frame = clip.source_start_frame
                    + (target_frame - clip.timeline_start_frame);
                sources.request_range(clip.source_id, source_frame, window_frames);
            }
        }
        return;
    }
}

int seek_source_wait_ms() {
    static const int value = [] {
        const char* v = std::getenv("LIBRETRACKS_SEEK_SOURCE_WAIT_MS");
        if (!v) return 750;
        const int parsed = std::atoi(v);
        return parsed >= 0 && parsed <= 10000 ? parsed : 750;
    }();
    return value;
}

bool jump_target_audio_ready(SourceManager& sources,
                             const Session& session,
                             Frame target_frame,
                             int window_frames) noexcept {
    for (const auto& song : session.songs) {
        if (target_frame < song.start_frame || target_frame >= song.end_frame)
            continue;
        for (const auto& track : song.tracks) {
            if (track.kind != TrackKind::Audio)
                continue;
            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                if (target_frame < clip.timeline_start_frame || target_frame >= clip_end)
                    continue;
                const auto source = sources.get_shared(clip.source_id);
                if (!source || !source->is_streaming())
                    continue;
                const Frame source_frame = clip.source_start_frame
                    + (target_frame - clip.timeline_start_frame);
                const Frame read_start = std::max<Frame>(0, source_frame);
                if (read_start >= source->duration_frames())
                    continue;
                const int frames = std::max(1, static_cast<int>(std::min<Frame>(
                    std::min<Frame>(
                        static_cast<Frame>(std::max(1, window_frames)),
                        source->duration_frames() - read_start),
                    static_cast<Frame>(std::numeric_limits<int>::max()))));
                if (!source->is_range_ready(read_start, frames))
                    return false;
            }
        }
        break;
    }
    return true;
}

void wait_jump_target_audio_ready(SourceManager& sources,
                                  const Session& session,
                                  Frame target_frame,
                                  int window_frames) noexcept {
    request_jump_target_audio(sources, session, target_frame, window_frames);
    if (jump_target_audio_ready(sources, session, target_frame, window_frames))
        return;

    const int wait_ms = seek_source_wait_ms();
    if (wait_ms <= 0)
        return;

    const auto start = std::chrono::steady_clock::now();
    const auto deadline = start + std::chrono::milliseconds(wait_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (jump_target_audio_ready(sources, session, target_frame, window_frames))
            return;
        request_jump_target_audio(sources, session, target_frame, window_frames);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (jump_debug_enabled()) {
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        debug_log(
            "[LT_JUMP_DEBUG][native-command] seek_source_window_timeout target_frame=%lld window_frames=%d wait_ms=%d elapsed_ms=%lld\n",
            static_cast<long long>(target_frame),
            window_frames,
            wait_ms,
            static_cast<long long>(elapsed));
    }
}

int playback_prepare_wait_ms() {
    static const int value = [] {
        const char* v = std::getenv("LIBRETRACKS_PLAYBACK_PREPARE_WAIT_MS");
        if (!v) return 5000;
        const int parsed = std::atoi(v);
        return parsed >= 0 && parsed <= 120000 ? parsed : 5000;
    }();
    return value;
}

int playback_prepare_window_frames(int sample_rate) {
    const int sr = sample_rate > 0 ? sample_rate : 48000;
    int seconds = 20;
    if (const char* v = std::getenv("LIBRETRACKS_PLAYBACK_PREPARE_SECONDS")) {
        const int parsed = std::atoi(v);
        if (parsed >= 1 && parsed <= 120)
            seconds = parsed;
    }
    return std::max(4096, sr * seconds);
}

void request_playback_audio_window(SourceManager& sources,
                                   const Session& session,
                                   Frame start_frame,
                                   int window_frames) noexcept {
    if (window_frames <= 0)
        return;
    const Frame end_frame = start_frame + static_cast<Frame>(window_frames);
    for (const auto& song : session.songs) {
        if (end_frame <= song.start_frame || start_frame >= song.end_frame)
            continue;
        for (const auto& track : song.tracks) {
            if (track.kind != TrackKind::Audio)
                continue;
            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                const Frame overlap_start = std::max(start_frame, clip.timeline_start_frame);
                const Frame overlap_end = std::min(end_frame, clip_end);
                if (overlap_end <= overlap_start)
                    continue;
                const Frame source_frame = clip.source_start_frame
                    + (overlap_start - clip.timeline_start_frame);
                const int frames = static_cast<int>(std::min<Frame>(
                    overlap_end - overlap_start,
                    static_cast<Frame>(std::numeric_limits<int>::max())));
                sources.request_range(clip.source_id, source_frame, frames);
            }
        }
    }
}

bool playback_audio_window_ready(SourceManager& sources,
                                 const Session& session,
                                 Frame start_frame,
                                 int window_frames) noexcept {
    if (window_frames <= 0)
        return true;
    const Frame end_frame = start_frame + static_cast<Frame>(window_frames);
    for (const auto& song : session.songs) {
        if (end_frame <= song.start_frame || start_frame >= song.end_frame)
            continue;
        for (const auto& track : song.tracks) {
            if (track.kind != TrackKind::Audio)
                continue;
            for (const auto& clip : track.clips) {
                const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
                const Frame overlap_start = std::max(start_frame, clip.timeline_start_frame);
                const Frame overlap_end = std::min(end_frame, clip_end);
                if (overlap_end <= overlap_start)
                    continue;
                const auto source = sources.get_shared(clip.source_id);
                if (!source || !source->is_streaming())
                    continue;
                const Frame source_frame = clip.source_start_frame
                    + (overlap_start - clip.timeline_start_frame);
                const Frame read_start = std::max<Frame>(0, source_frame);
                if (read_start >= source->duration_frames())
                    continue;
                const int frames = std::max(1, static_cast<int>(std::min<Frame>(
                    std::min<Frame>(
                        overlap_end - overlap_start,
                        source->duration_frames() - read_start),
                    static_cast<Frame>(std::numeric_limits<int>::max()))));
                if (!source->is_range_ready(read_start, frames))
                    return false;
            }
        }
    }
    return true;
}

void wait_playback_audio_window_ready(SourceManager& sources,
                                      const Session& session,
                                      Frame start_frame,
                                      int window_frames) noexcept {
    request_playback_audio_window(sources, session, start_frame, window_frames);
    if (playback_audio_window_ready(sources, session, start_frame, window_frames))
        return;

    const int wait_ms = playback_prepare_wait_ms();
    if (wait_ms <= 0)
        return;

    const auto start = std::chrono::steady_clock::now();
    const auto deadline = start + std::chrono::milliseconds(wait_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (playback_audio_window_ready(sources, session, start_frame, window_frames))
            return;
        request_playback_audio_window(sources, session, start_frame, window_frames);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (jump_debug_enabled()) {
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        debug_log(
            "[LT_JUMP_DEBUG][native-command] playback_prepare_window_timeout start_frame=%lld window_frames=%d wait_ms=%d elapsed_ms=%lld\n",
            static_cast<long long>(start_frame),
            window_frames,
            wait_ms,
            static_cast<long long>(elapsed));
    }
}

// Fires the moment the DLL is loaded by Windows, before any exported function is called.
struct DllLoadProbe {
    DllLoadProbe() {
        if (!audio_debug_enabled()) return;
        lt_reset_debug_log_file();
        lt_debug_log("[LT_PITCH_DEBUG] DLL_LOADED lt_audio_engine_v2\n");
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

bool session_sources_ready(const Session& session, const SourceManager& sources) {
    for (const auto& source : session.sources) {
        const DecodedSource* decoded = sources.get(source.id);
        if (!decoded || !decoded->is_loaded())
            return false;
    }
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
        // Race-safe: load session_ atomically. The control thread may be
        // reassigning session_ concurrently (LoadSession / transpose / etc.),
        // and a non-atomic shared_ptr copy can yield a dangling control block
        // → silent SEH crash on the decode worker thread.
        auto current_session = std::atomic_load(&session_);
        if (!current_session || !session_contains_source(*current_session, source_id))
            return;

        const bool all_ready = session_sources_ready(*current_session, *source_manager_);
        // Defer the heavy Bungee rebuild until every source is decoded —
        // doing it per-source from a worker thread races with the control
        // thread's session reassignments and was crashing on multi-track
        // projects. One rebuild at the end is enough because pitched
        // playback only kicks in after the user hits Play / seeks.
        if (all_ready && bungee_voices_ && bungee_voices_->is_available() && clock_) {
            bungee_voices_->rebuild_for_session(
                *current_session, *source_manager_, clock_->position().frame);
        }
        if (prearmed_jumps_ && all_ready) {
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
    std::atomic_store(&session_, std::shared_ptr<const Session>{});
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
    if (mixer_) {
        const Frame target = mixer_->take_pending_scheduled_jump();
        if (target != Mixer::kNoJumpPending
            && bungee_voices_ && bungee_voices_->is_available()
            && session_ && source_manager_) {
            bungee_voices_->rebuild_for_seek_async(
                target, *session_, *source_manager_);
        }
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
                    lt_debug_log("[SNAP_FRAME] wall_ms=%lld raw_frame=%lld comp_frame=%lld "
                                 "raw_s=%.4f comp_s=%.4f buf=%d lat=%d lead_ms=%.2f sr=%d\n",
                                 static_cast<long long>(wall_ms),
                                 static_cast<long long>(pos.frame),
                                 static_cast<long long>(compensated),
                                 raw_s, comp_s, dbg_buffer, dbg_latency, lead_ms, sr);
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
    }
    if (source_manager_) {
        const auto source_diagnostics = source_manager_->diagnostics();
        std::unordered_map<Id, SourceDiagnostics> diagnostics_by_id;
        diagnostics_by_id.reserve(source_diagnostics.size());
        for (const auto& d : source_diagnostics)
            diagnostics_by_id[d.source_id] = d;

        for (auto& info : snap.source_states) {
            auto it = diagnostics_by_id.find(info.source_id);
            if (it == diagnostics_by_id.end())
                continue;
            const auto& d = it->second;
            if (d.status == "ready" || d.status == "cache_ready") {
                info.status = d.status;
                info.progress_percent = 100;
                info.error_message.clear();
            } else if (d.status == "failed") {
                info.status = d.status;
                info.error_message = d.error_message;
            }
        }

        std::unordered_set<Id> seen_sources;
        seen_sources.reserve(snap.source_states.size());
        for (const auto& info : snap.source_states)
            seen_sources.insert(info.source_id);

        for (const auto& d : source_diagnostics) {
            if (seen_sources.find(d.source_id) != seen_sources.end())
                continue;
            SourcePreparationInfo info;
            info.source_id = d.source_id;
            info.status = d.status;
            info.error_message = d.error_message;
            if (d.status == "ready" || d.status == "cache_ready")
                info.progress_percent = 100;
            snap.source_states.push_back(std::move(info));
        }
    }
    if (source_manager_) {
        auto cd = source_manager_->cache_diagnostics();
        snap.source_cache.ram_bytes_used = cd.bytes_used;
        snap.source_cache.ram_bytes_capacity = cd.bytes_capacity;
        snap.source_cache.blocks_cached = cd.blocks_cached;
        snap.source_cache.blocks_hit = cd.blocks_hit;
        snap.source_cache.blocks_miss = cd.blocks_miss;
        std::size_t disk_bytes = 0;
        for (const auto& d : source_manager_->diagnostics())
            disk_bytes += d.disk_cache_bytes;
        snap.source_cache.disk_bytes_used = disk_bytes;
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
        snap.prearmed_jumps.worker_busy = pd.worker_busy;
        snap.prearmed_jumps.latest_posted_revision = pd.latest_posted_revision;
        snap.prearmed_jumps.last_completed_revision = pd.last_completed_revision;
        snap.prearmed_jumps.posted_count = pd.posted_count;
        snap.prearmed_jumps.completed_count = pd.completed_count;
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

    const auto overview = source_manager_->source_peaks(source_id, resolution_frames);
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
            std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
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
                if (jump_debug_enabled()) {
                    debug_log(
                        "[LT_JUMP_DEBUG][prearm] request_all reason=load_session revision=%llu\n",
                        static_cast<unsigned long long>(rev));
                }
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
            const auto pos = clock_->position();
            Frame from = pos.frame;

            // No-op seek short-circuit. The Rust play path unconditionally
            // sends SeekAbsolute(current_position) before Play (see
            // audio_engine.rs::play). When the target frame equals where the
            // clock already is while stopped/paused, use it as the guarded
            // first-play preparation point: fill the near-future disk cache and
            // publish any transposed voices before the clock is allowed to run.
            if (c.frame == from) {
                if (pos.state != TransportState::Playing && source_manager_ && session_) {
                    const int prepare_window = playback_prepare_window_frames(
                        clock_ ? clock_->sample_rate() : 48000);
                    wait_playback_audio_window_ready(
                        *source_manager_, *session_, c.frame, prepare_window);
                    if (bungee_voices_ && bungee_voices_->is_available()) {
                        auto seek_voice_map = bungee_voices_->build_seek_voice_map(
                            c.frame, *session_, *source_manager_);
                        if (seek_voice_map)
                            bungee_voices_->publish_prepared_voice_map_realtime(
                                std::move(seek_voice_map));
                    }
                }
                push_event(EvSeekExecuted{ from, c.frame });
                return Result<void>::ok();
            }

            const bool preparing_stopped_playback = pos.state != TransportState::Playing;
            const int seek_window = preparing_stopped_playback
                ? playback_prepare_window_frames(clock_ ? clock_->sample_rate() : 48000)
                : std::max(
                    4096,
                    (device_manager_ ? device_manager_->actual_buffer_size() : 1024) * 8);
            if (source_manager_ && session_)
                request_jump_target_audio(*source_manager_, *session_, c.frame, seek_window);
            std::shared_ptr<const PreparedVoiceMap> seek_voice_map;
            if (bungee_voices_ && bungee_voices_->is_available() && session_ && source_manager_) {
                seek_voice_map = bungee_voices_->build_seek_voice_map(
                    c.frame, *session_, *source_manager_);
            }
            if (source_manager_ && session_) {
                if (preparing_stopped_playback) {
                    wait_playback_audio_window_ready(
                        *source_manager_, *session_, c.frame, seek_window);
                } else {
                    wait_jump_target_audio_ready(
                        *source_manager_, *session_, c.frame, seek_window);
                }
            }
            clock_->seek(c.frame);
            if (bungee_voices_ && seek_voice_map)
                bungee_voices_->publish_prepared_voice_map_realtime(std::move(seek_voice_map));
            (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
            if (mixer_) mixer_->trigger_crossfade();
            push_event(EvSeekExecuted{ from, c.frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekRelative>) {
            Frame from = clock_->position().frame;
            Frame to   = from + c.delta_frames;
            const int seek_window = std::max(
                4096,
                (device_manager_ ? device_manager_->actual_buffer_size() : 1024) * 8);
            if (source_manager_ && session_)
                request_jump_target_audio(*source_manager_, *session_, to, seek_window);
            std::shared_ptr<const PreparedVoiceMap> seek_voice_map;
            if (bungee_voices_ && bungee_voices_->is_available() && session_ && source_manager_) {
                seek_voice_map = bungee_voices_->build_seek_voice_map(
                    to, *session_, *source_manager_);
            }
            if (source_manager_ && session_)
                wait_jump_target_audio_ready(*source_manager_, *session_, to, seek_window);
            clock_->seek(to);
            if (bungee_voices_ && seek_voice_map)
                bungee_voices_->publish_prepared_voice_map_realtime(std::move(seek_voice_map));
            (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
            if (mixer_) mixer_->trigger_crossfade();
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

                        const char* prearm_source = "none";
                        int prearm_set_voices = 0;
                        bool prearm_set_valid = false;
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
                if (resolved_for_schedule_log.is_ok()) {
                    resolved_target_frame_for_log = resolved_for_schedule_log.unwrap();
                    if (source_manager_) {
                        const int window = std::max(
                            4096,
                            (device_manager_ ? device_manager_->actual_buffer_size() : 1024) * 8);
                        request_jump_target_audio(
                            *source_manager_, *session_, resolved_target_frame_for_log, window);
                    }
                }
                const char* prearm_source = "none";
                int prearm_set_voices = 0;
                bool prearm_set_valid = false;
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
                            if (prepared) {
                                prearm_source = "take_ready";
                            }
                            if (!prepared) {
                                prepared = prearmed_jumps_->prepare_target_now(
                                    *session_, *source_manager_, *prearm_kind, song_id,
                                    target_id, target_frame, rev);
                                prearm_source = prepared ? "prepare_now" : "miss";
                            }
                            if (prepared) {
                                prearm_set_valid = prepared->valid;
                                prearm_set_voices = static_cast<int>(prepared->tracks.size());
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
                    const auto prepared_summary =
                        summarize_prepared_voice_map(jump.prepared_voice_map);
                    debug_log(
                        "[LT_JUMP_DEBUG][native-command] schedule jump_id=%s trigger=%s target_kind=%s target_id=%s target_frame=%lld trigger_frame=%lld current_frame=%lld prepared=%d suppress_seek_fade=%d prearm_source=%s prearm_set_valid=%d prearm_set_voices=%d prepared_voices=%d prepared_fifo_min=%d prepared_fifo_max=%d prepared_fifo_total=%d\n",
                        c.jump_id.c_str(),
                        jump_trigger_name(c.trigger),
                        jump_target_kind_name(c.target.kind),
                        c.target.id ? c.target.id->c_str() : "",
                        static_cast<long long>(resolved_target_frame_for_log),
                        static_cast<long long>(jump.trigger_frame.value_or(-1)),
                        static_cast<long long>(clock_->position().frame),
                        jump.prepared_voice_map ? 1 : 0,
                        jump.suppress_seek_fade ? 1 : 0,
                        prearm_source,
                        prearm_set_valid ? 1 : 0,
                        prearm_set_voices,
                        prepared_summary.voices,
                        prepared_summary.queued_min,
                        prepared_summary.queued_max,
                        prepared_summary.queued_total);
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
                std::shared_ptr<const PreparedVoiceMap> prepared_voice_map;
                if (bungee_voices_ && bungee_voices_->is_available()
                    && source_manager_ && clock_) {
                    const Frame frame = clock_->position().frame;
                    request_playback_audio_window(
                        *source_manager_, *next_session, frame,
                        playback_prepare_window_frames(clock_->sample_rate()));
                    prepared_voice_map = bungee_voices_->build_seek_voice_map(
                        frame, *next_session, *source_manager_);
                    if (prepared_voice_map)
                        bungee_voices_->publish_prepared_voice_map_realtime(
                            prepared_voice_map);
                }
                std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
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
                std::shared_ptr<const PreparedVoiceMap> prepared_voice_map;
                if (bungee_voices_ && bungee_voices_->is_available()
                    && source_manager_ && clock_) {
                    const Frame frame = clock_->position().frame;
                    request_playback_audio_window(
                        *source_manager_, *next_session, frame,
                        playback_prepare_window_frames(clock_->sample_rate()));
                    prepared_voice_map = bungee_voices_->build_seek_voice_map(
                        frame, *next_session, *source_manager_);
                    if (prepared_voice_map)
                        bungee_voices_->publish_prepared_voice_map_realtime(
                            prepared_voice_map);
                }
                std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
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
                std::shared_ptr<const PreparedVoiceMap> prepared_voice_map;
                if (bungee_voices_ && bungee_voices_->is_available()
                    && source_manager_ && clock_) {
                    const Frame frame = clock_->position().frame;
                    request_playback_audio_window(
                        *source_manager_, *next_session, frame,
                        playback_prepare_window_frames(clock_->sample_rate()));
                    prepared_voice_map = bungee_voices_->build_seek_voice_map(
                        frame, *next_session, *source_manager_);
                    if (prepared_voice_map)
                        bungee_voices_->publish_prepared_voice_map_realtime(
                            prepared_voice_map);
                }
                std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
                (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                if (mixer_) mixer_->trigger_crossfade();
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
                    std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
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
        else if constexpr (std::is_same_v<T, CmdSetSongMarkers>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                bool changed = false;
                for (auto& song : next_session->songs) {
                    if (song.id != c.song_id) continue;
                    song.markers.clear();
                    song.markers.reserve(c.markers.size());
                    for (const auto& update : c.markers) {
                        Marker marker;
                        marker.id = update.id;
                        marker.name = update.name;
                        marker.frame = update.frame;
                        song.markers.push_back(std::move(marker));
                    }
                    changed = true;
                    break;
                }
                if (changed) {
                    std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
                    (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                    if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                    if (prearmed_jumps_) {
                        const auto rev = prearm_revision_.fetch_add(1,
                            std::memory_order_relaxed) + 1;
                        if (jump_debug_enabled()) {
                            debug_log(
                                "[LT_JUMP_DEBUG][prearm] request_all reason=set_song_markers revision=%llu markers=%zu\n",
                                static_cast<unsigned long long>(rev),
                                c.markers.size());
                        }
                        prearmed_jumps_->prepare_all_targets_async(
                            next_session, source_manager_.get(), rev);
                    }
                }
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetSongTiming>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                bool changed = false;
                for (auto& song : next_session->songs) {
                    if (song.id != c.song_id) continue;
                    song.bpm = std::clamp(c.bpm, 20.0, 300.0);
                    song.beats_per_bar = std::max(1, c.beats_per_bar);
                    song.beat_unit = std::max(1, c.beat_unit);

                    song.tempo_markers.clear();
                    song.tempo_markers.reserve(c.tempo_markers.size());
                    for (const auto& update : c.tempo_markers) {
                        TempoMarker marker;
                        marker.id = update.id;
                        marker.frame = std::max<Frame>(0, update.frame);
                        marker.bpm = std::clamp(update.bpm, 20.0, 300.0);
                        song.tempo_markers.push_back(std::move(marker));
                    }
                    std::sort(song.tempo_markers.begin(), song.tempo_markers.end(),
                        [](const TempoMarker& left, const TempoMarker& right) {
                            return left.frame < right.frame;
                        });

                    song.time_signature_markers.clear();
                    song.time_signature_markers.reserve(c.time_signature_markers.size());
                    for (const auto& update : c.time_signature_markers) {
                        TimeSignatureMarker marker;
                        marker.id = update.id;
                        marker.frame = std::max<Frame>(0, update.frame);
                        marker.beats_per_bar = std::max(1, update.beats_per_bar);
                        marker.beat_unit = std::max(1, update.beat_unit);
                        song.time_signature_markers.push_back(std::move(marker));
                    }
                    std::sort(song.time_signature_markers.begin(),
                        song.time_signature_markers.end(),
                        [](const TimeSignatureMarker& left,
                           const TimeSignatureMarker& right) {
                            return left.frame < right.frame;
                        });

                    changed = true;
                    break;
                }
                if (changed) {
                    std::atomic_store(&session_, std::shared_ptr<const Session>(next_session));
                    (void)session_generation_.fetch_add(1, std::memory_order_relaxed);
                    if (mixer_) mixer_->set_session(next_session, /*preserve_realtime_state=*/true);
                }
            }
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetOutputDevice>) {
            DeviceOpenRequest req;
            req.device_id = c.device_id;
            req.sample_rate = current_device_request_.sample_rate;
            req.buffer_size = current_device_request_.buffer_size;
            req.active_output_channels = c.active_channels;
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
            req.active_output_channels = current_device_request_.active_output_channels;
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
            req.active_output_channels = current_device_request_.active_output_channels;
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
