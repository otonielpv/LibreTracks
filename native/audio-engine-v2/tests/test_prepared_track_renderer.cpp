// The offline renderer that produces a prepared track. What matters here is
// not that it makes a file, but that the file is the RIGHT file: it covers the
// track's span and no more, it stops at the mixer's boundary, and it never
// leaves a partial render behind for playback to find.
#include <doctest/doctest.h>

#include <lt_engine/render/prepared_track_renderer.h>
#include <lt_engine/sources/source_manager.h>

#include "test_audio_fixtures.h"

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR = test::kFixtureSampleRate;
constexpr Frame kClipFrames = kSR / 2;  // Half a second is plenty to compare.

struct Wav {
    std::uint16_t format = 0;
    std::uint16_t channels = 0;
    std::uint16_t bits = 0;
    std::uint32_t sample_rate = 0;
    std::vector<char> data;
};

Wav read_wav(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    REQUIRE(in.good());
    std::vector<char> raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    REQUIRE(raw.size() >= 44);
    const auto u16 = [&raw](std::size_t at) {
        std::uint16_t value = 0;
        std::memcpy(&value, raw.data() + at, sizeof(value));
        return value;
    };
    const auto u32 = [&raw](std::size_t at) {
        std::uint32_t value = 0;
        std::memcpy(&value, raw.data() + at, sizeof(value));
        return value;
    };
    CHECK(std::string(raw.data(), 4) == "RIFF");
    CHECK(std::string(raw.data() + 8, 4) == "WAVE");
    CHECK(std::string(raw.data() + 36, 4) == "data");
    Wav wav;
    wav.format = u16(20);
    wav.channels = u16(22);
    wav.sample_rate = u32(24);
    wav.bits = u16(34);
    const auto declared = u32(40);
    CHECK(declared == raw.size() - 44);
    wav.data.assign(raw.begin() + 44, raw.end());
    return wav;
}

// A song long enough that "the whole song" and "the track's span" are very
// different sizes — which is the property the span logic exists for.
Session make_session(Frame clip_start, bool warp) {
    Session session;
    session.id = "prep";
    session.sample_rate = kSR;
    session.sources.push_back(Source{"src", ""});

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kSR * 60;
    song.bpm = 120.0;

    Region region;
    region.id = "region";
    region.start_frame = 0;
    region.end_frame = song.end_frame;
    region.warp_enabled = warp;
    region.warp_source_bpm = warp ? 100.0 : 0.0;
    song.regions.push_back(region);

    Track track;
    track.id = "trk";
    track.kind = TrackKind::Audio;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip", "src", clip_start, 0, kClipFrames});
    song.tracks.push_back(std::move(track));

    session.songs.push_back(std::move(song));
    return session;
}

void install_source(SourceManager& sources, Frame length) {
    sources.register_source("src", "");
    REQUIRE(sources
                .store_decoded_source("src", test::make_stereo_sine(length, 330.0, 0.5f), 2, kSR,
                                      length)
                .is_ok());
}

struct Scratch {
    std::filesystem::path dir;
    Scratch() {
        dir = std::filesystem::temp_directory_path() /
              ("lt-prep-" + std::to_string(reinterpret_cast<std::uintptr_t>(this)));
        std::filesystem::create_directories(dir);
    }
    ~Scratch() {
        std::error_code ignored;
        std::filesystem::remove_all(dir, ignored);
    }
    std::string file(const char* name) const { return (dir / name).string(); }
};

PreparedRenderRequest request_for(const Session& session, SourceManager& sources,
                                  const std::string& output, PreparedSampleFormat format) {
    PreparedRenderRequest request;
    request.session = &session;
    request.sources = &sources;
    request.song_id = "song";
    request.track_id = "trk";
    request.output_path = output;
    request.format = format;
    request.block_frames = 1024;
    return request;
}

} // namespace

TEST_CASE("a prepared render covers the track span and not the song") {
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);
    // The clip sits ten seconds into a sixty-second song.
    const Session session = make_session(kSR * 10, /*warp=*/false);
    const auto output = scratch.file("span.wav");

    const auto result =
        render_prepared_track(request_for(session, sources, output, PreparedSampleFormat::Pcm16),
                              nullptr, nullptr);
    REQUIRE(result.ok);
    CHECK(result.error.empty());
    CHECK(result.frames == kClipFrames);
    CHECK(result.timeline_start_frame == kSR * 10);

    const auto wav = read_wav(output);
    CHECK(wav.format == 1);
    CHECK(wav.channels == 2);
    CHECK(wav.bits == 16);
    CHECK(wav.sample_rate == static_cast<std::uint32_t>(kSR));
    CHECK(wav.data.size() == static_cast<std::size_t>(kClipFrames) * 4);
    CHECK(result.output_bytes == wav.data.size() + 44);

    // Half a second of a sine is not silence; a file of zeros would mean the
    // renderer wrote the span but read nothing into it.
    bool any_audio = false;
    for (char byte : wav.data)
        if (byte != 0) {
            any_audio = true;
            break;
        }
    CHECK(any_audio);
}

TEST_CASE("float32 costs exactly twice PCM16 for the same span") {
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);
    const Session session = make_session(0, /*warp=*/false);

    const auto small = scratch.file("a.wav");
    const auto large = scratch.file("b.wav");
    const auto pcm =
        render_prepared_track(request_for(session, sources, small, PreparedSampleFormat::Pcm16),
                              nullptr, nullptr);
    const auto flt =
        render_prepared_track(request_for(session, sources, large, PreparedSampleFormat::Float32),
                              nullptr, nullptr);
    REQUIRE(pcm.ok);
    REQUIRE(flt.ok);
    CHECK(pcm.frames == flt.frames);
    CHECK(flt.output_bytes - 44 == (pcm.output_bytes - 44) * 2);
    CHECK(read_wav(large).format == 3);
    CHECK(read_wav(large).bits == 32);
}

TEST_CASE("the mixer's controls are not baked into the file") {
    // This is the boundary the whole feature rests on. Track gain, pan and mute
    // are applied by the Mixer AFTER the prepared file is read, so a render
    // taken with the fader down must be byte-identical to one taken with it up.
    // If this ever fails, prepared playback has dead faders.
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);

    Session loud = make_session(0, /*warp=*/false);
    Session quiet = loud;
    quiet.songs[0].tracks[0].gain = 0.25f;
    quiet.songs[0].tracks[0].pan = -1.0f;
    quiet.songs[0].tracks[0].mute = true;

    const auto a = scratch.file("loud.wav");
    const auto b = scratch.file("quiet.wav");
    REQUIRE(render_prepared_track(request_for(loud, sources, a, PreparedSampleFormat::Pcm16),
                                  nullptr, nullptr)
                .ok);
    REQUIRE(render_prepared_track(request_for(quiet, sources, b, PreparedSampleFormat::Pcm16),
                                  nullptr, nullptr)
                .ok);
    CHECK(read_wav(a).data == read_wav(b).data);
}

TEST_CASE("clip gain IS baked, because the renderer applies it") {
    // The other side of the same boundary: clip gain is an edit, not a live
    // control, so it belongs in the file — and therefore in the cache key.
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);

    Session unity = make_session(0, /*warp=*/false);
    Session halved = unity;
    halved.songs[0].tracks[0].clips[0].gain = 0.5f;

    const auto a = scratch.file("unity.wav");
    const auto b = scratch.file("halved.wav");
    REQUIRE(render_prepared_track(request_for(unity, sources, a, PreparedSampleFormat::Pcm16),
                                  nullptr, nullptr)
                .ok);
    REQUIRE(render_prepared_track(request_for(halved, sources, b, PreparedSampleFormat::Pcm16),
                                  nullptr, nullptr)
                .ok);
    CHECK(read_wav(a).data != read_wav(b).data);
}

TEST_CASE("a cancelled render leaves nothing behind") {
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);
    const Session session = make_session(0, /*warp=*/false);
    const auto output = scratch.file("cancelled.wav");

    int calls = 0;
    const auto result = render_prepared_track(
        request_for(session, sources, output, PreparedSampleFormat::Pcm16),
        [](void* ctx, Frame, Frame) {
            // Let one step through, then pull the plug.
            return ++*static_cast<int*>(ctx) < 2;
        },
        &calls);

    CHECK_FALSE(result.ok);
    CHECK(result.cancelled);
    CHECK(calls == 2);
    CHECK_FALSE(std::filesystem::exists(output));
}

TEST_CASE("progress reaches the end exactly once for a completed render") {
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);
    const Session session = make_session(0, /*warp=*/false);

    struct Seen {
        Frame last = 0;
        Frame total = 0;
        int calls = 0;
        bool monotonic = true;
    } seen;
    const auto result = render_prepared_track(
        request_for(session, sources, scratch.file("progress.wav"), PreparedSampleFormat::Pcm16),
        [](void* ctx, Frame rendered, Frame total) {
            auto& seen = *static_cast<Seen*>(ctx);
            if (rendered <= seen.last) seen.monotonic = false;
            seen.last = rendered;
            seen.total = total;
            ++seen.calls;
            return true;
        },
        &seen);

    REQUIRE(result.ok);
    CHECK(seen.monotonic);
    CHECK(seen.total == kClipFrames);
    CHECK(seen.last == kClipFrames);
    CHECK(seen.calls > 1);
}

TEST_CASE("a request that cannot be rendered fails without writing a file") {
    Scratch scratch;
    SourceManager sources;
    install_source(sources, kSR * 4);
    const Session session = make_session(0, /*warp=*/false);

    struct Case {
        const char* name;
        const char* song;
        const char* track;
    };
    const Case cases[] = {
        {"missing.wav", "nope", "trk"},
        {"missing2.wav", "song", "nope"},
    };
    for (const auto& item : cases) {
        const auto output = scratch.file(item.name);
        auto request = request_for(session, sources, output, PreparedSampleFormat::Pcm16);
        request.song_id = item.song;
        request.track_id = item.track;
        const auto result = render_prepared_track(request, nullptr, nullptr);
        CHECK_FALSE(result.ok);
        CHECK_FALSE(result.error.empty());
        CHECK_FALSE(std::filesystem::exists(output));
    }

    // A track with no clips has nothing to prepare, and saying so is better
    // than writing an empty file that playback would happily read as silence.
    Session empty = session;
    empty.songs[0].tracks[0].clips.clear();
    const auto output = scratch.file("empty.wav");
    const auto result = render_prepared_track(
        request_for(empty, sources, output, PreparedSampleFormat::Pcm16), nullptr, nullptr);
    CHECK_FALSE(result.ok);
    CHECK_FALSE(std::filesystem::exists(output));
}

TEST_CASE("the JSON handed to the host has the shape the host parses") {
    // The Rust wrapper parses these exact keys. Pinning the shape on both sides
    // is what stops a rename here from turning into a silent "la preparacion
    // fallo sin explicar por que" over there.
    PreparedRenderResult ok;
    ok.ok = true;
    ok.timeline_start_frame = 480000;
    ok.frames = 96000;
    ok.output_bytes = 384044;
    ok.clipped_samples = 7;
    CHECK(prepared_render_result_to_json(ok) ==
          "{\"ok\":true,\"timelineStartFrames\":480000,\"frames\":96000,"
          "\"outputBytes\":384044,\"clippedSamples\":7}");

    PreparedRenderResult cancelled;
    cancelled.cancelled = true;
    cancelled.error = "cancelled";
    CHECK(prepared_render_result_to_json(cancelled) ==
          "{\"ok\":false,\"cancelled\":true,\"error\":\"cancelled\"}");

    // An error carrying a Windows path is the normal case, and a raw backslash
    // or quote would make the reply unparseable exactly when it matters most.
    PreparedRenderResult failed;
    // The runtime text is:  cannot create C:\songs\my "set".wav
    failed.error = "cannot create C:\\songs\\my \"set\".wav";
    const auto json = prepared_render_result_to_json(failed);
    // ...which must reach the host with its backslashes doubled and its quotes
    // escaped, or the reply is unparseable exactly when it matters most.
    CHECK(json ==
          "{\"ok\":false,\"cancelled\":false,\"error\":\"cannot create "
          "C:\\\\songs\\\\my \\\"set\\\".wav\"}");
    // A control character has to survive too, as \u00XX rather than raw.
    PreparedRenderResult control;
    control.error = std::string("line") + '\n' + "next";
    CHECK(prepared_render_result_to_json(control) ==
          "{\"ok\":false,\"cancelled\":false,\"error\":\"line\\nnext\"}");
}
