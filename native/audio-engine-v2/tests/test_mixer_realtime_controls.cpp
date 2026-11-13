#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

#ifndef LT_ENGINE_HAVE_BUNGEE
#define LT_ENGINE_HAVE_BUNGEE 0
#endif

namespace {

constexpr int kBlock = 512;

float peak(const std::vector<float>& samples) {
    float p = 0.0f;
    for (float s : samples) {
        CHECK(std::isfinite(s));
        p = std::max(p, std::abs(s));
    }
    return p;
}

double rms(const std::vector<float>& samples) {
    double sum = 0.0;
    for (float s : samples) {
        CHECK(std::isfinite(s));
        sum += static_cast<double>(s) * s;
    }
    return std::sqrt(sum / std::max<std::size_t>(1, samples.size()));
}

void render_blocks(Mixer& mixer,
                   TransportClock& clock,
                   int blocks,
                   std::vector<float>& left,
                   std::vector<float>& right) {
    left.assign(kBlock, 0.0f);
    right.assign(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    for (int i = 0; i < blocks; ++i)
        mixer.render(out, 2, kBlock, clock.sample_rate());
}

Session one_track_session(Frame start = 0, Frame duration = 48000, const Id& track_id = "track") {
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    Song song;
    song.id = "song";
    song.start_frame = start;
    song.end_frame = start + duration;
    Track track;
    track.id = track_id;
    track.clips.push_back(Clip{"clip", "source", start, 0, duration});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

void add_source(SourceManager& sources, const Id& id, float amplitude = 0.5f, Frame duration = 48000 * 4) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(id,
        test::make_stereo_sine(duration, 440.0, amplitude),
        2, test::kFixtureSampleRate, duration).is_ok());
}

JumpTarget frame_target(Frame frame) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = frame;
    return target;
}

} // namespace

TEST_CASE("sparse ASIO channel selection preserves physical external routes") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    // UI route Out 15/16 uses zero-based physical indices 14/15.
    session->songs[0].tracks[0].audio_to = "ext:14-15";

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    // JUCE compacts enabled physical outputs 13-16 into callback slots 0-3.
    mixer.set_active_output_channels({12, 13, 14, 15});
    clock.play();
    clock.clear_pending_start();

    std::vector<float> out_13(kBlock), out_14(kBlock), out_15(kBlock), out_16(kBlock);
    float* out[4] = {out_13.data(), out_14.data(), out_15.data(), out_16.data()};
    mixer.render(out, 4, kBlock, clock.sample_rate());

    CHECK(peak(out_13) < 1.0e-7f);
    CHECK(peak(out_14) < 1.0e-7f);
    CHECK(peak(out_15) > 0.01f);
    CHECK(peak(out_16) > 0.01f);

    // The active physical map is a live input to the precomputed routes. It
    // must take effect without replacing the session/control table.
    mixer.set_active_output_channels({14, 15, 12, 13});
    std::fill(out_13.begin(), out_13.end(), 0.0f);
    std::fill(out_14.begin(), out_14.end(), 0.0f);
    std::fill(out_15.begin(), out_15.end(), 0.0f);
    std::fill(out_16.begin(), out_16.end(), 0.0f);
    mixer.render(out, 4, kBlock, clock.sample_rate());
    CHECK(peak(out_13) > 0.01f);
    CHECK(peak(out_14) > 0.01f);
    CHECK(peak(out_15) < 1.0e-7f);
    CHECK(peak(out_16) < 1.0e-7f);
}

#if LT_ENGINE_HAVE_BUNGEE
// An unprepared scheduled jump used to publish an EMPTY voice map, which
// silenced every warped or transposed track until the control thread repaired
// it. That was the right trade when the renderer integrated a source cursor: a
// voice left in place would keep playing the pre-jump position indefinitely,
// and a hole was better than being permanently wrong.
//
// It stopped being right when the read position started coming from the
// timeline. A voice left alone now re-anchors on the very next block and is
// reading the correct source within one pipeline flush, so keeping it costs a
// crossfaded moment of the old position instead of a few hundred milliseconds
// of silence at the exact instant the user hit a section.
//
// What still must hold is the repair latch: the control thread has to learn
// that an unprepared jump happened so it can rebuild voices for material that
// has none.
TEST_CASE("scheduled jump without prepared voices keeps voices and latches repair target") {
    constexpr Frame kDuration = 48000 * 90;
    constexpr Frame kTrigger = 48000 * 10 + 325;
    constexpr Frame kTarget = 48000 * 44 + 117;

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source(
        "source",
        test::make_stereo_sine(kDuration, 440.0, 0.5f),
        2,
        test::kFixtureSampleRate,
        kDuration).is_ok());

    auto session = std::make_shared<Session>();
    session->id = "ab";
    session->sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kDuration;
    song.bpm = 120.0;
    song.transpose_semitones = -2;
    song.markers.push_back(Marker{"target", "Target", kTarget});
    // Phase-4: Bungee voices only build for warp-active clips. Pre-Phase-4
    // this test relied on the pitch-only path to enroll a Bungee voice for
    // "clip-p"; that path is now Varispeed and does not enroll. Wrap the
    // song in a warp region (with ratio 1.0) so the manager still produces
    // a voice for the pitched track, which is what this test exercises.
    {
        Region region;
        region.id              = "warp-region";
        region.start_frame     = 0;
        region.end_frame       = kDuration;
        region.warp_enabled    = true;
        // Near-unity ratio: keeps Bungee active (so the de-click test still
        // exercises the Bungee voice lifecycle) without skewing the
        // sample-exact assertions further down.
        song.bpm               = 120.0;
        region.warp_source_bpm = 120.0001;
        song.regions.push_back(region);
    }

    Track unpitched;
    unpitched.id = "unpitched";
    unpitched.transpose_behavior = TransposeBehavior::NeverTranspose;
    unpitched.clips.push_back(Clip{"clip-u", "source", 0, 0, kDuration});
    song.tracks.push_back(unpitched);

    Track pitched;
    pitched.id = "pitched";
    pitched.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    pitched.clips.push_back(Clip{"clip-p", "source", 0, 0, kDuration});
    song.tracks.push_back(pitched);
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(test::kFixtureSampleRate, 2, kBlock));
    bvm.rebuild_for_session(*session, sources, 0);
    REQUIRE(bvm.voice_for("clip-p") != nullptr);
    mixer.set_bungee_voice_manager(&bvm);

    clock.seek(kTrigger - 325);
    clock.play();
    clock.clear_pending_start();

    ScheduledJump jump;
    jump.jump_id = "jump-unprepared";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, test::kFixtureSampleRate);

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    // The repair latch is the part that still matters: without it the control
    // thread never rebuilds voices for clips that have none at the target.
    CHECK(mixer.take_pending_scheduled_jump() == kTarget);
    // And the voice survives, so the track does not go silent waiting.
    CHECK(bvm.voice_for("clip-p") != nullptr);

    bvm.rebuild_for_seek(kTarget, *session, sources);
    CHECK(bvm.voice_for("clip-p") != nullptr);
}
#endif

TEST_CASE("mixer_gain_override_changes_rendered_level") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const double baseline = rms(left);
    REQUIRE(baseline > 0.01);

    mixer.set_track_gain("track", 0.25f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(rms(left) == doctest::Approx(baseline * 0.25).epsilon(0.20));
    CHECK(clock.position().state == TransportState::Playing);
}

TEST_CASE("mixer_pan_override_changes_output_balance") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    REQUIRE(peak(left) > 0.01f);
    REQUIRE(peak(right) > 0.01f);

    mixer.set_track_pan("track", -1.0f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) < 0.001f);

    mixer.set_track_pan("track", 1.0f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(peak(right) > 0.01f);
    CHECK(peak(left) < 0.001f);
}

// ── Paso 10 del plan de feedback de testers: sumar una pista a mono ──────
//
// Fuente con los dos canales OPUESTOS (L = +x, R = -x). Es el material que
// distingue las tres cosas que podrian estar pasando:
//   - sin downmix, el estereo suena en los dos lados;
//   - con downmix y ley (L+R)/2, se cancela a silencio;
//   - con downmix y "quedarse con un canal", NO se cancelaria.
// Es decir: el test no solo comprueba que hace algo, comprueba QUE ley de suma
// se aplico.
namespace {
std::vector<float> make_opposed_stereo(Frame frames, float amplitude) {
    std::vector<float> samples(static_cast<std::size_t>(frames) * 2, 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const float value =
            amplitude * std::sin(2.0f * 3.14159265358979f * 440.0f
                                 * static_cast<float>(f)
                                 / static_cast<float>(test::kFixtureSampleRate));
        samples[static_cast<std::size_t>(f) * 2] = value;
        samples[static_cast<std::size_t>(f) * 2 + 1] = -value;
    }
    return samples;
}

void add_opposed_source(SourceManager& sources, const Id& id, Frame duration = 48000 * 4) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(id, make_opposed_stereo(duration, 0.5f),
                                         2, test::kFixtureSampleRate, duration).is_ok());
}
} // namespace

TEST_CASE("una pista sumada a mono funde los dos canales en uno") {
    SourceManager sources;
    add_opposed_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;

    // Sin mono: los canales opuestos suenan, cada uno por su lado.
    {
        Mixer mixer(session, &sources, &clock, &scheduler);
        clock.play();
        std::vector<float> left, right;
        render_blocks(mixer, clock, 8, left, right);
        CHECK(peak(left) > 0.01f);
        CHECK(peak(right) > 0.01f);
    }

    // Con mono y ley (L+R)/2, un material en contrafase se cancela.
    {
        auto mono_session = std::make_shared<Session>(one_track_session());
        mono_session->songs[0].tracks[0].channel_mode = TrackChannelMode::Mono;
        TransportClock mono_clock(test::kFixtureSampleRate);
        Mixer mixer(mono_session, &sources, &mono_clock, &scheduler);
        mono_clock.play();
        std::vector<float> left, right;
        render_blocks(mixer, mono_clock, 8, left, right);
        CHECK_MESSAGE(peak(left) < 0.001f,
                      "con (L+R)/2 un estereo en contrafase tiene que cancelarse");
        CHECK(peak(right) < 0.001f);
    }
}

TEST_CASE("sumar a mono no sube el nivel: la ley es (L+R)/2") {
    // Material identico en los dos canales, que es lo normal en un estereo que
    // alguien quiere en mono. Sumar sin atenuar lo dejaria al doble y podria
    // pasar de +-1.0 (ver el paso 11); con la mitad se queda igual.
    SourceManager sources;
    add_source(sources, "source", /*amplitude=*/0.5f);

    auto stereo = std::make_shared<Session>(one_track_session());
    TransportClock stereo_clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer stereo_mixer(stereo, &sources, &stereo_clock, &scheduler);
    stereo_clock.play();
    std::vector<float> stereo_left, stereo_right;
    render_blocks(stereo_mixer, stereo_clock, 8, stereo_left, stereo_right);
    const float stereo_peak = peak(stereo_left);
    REQUIRE(stereo_peak > 0.01f);

    auto mono = std::make_shared<Session>(one_track_session());
    mono->songs[0].tracks[0].channel_mode = TrackChannelMode::Mono;
    TransportClock mono_clock(test::kFixtureSampleRate);
    Mixer mono_mixer(mono, &sources, &mono_clock, &scheduler);
    mono_clock.play();
    std::vector<float> mono_left, mono_right;
    render_blocks(mono_mixer, mono_clock, 8, mono_left, mono_right);

    CHECK(peak(mono_left) == doctest::Approx(stereo_peak).epsilon(0.02));
    CHECK(peak(mono_right) == doctest::Approx(stereo_peak).epsilon(0.02));
}

TEST_CASE("quitar el mono devuelve la pista a estereo, sin perdida") {
    SourceManager sources;
    add_opposed_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    session->songs[0].tracks[0].channel_mode = TrackChannelMode::Stereo;
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) > 0.01f);
}

// ── Plan channel-split, paso 02: modo de canal por pista ─────────────────
//
// Fuente con dos senales DISTINTAS por lado (L = seno A a 440 Hz, R = seno B a
// 660 Hz y otra amplitud). Se compara muestra a muestra con la salida en
// Stereo: Left tiene que sacar exactamente la L del estereo por los dos lados,
// Right la R, y Mono (L+R)/2.
namespace {
std::vector<float> make_two_sines(Frame frames) {
    std::vector<float> samples(static_cast<std::size_t>(frames) * 2, 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const float t = static_cast<float>(f) / static_cast<float>(test::kFixtureSampleRate);
        samples[static_cast<std::size_t>(f) * 2] = 0.5f * std::sin(2.0f * 3.14159265f * 440.0f * t);
        samples[static_cast<std::size_t>(f) * 2 + 1] = 0.25f * std::sin(2.0f * 3.14159265f * 660.0f * t);
    }
    return samples;
}

struct ModeRender {
    std::vector<float> left, right;
    TrackMeterValues meter{};
};

ModeRender render_mode(SourceManager& sources, TrackChannelMode mode,
                       TrackMeterMode meter_mode = TrackMeterMode::PostFader) {
    auto session = std::make_shared<Session>(one_track_session());
    session->songs[0].tracks[0].channel_mode = mode;
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_track_meter_mode(meter_mode);
    clock.play();
    ModeRender out;
    render_blocks(mixer, clock, 8, out.left, out.right);
    out.meter = mixer.track_meters()[0];
    return out;
}

void check_same(const std::vector<float>& actual, const std::vector<float>& expected,
                const char* what) {
    REQUIRE(actual.size() == expected.size());
    float worst = 0.0f;
    for (std::size_t i = 0; i < actual.size(); ++i)
        worst = std::max(worst, std::abs(actual[i] - expected[i]));
    CHECK_MESSAGE(worst < 1.0e-5f, what << ": diferencia maxima " << worst);
}
} // namespace

TEST_CASE("modo de canal: Left/Right sacan un lado por los dos, Mono la media") {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", make_two_sines(48000 * 4), 2,
                                         test::kFixtureSampleRate, 48000 * 4).is_ok());

    const auto stereo = render_mode(sources, TrackChannelMode::Stereo);
    REQUIRE(peak(stereo.left) > 0.1f);
    REQUIRE(peak(stereo.right) > 0.05f);
    // Las dos senales son distinguibles: si no, el test no demostraria nada.
    REQUIRE(std::abs(peak(stereo.left) - peak(stereo.right)) > 0.1f);

    const auto left = render_mode(sources, TrackChannelMode::Left);
    check_same(left.left, stereo.left, "Left, lado izquierdo");
    check_same(left.right, stereo.left, "Left, lado derecho");

    const auto right = render_mode(sources, TrackChannelMode::Right);
    check_same(right.left, stereo.right, "Right, lado izquierdo");
    check_same(right.right, stereo.right, "Right, lado derecho");

    std::vector<float> average(stereo.left.size());
    for (std::size_t i = 0; i < average.size(); ++i)
        average[i] = 0.5f * (stereo.left[i] + stereo.right[i]);
    const auto mono = render_mode(sources, TrackChannelMode::Mono);
    check_same(mono.left, average, "Mono, lado izquierdo");
    check_same(mono.right, average, "Mono, lado derecho");
}

TEST_CASE("modo de canal: una fuente mono suena igual en Left/Right que en Stereo") {
    SourceManager sources;
    sources.register_source("source", "");
    std::vector<float> mono_samples(48000 * 4);
    for (std::size_t f = 0; f < mono_samples.size(); ++f)
        mono_samples[f] = 0.4f * std::sin(2.0f * 3.14159265f * 440.0f * static_cast<float>(f)
                                          / static_cast<float>(test::kFixtureSampleRate));
    REQUIRE(sources.store_decoded_source("source", std::move(mono_samples), 1,
                                         test::kFixtureSampleRate, 48000 * 4).is_ok());

    const auto stereo = render_mode(sources, TrackChannelMode::Stereo);
    REQUIRE(peak(stereo.left) > 0.1f);
    for (auto mode : {TrackChannelMode::Left, TrackChannelMode::Right}) {
        const auto out = render_mode(sources, mode);
        check_same(out.left, stereo.left, "fuente mono, izquierdo");
        check_same(out.right, stereo.right, "fuente mono, derecho");
    }
}

TEST_CASE("modo de canal: el medidor de pista lee lo que se mezcla") {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", make_two_sines(48000 * 4), 2,
                                         test::kFixtureSampleRate, 48000 * 4).is_ok());

    for (auto meter_mode : {TrackMeterMode::PostPan, TrackMeterMode::PostFader}) {
        const auto stereo = render_mode(sources, TrackChannelMode::Stereo, meter_mode);
        REQUIRE(stereo.meter.left_peak > stereo.meter.right_peak + 0.1f);

        const auto left = render_mode(sources, TrackChannelMode::Left, meter_mode);
        CHECK(left.meter.left_peak == doctest::Approx(left.meter.right_peak).epsilon(1e-4));
        CHECK(left.meter.left_peak == doctest::Approx(stereo.meter.left_peak).epsilon(1e-3));

        const auto right = render_mode(sources, TrackChannelMode::Right, meter_mode);
        CHECK(right.meter.left_peak == doctest::Approx(right.meter.right_peak).epsilon(1e-4));
        CHECK(right.meter.right_peak == doctest::Approx(stereo.meter.right_peak).epsilon(1e-3));

        const auto mono = render_mode(sources, TrackChannelMode::Mono, meter_mode);
        CHECK(mono.meter.left_peak == doctest::Approx(mono.meter.right_peak).epsilon(1e-4));
        CHECK(mono.meter.left_peak == doctest::Approx(peak(mono.left)).epsilon(0.02));
    }
}

// Misma tabla que el test del offline ("offline render: el modo de canal suena
// igual que en directo"): L = 0.2 y R = 0.6 constantes, paneo centrado.
TEST_CASE("modo de canal: la mezcla en directo da la tabla del diseno") {
    SourceManager sources;
    sources.register_source("source", "");
    std::vector<float> samples(static_cast<std::size_t>(48000) * 4 * 2);
    for (std::size_t f = 0; f < samples.size() / 2; ++f) {
        samples[f * 2] = 0.2f;
        samples[f * 2 + 1] = 0.6f;
    }
    REQUIRE(sources.store_decoded_source("source", std::move(samples), 2,
                                         test::kFixtureSampleRate, 48000 * 4).is_ok());
    struct Row { TrackChannelMode mode; float l, r; };
    for (const Row row : {Row{TrackChannelMode::Stereo, 0.2f, 0.6f},
                          Row{TrackChannelMode::Mono, 0.4f, 0.4f},
                          Row{TrackChannelMode::Left, 0.2f, 0.2f},
                          Row{TrackChannelMode::Right, 0.6f, 0.6f}}) {
        const auto out = render_mode(sources, row.mode);
        CHECK(out.left[kBlock / 2] == doctest::Approx(row.l).epsilon(1e-4));
        CHECK(out.right[kBlock / 2] == doctest::Approx(row.r).epsilon(1e-4));
    }
}

TEST_CASE("mixer_mute_override_mutes_track") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    REQUIRE(peak(left) > 0.01f);

    mixer.set_track_mute("track", true);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) < 0.001f);
    CHECK(peak(right) < 0.001f);

    mixer.set_track_mute("track", false);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) > 0.01f);
}

TEST_CASE("mixer_solo_override_isolates_track") {
    SourceManager sources;
    sources.register_source("a", "");
    sources.register_source("b", "");
    REQUIRE(sources.store_decoded_source("a", test::make_stereo_sine(48000 * 4, 220.0, 0.25f),
                                         2, test::kFixtureSampleRate, 48000 * 4).is_ok());
    REQUIRE(sources.store_decoded_source("b", test::make_stereo_sine(48000 * 4, 880.0, 0.25f),
                                         2, test::kFixtureSampleRate, 48000 * 4).is_ok());
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.end_frame = 48000 * 4;
    Track a;
    a.id = "a";
    a.clips.push_back(Clip{"clip-a", "a", 0, 0, 48000 * 4});
    Track b;
    b.id = "b";
    b.clips.push_back(Clip{"clip-b", "b", 0, 0, 48000 * 4});
    song.tracks = {a, b};
    session.songs.push_back(song);
    auto shared = std::make_shared<Session>(session);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();
    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const double both = rms(left);
    REQUIRE(both > 0.1);

    mixer.set_track_solo("a", true);
    render_blocks(mixer, clock, 30, left, right);
    const double solo_a = rms(left);
    CHECK(solo_a < both);
    CHECK(solo_a > 0.05);

    mixer.set_track_solo("a", false);
    mixer.set_track_solo("b", true);
    render_blocks(mixer, clock, 30, left, right);
    const double solo_b = rms(left);
    CHECK(solo_b < both);
    CHECK(solo_b > 0.05);

    mixer.set_track_solo("b", false);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(rms(left) > solo_b);
}

TEST_CASE("mixer_controls_are_track_id_based_not_index_based") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 8);
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    session.songs.push_back(one_track_session(0, 48000 * 2, "A").songs[0]);
    session.songs[0].id = "song-a";
    session.songs.push_back(one_track_session(48000 * 4, 48000 * 2, "B").songs[0]);
    session.songs[1].id = "song-b";
    auto shared = std::make_shared<Session>(session);
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    mixer.set_track_gain("B", 0.25f);
    clock.seek(48000 * 4);
    render_blocks(mixer, clock, 30, left, right);
    const double b_level = rms(left);

    clock.seek(0);
    render_blocks(mixer, clock, 30, left, right);
    const double a_level = rms(left);
    CHECK(b_level < a_level * 0.45);
    CHECK(a_level > 0.1);
}

TEST_CASE("mixer_control_spam_no_clicks_or_callback_spikes") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();
    std::vector<float> left, right;
    float last = 0.0f;
    float max_jump = 0.0f;
    for (int i = 0; i < 100; ++i) {
        mixer.set_track_gain("track", (i % 10) / 10.0f);
        mixer.set_track_pan("track", (i % 2) ? -1.0f : 1.0f);
        mixer.set_track_mute("track", i % 17 == 0);
        render_blocks(mixer, clock, 1, left, right);
        for (float sample : left) {
            CHECK(std::isfinite(sample));
            max_jump = std::max(max_jump, std::abs(sample - last));
            last = sample;
        }
    }
    CHECK(max_jump < 1.0f);
    CHECK(mixer.callback_duration_ms() < 10.0);
}

TEST_CASE("track_renderer_no_scratch_allocation_in_render") {
    TrackRenderer::reset_diagnostics();
    SourceManager sources;
    add_source(sources, "source");
    auto session = one_track_session();
    TrackRenderer renderer;
    renderer.prepare(kBlock);
    const auto before = TrackRenderer::diagnostics();

    float left[kBlock] = {};
    float right[kBlock] = {};
    float* out[2] = {left, right};
    renderer.render(session.songs[0].tracks[0], 0, kBlock, out, 2, sources, nullptr,
                    test::kFixtureSampleRate, 0, &session.songs[0]);
    const auto after = TrackRenderer::diagnostics();

    CHECK(after.prepare_count == before.prepare_count);
    CHECK(after.scratch_resize_in_audio_thread_count == before.scratch_resize_in_audio_thread_count);
    CHECK(after.block_too_large_count == 0);
}

TEST_CASE("metronome_toggle_does_not_stop_existing_audio") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();
    mixer.set_metronome_config({true, 0.75f, "master", true});

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const auto before_frame = clock.position().frame;
    mixer.set_metronome_config({false, 0.75f, "master", true});
    render_blocks(mixer, clock, 8, left, right);

    CHECK(clock.position().frame > before_frame);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) > 0.01f);
}

TEST_CASE("scheduled region-end jump splits render block at exact trigger frame") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(
        Region{"region-a", "A", 0, 96000, 0});

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "region-end";
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = 1234;
    jump.target = target;
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(95600);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().frame == 1234 + (kBlock - 400));
    CHECK(mixer.scheduled_jump_executed_count() == 1);
}

namespace {

// Two back-to-back songs: A = [0, 96000), B = [96000, 192000).
std::shared_ptr<Session> two_song_session() {
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(Region{"region-a", "A", 0, 96000, 0});
    session->songs[0].regions.push_back(Region{"region-b", "B", 96000, 192000, 0});
    return session;
}

} // namespace

TEST_CASE("pause at song end is off by default: playback rolls into the next song") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    clock.seek(95600);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().state == TransportState::Playing);
    CHECK(clock.position().frame == 95600 + kBlock);
    CHECK(mixer.song_end_pause_count() == 0);
}

TEST_CASE("pause at song end stops on the exact end frame and silences the rest") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_pause_at_song_end(true);

    clock.seek(95700);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().state == TransportState::Paused);
    CHECK(clock.position().frame == 96000);
    CHECK(mixer.song_end_pause_count() == 1);

    // Song A sounds up to its end; past the crossfade ramp nothing of song B
    // leaks into the block.
    const std::vector<float> before(left.begin(), left.begin() + 300);
    const std::vector<float> after(left.begin() + 300 + 128, left.end());
    CHECK(peak(before) > 0.01f);
    CHECK(peak(after) < 1.0e-6f);

    // Play resumes from the boundary into song B without pausing again.
    clock.play();
    clock.clear_pending_start();
    mixer.render(out, 2, kBlock, clock.sample_rate());
    CHECK(clock.position().state == TransportState::Playing);
    CHECK(clock.position().frame == 96000 + kBlock);
    CHECK(mixer.song_end_pause_count() == 1);
}

// "Vamp between songs": at a song end the transport parks on the next song's
// first frame, but the click goes on at the ENDED song's tempo, for as long as
// the band needs, until Play starts the next song.
TEST_CASE("vamp between songs keeps clicking the ended song until Play") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    // Song B is at 60 bpm: the vamp must keep song A's 120.
    session->songs[0].tempo_markers.push_back(TempoMarker{"tempo-b", 96000, 60.0});
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_metronome_config(MetronomeConfig{true, 1.0f, "master", true});
    mixer.set_song_gap_vamp(true);

    clock.seek(95700);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    auto render_block = [&] {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, clock.sample_rate());
    };

    render_block();
    CHECK(clock.position().state == TransportState::Paused);
    CHECK(clock.position().frame == 96000);
    CHECK(mixer.song_end_pause_count() == 1);   // the host mirrors it as a pause
    CHECK(mixer.song_gap_vamp_active());

    // Parked up to virtual frame 191956: beats at 96000, 120000, 144000 and
    // 168000 at song A's 120 bpm (only 96000 and 144000 at song B's 60).
    for (int block = 1; block < 188; ++block)
        render_block();
    CHECK(clock.position().frame == 96000);       // song B never started
    CHECK(mixer.metronome_diagnostics().rendered_clicks_count == 4);
    CHECK(mixer.song_gap_vamp_active());

    // Play hands over to song B from its first frame.
    clock.play();
    clock.clear_pending_start();
    render_block();
    CHECK(!mixer.song_gap_vamp_active());
    CHECK(clock.position().state == TransportState::Playing);
    CHECK(clock.position().frame == 96000 + kBlock);
}

TEST_CASE("ending the vamp between songs silences the click without playing") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_metronome_config(MetronomeConfig{true, 1.0f, "master", true});
    mixer.set_song_gap_vamp(true);

    clock.seek(95700);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 1, left, right);
    REQUIRE(mixer.song_gap_vamp_active());

    mixer.end_song_gap_vamp();   // the user's Pause / Stop
    const auto clicks = mixer.metronome_diagnostics().rendered_clicks_count;
    render_blocks(mixer, clock, 200, left, right);
    CHECK(!mixer.song_gap_vamp_active());
    CHECK(mixer.metronome_diagnostics().rendered_clicks_count == clicks);
    CHECK(clock.position().state == TransportState::Paused);
}

TEST_CASE("pause at song end yields to a jump scheduled on the same boundary") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_pause_at_song_end(true);

    ScheduledJump jump;
    jump.jump_id = "region-end";
    jump.target = frame_target(1234);
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(95600);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().state == TransportState::Playing);
    CHECK(clock.position().frame == 1234 + (kBlock - 400));
    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(mixer.song_end_pause_count() == 0);
}

TEST_CASE("pause at song end yields to a transition fade heading to silence") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = two_song_session();
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_pause_at_song_end(true);
    mixer.start_master_fade(0.0f, 0.5);

    clock.seek(95600);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().state == TransportState::Playing);
    CHECK(mixer.song_end_pause_count() == 0);
}

TEST_CASE("scheduled jump can suppress seek fade for external fade transitions") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(
        Region{"region-a", "A", 0, 96000, 0});

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "region-end";
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = 1234;
    jump.target = target;
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(95600);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().frame == 1234 + (kBlock - 400));
    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(mixer.take_pending_scheduled_jump() == 1234);
}

TEST_CASE("scheduled jump suppress_seek_fade leaves first post-jump sample untouched") {
    constexpr Frame kDuration = 48000 * 2;
    constexpr Frame kTrigger = 300;
    constexpr Frame kTarget = 24000;

    std::vector<float> pcm(static_cast<std::size_t>(kDuration * 2), 0.0f);
    for (Frame f = 0; f < kDuration; ++f) {
        const float value = f < kTarget ? 0.25f : 0.75f;
        pcm[static_cast<std::size_t>(f * 2)] = value;
        pcm[static_cast<std::size_t>(f * 2 + 1)] = value;
    }

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", pcm, 2,
        test::kFixtureSampleRate, kDuration).is_ok());

    auto session = std::make_shared<Session>(one_track_session(0, kDuration));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "marker-instant";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(0);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(left[static_cast<std::size_t>(kTrigger)] == doctest::Approx(0.75f));
}

TEST_CASE("prepared scheduled jump still de-clicks the post-jump boundary") {
    constexpr Frame kDuration = 48000 * 2;
    constexpr Frame kTrigger = 300;
    constexpr Frame kTarget = 24000;

    std::vector<float> pcm(static_cast<std::size_t>(kDuration * 2), 0.0f);
    for (Frame f = 0; f < kDuration; ++f) {
        const float value = f < kTarget ? 0.25f : 0.75f;
        pcm[static_cast<std::size_t>(f * 2)] = value;
        pcm[static_cast<std::size_t>(f * 2 + 1)] = value;
    }

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", pcm, 2,
        test::kFixtureSampleRate, kDuration).is_ok());

    auto session = std::make_shared<Session>(one_track_session(0, kDuration));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "prepared-marker";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    jump.prepared_voice_map = std::make_shared<PreparedVoiceMap>();
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(0);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(left[static_cast<std::size_t>(kTrigger)] == doctest::Approx(0.25f));
    CHECK(left[static_cast<std::size_t>(kTrigger + 127)] == doctest::Approx(0.75f));
}

// A prepared set only covers the clips audible at its target; the control
// thread has to enroll the ones that start later (see the prearmed jump test
// "clips after a prepared jump target get their voices back"). This is the
// handshake that tells it to.
TEST_CASE("prepared scheduled jump hands its target to the control thread for a voice top-up") {
    BungeeVoiceManager bvm;
    if (!bvm.prepare(test::kFixtureSampleRate, 2, kBlock))
        return;  // built without Bungee: no prepared maps to publish

    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 2);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 2));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_bungee_voice_manager(&bvm);

    ScheduledJump jump;
    jump.jump_id = "prepared-marker";
    jump.target = frame_target(24000);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = 300;
    jump.prepared_voice_map = std::make_shared<PreparedVoiceMap>();
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(0);
    clock.play();
    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    REQUIRE(mixer.scheduled_jump_executed_count() == 1);
    CHECK(mixer.take_pending_prepared_jump() == 24000);
    CHECK(mixer.take_pending_prepared_jump() == Mixer::kNoJumpPending);
    // Prepared: no full rebuild requested — that one re-primes every voice.
    CHECK(mixer.take_pending_scheduled_jump() == Mixer::kNoJumpPending);
}

TEST_CASE("master fade ramps output gain in the audio callback") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    clock.play();
    mixer.start_master_fade(0.0f, static_cast<double>(kBlock) / clock.sample_rate());

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    const std::vector<float> left_head(left.begin(), left.begin() + kBlock / 4);
    const std::vector<float> left_tail(left.end() - kBlock / 4, left.end());
    const std::vector<float> right_head(right.begin(), right.begin() + kBlock / 4);
    const std::vector<float> right_tail(right.end() - kBlock / 4, right.end());
    CHECK(rms(left_head) > rms(left_tail));
    CHECK(rms(right_head) > rms(right_tail));
}

// Repro: an automation cue that jumps to another song with a 2 s fade faded
// EVERYTHING out — the metronome, the voice guide and the ambient pad went
// down with the song. Those are cues for the player, not part of the song: the
// song fades under them and they keep their level. The transition fade now
// runs where the region master gain runs, on the tracks only.
TEST_CASE("the jump transition fade does not fade the metronome") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_metronome_config(MetronomeConfig{true, 1.0f, "master", true});
    clock.play();

    // Faded fully out, instantly: whatever is still audible is not the song.
    mixer.start_master_fade(0.0f, 0.0);

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    constexpr int kBlocks = 200;                 // ~2.1 s at 48k/512
    float loudest = 0.0f;
    std::size_t audible_frames = 0;
    for (int block = 0; block < kBlocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, clock.sample_rate());
        for (float sample : left) {
            const float magnitude = std::abs(sample);
            loudest = std::max(loudest, magnitude);
            if (magnitude > 1.0e-6f)
                ++audible_frames;
        }
    }

    CHECK(mixer.metronome_diagnostics().rendered_clicks_count > 0);
    CHECK(loudest > 0.01f);   // the click is still there under a full fade-out
    // …and the song really is gone: only the short clicks survive, not the
    // continuous sine of the track.
    CHECK(audible_frames < static_cast<std::size_t>(kBlocks) * kBlock / 4);
}

// Repro: a song with one empty track (no clips) collapses to
// end_frame == start_frame. The per-song loop in render() skips it via
// `continue`, and the metronome render call lives inside that loop — so
// pressing play produced no click at all. The click must sound whenever the
// transport rolls, like the ambient pad, since its timing comes from the
// song's bpm/signature rather than from any audio content.
TEST_CASE("metronome clicks while playing an empty song") {
    SourceManager sources;
    auto session = std::make_shared<Session>();
    session->id = "session";
    session->sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 0;      // empty song: a track with no clips
    song.bpm = 120.0;
    song.beats_per_bar = 4;
    song.beat_unit = 4;
    Track track;
    track.id = "empty-track";
    song.tracks.push_back(track);
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_metronome_config(MetronomeConfig{true, 1.0f, "master", true});
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 200, left, right);   // ~2.1s at 48k/512

    CHECK(mixer.metronome_diagnostics().rendered_clicks_count > 0);
}

// Repro: the song master meter (one per region) read the final output bus,
// after the metronome, voice guide and pad had been mixed in. A song with
// nothing playing still showed the click on its master, and "Level songs"
// users read that bar as the song's own level. The song master gain never
// touched those cues; now its meter does not count them either.
TEST_CASE("the song master meter ignores the metronome") {
    SourceManager sources;
    auto session = std::make_shared<Session>();
    session->id = "session";
    session->sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 0;      // no audio at all: only the click can sound
    song.bpm = 120.0;
    song.beats_per_bar = 4;
    song.beat_unit = 4;
    Track track;
    track.id = "empty-track";
    song.tracks.push_back(track);
    song.regions.push_back(Region{"region-a", "A", 0, 48000 * 4, 0});
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_metronome_config(MetronomeConfig{true, 1.0f, "master", true});
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    float loudest = 0.0f;
    float meter_max = 0.0f;
    for (int block = 0; block < 200; ++block) {   // ~2.1 s at 48k/512
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, clock.sample_rate());
        loudest = std::max(loudest, peak(left));
        const auto meters = mixer.region_meters();
        REQUIRE(meters.size() == 1);
        meter_max = std::max(meter_max, meters[0].peak);
    }

    CHECK(loudest > 0.01f);              // the click does reach the output…
    CHECK(meter_max < 1.0e-6f);          // …but not the song's master meter
}

TEST_CASE("the song master meter still shows the song's tracks") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(Region{"region-a", "A", 0, 48000 * 4, 0});

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 20, left, right);

    const auto meters = mixer.region_meters();
    REQUIRE(meters.size() == 1);
    CHECK(meters[0].peak > 0.1f);
}

// Repro: the mixer's renderer pool was a fixed std::array of 64, and both
// render loops were bounded by that constant. A song with more than 64 tracks
// had track 65 onward silently skipped — no audio at all, while the track's
// mixer controls still responded (those live in controls_, capped separately),
// which is what made it look like a UI bug rather than a render-pool limit.
// Moving a track from slot 65 to slot 64 made it audible again.
//
// The pool now grows on the control thread to fit the largest song, so a
// track's index must not decide whether it is heard.
TEST_CASE("tracks past the old 64-track render pool still produce audio") {
    constexpr int kTrackCount = 100;   // comfortably past the old cap
    constexpr Frame kDuration = 48000;

    SourceManager sources;
    add_source(sources, "source", 0.5f, kDuration);

    auto session = std::make_shared<Session>();
    session->id = "session";
    session->sample_rate = test::kFixtureSampleRate;
    session->sources.push_back(Source{"source", ""});

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kDuration;
    // Every track is silent except the last one, so any audio on the bus can
    // only have come from the track sitting well past the old limit.
    for (int i = 0; i < kTrackCount; ++i) {
        Track track;
        track.id = "track-" + std::to_string(i);
        track.gain = (i == kTrackCount - 1) ? 1.0f : 0.0f;
        track.clips.push_back(Clip{"clip-" + std::to_string(i), "source", 0, 0, kDuration});
        song.tracks.push_back(track);
    }
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 4, left, right);

    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) > 0.01f);

    // The last track must also report a meter, i.e. it was really rendered
    // rather than merely leaking through some other path.
    const auto meters = mixer.track_meters();
    REQUIRE(meters.size() == static_cast<std::size_t>(kTrackCount));
    CHECK(meters.back().track_id == "track-" + std::to_string(kTrackCount - 1));
    CHECK(meters.back().left_peak > 0.01f);
}

// Companion to the above: control slots (gain/pan/mute/solo) were capped at
// 256 across the WHOLE session, so several songs with many tracks each left the
// surplus tracks without working mixer controls. Muting must work at any index.
TEST_CASE("mute works for a track past the old 256 control-slot cap") {
    constexpr int kSongs = 4;
    constexpr int kTracksPerSong = 100;   // 400 slots total, past the old 256
    constexpr Frame kDuration = 48000;

    SourceManager sources;
    add_source(sources, "source", 0.5f, kDuration * kSongs);

    auto session = std::make_shared<Session>();
    session->id = "session";
    session->sample_rate = test::kFixtureSampleRate;
    session->sources.push_back(Source{"source", ""});

    Id last_track_id;
    for (int s = 0; s < kSongs; ++s) {
        Song song;
        song.id = "song-" + std::to_string(s);
        song.start_frame = kDuration * s;
        song.end_frame = kDuration * (s + 1);
        for (int i = 0; i < kTracksPerSong; ++i) {
            Track track;
            track.id = "s" + std::to_string(s) + "-track-" + std::to_string(i);
            // Only the final track of the final song is audible.
            const bool audible = (s == kSongs - 1) && (i == kTracksPerSong - 1);
            track.gain = audible ? 1.0f : 0.0f;
            if (audible) last_track_id = track.id;
            track.clips.push_back(Clip{"clip-" + track.id, "source",
                                       song.start_frame, 0, kDuration});
            song.tracks.push_back(track);
        }
        session->songs.push_back(song);
    }

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);

    // Play inside the LAST song, where the audible track lives.
    clock.seek(kDuration * (kSongs - 1));
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 4, left, right);
    const float unmuted_peak = peak(left);
    CHECK(unmuted_peak > 0.01f);

    // Muting that track must actually silence it — proof it owns a real
    // control slot rather than falling back to its baked-in gain.
    mixer.set_track_mute(last_track_id, true);
    render_blocks(mixer, clock, 40, left, right);   // let the 10ms ramp settle
    CHECK(peak(left) < unmuted_peak * 0.05f);
}

// set_session(preserve_realtime_state=true) is the path used by transpose and
// region edits: the session pointer is swapped but live fader/mute state must
// survive. rebuild_control_slots looks up each track's previous slot to carry
// those values over — and it has to do so against the slots that were live
// BEFORE control_count_ is zeroed for the rebuild. Getting that wrong silently
// resets every fader on each transpose.
//
// Checked on the output bus, not the per-track meter: track meters are
// pre-fader, so a muted track still meters its raw signal.
TEST_CASE("session swap preserves live mute past the old control-slot cap") {
    constexpr int kTrackCount = 300;   // past the old 256 control-slot cap
    constexpr Frame kDuration = 48000;

    SourceManager sources;
    add_source(sources, "source", 0.5f, kDuration);

    // Exactly one track carries audio, so the bus level reports that track alone.
    const Id late_track = "track-" + std::to_string(kTrackCount - 1);
    auto build = [&] {
        auto session = std::make_shared<Session>();
        session->id = "session";
        session->sample_rate = test::kFixtureSampleRate;
        session->sources.push_back(Source{"source", ""});
        Song song;
        song.id = "song";
        song.start_frame = 0;
        song.end_frame = kDuration;
        for (int i = 0; i < kTrackCount; ++i) {
            Track track;
            track.id = "track-" + std::to_string(i);
            // The session always describes every track as unmuted and only the
            // last one as audible.
            track.gain = (track.id == late_track) ? 1.0f : 0.0f;
            track.mute = false;
            track.clips.push_back(Clip{"clip-" + std::to_string(i), "source", 0, 0, kDuration});
            song.tracks.push_back(track);
        }
        session->songs.push_back(song);
        return session;
    };

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(build(), &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    // The song is only 1s long, so seek back before each measurement: 40 blocks
    // is ~0.43s and three passes would otherwise run off the end into silence.
    std::vector<float> left, right;
    render_blocks(mixer, clock, 40, left, right);
    const float audible_peak = peak(left);
    CHECK(audible_peak > 0.01f);

    // Mute it live, then swap the session the way a transpose does. The mute
    // must survive even though the incoming session says the track is unmuted.
    mixer.set_track_mute(late_track, true);
    clock.seek(0);
    render_blocks(mixer, clock, 40, left, right);
    REQUIRE(peak(left) < audible_peak * 0.05f);

    mixer.set_session(build(), /*preserve_realtime_state=*/true);
    clock.seek(0);
    render_blocks(mixer, clock, 40, left, right);
    CHECK(peak(left) < audible_peak * 0.05f);

    // And preserve_realtime_state=false must do the opposite: take the
    // session's own value, un-muting the track again. Seek back first — the
    // song is only 1s long and the renders above have already run past its end.
    mixer.set_session(build(), /*preserve_realtime_state=*/false);
    clock.seek(0);
    render_blocks(mixer, clock, 40, left, right);
    CHECK(peak(left) > 0.01f);
}
