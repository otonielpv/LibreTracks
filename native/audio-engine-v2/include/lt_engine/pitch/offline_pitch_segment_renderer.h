#pragma once

#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/sources/decoded_source.h>

#include <string>
#include <vector>

namespace lt {

struct RenderedPitchSegment {
    bool ok = false;
    std::string error;
    Frame start_frame = 0;
    Frame frame_count = 0;
    int channel_count = 0;
    int sample_rate = 0;
    int latency_frames = 0;
    int preroll_frames = 0;
    int postroll_frames = 0;
    Frame trimmed_frames = 0;
    std::vector<float> interleaved_samples;
};

class OfflinePitchSegmentRenderer {
public:
    RenderedPitchSegment render_segment(const PitchCacheKey& key,
                                        const DecodedSource& source,
                                        Frame requested_start_frame,
                                        Frame requested_frame_count) const;
};

} // namespace lt
