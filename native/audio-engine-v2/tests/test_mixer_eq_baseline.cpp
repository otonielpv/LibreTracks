// Plan track-eq, paso 03 C2: una sesión SIN EQ suena bit a bit igual que antes
// del paso. El hash esperado se grabó compilando este mismo test contra el
// motor anterior al paso 03 (commit 20bebb47). Si cambia sin que nadie haya
// tocado a propósito la mezcla, el EQ se ha colado en pistas que no lo tienen.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// Grabado con el motor de 20bebb47 (antes del paso 03), en x86_64. Solo vale
// ahí: en arm64 (macOS) la senoidal de la fixture y la coma flotante dan otros
// bits, así que allí cuenta la comprobación que no depende de la arquitectura
// (EQ apagado == sin EQ, bit a bit).
#define LT_EQ_BASELINE_HASH 4629536658748450973ull

using namespace lt;

namespace {

/** FNV-1a of the rendered mix. `disabled_eq` gives every track an EQ that is
 * present but off, which must cost nothing and change no bit. */
std::uint64_t render_baseline_hash(bool disabled_eq) {
    constexpr int kSR = test::kFixtureSampleRate;
    constexpr int kBlock = 512;
    constexpr int kBlocks = 80;
    constexpr Frame kFrames = static_cast<Frame>(kBlock) * (kBlocks + 8);

    SourceManager sources;
    Session session;
    session.id = "baseline";
    session.sample_rate = kSR;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kFrames;
    Track folder;
    folder.id = "folder";
    folder.kind = TrackKind::Folder;
    folder.gain = 0.8f;
    song.tracks.push_back(folder);
    const TrackChannelMode modes[] = { TrackChannelMode::Stereo, TrackChannelMode::Mono,
                                       TrackChannelMode::Left, TrackChannelMode::Right };
    for (int i = 0; i < 4; ++i) {
        const std::string src = "src-" + std::to_string(i);
        sources.register_source(src, "");
        REQUIRE(sources.store_decoded_source(src, test::make_stereo_sine(kFrames, 110.0 * (i + 1), 0.3f),
                                             2, kSR, kFrames).is_ok());
        session.sources.push_back(Source{ src, "" });
        Track t;
        t.id = "t" + std::to_string(i);
        t.gain = 0.4f + 0.1f * static_cast<float>(i);
        t.pan = -0.6f + 0.4f * static_cast<float>(i);
        t.channel_mode = modes[i];
        t.parent_track_id = (i % 2 == 0) ? "folder" : "";
        t.clips.push_back(Clip{ "c" + std::to_string(i), src, 0, 0, kFrames });
        song.tracks.push_back(std::move(t));
    }
    if (disabled_eq) {
        for (Track& track : song.tracks) track.eq = TrackEqParams{};
    }
    session.songs.push_back(std::move(song));

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    auto shared = std::make_shared<const Session>(std::move(session));
    Mixer mixer(shared, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    mixer.set_active_output_channels({ 0, 1 });
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock), right(kBlock);
    float* out[2] = { left.data(), right.data() };
    std::uint64_t hash = 1469598103934665603ull;   // FNV-1a
    auto mix_in = [&](const std::vector<float>& v) {
        for (float sample : v) {
            std::uint32_t bits;
            std::memcpy(&bits, &sample, sizeof bits);
            for (int byte = 0; byte < 4; ++byte) {
                hash ^= (bits >> (byte * 8)) & 0xffu;
                hash *= 1099511628211ull;
            }
        }
    };
    for (int b = 0; b < kBlocks; ++b) {
        if (b == 20) mixer.set_track_mute("t1", true);
        if (b == 35) mixer.set_track_mute("t1", false);
        if (b == 50) mixer.set_track_pan("t2", 0.9f);
        if (b == 60) mixer.set_track_gain("folder", 0.3f);
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, clock.sample_rate());
        mix_in(left);
        mix_in(right);
    }
    return hash;
}

}  // namespace

TEST_CASE("mixer eq C2: a session without eq renders exactly as before the eq existed") {
    const std::uint64_t without_eq = render_baseline_hash(false);
    MESSAGE("baseline hash = " << without_eq);
    // On every platform: an EQ that is there but off is the same as none.
    CHECK(render_baseline_hash(true) == without_eq);
#if defined(__x86_64__) || defined(_M_X64)
    // Where the golden hash was recorded: bit for bit as before the EQ existed.
    CHECK(without_eq == LT_EQ_BASELINE_HASH);
#endif
}
