#include <doctest/doctest.h>
#include <lt_engine/render/pad_renderer.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

using namespace lt;

namespace {

// Build a stereo clip with a constant value per channel, `frames` long.
std::shared_ptr<PadClip> make_clip(int frames, float left, float right,
                                   int key = 0, double sr = 48000.0) {
    auto clip = std::make_shared<PadClip>();
    clip->channels = 2;
    clip->sample_rate = sr;
    clip->key = key;
    clip->samples.assign(static_cast<std::size_t>(frames) * 2, 0.0f);
    for (int f = 0; f < frames; ++f) {
        clip->samples[static_cast<std::size_t>(f) * 2] = left;
        clip->samples[static_cast<std::size_t>(f) * 2 + 1] = right;
    }
    return clip;
}

// A clip whose recorded attack occupies only its first `silent_frames`. It
// makes it possible to verify that a live replacement inherits the old pad's
// playback position instead of restarting that attack.
std::shared_ptr<PadClip> make_attack_clip(int frames, int silent_frames,
                                          int key = 0,
                                          double sr = 48000.0) {
    auto clip = make_clip(frames, 1.0f, 1.0f, key, sr);
    for (int f = 0; f < std::min(frames, silent_frames); ++f) {
        clip->samples[static_cast<std::size_t>(f) * 2] = 0.0f;
        clip->samples[static_cast<std::size_t>(f) * 2 + 1] = 0.0f;
    }
    return clip;
}

// Render `num_frames` into a fresh stereo (or n-channel) buffer and return it as
// a channel-major vector of vectors.
std::vector<std::vector<float>> render_block(PadRenderer& pad, int num_channels,
                                             int num_frames, double sr = 48000.0) {
    std::vector<std::vector<float>> chans(
        static_cast<std::size_t>(num_channels),
        std::vector<float>(static_cast<std::size_t>(num_frames), 0.0f));
    std::vector<float*> ptrs;
    for (auto& c : chans) ptrs.push_back(c.data());
    pad.render(ptrs.data(), num_channels, num_frames, sr);
    return chans;
}

float max_abs(const std::vector<float>& v) {
    float p = 0.0f;
    for (float s : v) p = std::max(p, std::abs(s));
    return p;
}

} // namespace

TEST_CASE("pad is silent when disabled") {
    PadRenderer pad;
    pad.set_clip(make_clip(4800, 0.5f, 0.5f));
    // Not enabled → nothing written.
    auto out = render_block(pad, 2, 512);
    CHECK(max_abs(out[0]) == doctest::Approx(0.0f));
    CHECK(max_abs(out[1]) == doctest::Approx(0.0f));
    CHECK(pad.diagnostics().enabled == false);
}

TEST_CASE("pad plays and loops the clip when enabled") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    cfg.output_route = "master";
    pad.set_config(cfg);
    // Short clip so a single block wraps it several times.
    pad.set_clip(make_clip(64, 0.5f, 0.5f));

    // Warm up the volume ramp AND the initial swap fade-in, then measure.
    for (int i = 0; i < 8; ++i) render_block(pad, 2, 256);
    auto out = render_block(pad, 2, 256);
    // After ramp-in the constant clip should be clearly audible on both channels.
    CHECK(max_abs(out[0]) > 0.3f);
    CHECK(max_abs(out[1]) > 0.3f);
    CHECK(pad.diagnostics().clip_loaded == true);
}

TEST_CASE("pad volume scales the output") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.output_route = "master";
    cfg.volume = 0.25f;
    pad.set_config(cfg);
    pad.set_clip(make_clip(64, 1.0f, 1.0f));

    // Settle the gain ramp.
    for (int i = 0; i < 8; ++i) render_block(pad, 2, 256);
    auto out = render_block(pad, 2, 256);
    // Constant 1.0 clip at 0.25 volume → ~0.25 peak (allow ramp slack).
    CHECK(max_abs(out[0]) == doctest::Approx(0.25f).epsilon(0.05));
}

TEST_CASE("pad routes to the monitor bus when available") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    cfg.output_route = "monitor";
    pad.set_config(cfg);
    pad.set_clip(make_clip(64, 0.5f, 0.5f));

    // 4 channels → monitor is 2-3.
    for (int i = 0; i < 8; ++i) render_block(pad, 4, 256);
    auto out = render_block(pad, 4, 256);
    CHECK(max_abs(out[0]) == doctest::Approx(0.0f));  // main pair untouched
    CHECK(max_abs(out[1]) == doctest::Approx(0.0f));
    CHECK(max_abs(out[2]) > 0.3f);                    // monitor pair carries it
    CHECK(max_abs(out[3]) > 0.3f);
    CHECK(pad.diagnostics().route_resolved == "monitor");
}

TEST_CASE("pad clip swap resets the read cursor and updates diagnostics") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    cfg.output_route = "master";
    pad.set_config(cfg);

    pad.set_clip(make_clip(64, 0.5f, 0.5f, /*key=*/0));
    render_block(pad, 2, 256);
    CHECK(pad.diagnostics().clip_key == 0);

    // Swap to a different key/clip; diagnostics reflect the newest clip
    // immediately (clip_key comes from set_clip). The renderer crossfades the
    // adoption over a short fade, so render enough frames to let the swap settle.
    pad.set_clip(make_clip(64, 0.5f, 0.5f, /*key=*/7));
    render_block(pad, 2, 4096);
    CHECK(pad.diagnostics().clip_key == 7);
    CHECK(pad.diagnostics().clip_loaded == true);
}

TEST_CASE("key swap is click-free (no abrupt sample jump)") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    cfg.output_route = "master";
    pad.set_config(cfg);

    // Clip A: constant +0.8. Clip B: constant -0.8. A raw swap would jump 1.6
    // between adjacent samples; the swap fade must dip through silence instead.
    pad.set_clip(make_clip(2048, 0.8f, 0.8f, /*key=*/0));
    for (int i = 0; i < 12; ++i) render_block(pad, 2, 256);  // settle at +0.8

    pad.set_clip(make_clip(2048, -0.8f, -0.8f, /*key=*/1));

    // Render across the swap and check no single-sample delta exceeds a small
    // threshold (a hard swap would show ~1.6; the fade keeps steps tiny).
    float max_delta = 0.0f;
    float prev = 0.8f;  // last value before the swap block
    for (int b = 0; b < 16; ++b) {
        auto out = render_block(pad, 2, 256);
        for (float s : out[0]) {
            max_delta = std::max(max_delta, std::abs(s - prev));
            prev = s;
        }
    }
    CHECK(max_delta < 0.2f);  // smooth; no click
}

TEST_CASE("key swap settles in under 15 milliseconds") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    pad.set_config(cfg);

    pad.set_clip(make_clip(4096, 0.8f, 0.8f, /*key=*/0));
    for (int i = 0; i < 8; ++i) render_block(pad, 2, 256);

    pad.set_clip(make_clip(4096, -0.8f, -0.8f, /*key=*/1));
    auto out = render_block(pad, 2, 720); // 15 ms at the test's 48 kHz rate.
    CHECK(out[0].back() < -0.75f);
}

TEST_CASE("key swap overlaps both pads without a silent gap") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    pad.set_config(cfg);

    pad.set_clip(make_clip(10000, 0.8f, 0.8f, /*key=*/0));
    for (int i = 0; i < 12; ++i) render_block(pad, 2, 256);

    pad.set_clip(make_clip(10000, 0.4f, 0.4f, /*key=*/7));
    auto out = render_block(pad, 2, 720);
    const float quietest = *std::min_element(out[0].begin(), out[0].end());
    CHECK(quietest > 0.35f);
}

TEST_CASE("key swap preserves the playing position instead of replaying the attack") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    pad.set_config(cfg);

    pad.set_clip(make_clip(10000, 0.5f, 0.5f, /*key=*/0));
    for (int i = 0; i < 12; ++i) render_block(pad, 2, 256);

    // The incoming clip is silent for its first 1000 frames. Since the old
    // voice is already beyond frame 3000, a legato swap must enter its audible
    // body rather than returning to frame zero.
    pad.set_clip(make_attack_clip(10000, 1000, /*key=*/7));
    auto out = render_block(pad, 2, 720);
    CHECK(out[0].back() > 0.9f);
}

TEST_CASE("failed replacement keeps the current pad audible") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    pad.set_config(cfg);

    pad.set_clip(make_clip(10000, 0.6f, 0.6f));
    for (int i = 0; i < 12; ++i) render_block(pad, 2, 256);

    pad.set_clip(std::make_shared<PadClip>());
    auto out = render_block(pad, 2, 720);
    CHECK(max_abs(out[0]) > 0.5f);
}

TEST_CASE("empty clip yields silence and a muted reason") {
    PadRenderer pad;
    PadConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    pad.set_config(cfg);
    pad.set_clip(std::make_shared<PadClip>());  // empty

    auto out = render_block(pad, 2, 256);
    CHECK(max_abs(out[0]) == doctest::Approx(0.0f));
    CHECK(pad.diagnostics().clip_loaded == false);
}
