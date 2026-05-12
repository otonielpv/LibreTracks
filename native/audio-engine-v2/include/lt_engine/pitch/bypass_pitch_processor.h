#pragma once

#include <lt_engine/pitch/pitch_processor.h>

namespace lt {

// ---------------------------------------------------------------------------
// BypassPitchProcessor — zero-latency passthrough.
// Used when semitones == 0 or TransposeBehavior::NeverTranspose.
// ---------------------------------------------------------------------------
class BypassPitchProcessor : public PitchProcessor {
public:
    void   reset()                                              noexcept override {}
    int    process(float**, int, int frame_count)               noexcept override { return frame_count; }
    void   set_semitones(double)                               noexcept override {}
    int    latency_frames()  const noexcept override { return 0; }
    bool   is_bypass()       const noexcept override { return true; }
    const char* type_name()  const noexcept override { return "bypass"; }
};

} // namespace lt
