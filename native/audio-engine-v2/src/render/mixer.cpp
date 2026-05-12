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
    : session_(session)
    , sources_(sources)
    , clock_(clock)
    , scheduler_(scheduler)
{
    // Wire jump execution callback: triggers a crossfade so the seek is click-free.
    // Constructed here so the lambda captures the FadeProcessor pointer.
    // FadeProcessor is allocated on first render; this is safe because the
    // callback is only fired from the audio thread after render() starts.
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

    // Drain pending scheduler ops (at top of block, before clock advance).
    scheduler_->drain_pending();

    // Check for due jumps.
    auto due_frame = scheduler_->check_due(*clock_, *session_);
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

    if (clock_->position().state == TransportState::Playing && session_) {
        // Find the current song.
        for (const auto& song : session_->songs) {
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
    for (int f = 0; f < num_frames; ++f) {
        peak_l = std::max(peak_l, std::abs(output_channels[0][f]));
        if (num_channels >= 2)
            peak_r = std::max(peak_r, std::abs(output_channels[1][f]));
    }
    meter_l_.store(peak_l, std::memory_order_relaxed);
    meter_r_.store(peak_r, std::memory_order_relaxed);

    auto t1 = std::chrono::steady_clock::now();
    double dur = std::chrono::duration<double, std::milli>(t1 - t0).count();
    double prev = callback_duration_ms_.load(std::memory_order_relaxed);
    callback_duration_ms_.store(0.9 * prev + 0.1 * dur, std::memory_order_relaxed);
}

void Mixer::set_track_gain(const Id& track_id, Gain gain) {
    if (!session_) return;
    for (const auto& song : session_->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].gain.store(gain, std::memory_order_relaxed);
}

void Mixer::set_track_mute(const Id& track_id, bool mute) {
    if (!session_) return;
    for (const auto& song : session_->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].mute.store(mute, std::memory_order_relaxed);
}

void Mixer::set_track_solo(const Id& track_id, bool solo) {
    if (!session_) return;
    for (const auto& song : session_->songs)
        for (std::size_t i = 0; i < song.tracks.size() && i < kMaxTracks; ++i)
            if (song.tracks[i].id == track_id)
                overrides_[i].solo.store(solo, std::memory_order_relaxed);
}

MeterValues Mixer::meters() const noexcept {
    MeterValues m;
    m.left_peak  = meter_l_.load(std::memory_order_relaxed);
    m.right_peak = meter_r_.load(std::memory_order_relaxed);
    return m;
}

int    Mixer::callback_count()       const noexcept { return callback_count_.load(std::memory_order_relaxed); }
double Mixer::callback_duration_ms() const noexcept { return callback_duration_ms_.load(std::memory_order_relaxed); }

} // namespace lt
