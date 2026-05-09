#include <lt_engine/transport/transport_clock.h>
#include <algorithm>
#include <cmath>

namespace lt {

TransportClock::TransportClock(int sample_rate)
    : sample_rate_(sample_rate) {}

void TransportClock::play() {
    position_.state = TransportState::Playing;
}

void TransportClock::pause() {
    position_.state = TransportState::Paused;
}

void TransportClock::stop() {
    position_.state  = TransportState::Stopped;
    position_.frame  = 0;
    position_.seconds = 0.0;
}

void TransportClock::seek(Frame frame) {
    position_.frame   = frame;
    position_.seconds = static_cast<double>(frame) / sample_rate_;
}

void TransportClock::advance(int block_frames) {
    if (position_.state != TransportState::Playing)
        return;
    position_.frame   += block_frames;
    position_.seconds  = static_cast<double>(position_.frame) / sample_rate_;
}

void TransportClock::resolve_context(const Session& session) {
    position_.song_id.reset();
    position_.region_id.reset();
    position_.marker_id.reset();

    for (const auto& song : session.songs) {
        if (position_.frame >= song.start_frame &&
            position_.frame <  song.end_frame) {
            position_.song_id = song.id;

            for (const auto& region : song.regions) {
                if (position_.frame >= region.start_frame &&
                    position_.frame <  region.end_frame) {
                    position_.region_id = region.id;
                    break;
                }
            }

            // Nearest marker at or before current frame.
            Frame best_dist = std::numeric_limits<Frame>::max();
            for (const auto& marker : song.markers) {
                if (marker.frame <= position_.frame) {
                    Frame dist = position_.frame - marker.frame;
                    if (dist < best_dist) {
                        best_dist = dist;
                        position_.marker_id = marker.id;
                    }
                }
            }
            break;
        }
    }
}

} // namespace lt
