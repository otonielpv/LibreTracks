#include <doctest/doctest.h>
#include <lt_engine/render/voice_guide_renderer.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

using namespace lt;

namespace {

constexpr int kSampleRate = 48000;

// A song [0, 16s) at the given tempo/signature with one section marker.
Session make_session(MarkerKind kind, double marker_seconds, double bpm = 120.0,
                     int beats_per_bar = 4, int beat_unit = 4, int variant = 0) {
    Session session;
    session.sample_rate = kSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = static_cast<Frame>(kSampleRate) * 16;
    song.bpm = bpm;
    song.beats_per_bar = beats_per_bar;
    song.beat_unit = beat_unit;
    Marker marker;
    marker.id = "m1";
    marker.name = "Section";
    marker.kind = kind;
    marker.variant = variant;
    marker.frame = static_cast<Frame>(std::llround(marker_seconds * kSampleRate));
    song.markers.push_back(marker);
    session.songs.push_back(song);
    return session;
}

// Clip bank where every clip is a short DC pulse whose amplitude encodes the
// slot, so a test can tell *which* clip fired from the output samples.
//   section[kind] -> amplitude 0.50
//   count[n]      -> amplitude 0.10 * n  (n = 2..)
std::shared_ptr<VoiceGuideClipBank> make_marked_bank() {
    auto bank = std::make_shared<VoiceGuideClipBank>();
    bank->sample_rate = kSampleRate;
    const int len = 240; // 5 ms clip
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k)
        bank->sections[static_cast<std::size_t>(k)].base.samples.assign(len, 0.50f);
    for (int n = 2; n < VoiceGuideClipBank::kMaxCount; ++n)
        bank->counts[static_cast<std::size_t>(n)].samples.assign(len, 0.10f * static_cast<float>(n));
    return bank;
}

float peak(const std::vector<float>& s) {
    float p = 0.0f;
    for (float v : s) p = std::max(p, std::abs(v));
    return p;
}

// Count distinct onsets (rising edges out of silence) with a refractory gap.
int onsets(const std::vector<float>& s, float threshold = 0.02f) {
    int count = 0;
    int silence = 10000;
    for (float v : s) {
        if (std::abs(v) > threshold) {
            if (silence > 64) ++count;
            silence = 0;
        } else {
            ++silence;
        }
    }
    return count;
}

// Render the whole [0, total_frames) range in fixed blocks into 4 channels
// (so the monitor bus, channels 2-3, exists). Returns the 4 channel buffers.
std::array<std::vector<float>, 4> render_all(VoiceGuideRenderer& r, const Session& session,
                                             Frame total_frames, int block = 1024) {
    std::array<std::vector<float>, 4> ch;
    for (auto& c : ch) c.assign(static_cast<std::size_t>(total_frames), 0.0f);
    for (Frame start = 0; start < total_frames; start += block) {
        const int frames = static_cast<int>(std::min<Frame>(block, total_frames - start));
        float* out[4] = {
            ch[0].data() + start, ch[1].data() + start,
            ch[2].data() + start, ch[3].data() + start,
        };
        r.render(out, 4, frames, static_cast<double>(kSampleRate), start, &session);
    }
    return ch;
}

} // namespace

TEST_CASE("voice guide disabled produces silence") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(peak(ch[2]) == doctest::Approx(0.0f));
    CHECK(peak(ch[3]) == doctest::Approx(0.0f));
}

TEST_CASE("voice guide routes to the monitor bus, not master") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    // Audio appears on channels 2-3 (monitor) and nothing leaks to 0-1 (master).
    CHECK(peak(ch[2]) > 0.05f);
    CHECK(peak(ch[3]) > 0.05f);
    CHECK(peak(ch[0]) == doctest::Approx(0.0f));
    CHECK(peak(ch[1]) == doctest::Approx(0.0f));
}

TEST_CASE("voice guide fires section + count clips in a 4/4 lead bar") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Marker at 4s, 120 BPM, 4/4: lead bar is [2s, 4s). Expect 4 onsets:
    // section on beat 1 (2.0s) + counts on beats 2,3,4 (2.5,3.0,3.5s).
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(onsets(ch[2]) == 4);

    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    CHECK(diag.counts_fired == 3);
}

TEST_CASE("diagnostics report the upcoming marker kind while it is still ahead") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Chorus, 4.0);
    // Render only up to 3.5s so the 4s marker is still upcoming at the last block.
    render_all(r, session, static_cast<Frame>(kSampleRate * 3.5));
    CHECK(r.diagnostics().next_marker_kind == "chorus");
}

TEST_CASE("count-in disabled fires only the section clip") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, false}); // count_in_enabled = false
    auto session = make_session(MarkerKind::Verse, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(onsets(ch[2]) == 1);
    CHECK(r.diagnostics().counts_fired == 0);
}

TEST_CASE("count adapts to a 3/4 time signature") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // 3/4: lead bar has 3 beats -> section + 2 counts = 3 onsets.
    auto session = make_session(MarkerKind::Bridge, 4.0, 120.0, 3, 4);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(onsets(ch[2]) == 3);
    CHECK(r.diagnostics().counts_fired == 2);
}

TEST_CASE("a Custom marker has no recording and stays silent") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Custom, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(peak(ch[2]) == doctest::Approx(0.0f));
    CHECK(r.diagnostics().announcements_fired == 0);
}

TEST_CASE("no clip bank means silence even when enabled") {
    VoiceGuideRenderer r;
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(peak(ch[2]) == doctest::Approx(0.0f));
    CHECK(r.diagnostics().bank_loaded == false);
}

TEST_CASE("two lead bars announce one bar earlier") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 2, true}); // lead_bars = 2
    // Marker at 4s, 120 BPM 4/4. Two lead bars = [0s, 4s): 8 beats ->
    // section on beat 1 + counts on the other 7 beats-in-bar (2,3,4 twice... )
    // Section fires once; counts fire on every non-downbeat-1 beat = 6.
    auto session = make_session(MarkerKind::Drop, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    // 8 lead beats, beat indices b=0..7; section at b=0, counts where
    // (b % 4)+1 >= 2 -> b in {1,2,3,5,6,7} = 6 counts.
    CHECK(diag.counts_fired == 6);
}

// Find the amplitude of the section onset (beat 1 of the lead bar). The marked
// bank uses base=0.50 and we set a distinct variant amplitude to tell them apart.
float section_onset_amplitude(const std::vector<float>& s) {
    for (float v : s)
        if (std::abs(v) > 0.02f) return std::abs(v);
    return 0.0f;
}

TEST_CASE("a numbered variant plays its own clip when present") {
    auto bank = make_marked_bank();
    // Give Chorus variant 2 a distinct amplitude (0.70 vs base 0.50).
    bank->sections[static_cast<std::size_t>(MarkerKind::Chorus)]
        .variants[2].samples.assign(240, 0.70f);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, false}); // section only, no count noise
    auto session = make_session(MarkerKind::Chorus, 4.0, 120.0, 4, 4, /*variant=*/2);
    auto ch = render_all(r, session, kSampleRate * 6);
    // Section onset amplitude should be the variant's 0.70, not the base 0.50.
    CHECK(section_onset_amplitude(ch[2]) == doctest::Approx(0.70f * 0.9f).epsilon(0.05));
}

TEST_CASE("a numbered variant falls back to the base clip when absent") {
    // Bank has only base clips (no variant 3 for Verse).
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, false});
    auto session = make_session(MarkerKind::Verse, 4.0, 120.0, 4, 4, /*variant=*/3);
    auto ch = render_all(r, session, kSampleRate * 6);
    // Falls back to base amplitude 0.50.
    CHECK(section_onset_amplitude(ch[2]) == doctest::Approx(0.50f * 0.9f).epsilon(0.05));
}

TEST_CASE("choke prevents overlapping voices from summing") {
    // A bank whose clips are LONG (1 s) so, without choke, the section clip
    // would still be playing when the count clips fire and they would sum to
    // ~2x amplitude. With choke the new clip silences the previous one, so the
    // peak stays near a single voice (0.5 * gain 0.9 = 0.45), never ~0.9+.
    auto bank = std::make_shared<VoiceGuideClipBank>();
    bank->sample_rate = kSampleRate;
    const int len = kSampleRate; // 1 s clips
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k)
        bank->sections[static_cast<std::size_t>(k)].base.samples.assign(len, 0.5f);
    for (int n = 2; n < VoiceGuideClipBank::kMaxCount; ++n)
        bank->counts[static_cast<std::size_t>(n)].samples.assign(len, 0.5f);

    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Fast tempo so beats are 0.25 s apart but clips are 1 s — heavy overlap
    // territory without choke.
    auto session = make_session(MarkerKind::Chorus, 4.0, 240.0, 4, 4);
    auto ch = render_all(r, session, kSampleRate * 6);
    // A single voice is 0.5 * gain 0.9 = 0.45. Two summed voices ~0.9. With the
    // ~20 ms choke crossfade, samples above the single-voice level should only
    // appear in those brief fade windows — never sustained for whole beats as
    // they would without choke. Assert the overlap fraction is tiny.
    int overlapping = 0;
    int audible = 0;
    for (float v : ch[2]) {
        if (std::abs(v) > 0.02f) ++audible;
        if (std::abs(v) > 0.55f) ++overlapping;
    }
    REQUIRE(audible > 0);
    const double overlap_fraction =
        static_cast<double>(overlapping) / static_cast<double>(audible);
    // 20 ms fades across a handful of beats vs ~1 s of audible voice → well
    // under 10% overlap. Without choke this would be the majority of the buffer.
    CHECK(overlap_fraction < 0.1);
}
