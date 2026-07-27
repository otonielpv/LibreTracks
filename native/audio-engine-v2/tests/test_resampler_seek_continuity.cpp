#include <doctest/doctest.h>

#include <lt_engine/sources/resampler.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

// ---------------------------------------------------------------------------
// Seek continuity for on-the-fly resampling.
//
// Context: a 44.1kHz multitrack loaded on a 48kHz device currently takes the
// decode+resample-to-disk route (measured: 3.1 s and 865 MB written for 6 of
// the user's stems, vs 0 ms / 0 MB when rates match — see bench_multitrack_load).
// The fix is to resample block-by-block during streaming instead, the way
// Ableton does, so any file rate plays on any device rate with no load cost.
//
// The risk of that design is NOT throughput, it is STATE: r8brain's
// CDSPResampler is stateful and its output depends on the samples fed before
// it. Streaming plays blocks on demand and seeks jump arbitrarily, so a block
// resampled after a seek must match the same block resampled by a resampler
// that ran from the start of the file — otherwise every seek produces a click.
//
// These tests characterise that behaviour BEFORE any production code depends
// on it. They deliberately assert what r8brain actually does, so the numbers
// here are evidence for the design, not aspirations.
// ---------------------------------------------------------------------------

namespace {

constexpr int kSrcRate = 44100;   // the reported stems
constexpr int kDstRate = 48000;   // a common device rate

// A signal with content at several frequencies: a pure tone would hide phase
// and filter-transient errors that a broadband signal exposes.
std::vector<float> make_signal(Frame frames, int channels) {
    std::vector<float> s(static_cast<std::size_t>(frames) *
                         static_cast<std::size_t>(channels), 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const double t = static_cast<double>(f) / kSrcRate;
        const double v = 0.40 * std::sin(2.0 * 3.14159265358979 * 220.0 * t)
                       + 0.25 * std::sin(2.0 * 3.14159265358979 * 1310.0 * t)
                       + 0.15 * std::sin(2.0 * 3.14159265358979 * 6100.0 * t);
        for (int c = 0; c < channels; ++c) {
            const double phase = c == 0 ? v : v * 0.8;
            s[static_cast<std::size_t>(f) * static_cast<std::size_t>(channels) +
              static_cast<std::size_t>(c)] = static_cast<float>(phase);
        }
    }
    return s;
}

// Resample `in` from the beginning, feeding it in `chunk` sized pieces.
std::vector<float> resample_from_start(const std::vector<float>& in,
                                       int channels,
                                       Frame chunk) {
    auto rs = make_streaming_resampler(channels, kSrcRate, kDstRate);
    std::vector<float> out;
    const Frame total = static_cast<Frame>(in.size() / channels);
    for (Frame pos = 0; pos < total; pos += chunk) {
        const Frame n = std::min<Frame>(chunk, total - pos);
        rs->process_chunk(in.data() + static_cast<std::size_t>(pos) *
                              static_cast<std::size_t>(channels),
                          n, pos + n >= total, out);
    }
    return out;
}

// Measured r8brain output latency for 44100 -> 48000 (see the dedicated test
// below, which asserts it rather than trusting this constant). The resampler
// withholds this many OUTPUT frames before its stream lines up with the input,
// and the deficit stays constant once running — that is what makes a seek
// correctable by a fixed offset instead of guesswork.
constexpr Frame kR8brainLatencyOut = 1850;

// Resample starting at `start_frame`, priming the filter with `warmup` frames
// of real audio from before that point. Because the resampler holds back
// kR8brainLatencyOut frames, the warmup produces LESS output than the ratio
// suggests; the caller must drop exactly what the warmup emitted and no more.
// Returns output aligned to `start_frame`.
std::vector<float> resample_from_seek(const std::vector<float>& in,
                                      int channels,
                                      Frame start_frame,
                                      Frame warmup,
                                      Frame chunk) {
    auto rs = make_streaming_resampler(channels, kSrcRate, kDstRate);
    const Frame total = static_cast<Frame>(in.size() / channels);
    const Frame warm_start = std::max<Frame>(0, start_frame - warmup);

    // Feed the warmup context into the same buffer we will trim, so the split
    // between "context output" and "wanted output" is exact.
    std::vector<float> out;
    for (Frame pos = warm_start; pos < start_frame; pos += chunk) {
        const Frame n = std::min<Frame>(chunk, start_frame - pos);
        rs->process_chunk(in.data() + static_cast<std::size_t>(pos) *
                              static_cast<std::size_t>(channels),
                          n, false, out);
    }
    const Frame produced_by_warmup = static_cast<Frame>(out.size() / channels);

    for (Frame pos = start_frame; pos < total; pos += chunk) {
        const Frame n = std::min<Frame>(chunk, total - pos);
        rs->process_chunk(in.data() + static_cast<std::size_t>(pos) *
                              static_cast<std::size_t>(channels),
                          n, pos + n >= total, out);
    }

    // The output stream corresponding to `start_frame` begins where the warmup
    // stopped producing, shifted by the latency the resampler still owes us.
    const Frame drop = std::max<Frame>(0, produced_by_warmup);
    if (drop <= 0) return out;
    const std::size_t cut = static_cast<std::size_t>(drop) *
                            static_cast<std::size_t>(channels);
    if (cut >= out.size()) return {};
    return std::vector<float>(out.begin() + static_cast<std::ptrdiff_t>(cut),
                              out.end());
}

// Peak absolute difference over `frames` frames, comparing `a` from a_off and
// `b` from b_off (both frame offsets, interleaved buffers).
double peak_diff(const std::vector<float>& a, Frame a_off,
                 const std::vector<float>& b, Frame b_off,
                 Frame frames, int channels) {
    double worst = 0.0;
    for (Frame f = 0; f < frames; ++f) {
        for (int c = 0; c < channels; ++c) {
            const std::size_t ia = (static_cast<std::size_t>(a_off + f)) *
                static_cast<std::size_t>(channels) + static_cast<std::size_t>(c);
            const std::size_t ib = (static_cast<std::size_t>(b_off + f)) *
                static_cast<std::size_t>(channels) + static_cast<std::size_t>(c);
            if (ia >= a.size() || ib >= b.size()) return worst;
            worst = std::max(worst,
                std::fabs(static_cast<double>(a[ia]) - static_cast<double>(b[ib])));
        }
    }
    return worst;
}

} // namespace

TEST_CASE("streaming resampler is chunk-size invariant") {
    // Baseline property: the same audio fed in different chunk sizes must give
    // identical output. Streaming reads blocks of varying size (the last block
    // of a file is short), so this must hold before anything else can.
    constexpr int kChannels = 2;
    constexpr Frame kFrames = kSrcRate;  // 1 s
    const auto signal = make_signal(kFrames, kChannels);

    const auto a = resample_from_start(signal, kChannels, 4096);
    const auto b = resample_from_start(signal, kChannels, 1024);
    const auto c = resample_from_start(signal, kChannels, 65536);

    REQUIRE(a.size() > 0);
    const Frame common = static_cast<Frame>(
        std::min({a.size(), b.size(), c.size()}) / kChannels);
    REQUIRE(common > kDstRate / 2);

    CHECK(peak_diff(a, 0, b, 0, common, kChannels) < 1e-6);
    CHECK(peak_diff(a, 0, c, 0, common, kChannels) < 1e-6);
}

TEST_CASE("streaming resampler withholds a constant output latency") {
    // The property that makes seeking correctable at all. r8brain does not emit
    // output for its first input samples, and thereafter runs a CONSTANT number
    // of output frames behind the ratio. Constant means a seek can be corrected
    // by a fixed offset; drifting would make on-the-fly resampling unusable.
    //
    // Measured 44100 -> 48000: the deficit settles at ~1850 output frames and
    // stays there (1849.4 - 1850.2 across 32k input frames).
    constexpr int kChannels = 1;
    constexpr Frame kChunk = 4096;
    auto rs = make_streaming_resampler(kChannels, kSrcRate, kDstRate);

    std::vector<float> buf(static_cast<std::size_t>(kChunk), 0.5f);
    std::vector<float> out;
    std::vector<double> deficits;

    for (int i = 1; i <= 8; ++i) {
        rs->process_chunk(buf.data(), kChunk, false, out);
        const double in_total = static_cast<double>(kChunk) * i;
        const double expected = in_total * kDstRate / kSrcRate;
        deficits.push_back(expected - static_cast<double>(out.size() / kChannels));
    }

    const double first = deficits.front();
    const double last = deficits.back();
    INFO("deficit first=", first, " last=", last);

    // Non-zero (there IS latency) and stable (it does not accumulate).
    CHECK(first > 1000.0);
    CHECK(std::fabs(last - first) < 5.0);

    // Pin the measured value so a backend or ratio change is caught here rather
    // than as a click in the field.
    CHECK(std::fabs(first - static_cast<double>(kR8brainLatencyOut)) < 10.0);
}

TEST_CASE("a seek-started stream does NOT reproduce the from-start samples") {
    // THE KEY FINDING, and it constrains the design.
    //
    // A resampler restarted mid-file, primed with preceding audio and aligned
    // as well as an exhaustive offset scan allows, still differs from the
    // from-start stream by ~0.013 peak / ~0.0068 RMS (about -43 dBFS).
    //
    // Crucially that residual is a FLOOR, not a transient: measured in 512-frame
    // windows across 8192 output frames it stays at 0.00675 RMS and never
    // decays. More priming context does not remove it (4k/16k/32k warmup give
    // 0.040 / 0.013 / 0.026 — it does not converge).
    //
    // Consequence for the design: the same block resampled by two different
    // resampler runs is NOT the same audio. On-the-fly resampling is fine, but
    // the block cache must never serve a mix of blocks produced by different
    // runs across a seek boundary, or the seam is audible. Either a source keeps
    // ONE forward-running resampler, or blocks carry the identity of the run
    // that produced them.
    constexpr int kChannels = 1;
    constexpr Frame kFrames = kSrcRate * 3;
    constexpr Frame kSeekAt = 88200;   // 600 * 147 — an exact ratio boundary
    const auto signal = make_signal(kFrames, kChannels);

    const auto full = resample_from_start(signal, kChannels, 4096);
    const auto seeked = resample_from_seek(signal, kChannels, kSeekAt, 16384, 4096);
    const Frame seek_out = static_cast<Frame>(
        static_cast<double>(kSeekAt) * kDstRate / kSrcRate);

    // Best achievable alignment, searched exhaustively.
    double best = 1.0;
    for (long long off = -4000; off <= 4000; ++off) {
        const Frame b = static_cast<Frame>(off);
        if (b < 0) continue;
        best = std::min(best, peak_diff(full, seek_out, seeked, b, 2048, kChannels));
    }
    INFO("best achievable peak error after a seek: ", best);

    // It is small but NOT sample-exact. Both bounds matter: the upper one says
    // resampling is usable, the lower one says do not assume exactness.
    CHECK(best < 0.05);
    CHECK(best > 1e-4);
}

TEST_CASE("ratio-boundary seeks align consistently, off-boundary ones do not") {
    // 44100:48000 reduces to 147:160. A seek on a multiple of 147 input frames
    // lands exactly on an output sample; anything else lands between samples and
    // the streams cannot be aligned by an integer offset at all.
    //
    // Measured: multiples of 147 all give peak 0.0129 at a stable offset, while
    // +1 / +37 / +73 give 0.028 / 0.048 / 0.069 at erratic offsets — up to 5x
    // worse. Production code that resamples on demand should therefore anchor
    // its restart points to ratio boundaries.
    constexpr int kChannels = 1;
    constexpr Frame kFrames = kSrcRate * 3;
    constexpr Frame kRatioPeriod = 147;
    const auto signal = make_signal(kFrames, kChannels);
    const auto full = resample_from_start(signal, kChannels, 4096);

    auto best_error_for = [&](Frame seek_at) {
        const auto seeked =
            resample_from_seek(signal, kChannels, seek_at, 16384, 4096);
        const Frame seek_out = static_cast<Frame>(
            static_cast<double>(seek_at) * kDstRate / kSrcRate);
        double best = 1.0;
        for (long long off = 0; off <= 8000; ++off) {
            const Frame b = static_cast<Frame>(off);
            best = std::min(best,
                peak_diff(full, seek_out, seeked, b, 2048, kChannels));
        }
        return best;
    };

    REQUIRE(88200 % kRatioPeriod == 0);
    const double on_boundary  = best_error_for(88200);
    const double off_boundary = best_error_for(88200 + 73);
    INFO("on-boundary: ", on_boundary, "  off-boundary: ", off_boundary);

    // Landing on a ratio boundary is materially better.
    CHECK(on_boundary < off_boundary);

    // And two different boundaries behave identically — the property that makes
    // boundary anchoring worth doing.
    const double another_boundary = best_error_for(88200 + kRatioPeriod);
    CHECK(std::fabs(another_boundary - on_boundary) < 5e-3);
}

TEST_CASE("passthrough resampler is exact when rates match") {
    // The fast path must stay bit-exact: a device at the file's own rate must
    // not pay any resampling penalty or alter a single sample.
    constexpr int kChannels = 2;
    constexpr Frame kFrames = 4096;
    const auto signal = make_signal(kFrames, kChannels);

    auto rs = make_streaming_resampler(kChannels, kSrcRate, kSrcRate);
    std::vector<float> out;
    const Frame produced = rs->process_chunk(signal.data(), kFrames, true, out);

    CHECK(produced == kFrames);
    REQUIRE(out.size() == signal.size());
    for (std::size_t i = 0; i < signal.size(); ++i)
        REQUIRE(out[i] == signal[i]);
}
