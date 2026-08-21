#include <lt_engine/pitch/voice_priming.h>

#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace lt::voice_priming {

namespace {

// Safety cap on the warm loop, in case Bungee never reports convergence with
// some ratio. Never reached in practice: latency settles after roughly 2048
// input frames at any hop setting, and is_warm() breaks the loop there.
constexpr int kMaxWarmFramesAt48k = 28800;  // 600 ms at 48 kHz

// Planar scratch for one priming pass. Allocating here is fine — this is
// control-thread work by construction.
struct Planes {
    std::vector<float> in_l, in_r, out_l, out_r;
    std::vector<const float*> in_ptrs;
    std::vector<float*> out_ptrs;

    Planes(int channel_count, int frames)
        : in_l(static_cast<std::size_t>(frames), 0.0f),
          in_r(static_cast<std::size_t>(frames), 0.0f),
          out_l(static_cast<std::size_t>(frames), 0.0f),
          out_r(static_cast<std::size_t>(frames), 0.0f),
          in_ptrs(static_cast<std::size_t>(channel_count), nullptr),
          out_ptrs(static_cast<std::size_t>(channel_count), nullptr) {
        in_ptrs[0]  = in_l.data();
        out_ptrs[0] = out_l.data();
        if (channel_count >= 2) {
            in_ptrs[1]  = in_r.data();
            out_ptrs[1] = out_r.data();
        }
    }
};

// Output frames to request for `input_frames` at `ratio`. This IS how the
// ratio is set: Bungee derives its speed from the proportion between the two
// counts, so there is no separate parameter that could disagree with them.
int output_for(int input_frames, double ratio, int max_in_frames) {
    const double safe = ratio > 0.0 ? ratio : 1.0;
    const int wanted = static_cast<int>(
        std::llround(static_cast<double>(input_frames) / safe));
    return std::max(1, std::min(wanted, max_in_frames));
}

} // namespace

void warm(BungeePitchVoice& voice,
          int sample_rate,
          int channel_count,
          int max_in_frames,
          double time_ratio,
          double pitch_scale) {
    if (!voice.is_ready()) return;
    const int budget = std::max(0, static_cast<int>(
        static_cast<long long>(kMaxWarmFramesAt48k) * sample_rate / 48000));
    if (budget <= 0 || max_in_frames <= 0) return;

    Planes planes(channel_count, max_in_frames);

    int fed = 0;
    while (fed < budget) {
        const int chunk = std::min(max_in_frames, budget - fed);
        (void)voice.render_block(planes.in_ptrs.data(), chunk,
                                 planes.out_ptrs.data(),
                                 output_for(chunk, time_ratio, max_in_frames),
                                 pitch_scale);
        fed += chunk;
        if (voice.is_warm())
            break;
    }
}

Alignment align_on_source(BungeePitchVoice& voice,
                          const DecodedSource& source,
                          Frame target_source_frame,
                          int channel_count,
                          int max_in_frames,
                          double pitch_scale,
                          double time_ratio) {
    const Alignment nothing_to_do{target_source_frame, target_source_frame};
    if (!voice.is_ready() || max_in_frames <= 0) return nothing_to_do;
    const int latency_frames = static_cast<int>(voice.latency_frames());
    if (latency_frames <= 0) return nothing_to_do;  // not warm yet

    Planes planes(channel_count, max_in_frames);

    const Frame src_end = source.duration_frames();
    Frame read_cursor = target_source_frame;

    // Read `frames` of source at read_cursor into the input planes, zero-padding
    // anything before the start or past the end, and advance the cursor. The
    // feed must stay contiguous: Bungee splices whatever it is handed into one
    // stream and cannot tell that a frame was skipped or repeated.
    auto read_source = [&](int frames) {
        std::fill_n(planes.in_l.begin(), frames, 0.0f);
        std::fill_n(planes.in_r.begin(), frames, 0.0f);
        const int dst_offset = read_cursor < 0
            ? static_cast<int>(std::min<Frame>(frames, -read_cursor))
            : 0;
        const Frame read_start = std::max<Frame>(0, read_cursor);
        const int available = (dst_offset >= frames || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                frames - dst_offset,
                static_cast<long long>(src_end - read_start)));
        if (available > 0) {
            float* into[2] = {planes.in_l.data() + dst_offset,
                              planes.in_r.data() + dst_offset};
            const int got = source.read(read_start, available, into,
                                        std::min(2, source.channel_count()));
            if (got > 0 && source.channel_count() == 1)
                std::copy_n(planes.in_l.begin() + dst_offset, got,
                            planes.in_r.begin() + dst_offset);
        }
        read_cursor += frames;
    };

    // Captured before any real audio so the readings below convert back into
    // source frames: every frame fed from here is one source frame, read
    // contiguously.
    const long long input_pos_before_real = voice.input_position();
    const Frame real_audio_read_start = read_cursor;

    // Push `latency_frames` of real source through and discard the output. That
    // output is the flush of the warm silence, so it belongs to positions
    // BEFORE the target; discarding it is what leaves the voice emitting the
    // target next.
    //
    // One loop for every ratio. There used to be two, chosen on
    // |ratio - 1| > 1e-6, which disagreed with the engine's own definition of
    // warp (warp_enabled && warp_source_bpm > 0). Any ratio close enough to 1
    // satisfied one and not the other, and the tests sat in exactly that gap.
    int fed = 0;
    while (fed < latency_frames) {
        const int chunk = std::min(max_in_frames, latency_frames - fed);
        read_source(chunk);
        (void)voice.render_block(planes.in_ptrs.data(), chunk,
                                 planes.out_ptrs.data(),
                                 output_for(chunk, time_ratio, max_in_frames),
                                 pitch_scale);
        fed += chunk;
    }
    voice.clear_queued_output();

    // Ask Bungee where it is instead of predicting it. outputPosition() is the
    // input-frame position of the next sample it will emit.
    const double consumed_before_output =
        voice.output_position() - static_cast<double>(input_pos_before_real);

    // No output priming. It used to fill the FIFO so the first realtime block
    // needed no synthesis, sized against latency_frames — which can exceed the
    // FIFO capacity, and push_fifo drops the overflow silently after the read
    // cursor has already passed it, tearing the contiguity this function exists
    // to establish. The pipeline is aligned now; the first block synthesises
    // like every other one.
    return Alignment{
        real_audio_read_start
            + static_cast<Frame>(std::llround(consumed_before_output)),
        read_cursor};
}

} // namespace lt::voice_priming
