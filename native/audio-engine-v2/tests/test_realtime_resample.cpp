#include <doctest/doctest.h>

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/decoded_source.h>
#include <lt_engine/sources/sinc_interpolator.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#if LT_ENGINE_USE_LIBSNDFILE
#include <sndfile.h>

using namespace lt;

// ---------------------------------------------------------------------------
// Plan realtime-resample, step 3: a file whose rate differs from the engine's
// streams in place, resampled while it is read. The DecodedSource
// keeps native frames in the block cache and answers in engine frames, so
// everything above it (clips, timeline, Bungee, prepared jumps) is unchanged.
// These tests pin that boundary: what comes out of the real cache path must be
// exactly what SincInterpolator computes from the file, wherever a read starts.
// ---------------------------------------------------------------------------

namespace {

constexpr int kFileRate = 44100;
constexpr int kEngineRate = 48000;

std::string temp_wav(const char* tag) {
#if defined(_WIN32)
    const char* tmp = std::getenv("TEMP");
    if (!tmp || !*tmp) tmp = ".";
    return std::string(tmp) + "\\lt_rt_resample_" + tag + ".wav";
#else
    const char* tmp = std::getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
    return std::string(tmp) + "/lt_rt_resample_" + tag + ".wav";
#endif
}

// Float WAV: what is read back is bit-identical to what was written, so the
// comparisons below can be exact.
bool write_float_wav(const std::string& path, const std::vector<float>& samples,
                     int channels, int rate) {
    SF_INFO info{};
    info.channels = channels;
    info.samplerate = rate;
    info.format = SF_FORMAT_WAV | SF_FORMAT_FLOAT;
    SNDFILE* sf = sf_open(path.c_str(), SFM_WRITE, &info);
    if (!sf) return false;
    const sf_count_t frames = static_cast<sf_count_t>(samples.size() / channels);
    const sf_count_t written = sf_writef_float(sf, samples.data(), frames);
    sf_close(sf);
    return written == frames;
}

std::vector<float> make_audio(Frame frames, int channels) {
    std::vector<float> s(static_cast<std::size_t>(frames) * static_cast<std::size_t>(channels));
    for (Frame f = 0; f < frames; ++f)
        for (int c = 0; c < channels; ++c)
            s[static_cast<std::size_t>(f) * channels + c] =
                0.4f * std::sin(0.0137f * f * (c + 1)) + 0.2f * std::sin(0.31f * f + c);
    return s;
}

// Engine frames [start, start + frames) as SincInterpolator computes them from
// the whole file: the reference every cached read must reproduce exactly.
std::vector<float> expected_engine_frames(const std::vector<float>& file, int channels,
                                          Frame start, int frames,
                                          int file_rate = kFileRate,
                                          int engine_rate = kEngineRate) {
    const SincInterpolator si(file_rate, engine_rate, kRealtimeResampleTaps);
    std::vector<float> out(static_cast<std::size_t>(frames) * channels);
    si.render(file.data(), 0, static_cast<Frame>(file.size() / channels), channels,
              start, frames, out.data());
    return out;
}

void wait_ready(const SourceManager& manager, const Id& id, Frame start, int frames) {
    const auto source = manager.get_shared(id);
    REQUIRE(static_cast<bool>(source));
    manager.request_range(id, start, frames, /*urgent=*/true);
    for (int spin = 0; spin < 2000 && !source->is_range_ready(start, frames); ++spin)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(source->is_range_ready(start, frames));
}

std::vector<float> read_interleaved(const DecodedSource& source, Frame start, int frames,
                                    int channels) {
    std::vector<float> left(static_cast<std::size_t>(frames));
    std::vector<float> right(static_cast<std::size_t>(frames));
    float* out[2] = {left.data(), right.data()};
    REQUIRE(source.read(start, frames, out, 2) == frames);
    std::vector<float> interleaved(static_cast<std::size_t>(frames) * channels);
    for (int f = 0; f < frames; ++f) {
        interleaved[static_cast<std::size_t>(f) * channels] = left[static_cast<std::size_t>(f)];
        if (channels == 2) interleaved[static_cast<std::size_t>(f) * 2 + 1] = right[static_cast<std::size_t>(f)];
        // A mono source plays on both sides.
        if (channels == 1) CHECK(right[static_cast<std::size_t>(f)] == left[static_cast<std::size_t>(f)]);
    }
    return interleaved;
}

bool identical(const std::vector<float>& a, const std::vector<float>& b) {
    return a.size() == b.size() &&
           std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0;
}

} // namespace

// These tests are about streaming in place, not about the disk: pin a fast
// disk, or a CI runner whose disk reports itself rotational sends every
// file to the PCM cache instead (see path_has_seek_penalty).
static bool fast_disk(const std::string&) { return false; }

TEST_CASE("realtime resample: a 44.1k file streams in place on a 48k engine") {
    const auto path = temp_wav("flag");
    REQUIRE(write_float_wav(path, make_audio(4096, 2), 2, kFileRate));
    {
        SourceManager manager;
        manager.set_seek_penalty_probe(fast_disk);
        manager.register_source("b", path);
        REQUIRE(manager.try_install_native_file("b", kEngineRate));
        const auto source = manager.get_shared("b");
        REQUIRE(static_cast<bool>(source));
        CHECK(source->is_resampled());
        CHECK(source->sample_rate() == kEngineRate);
        CHECK(source->native_sample_rate() == kFileRate);
        // 4096 * 160 / 147, rounded up.
        CHECK(source->duration_frames() == 4459);
        // Nothing written to the engine's cache: that is the point of the plan.
        CHECK(manager.diagnostics()[0].disk_cache_bytes == 0);
        // The waveform reads the file, so it reports the file's own rate.
        CHECK(manager.source_peaks("b", 256).sample_rate == kFileRate);
    }
    std::remove(path.c_str());
}

TEST_CASE("realtime resample: reads through the block cache match the interpolator exactly") {
    // 96k -> 48k reads two source frames per output frame, so a callback is
    // split into several cache reads; 48k -> 44.1k downsamples.
    struct Rates { int file, engine; };
    for (Rates rates : {Rates{kFileRate, kEngineRate}, Rates{96000, 48000}, Rates{48000, 44100}})
    for (int channels : {2, 1}) {
        // Several cache blocks, an odd length, so reads cross block edges and
        // reach the end of the file.
        const Frame file_frames = kDefaultBlockFrames * 5 + 333;
        const auto file = make_audio(file_frames, channels);
        const auto path = temp_wav(channels == 2 ? "exact_st" : "exact_mono");
        REQUIRE(write_float_wav(path, file, channels, rates.file));

        SourceManager manager;
        manager.set_seek_penalty_probe(fast_disk);
        const Id id = "src";
        manager.register_source(id, path);
        REQUIRE(manager.try_install_native_file(id, rates.engine));
        const auto source = manager.get_shared(id);
        REQUIRE(static_cast<bool>(source));
        const Frame total = source->duration_frames();

        struct Span { Frame start; int frames; };
        for (Span s : {Span{0, 512}, Span{1, 777}, Span{kDefaultBlockFrames - 40, 300},
                       Span{total / 2 + 37, 4000}, Span{total - 200, 200}}) {
            INFO("rates=", rates.file, "->", rates.engine, " channels=", channels,
                 " start=", s.start, " frames=", s.frames);
            wait_ready(manager, id, s.start, s.frames);
            CHECK(identical(read_interleaved(*source, s.start, s.frames, channels),
                            expected_engine_frames(file, channels, s.start, s.frames,
                                                   rates.file, rates.engine)));
        }
        std::remove(path.c_str());
    }
}

TEST_CASE("realtime resample: positions stay exact across the file") {
    // An impulse on every second of the file must land on exactly that second
    // at the engine rate: 44100 * k -> 48000 * k, with no drift.
    constexpr int kSeconds = 20;
    std::vector<float> file(static_cast<std::size_t>(kFileRate) * kSeconds, 0.0f);
    for (int k = 1; k < kSeconds; ++k)
        file[static_cast<std::size_t>(kFileRate) * k] = 1.0f;
    const auto path = temp_wav("impulses");
    REQUIRE(write_float_wav(path, file, 1, kFileRate));

    SourceManager manager;
    manager.set_seek_penalty_probe(fast_disk);
    manager.register_source("imp", path);
    REQUIRE(manager.try_install_native_file("imp", kEngineRate));
    const auto source = manager.get_shared("imp");
    for (int k = 1; k < kSeconds; ++k) {
        const Frame centre = static_cast<Frame>(kEngineRate) * k;
        wait_ready(manager, "imp", centre - 64, 129);
        const auto window = read_interleaved(*source, centre - 64, 129, 1);
        const auto peak = std::max_element(window.begin(), window.end());
        INFO("second ", k);
        CHECK(std::distance(window.begin(), peak) == 64);
        CHECK(*peak > 0.9f);
    }
    std::remove(path.c_str());
}

TEST_CASE("realtime resample: a jump renders the same samples as playing through") {
    // TrackRenderer (Direct path) on a 44.1k clip in a 48k engine. Playing
    // block after block and jumping straight to a block must give identical
    // output: the property r8brain could not offer.
    const Frame file_frames = kFileRate * 3;
    const auto file = make_audio(file_frames, 2);
    const auto path = temp_wav("jump");
    REQUIRE(write_float_wav(path, file, 2, kFileRate));

    SourceManager manager;
    manager.set_seek_penalty_probe(fast_disk);
    manager.register_source("song", path);
    REQUIRE(manager.try_install_native_file("song", kEngineRate));
    const Frame total = manager.get_shared("song")->duration_frames();
    wait_ready(manager, "song", 0, static_cast<int>(total));

    Track track;
    track.id = "t";
    track.clips.push_back(Clip{"c", "song", 1000, 0, total - 1000, 1.0f});

    constexpr int kBlock = 480;
    // One renderer for the play-through, as the mixer keeps one per track; a
    // fresh one for each jump.
    TrackRenderer playing;
    playing.prepare(kBlock);
    auto render = [&](TrackRenderer& renderer, Frame at) {
        std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
        float* out[2] = {l.data(), r.data()};
        renderer.render(track, at, kBlock, out, 2, manager, nullptr, kEngineRate);
        l.insert(l.end(), r.begin(), r.end());
        return l;
    };

    std::vector<std::vector<float>> through;
    for (Frame at = 0; at < kBlock * 300; at += kBlock)
        through.push_back(render(playing, at));
    for (int block : {0, 2, 3, 101, 299}) {
        INFO("block ", block);
        TrackRenderer jumped;
        jumped.prepare(kBlock);
        CHECK(identical(render(jumped, static_cast<Frame>(block) * kBlock),
                        through[static_cast<std::size_t>(block)]));
    }
    // And the first audible block is the clip start, not silence or noise.
    const auto& first = through[2];
    CHECK(std::any_of(first.begin(), first.end(), [](float v) { return std::fabs(v) > 0.01f; }));
    std::remove(path.c_str());
}

TEST_CASE("realtime resample: a warp voice seeking into a resampled source does not stall") {
    // Reported in the app: with warp on, a far click took seconds and the app
    // lagged after it. The voice manager asked for blocks by dividing ENGINE
    // frames by the block size, i.e. the wrong blocks for a source whose cache
    // holds native frames, then waited on the right ones — nobody had asked
    // for them — until its 750 ms deadline, voice after voice.
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kEngineRate, 2, 480)) return;

    constexpr int kSeconds = 30;
    const auto path = temp_wav("warp_seek");
    REQUIRE(write_float_wav(path, make_audio(static_cast<Frame>(kFileRate) * kSeconds, 2),
                            2, kFileRate));
    SourceManager sm;
    sm.set_seek_penalty_probe(fast_disk);
    sm.register_source("src1", path);
    REQUIRE(sm.try_install_native_file("src1", kEngineRate));
    const Frame length = sm.get_shared("src1")->duration_frames();

    Session session;
    session.id = "s";
    session.sample_rate = kEngineRate;
    Song song;
    song.id = "song1";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;
    // Warp AND a transpose, as in the app: a neutral warp would skip the voice.
    song.transpose_semitones = -2;
    Region region;
    region.id = "region1";
    region.start_frame = 0;
    region.end_frame = length;
    region.warp_enabled = true;
    region.warp_source_bpm = 100.0;
    song.regions.push_back(region);
    Track track;
    track.id = "trk1";
    track.kind = TrackKind::Audio;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip1", "src1", 0, 0, length});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    // 15 s in (18 s of source at this warp ratio): engine-frame blocks and
    // native-frame blocks are well apart there.
    const auto t0 = std::chrono::steady_clock::now();
    mgr.rebuild_for_seek(static_cast<Frame>(kEngineRate) * 15, session, sm);
    const double ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();
    MESSAGE("warp seek rebuild: ", ms, " ms");
#if LT_ENGINE_HAVE_BUNGEE
    CHECK(mgr.voice_for("clip1") != nullptr);
    CHECK(ms < 500.0);
#endif
    std::remove(path.c_str());
}

#endif // LT_ENGINE_USE_LIBSNDFILE
