// Voz guia "solo en saltos" (estilo AbleSet): con la opcion encendida la voz
// solo anuncia los saltos programados y, mientras anuncia uno, el mixer calla
// las pistas con rol Guide (la guia grabada de la secuencia). Al tocar en orden
// suena la guia de la secuencia y la voz dinamica calla.
#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/voice_guide_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr int kBlock = 512;
constexpr int kSR = test::kFixtureSampleRate;
// 120 BPM 4/4: un compas = 2 s.
constexpr Frame kBar = static_cast<Frame>(kSR) * 2;
constexpr Frame kSongEnd = static_cast<Frame>(kSR) * 16;
// El salto se dispara a los 10 s y aterriza en el Coro de los 2 s.
constexpr Frame kTrigger = static_cast<Frame>(kSR) * 10;
constexpr Frame kChorus = static_cast<Frame>(kSR) * 2;

VoiceGuideConfig jumps_only_config(bool jumps_only = true, bool enabled = true) {
    VoiceGuideConfig config;
    config.enabled = enabled;
    config.lead_bars = 1;
    config.count_in_enabled = true;
    config.jumps_only = jumps_only;
    return config;
}

Session guide_session(TrackRole role) {
    Session session;
    session.id = "session";
    session.sample_rate = kSR;
    session.sources.push_back(Source{"src", ""});

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kSongEnd;
    song.bpm = 120.0;
    song.beats_per_bar = 4;
    song.beat_unit = 4;
    Marker chorus;
    chorus.id = "chorus";
    chorus.name = "Coro";
    chorus.kind = MarkerKind::Chorus;
    chorus.frame = kChorus;
    song.markers.push_back(chorus);

    Track track;
    track.id = "guide";
    track.name = "Guia";
    track.kind = TrackKind::Audio;
    track.role = role;
    track.clips.push_back(Clip{"clip", "src", 0, 0, kSongEnd});
    song.tracks.push_back(track);

    session.songs.push_back(song);
    return session;
}

VoiceGuideTarget jump_to_chorus() {
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = kTrigger;
    jump.destination_frame = kChorus;
    jump.kind = MarkerKind::Chorus;
    return jump;
}

float peak(const float* s, int n) {
    float p = 0.f;
    for (int i = 0; i < n; ++i) p = std::max(p, std::abs(s[i]));
    return p;
}

// Peak of the master pair over the block that starts at or after `frame`,
// rendering every block before it so the mixer sees continuous playback.
struct Rig {
    SourceManager sources;
    std::shared_ptr<Session> session;
    TransportClock clock{kSR};
    JumpScheduler scheduler;
    std::unique_ptr<Mixer> mixer;
    std::vector<float> left = std::vector<float>(kBlock, 0.f);
    std::vector<float> right = std::vector<float>(kBlock, 0.f);

    Rig(TrackRole role, const VoiceGuideConfig& config, bool schedule_jump) {
        sources.register_source("src", "");
        REQUIRE(sources.store_decoded_source(
            "src", test::make_stereo_sine(kSongEnd, 440.0, 0.5f), 2, kSR, kSongEnd).is_ok());
        session = std::make_shared<Session>(guide_session(role));
        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);
        mixer->set_voice_guide_config(config);
        if (schedule_jump) {
            ScheduledJump jump;
            jump.jump_id = "jump";
            jump.target.kind = JumpTarget::Kind::Marker;
            jump.target.id = "chorus";
            jump.trigger = JumpTrigger::AtFrame;
            jump.status = JumpStatus::Pending;
            jump.trigger_frame = kTrigger;
            REQUIRE(scheduler.schedule(jump).is_ok());
        }
        clock.play();
    }

    float peak_of_block() {
        std::fill(left.begin(), left.end(), 0.f);
        std::fill(right.begin(), right.end(), 0.f);
        float* out[2] = {left.data(), right.data()};
        mixer->render(out, 2, kBlock, clock.sample_rate());
        return std::max(peak(left.data(), kBlock), peak(right.data(), kBlock));
    }

    // Render (and drop) blocks until the playhead reaches `frame` along the
    // linear timeline, then return the peak of the next block.
    float peak_at(Frame frame) {
        while (clock.position().frame + kBlock <= frame) peak_of_block();
        return peak_of_block();
    }
};

} // namespace

TEST_CASE("jumps only: the duck window spans the jump's announcement and ends at the jump") {
    VoiceGuideRenderer r;
    r.set_config(jumps_only_config());
    const Session session = guide_session(TrackRole::Guide);
    const VoiceGuideTarget jump = jump_to_chorus();
    // Un compas de conteo + uno para el nombre = 2 compases antes del salto.
    const Frame start = kTrigger - 2 * kBar;
    CHECK_FALSE(r.ducks_guide_tracks(&session, jump, start - kSR / 10, kSR));
    CHECK(r.ducks_guide_tracks(&session, jump, start, kSR));
    CHECK(r.ducks_guide_tracks(&session, jump, kTrigger - 1, kSR));
    CHECK_FALSE(r.ducks_guide_tracks(&session, jump, kTrigger, kSR));

    VoiceGuideTarget none;
    CHECK_FALSE(r.ducks_guide_tracks(&session, none, kTrigger - 1, kSR));
}

TEST_CASE("jumps only off or voice guide off never ducks the sequence guide") {
    const Session session = guide_session(TrackRole::Guide);
    const VoiceGuideTarget jump = jump_to_chorus();
    VoiceGuideRenderer always;
    always.set_config(jumps_only_config(/*jumps_only=*/false));
    CHECK_FALSE(always.ducks_guide_tracks(&session, jump, kTrigger - 1, kSR));
    VoiceGuideRenderer disabled;
    disabled.set_config(jumps_only_config(/*jumps_only=*/true, /*enabled=*/false));
    CHECK_FALSE(disabled.ducks_guide_tracks(&session, jump, kTrigger - 1, kSR));
}

TEST_CASE("jumps only: markers and loose cues stay silent, only the jump is announced") {
    auto bank = std::make_shared<VoiceGuideClipBank>();
    bank->sample_rate = kSR;
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k) {
        bank->sections[static_cast<std::size_t>(k)].base.samples.assign(240, 0.5f);
        bank->cues[static_cast<std::size_t>(k)].samples.assign(240, 0.3f);
    }
    for (int n = 2; n < VoiceGuideClipBank::kMaxCount; ++n)
        bank->counts[static_cast<std::size_t>(n)].samples.assign(240, 0.1f * n);

    Session session = guide_session(TrackRole::Guide);
    // Marca lineal a los 6 s y un aviso suelto a los 3 s: con la voz siempre
    // activa se anunciarian los dos.
    session.songs[0].markers[0].frame = static_cast<Frame>(kSR) * 6;
    Marker cue;
    cue.id = "cue";
    cue.kind = MarkerKind::Build;
    cue.frame = static_cast<Frame>(kSR) * 3;
    session.songs[0].markers.push_back(cue);
    VoiceGuideTarget jump = jump_to_chorus();
    jump.destination_frame = 0;

    auto run = [&](bool jumps_only) {
        VoiceGuideRenderer r;
        r.set_clip_bank(bank);
        r.set_config(jumps_only_config(jumps_only));
        std::vector<float> ch(4 * kBlock);
        for (Frame start = 0; start < kTrigger; start += kBlock) {
            std::fill(ch.begin(), ch.end(), 0.f);
            float* out[4] = {ch.data(), ch.data() + kBlock, ch.data() + 2 * kBlock,
                             ch.data() + 3 * kBlock};
            r.render(out, 4, kBlock, kSR, start, &session, jump);
        }
        return r.diagnostics();
    };
    const auto always = run(false);
    CHECK(always.announcements_fired == 3);  // aviso + marca + salto
    const auto only_jumps = run(true);
    CHECK(only_jumps.announcements_fired == 1);  // solo el destino del salto
    CHECK(only_jumps.counts_fired == 4);
}

TEST_CASE("jumps only: the mixer silences a Guide track while a jump is announced") {
    Rig rig(TrackRole::Guide, jumps_only_config(), /*schedule_jump=*/true);
    CHECK(rig.peak_at(kSR * 4) > 0.1f);                 // tocando en orden: suena
    CHECK(rig.peak_at(kTrigger - kBar) < 1.0e-4f);      // durante el aviso: callada
    // Tras el salto vuelve sola (el playhead ya esta en el Coro).
    rig.peak_at(kTrigger);
    REQUIRE(rig.clock.position().frame < kTrigger);
    float after = 0.f;
    for (int i = 0; i < 20; ++i) after = rig.peak_of_block();
    CHECK(rig.clock.position().frame < kTrigger);       // aterrizo en el Coro
    CHECK(after > 0.1f);
}

TEST_CASE("jumps only: a Normal track keeps playing during the announcement") {
    Rig rig(TrackRole::Normal, jumps_only_config(), /*schedule_jump=*/true);
    CHECK(rig.peak_at(kTrigger - kBar) > 0.1f);
}

TEST_CASE("jumps only: without a scheduled jump the Guide track plays throughout") {
    Rig rig(TrackRole::Guide, jumps_only_config(), /*schedule_jump=*/false);
    CHECK(rig.peak_at(kTrigger - kBar) > 0.1f);
}
