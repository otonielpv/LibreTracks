#include <lt_engine/engine_impl.h>
#include <lt_engine/core/engine_core.h>
#include <lt_engine/core/events.h>
#include <lt_engine/render/pitch_resolution.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <mutex>
#include <queue>
#include <stdexcept>

namespace lt {

using json = nlohmann::json;

namespace {

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
    pitch_cache_    = std::make_unique<PitchCache>();
    worker_pool_    = std::make_unique<DecodeWorkerPool>();
    mixer_          = std::make_unique<Mixer>(
        std::shared_ptr<const Session>{},
        source_manager_.get(),
        clock_.get(),
        scheduler_.get(),
        pitch_cache_.get());
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

std::string EngineImpl::poll_event() {
    return event_queue_->pop();
}

std::string EngineImpl::get_snapshot() const {
    EngineSnapshot snap;

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
        snap.cpu.callback_count       = mixer_->callback_count();
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
        snap.pitch.pitch_processors_prepared = pitch.processors_prepared;
        snap.pitch.pitch_processors_missing = pitch.processors_missing;
        snap.pitch.pitch_missing_processor_count = pitch.missing_processor_count;
    }

    return snapshot_to_json(snap);
}

void EngineImpl::prepare_pitch_processors_for_session() {
    if (!session_ || !source_manager_ || !pitch_cache_ || !clock_)
        return;

    const int sample_rate = clock_->sample_rate();
    for (const auto& song : session_->songs) {
        for (const auto& track : song.tracks) {
            for (const auto& clip : track.clips) {
                Semitones semitones = resolve_effective_semitones(
                    track, clip, song, clip.timeline_start_frame);
                if (semitones == 0)
                    continue;
                const auto* source = source_manager_->get(clip.source_id);
                if (!source || !source->is_loaded())
                    continue;
                PitchCacheKey key{clip.source_id, track.id, clip.id,
                                  static_cast<double>(semitones),
                                  sample_rate, source->channel_count(), "realtime"};
                pitch_cache_->prepare_processor(key);
            }
        }
    }
}

std::string EngineImpl::list_devices() const {
    json arr = json::array();
    for (const auto& d : device_manager_->list_devices()) {
        arr.push_back({
            {"device_id",   d.id},
            {"device_name", d.name},
            {"backend",     d.backend},
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
            session_ = next_session;
            session_generation_.fetch_add(1, std::memory_order_relaxed);

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
            }

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
            if (mixer_) mixer_->trigger_crossfade();
            push_event(EvSeekExecuted{ from, c.frame });
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSeekRelative>) {
            Frame from = clock_->position().frame;
            Frame to   = from + c.delta_frames;
            clock_->seek(to);
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
            update_track_session(session_, mixer_.get(), c.track_id, [pan = c.pan](Track& track) {
                track.pan = std::clamp(pan, -1.0f, 1.0f);
            });
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
            if (mixer_) mixer_->set_metronome_config(metronome_config_);
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetMetronomeVolume>) {
            metronome_config_.volume = std::clamp(c.volume, 0.0f, 1.0f);
            if (mixer_) mixer_->set_metronome_config(metronome_config_);
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
            bool changed = update_track_session(session_, mixer_.get(), c.track_id, [enabled = c.enabled](Track& track) {
                track.transpose_behavior = enabled
                    ? TransposeBehavior::FollowsSongOrRegion
                    : TransposeBehavior::NeverTranspose;
            });
            if (changed)
                prepare_pitch_processors_for_session();
            return Result<void>::ok();
        }
        else if constexpr (std::is_same_v<T, CmdSetSongTranspose>) {
            if (session_) {
                auto next_session = std::make_shared<Session>(*session_);
                for (auto& song : next_session->songs)
                    if (song.id == c.song_id)
                        song.transpose_semitones = c.semitones;
                session_ = next_session;
                prepare_pitch_processors_for_session();
                if (mixer_) mixer_->set_session(next_session);
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
                prepare_pitch_processors_for_session();
                if (mixer_) mixer_->set_session(next_session);
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
