#include <lt_engine/render/mixer.h>
#include <lt_engine/render/fade_processor.h>
#include <algorithm>
#include <chrono>
#include <cstring>

namespace lt {

Mixer::Mixer(const Session*       session,
             const SourceManager* sources,
             TransportClock*      clock,
             JumpScheduler*       scheduler)
    : session_(session ? std::make_shared<Session>(*session) : nullptr)
    , sources_(sources)
    , clock_(clock)
    , scheduler_(scheduler)
{
}

Mixer::Mixer(std::shared_ptr<const Session> session,
             const SourceManager* sources,
             TransportClock* clock,
             JumpScheduler* scheduler)
    : session_(std::move(session))
    , sources_(sources)
    , clock_(clock)
    , scheduler_(scheduler)
{
}

bool Mixer::any_solo_active(const Song& song) const noexcept {
    for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
        if (overrides_[i].solo.load(std::memory_order_relaxed)) return true;
    return false;
}

void Mixer::render(float** output_channels,
                   int     num_channels,
                   int     num_frames,
                   double  /*sample_rate*/) noexcept {
    auto t0 = std::chrono::steady_clock::now();
    callback_count_.fetch_add(1, std::memory_order_relaxed);
    auto session = std::atomic_load(&session_);

    // Drain pending scheduler ops (at top of block, before clock advance).
    scheduler_->drain_pending();

    // Check for due jumps.
    auto due_frame = session ? scheduler_->check_due(*clock_, *session, num_frames) : std::nullopt;
    if (due_frame) {
        Frame from = clock_->position().frame;
        clock_->seek(*due_frame);
        scheduler_->mark_executed(from, *due_frame);
        // Crossfade to hide the discontinuity (applied below).
        fade_.trigger_crossfade();
    }

    // Zero output buses.
    for (int ch = 0; ch < num_channels; ++ch)
        std::fill(output_channels[ch], output_channels[ch] + num_frames, 0.f);

    Frame timeline_frame = clock_->position().frame;

    reset_track_meters();

    if (clock_->position().state == TransportState::Playing && session) {
        // Find the current song.
        for (const auto& song : session->songs) {
            if (timeline_frame < song.start_frame || timeline_frame >= song.end_frame)
                continue;

            bool solo_active = any_solo_active(song);

            // Render each track.
            for (std::size_t ti = 0; ti < song.tracks.size() && ti < kMaxTracks; ++ti) {
                const Track& track = song.tracks[ti];

                float gain = overrides_[ti].gain.load(std::memory_order_relaxed);
                bool  mute = overrides_[ti].mute.load(std::memory_order_relaxed);
                bool  solo = overrides_[ti].solo.load(std::memory_order_relaxed);

                if (mute) continue;
                if (solo_active && !solo) continue;

                // Render into mix bus.
                std::fill(mix_l_, mix_l_ + num_frames, 0.f);
                std::fill(mix_r_, mix_r_ + num_frames, 0.f);

                // Temporarily override gain so TrackRenderer sees the command-thread gain.
                Track patched = track;
                patched.gain  = gain;
                patched.mute  = false;  // already handled above

                renderers_[ti].render(patched, timeline_frame, num_frames,
                                       mix_, 2, *sources_, nullptr,
                                       clock_->sample_rate());

                float track_peak_l = 0.f, track_peak_r = 0.f;
                double track_sum_l = 0.0, track_sum_r = 0.0;
                for (int f = 0; f < num_frames; ++f) {
                    track_peak_l = std::max(track_peak_l, std::abs(mix_l_[f]));
                    track_peak_r = std::max(track_peak_r, std::abs(mix_r_[f]));
                    track_sum_l += static_cast<double>(mix_l_[f]) * mix_l_[f];
                    track_sum_r += static_cast<double>(mix_r_[f]) * mix_r_[f];
                }
                track_meters_[ti].left_peak.store(track_peak_l, std::memory_order_relaxed);
                track_meters_[ti].right_peak.store(track_peak_r, std::memory_order_relaxed);
                track_meters_[ti].left_rms.store(static_cast<float>(std::sqrt(track_sum_l / std::max(1, num_frames))), std::memory_order_relaxed);
                track_meters_[ti].right_rms.store(static_cast<float>(std::sqrt(track_sum_r / std::max(1, num_frames))), std::memory_order_relaxed);

                // Accumulate into stereo output.
                for (int f = 0; f < num_frames; ++f) {
                    output_channels[0][f] += mix_l_[f];
                    if (num_channels >= 2)
                        output_channels[1][f] += mix_r_[f];
                }
            }
            break;
        }

        // Advance transport clock.
        clock_->advance(num_frames);
    }

    // Apply crossfade ramp (Phase 7).
    fade_.process(output_channels, num_channels, num_frames);

    // Peak meters.
    float peak_l = 0.f, peak_r = 0.f;
    double sum_l = 0.0, sum_r = 0.0;
    for (int f = 0; f < num_frames; ++f) {
        peak_l = std::max(peak_l, std::abs(output_channels[0][f]));
        sum_l += static_cast<double>(output_channels[0][f]) * output_channels[0][f];
        if (num_channels >= 2)
        {
            peak_r = std::max(peak_r, std::abs(output_channels[1][f]));
            sum_r += static_cast<double>(output_channels[1][f]) * output_channels[1][f];
        }
    }
    meter_l_.store(peak_l, std::memory_order_relaxed);
    meter_r_.store(peak_r, std::memory_order_relaxed);
    meter_l_rms_.store(static_cast<float>(std::sqrt(sum_l / std::max(1, num_frames))), std::memory_order_relaxed);
    meter_r_rms_.store(static_cast<float>(std::sqrt(sum_r / std::max(1, num_frames))), std::memory_order_relaxed);
    if (session) {
        int count = 0;
        for (const auto& song : session->songs) {
            if (timeline_frame >= song.start_frame && timeline_frame < song.end_frame) {
                count = static_cast<int>(std::min<std::size_t>(song.tracks.size(), kMaxTracks));
                break;
            }
        }
        track_meter_count_.store(count, std::memory_order_relaxed);
    } else {
        track_meter_count_.store(0, std::memory_order_relaxed);
    }

    auto t1 = std::chrono::steady_clock::now();
    double dur = std::chrono::duration<double, std::milli>(t1 - t0).count();
    double prev = callback_duration_ms_.load(std::memory_order_relaxed);
    callback_duration_ms_.store(0.9 * prev + 0.1 * dur, std::memory_order_relaxed);
}

void Mixer::set_track_gain(const Id& track_id, Gain gain) {
    auto session = std::atomic_load(&session_);
    if (!session) return;
    for (const auto& song : session->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].gain.store(gain, std::memory_order_relaxed);
}

void Mixer::set_track_mute(const Id& track_id, bool mute) {
    auto session = std::atomic_load(&session_);
    if (!session) return;
    for (const auto& song : session->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].mute.store(mute, std::memory_order_relaxed);
}

void Mixer::set_track_solo(const Id& track_id, bool solo) {
    auto session = std::atomic_load(&session_);
    if (!session) return;
    for (const auto& song : session->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].solo.store(solo, std::memory_order_relaxed);
}

void Mixer::set_session(std::shared_ptr<const Session> session) {
    std::atomic_store(&session_, std::move(session));
    reset_track_meters();
}

void Mixer::clear_session() {
    std::atomic_store(&session_, std::shared_ptr<const Session>{});
    reset_track_meters();
}

void Mixer::trigger_crossfade() noexcept {
    fade_.trigger_crossfade();
}

MeterValues Mixer::meters() const noexcept {
    MeterValues m;
    m.left_peak  = meter_l_.load(std::memory_order_relaxed);
    m.right_peak = meter_r_.load(std::memory_order_relaxed);
    m.left_rms   = meter_l_rms_.load(std::memory_order_relaxed);
    m.right_rms  = meter_r_rms_.load(std::memory_order_relaxed);
    return m;
}

std::vector<TrackMeterValues> Mixer::track_meters() const {
    std::vector<TrackMeterValues> values;
    auto session = std::atomic_load(&session_);
    if (!session) return values;
    Frame frame = clock_ ? clock_->position().frame : 0;
    const Song* active_song = nullptr;
    for (const auto& song : session->songs) {
        if (frame >= song.start_frame && frame < song.end_frame) {
            active_song = &song;
            break;
        }
    }
    if (!active_song && !session->songs.empty()) {
        active_song = &session->songs.front();
    }
    if (!active_song) return values;

    int count = static_cast<int>(std::min<std::size_t>(active_song->tracks.size(), kMaxTracks));
    values.reserve(static_cast<std::size_t>(count));
    for (int i = 0; i < count; ++i) {
        TrackMeterValues meter;
        meter.track_id = active_song->tracks[static_cast<std::size_t>(i)].id;
        meter.left_peak = track_meters_[i].left_peak.load(std::memory_order_relaxed);
        meter.right_peak = track_meters_[i].right_peak.load(std::memory_order_relaxed);
        meter.left_rms = track_meters_[i].left_rms.load(std::memory_order_relaxed);
        meter.right_rms = track_meters_[i].right_rms.load(std::memory_order_relaxed);
        values.push_back(std::move(meter));
    }
    return values;
}

void Mixer::reset_track_meters() noexcept {
    int count = track_meter_count_.load(std::memory_order_relaxed);
    count = std::max(0, std::min(count, kMaxTracks));
    for (int i = 0; i < count; ++i) {
        track_meters_[i].left_peak.store(0.f, std::memory_order_relaxed);
        track_meters_[i].right_peak.store(0.f, std::memory_order_relaxed);
        track_meters_[i].left_rms.store(0.f, std::memory_order_relaxed);
        track_meters_[i].right_rms.store(0.f, std::memory_order_relaxed);
    }
}

int    Mixer::callback_count()       const noexcept { return callback_count_.load(std::memory_order_relaxed); }
double Mixer::callback_duration_ms() const noexcept { return callback_duration_ms_.load(std::memory_order_relaxed); }

} // namespace lt
