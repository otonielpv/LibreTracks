// warp_cascade_isolated_tests.cpp
//
// Smoke-test the Cascade DSP path (Bungee pitch → RubberBand warp) in
// isolation, outside the engine. Reads a real WAV, runs it through the
// same per-block dance as TrackRenderer::render_path_cascade, and writes
// the result to bench-out/warp/cascade_isolated_*.wav so the user can
// listen.
//
// What this confirms:
//   - If the WAV sounds clean here, the cascade DSP is correct and any
//     bug is in how the engine schedules / shares state.
//   - If the WAV sounds broken here, the bug is in the cascade itself
//     (cursor math, feed sizes, RubberBand reuse, etc).

#define _USE_MATH_DEFINES
#include <cmath>

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/pitch/rubberband_warp_voice.h>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <vector>

#if LT_ENGINE_HAVE_BUNGEE && LT_ENGINE_HAVE_RUBBERBAND
#  include <sndfile.h>
#endif

using namespace lt;

namespace {

#if LT_ENGINE_HAVE_BUNGEE && LT_ENGINE_HAVE_RUBBERBAND

std::filesystem::path find_acustica_sample() {
    for (auto path : {
             std::filesystem::path("samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("Samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / "samples" / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / ".." / "samples" / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / ".." / ".." / "samples" / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / ".." / ".." / ".." / "samples" / "ACUSTICA 1_01.wav"}) {
        if (std::filesystem::exists(path))
            return std::filesystem::absolute(path);
    }
    return {};
}

int load_wav_planar(const std::filesystem::path& path,
                     int max_frames,
                     std::vector<float>& l,
                     std::vector<float>& r,
                     int& sample_rate) {
    SF_INFO info{};
    SNDFILE* sf = sf_open(path.string().c_str(), SFM_READ, &info);
    if (!sf) return 0;
    if (info.channels < 1 || info.channels > 8) { sf_close(sf); return 0; }
    sample_rate = info.samplerate;
    std::vector<float> inter(
        static_cast<size_t>(max_frames) * info.channels, 0.f);
    const sf_count_t got = sf_readf_float(sf, inter.data(), max_frames);
    sf_close(sf);
    if (got <= 0) return 0;
    l.assign(static_cast<size_t>(got), 0.f);
    r.assign(static_cast<size_t>(got), 0.f);
    for (sf_count_t f = 0; f < got; ++f) {
        const float a = inter[static_cast<size_t>(f * info.channels)];
        const float b = info.channels > 1
            ? inter[static_cast<size_t>(f * info.channels + 1)] : a;
        l[static_cast<size_t>(f)] = a;
        r[static_cast<size_t>(f)] = b;
    }
    return static_cast<int>(got);
}

bool write_wav_planar(const std::filesystem::path& path,
                       const std::vector<float>& l,
                       const std::vector<float>& r,
                       int sample_rate) {
    std::filesystem::create_directories(path.parent_path());
    SF_INFO info{};
    info.samplerate = sample_rate;
    info.channels = 2;
    info.format = SF_FORMAT_WAV | SF_FORMAT_PCM_16;
    SNDFILE* sf = sf_open(path.string().c_str(), SFM_WRITE, &info);
    if (!sf) return false;
    const size_t frames = std::min(l.size(), r.size());
    std::vector<float> inter(frames * 2, 0.f);
    for (size_t f = 0; f < frames; ++f) {
        inter[f * 2 + 0] = l[f];
        inter[f * 2 + 1] = r[f];
    }
    sf_writef_float(sf, inter.data(), static_cast<sf_count_t>(frames));
    sf_close(sf);
    return true;
}

// Simulate exactly what TrackRenderer::render_path_cascade does: pull from
// the source file, feed Bungee at speed=1 with pitch_scale, pipe its output
// through RubberBand at time_ratio. Returns the warped+pitched audio.
struct CascadeOutput {
    std::vector<float> l;
    std::vector<float> r;
};

CascadeOutput run_cascade(const std::vector<float>& src_l,
                           const std::vector<float>& src_r,
                           int sample_rate,
                           int block_frames,
                           double pitch_scale,
                           double time_ratio) {
    constexpr int kMaxIn = 2048;
    BungeePitchVoice bv;
    RubberBandWarpVoice wv;
    REQUIRE(bv.configure(sample_rate, /*ch*/ 2, kMaxIn));
    REQUIRE(wv.configure(sample_rate, /*ch*/ 2, kMaxIn));
    // Warm Bungee with one process(zeros) so latency() and the internal
    // OutputChunk pointers are valid. The engine does this in
    // BungeeVoiceManager::warm_voice; without it the first latency() call
    // dereferences a null OutputChunk.request and segfaults.
    {
        std::vector<float> warm_in(static_cast<size_t>(kMaxIn), 0.f);
        std::vector<float> warm_out(static_cast<size_t>(kMaxIn), 0.f);
        const float* in_p[2] = { warm_in.data(), warm_in.data() };
        float*       out_p[2] = { warm_out.data(), warm_out.data() };
        bv.render_block(in_p, kMaxIn, out_p, kMaxIn, /*pitch*/ 1.0, /*ratio*/ 1.0);
    }

    const int rb_input_needed = static_cast<int>(
        std::ceil(static_cast<double>(block_frames) * time_ratio));

    // Mirror the renderer's source-frame model: cursor advances by
    // rb_input_needed each block (== bungee_feed). Initial cursor = 0.
    long long source_cursor = 0;
    wv.reset_source_cursor(source_cursor);

    const int total_src = static_cast<int>(std::min(src_l.size(), src_r.size()));

    std::vector<float> bungee_in_l(kMaxIn, 0.f);
    std::vector<float> bungee_in_r(kMaxIn, 0.f);
    std::vector<float> mid_l(kMaxIn, 0.f);
    std::vector<float> mid_r(kMaxIn, 0.f);
    std::vector<float> out_l_block(static_cast<size_t>(block_frames), 0.f);
    std::vector<float> out_r_block(static_cast<size_t>(block_frames), 0.f);

    CascadeOutput out;
    out.l.reserve(static_cast<size_t>(total_src) * 2);
    out.r.reserve(static_cast<size_t>(total_src) * 2);

    int blocks = 0;
    std::fprintf(stderr, "[cascade-test] starting loop total_src=%d rb_input_needed=%d\n",
                 total_src, rb_input_needed);
    std::fflush(stderr);
    while (true) {
        const long long cursor = wv.source_cursor();
        const long long latency = static_cast<long long>(bv.latency_frames());
        const int compensation = bv.alignment_compensation_frames(pitch_scale);
        const int bungee_queued = bv.queued_output_frames();
        const long long read_from = cursor + latency + compensation + bungee_queued;

        const int feed = bungee_queued >= rb_input_needed
            ? 0 : rb_input_needed;

        if (read_from >= total_src) break;

        // Fill bungee_in with source audio (zero-pad if before-start or past-end).
        std::fill(bungee_in_l.begin(), bungee_in_l.begin() + feed, 0.f);
        std::fill(bungee_in_r.begin(), bungee_in_r.begin() + feed, 0.f);
        if (feed > 0) {
            const int dst_offset = read_from < 0
                ? static_cast<int>(std::min<long long>(feed, -read_from))
                : 0;
            const long long start = std::max<long long>(0, read_from);
            const int max_from_src = static_cast<int>(std::max<long long>(0,
                static_cast<long long>(total_src) - start));
            const int avail = std::min(feed - dst_offset, max_from_src);
            if (avail > 0 && dst_offset >= 0 && dst_offset < feed) {
                for (int i = 0; i < avail; ++i) {
                    const size_t src_i = static_cast<size_t>(start + i);
                    if (src_i >= src_l.size()) break;
                    bungee_in_l[static_cast<size_t>(dst_offset + i)] = src_l[src_i];
                    bungee_in_r[static_cast<size_t>(dst_offset + i)] = src_r[src_i];
                }
            }
        }

        // Bungee pitch (speed=1).
        if (blocks < 5) {
            std::fprintf(stderr, "[cascade-test] blk=%d cursor=%lld read_from=%lld feed=%d rb_in=%d\n",
                         blocks, cursor, read_from, feed, rb_input_needed);
            std::fflush(stderr);
        }
        float* mid_ptrs[2] = { mid_l.data(), mid_r.data() };
        const float* bungee_in_ptrs[2] = { bungee_in_l.data(), bungee_in_r.data() };
        const int pitched = bv.render_block(
            bungee_in_ptrs, feed,
            mid_ptrs, rb_input_needed,
            pitch_scale, /*time_ratio*/ 1.0);
        if (blocks < 5) {
            std::fprintf(stderr, "[cascade-test] blk=%d pitched=%d\n", blocks, pitched);
            std::fflush(stderr);
        }
        if (pitched < rb_input_needed) {
            std::fill(mid_l.begin() + std::max(0, pitched),
                      mid_l.begin() + rb_input_needed, 0.f);
            std::fill(mid_r.begin() + std::max(0, pitched),
                      mid_r.begin() + rb_input_needed, 0.f);
        }

        // RubberBand warp.
        float* out_ptrs[2] = { out_l_block.data(), out_r_block.data() };
        const float* rb_in_ptrs[2] = { mid_l.data(), mid_r.data() };
        const int produced = wv.render_block(
            rb_in_ptrs, rb_input_needed,
            out_ptrs, block_frames,
            time_ratio);
        if (blocks < 5) {
            std::fprintf(stderr, "[cascade-test] blk=%d produced=%d new_cursor=%lld\n",
                         blocks, produced, wv.source_cursor());
            std::fflush(stderr);
        }

        for (int i = 0; i < block_frames; ++i) {
            out.l.push_back(out_l_block[static_cast<size_t>(i)]);
            out.r.push_back(out_r_block[static_cast<size_t>(i)]);
        }
        (void)produced;
        ++blocks;
        if (blocks > 1000) break;  // safety cap (~10s @ 48kHz / 480 block)
    }
    return out;
}

#endif // backends

} // namespace

#if LT_ENGINE_HAVE_BUNGEE && LT_ENGINE_HAVE_RUBBERBAND

TEST_CASE("Warp[cascade]: real WAV through Bungee→RubberBand cascade") {
    const auto sample = find_acustica_sample();
    if (sample.empty()) {
        MESSAGE("samples/ACUSTICA 1_01.wav not found — skipping cascade test");
        return;
    }

    constexpr int kMaxLoad = 44100 * 8;   // 8 seconds
    constexpr int kBlock   = 480;
    constexpr double kPitchScale = 0.8908987181403393; // -2 semitones
    constexpr double kRatio = 1.213333;                // ≈ 91/75

    std::vector<float> src_l, src_r;
    int src_sr = 0;
    const int loaded = load_wav_planar(sample, kMaxLoad, src_l, src_r, src_sr);
    REQUIRE(loaded > 0);
    REQUIRE(src_sr > 0);

    MESSAGE("loaded " << loaded << " frames at " << src_sr << " Hz");
    const auto out = run_cascade(src_l, src_r, src_sr, kBlock, kPitchScale, kRatio);
    MESSAGE("cascade produced " << out.l.size() << " / " << out.r.size() << " frames");
    REQUIRE(!out.l.empty());
    REQUIRE(!out.r.empty());

    // Sanity: output stays bounded, no NaNs / Infs.
    float worst_amp = 0.f;
    int worst_idx = -1;
    for (size_t i = 0; i < out.l.size(); ++i) {
        if (!std::isfinite(out.l[i]) || !std::isfinite(out.r[i])) {
            MESSAGE("non-finite at idx " << i << " L=" << out.l[i] << " R=" << out.r[i]);
            FAIL("non-finite output");
            break;
        }
        const float amp = std::max(std::abs(out.l[i]), std::abs(out.r[i]));
        if (amp > worst_amp) { worst_amp = amp; worst_idx = static_cast<int>(i); }
    }
    MESSAGE("worst_amp=" << worst_amp << " at idx=" << worst_idx);
    CHECK(worst_amp < 2.0f);

    // Write to bench-out so the user can ear-test.
    const std::filesystem::path out_dir =
        std::filesystem::absolute("bench-out/warp");
    const std::filesystem::path out_path =
        out_dir / "cascade_isolated_pitch-2st_ratio1.21.wav";
    const bool ok = write_wav_planar(out_path, out.l, out.r, src_sr);
    CHECK(ok);

    MESSAGE("Cascade output written to " << out_path.string()
            << " (open in your DAW to compare with the engine's cascade output)");
}

TEST_CASE("Warp[cascade]: identity ratio 1.0 matches plain pitch shift") {
    // When ratio=1.0 the cascade should sound identical to plain Bungee
    // pitch shift. If THIS test reports broken audio, the cascade's
    // RubberBand stage is corrupting an otherwise unchanged signal.
    const auto sample = find_acustica_sample();
    if (sample.empty()) {
        MESSAGE("sample not found, skipping");
        return;
    }
    constexpr int kMaxLoad = 44100 * 4;
    constexpr int kBlock   = 480;
    constexpr double kPitchScale = 0.8908987181403393; // -2 st
    constexpr double kRatio = 1.0;

    std::vector<float> src_l, src_r;
    int sr = 0;
    REQUIRE(load_wav_planar(sample, kMaxLoad, src_l, src_r, sr) > 0);

    const auto out = run_cascade(src_l, src_r, sr, kBlock, kPitchScale, kRatio);
    REQUIRE(!out.l.empty());

    const std::filesystem::path out_path =
        std::filesystem::absolute("bench-out/warp/cascade_isolated_ratio1.0.wav");
    write_wav_planar(out_path, out.l, out.r, sr);
    MESSAGE("Cascade identity-ratio output → " << out_path.string());
}

// Replica of run_cascade that walks a list of ratios: starts at ratios[0],
// after `kRatioChangeBlocks` blocks switches to ratios[1], and so on.
// Mirrors the user's edit pattern (toggle warp at 1.0 then drag BPM down).
TEST_CASE("Warp[cascade]: ratio changes mid-stream (engine A/B pattern)") {
    const auto sample = find_acustica_sample();
    if (sample.empty()) {
        MESSAGE("sample not found, skipping");
        return;
    }
    constexpr int kMaxLoad = 44100 * 8;
    constexpr int kBlock = 480;
    constexpr double kPitchScale = 0.8908987181403393;
    constexpr int kRatioChangeBlocks = 50;  // ~580ms between ratio bumps
    const std::vector<double> ratios = {
        1.0, 1.011, 1.034, 1.058, 1.083, 1.110, 1.137, 1.164, 1.192, 1.213
    };

    std::vector<float> src_l, src_r;
    int sr = 0;
    REQUIRE(load_wav_planar(sample, kMaxLoad, src_l, src_r, sr) > 0);

    constexpr int kMaxIn = 2048;
    BungeePitchVoice bv;
    RubberBandWarpVoice wv;
    REQUIRE(bv.configure(sr, 2, kMaxIn));
    REQUIRE(wv.configure(sr, 2, kMaxIn));
    {
        std::vector<float> z(static_cast<size_t>(kMaxIn), 0.f);
        const float* in_p[2] = { z.data(), z.data() };
        float* out_p[2] = { z.data(), z.data() };
        bv.render_block(in_p, kMaxIn, out_p, kMaxIn, 1.0, 1.0);
    }
    wv.reset_source_cursor(0);

    const int total_src = static_cast<int>(std::min(src_l.size(), src_r.size()));
    std::vector<float> bungee_in_l(kMaxIn, 0.f);
    std::vector<float> bungee_in_r(kMaxIn, 0.f);
    std::vector<float> mid_l(kMaxIn, 0.f);
    std::vector<float> mid_r(kMaxIn, 0.f);
    std::vector<float> out_l_block(kBlock, 0.f);
    std::vector<float> out_r_block(kBlock, 0.f);
    std::vector<float> out_l, out_r;
    out_l.reserve(total_src * 2);
    out_r.reserve(total_src * 2);

    int blocks = 0;
    while (true) {
        const size_t ratio_idx = std::min(
            ratios.size() - 1,
            static_cast<size_t>(blocks / kRatioChangeBlocks));
        const double time_ratio = ratios[ratio_idx];
        const int rb_input_needed = static_cast<int>(
            std::ceil(static_cast<double>(kBlock) * time_ratio));

        const long long cursor = wv.source_cursor();
        const long long latency = static_cast<long long>(bv.latency_frames());
        const int compensation = bv.alignment_compensation_frames(kPitchScale);
        const int bungee_queued = bv.queued_output_frames();
        const long long read_from = cursor + latency + compensation + bungee_queued;
        const int feed = bungee_queued >= rb_input_needed ? 0 : rb_input_needed;

        if (read_from >= total_src) break;

        std::fill(bungee_in_l.begin(), bungee_in_l.begin() + feed, 0.f);
        std::fill(bungee_in_r.begin(), bungee_in_r.begin() + feed, 0.f);
        if (feed > 0) {
            const int dst_offset = read_from < 0
                ? static_cast<int>(std::min<long long>(feed, -read_from)) : 0;
            const long long start = std::max<long long>(0, read_from);
            const int max_from_src = static_cast<int>(std::max<long long>(0,
                static_cast<long long>(total_src) - start));
            const int avail = std::min(feed - dst_offset, max_from_src);
            for (int i = 0; i < avail; ++i) {
                const size_t src_i = static_cast<size_t>(start + i);
                if (src_i >= src_l.size()) break;
                bungee_in_l[static_cast<size_t>(dst_offset + i)] = src_l[src_i];
                bungee_in_r[static_cast<size_t>(dst_offset + i)] = src_r[src_i];
            }
        }

        float* mid_ptrs[2] = { mid_l.data(), mid_r.data() };
        const float* bungee_in_ptrs[2] = { bungee_in_l.data(), bungee_in_r.data() };
        bv.render_block(bungee_in_ptrs, feed, mid_ptrs, rb_input_needed, kPitchScale, 1.0);

        float* out_ptrs[2] = { out_l_block.data(), out_r_block.data() };
        const float* rb_in_ptrs[2] = { mid_l.data(), mid_r.data() };
        wv.render_block(rb_in_ptrs, rb_input_needed, out_ptrs, kBlock, time_ratio);

        for (int i = 0; i < kBlock; ++i) {
            out_l.push_back(out_l_block[static_cast<size_t>(i)]);
            out_r.push_back(out_r_block[static_cast<size_t>(i)]);
        }
        ++blocks;
        if (blocks > 1500) break;
    }

    const std::filesystem::path out_path =
        std::filesystem::absolute("bench-out/warp/cascade_isolated_ratio_drag.wav");
    write_wav_planar(out_path, out_l, out_r, sr);
    MESSAGE("Cascade ratio-drag output → " << out_path.string()
            << " (this is what the engine should sound like when the user "
               "drags the BPM stepper from 91 down to 75)");
}

#endif // backends
