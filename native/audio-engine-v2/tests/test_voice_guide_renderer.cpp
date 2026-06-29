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
                                             Frame total_frames, int block = 1024,
                                             VoiceGuideTarget jump = {}) {
    std::array<std::vector<float>, 4> ch;
    for (auto& c : ch) c.assign(static_cast<std::size_t>(total_frames), 0.0f);
    for (Frame start = 0; start < total_frames; start += block) {
        const int frames = static_cast<int>(std::min<Frame>(block, total_frames - start));
        float* out[4] = {
            ch[0].data() + start, ch[1].data() + start,
            ch[2].data() + start, ch[3].data() + start,
        };
        r.render(out, 4, frames, static_cast<double>(kSampleRate), start, &session, jump);
    }
    return ch;
}

// A bare song [0, 16s) with no markers (the jump target lives in the jump arg).
Session make_song_no_markers(double bpm = 120.0, int beats_per_bar = 4, int beat_unit = 4) {
    Session session;
    session.sample_rate = kSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = static_cast<Frame>(kSampleRate) * 16;
    song.bpm = bpm;
    song.beats_per_bar = beats_per_bar;
    song.beat_unit = beat_unit;
    session.songs.push_back(song);
    return session;
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

TEST_CASE("voice guide can route to a specific external mono output") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "ext:1", 1, true});
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(peak(ch[1]) > 0.05f);
    CHECK(peak(ch[0]) == doctest::Approx(0.0f));
    CHECK(peak(ch[2]) == doctest::Approx(0.0f));
    CHECK(peak(ch[3]) == doctest::Approx(0.0f));
}

TEST_CASE("voice guide fires section announcement + full count in a 4/4 lead bar") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Marker at 4s, 120 BPM, 4/4: count bar is [2s, 4s) with a full count
    // "1,2,3,4" on beats 2.0,2.5,3.0,3.5s. The section name is placed to END at
    // 2.0s (the "1"), so it fires just before it — never overlapping the count.
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);

    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    CHECK(diag.counts_fired == 4); // full count includes beat 1
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
    // 3/4: count bar has 3 beats -> full count "1,2,3" = 3 counts.
    auto session = make_session(MarkerKind::Bridge, 4.0, 120.0, 3, 4);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(r.diagnostics().counts_fired == 3);
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

TEST_CASE("two lead bars count both bars fully") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 2, true}); // lead_bars = 2
    // Marker at 6s, 120 BPM 4/4. Two lead bars = [2s, 6s): 8 beats counted
    // "1,2,3,4,1,2,3,4". Section ends at 2s (the first count), so it fires once
    // just before. (Marker at 6s leaves room for the section before 2s.)
    auto session = make_session(MarkerKind::Drop, 6.0);
    auto ch = render_all(r, session, kSampleRate * 7);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    CHECK(diag.counts_fired == 8); // full count across both lead bars
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

TEST_CASE("section announcement ends right before the count bar, no overlap") {
    // Long section clip (0.4 s) + a marked bank. At 120 BPM 4/4, marker at 4s,
    // the count bar starts at 2s. The section must be placed to end at ~2s, so
    // its audio sits entirely BEFORE the first count and they never overlap.
    auto bank = make_marked_bank();
    const int section_len = static_cast<int>(kSampleRate * 0.4); // 0.4 s
    bank->sections[static_cast<std::size_t>(MarkerKind::Chorus)]
        .base.samples.assign(section_len, 0.5f);

    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Chorus, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);

    // The section is amplitude 0.5; the counts are 0.10*n (n>=1 -> 0.1..). Find
    // the last sample of the loud (>=0.4) section audio; it must land before the
    // count bar start (2 s).
    int last_section = -1;
    const int count_bar_start = static_cast<int>(kSampleRate * 2.0);
    for (int i = 0; i < static_cast<int>(ch[2].size()); ++i)
        if (std::abs(ch[2][static_cast<std::size_t>(i)]) > 0.4f) last_section = i;
    REQUIRE(last_section >= 0);
    // Section audio ends at or just before the count bar start (allow the choke
    // fade + a few ms of slack).
    CHECK(last_section <= count_bar_start + static_cast<int>(kSampleRate * 0.03));
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

// ── Scheduled-jump announcements ─────────────────────────────────────────────

TEST_CASE("a scheduled jump announces its destination before the trigger frame") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // No markers in the song; the jump destination is supplied separately. The
    // jump fires at 4s and lands on a Chorus, so the count bar [2s,4s) names
    // "Chorus" + counts 1-4, and the jump executes on the downbeat.
    auto session = make_song_no_markers();
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;
    jump.kind = MarkerKind::Chorus;
    auto ch = render_all(r, session, kSampleRate * 6, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    CHECK(diag.counts_fired == 4);
}

TEST_CASE("a short jump still counts even when the name does not fit") {
    // Section clip is long (1.5 s); the jump is only ~1 bar (2 s at 120 BPM 4/4)
    // ahead, but the count bar needs the whole [trigger-2s, trigger). The name
    // would need to start at trigger-2s-1.5s = before frame 0 → it does NOT fit,
    // so it is skipped, but the count still plays in full.
    auto bank = make_marked_bank();
    bank->sections[static_cast<std::size_t>(MarkerKind::Verse)]
        .base.samples.assign(static_cast<int>(kSampleRate * 1.5), 0.5f);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_song_no_markers();
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 2; // count bar is [0s, 2s)
    jump.kind = MarkerKind::Verse;
    auto ch = render_all(r, session, kSampleRate * 4, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.counts_fired == 4);       // count always plays
    CHECK(diag.announcements_fired == 0); // name didn't fit, skipped
}

TEST_CASE("a jump to a Custom destination plays only the count") {
    auto bank = make_marked_bank();
    // Custom has no recording in a real bank.
    bank->sections[static_cast<std::size_t>(MarkerKind::Custom)].base.samples.clear();
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_song_no_markers();
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;
    jump.kind = MarkerKind::Custom; // no recording
    auto ch = render_all(r, session, kSampleRate * 6, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 0);
    CHECK(diag.counts_fired == 4);
}

TEST_CASE("a scheduled jump's count adapts to the time signature") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // 3/4 song: the count bar before the jump has 3 beats, so the jump is
    // counted "1,2,3" — same adaptation as the linear path, proving both routes
    // share signature_at().
    auto session = make_song_no_markers(120.0, 3, 4);
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;
    jump.kind = MarkerKind::Chorus;
    auto ch = render_all(r, session, kSampleRate * 6, 1024, jump);
    CHECK(r.diagnostics().counts_fired == 3);
}

// ── Markers and a pending jump coexist (regression) ──────────────────────────
// Bug: a pending automation jump anywhere ahead silenced every typed marker
// between the playhead and the jump — the marker announcement was an `else if`
// to the jump branch, so any active jump suppressed it. A jump further down the
// timeline must NOT stop the markers in between from being announced.

TEST_CASE("a marker is still announced when a jump is pending further ahead") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Marker at 4s; a pending jump lands far later at 12s. Both downbeats fall in
    // the rendered range, so both should announce + count (1 + 1 = 2 each).
    auto session = make_session(MarkerKind::Chorus, 4.0);
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 12;
    jump.kind = MarkerKind::Bridge;
    auto ch = render_all(r, session, kSampleRate * 14, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 2); // the marker AND the jump destination
    CHECK(diag.counts_fired == 8);        // 4 + 4
}

TEST_CASE("a jump to a region (Custom kind) leaves earlier markers announced") {
    // Real-world case: an automation cue that jumps to a region/frame carries a
    // Custom kind (no spoken name). It must not gag the section marker ahead.
    auto bank = make_marked_bank();
    bank->sections[static_cast<std::size_t>(MarkerKind::Custom)].base.samples.clear();
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    auto session = make_session(MarkerKind::Verse, 4.0);
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 12;
    jump.kind = MarkerKind::Custom; // region/frame destination → no name
    auto ch = render_all(r, session, kSampleRate * 14, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1); // the Verse marker still speaks
    CHECK(diag.counts_fired == 8);        // marker count (4) + jump count (4)
}

TEST_CASE("a jump landing on the same frame as a marker fires once, not twice") {
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Jump trigger coincides exactly with the marker frame (4s): same downbeat,
    // so it must announce + count once, not double-trigger.
    auto session = make_session(MarkerKind::Chorus, 4.0);
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;
    jump.kind = MarkerKind::Chorus;
    auto ch = render_all(r, session, kSampleRate * 6, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.announcements_fired == 1);
    CHECK(diag.counts_fired == 4);
}

// ── Dynamic cues ─────────────────────────────────────────────────────────────
// Cues (Build, All In, ...) are one-shot spoken instructions. A loose cue (away
// from any section downbeat) fires at its own frame with NO count-in. A cue that
// falls inside a section's lead window is chained before the count (name → cue →
// "1,2,3,4"), the count still landing intact on the downbeat.

// Give every cue slot a distinct amplitude (0.30) so a test can pick cue audio
// apart from sections (0.50) and counts (0.10*n).
void add_cue_clips(VoiceGuideClipBank& bank, int len = 240) {
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k)
        if (marker_kind_is_cue(static_cast<MarkerKind>(k)))
            bank.cues[static_cast<std::size_t>(k)].samples.assign(len, 0.30f);
}

// A song with one section marker and one cue marker at the given times.
Session make_session_section_and_cue(MarkerKind section_kind, double section_seconds,
                                     MarkerKind cue_kind, double cue_seconds,
                                     double bpm = 120.0) {
    auto session = make_session(section_kind, section_seconds, bpm);
    Marker cue;
    cue.id = "cue1";
    cue.name = "Cue";
    cue.kind = cue_kind;
    cue.frame = static_cast<Frame>(std::llround(cue_seconds * kSampleRate));
    session.songs[0].markers.push_back(cue);
    return session;
}

TEST_CASE("a loose dynamic cue fires once as a one-shot with no count-in") {
    auto bank = make_marked_bank();
    add_cue_clips(*bank);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Only a cue at 4s, far from any section. It should speak once at 4s and not
    // trigger any count (counts are a section-only behaviour).
    Session session = make_song_no_markers();
    Marker cue;
    cue.id = "cue1";
    cue.name = "Build";
    cue.kind = MarkerKind::Build;
    cue.frame = static_cast<Frame>(kSampleRate) * 4;
    session.songs[0].markers.push_back(cue);

    auto ch = render_all(r, session, kSampleRate * 6);
    auto diag = r.diagnostics();
    CHECK(onsets(ch[2]) == 1);          // exactly one spoken clip
    CHECK(diag.counts_fired == 0);      // no count-in for a cue
    CHECK(diag.announcements_fired == 1);
}

TEST_CASE("a cue kind with no recording in this bank stays silent") {
    // No cue clips loaded (English-only cue absent in this language, say).
    VoiceGuideRenderer r;
    r.set_clip_bank(make_marked_bank());   // sections+counts only, no cues
    r.set_config({true, 1.0f, "monitor", 1, true});
    Session session = make_song_no_markers();
    Marker cue;
    cue.id = "cue1";
    cue.kind = MarkerKind::WorshipFreely;
    cue.frame = static_cast<Frame>(kSampleRate) * 4;
    session.songs[0].markers.push_back(cue);
    auto ch = render_all(r, session, kSampleRate * 6);
    CHECK(peak(ch[2]) == doctest::Approx(0.0f));
    CHECK(r.diagnostics().announcements_fired == 0);
}

TEST_CASE("a cue in a section's lead window is chained before the intact count") {
    auto bank = make_marked_bank();
    add_cue_clips(*bank);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Section (Chorus) at 4s; cue (Build) at the same downbeat (4s). 120 BPM 4/4:
    // count bar [2s,4s). The cue is chained into the lead-in, so the count must
    // STILL be a full "1,2,3,4" landing on the 4s downbeat — unchanged by the cue.
    auto session =
        make_session_section_and_cue(MarkerKind::Chorus, 4.0, MarkerKind::Build, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    auto diag = r.diagnostics();
    CHECK(diag.counts_fired == 4);                 // count unchanged by the cue
    // Section name + chained cue both spoke (2 announcements). The cue must NOT
    // also fire as a loose one-shot (that would be a 3rd).
    CHECK(diag.announcements_fired == 2);
    // Cue audio (0.30) is present somewhere before the count bar.
    bool cue_audio = false;
    for (int i = 0; i < static_cast<int>(kSampleRate * 2.0); ++i)
        if (std::abs(ch[2][static_cast<std::size_t>(i)]) > 0.25f
            && std::abs(ch[2][static_cast<std::size_t>(i)]) < 0.35f)
            cue_audio = true;
    CHECK(cue_audio);
}

TEST_CASE("the chained cue does not displace the count off the downbeat") {
    auto bank = make_marked_bank();
    add_cue_clips(*bank);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, false}); // section+cue only, no count noise
    auto session =
        make_session_section_and_cue(MarkerKind::Verse, 4.0, MarkerKind::AllIn, 4.0);
    auto ch = render_all(r, session, kSampleRate * 6);
    // Both the section (amplitude ~0.50) and the cue (~0.30) speak. They play
    // back-to-back (Playback-style, no gap), so rather than counting onsets we
    // assert both distinct amplitudes appear in the output, and that all audio
    // lands before the 4s downbeat (count-in off → nothing after it).
    bool saw_section = false;
    bool saw_cue = false;
    int last_audible = -1;
    for (int i = 0; i < static_cast<int>(ch[2].size()); ++i) {
        const float a = std::abs(ch[2][static_cast<std::size_t>(i)]);
        if (a > 0.02f) last_audible = i;
        if (a > 0.40f) saw_section = true;            // 0.50 * 0.9 ≈ 0.45
        if (a > 0.20f && a < 0.35f) saw_cue = true;   // 0.30 * 0.9 ≈ 0.27
    }
    CHECK(saw_section);
    CHECK(saw_cue);
    CHECK(last_audible <= static_cast<int>(kSampleRate * 4.0));
}

TEST_CASE("a scheduled jump chains a cue attached to its destination marker") {
    auto bank = make_marked_bank();
    add_cue_clips(*bank);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    // The jump TRIGGERS at 4s (count bar [2s,4s)) and lands on a Solo whose
    // marker sits at 10s with a Guitar cue on the same downbeat. The cue lives
    // near the DESTINATION (10s), far from the trigger, yet it must still be
    // chained into the announcement — this is the "jump to Solo+Guitar only
    // said Solo" bug. The count still lands intact at the 4s trigger.
    Session session = make_song_no_markers();
    Marker cue;
    cue.id = "cue1";
    cue.kind = MarkerKind::Guitar;
    cue.frame = static_cast<Frame>(kSampleRate) * 10;
    session.songs[0].markers.push_back(cue);

    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;        // trigger
    jump.destination_frame = static_cast<Frame>(kSampleRate) * 10; // lands here
    jump.kind = MarkerKind::Solo;
    auto ch = render_all(r, session, kSampleRate * 6, 1024, jump);
    auto diag = r.diagnostics();
    CHECK(diag.counts_fired == 4);          // count unchanged by the cue
    // Section name (Solo) AND the chained Guitar cue both speak (2 announcements).
    CHECK(diag.announcements_fired == 2);
    bool saw_cue = false;
    for (int i = 0; i < static_cast<int>(kSampleRate * 2.0); ++i) {
        const float a = std::abs(ch[2][static_cast<std::size_t>(i)]);
        if (a > 0.20f && a < 0.35f) saw_cue = true; // cue amplitude 0.30 * 0.9
    }
    CHECK(saw_cue);
}

TEST_CASE("a jump-chained cue is NOT re-announced when the playhead reaches it") {
    auto bank = make_marked_bank();
    add_cue_clips(*bank);
    VoiceGuideRenderer r;
    r.set_clip_bank(bank);
    r.set_config({true, 1.0f, "monitor", 1, true});
    // Sequence: announce a jump to Solo@10s (with a Guitar cue@10s) during the
    // lead-in before the 4s trigger; the cue is spoken chained. Then the jump
    // fires — the playhead jumps to 10s — and plays linearly THROUGH the cue's
    // real position. The Guitar cue must not be spoken a second time.
    Session session = make_song_no_markers();
    Marker cue;
    cue.id = "cue1";
    cue.kind = MarkerKind::Guitar;
    cue.frame = static_cast<Frame>(kSampleRate) * 10;
    session.songs[0].markers.push_back(cue);
    // Make the song long enough to contain frame 10s + a bit.
    session.songs[0].end_frame = static_cast<Frame>(kSampleRate) * 20;

    const int block = 1024;
    const double sr = static_cast<double>(kSampleRate);
    auto render_window = [&](Frame start, Frame count, const VoiceGuideTarget& jt) {
        std::array<std::vector<float>, 4> ch;
        for (auto& c : ch) c.assign(static_cast<std::size_t>(count), 0.0f);
        for (Frame off = 0; off < count; off += block) {
            const int frames =
                static_cast<int>(std::min<Frame>(block, count - off));
            float* out[4] = {ch[0].data() + off, ch[1].data() + off,
                             ch[2].data() + off, ch[3].data() + off};
            r.render(out, 4, frames, sr, start + off, &session, jt);
        }
        return ch;
    };

    // 1) Lead-in + trigger: render [0, 4.1s) with the jump active. The cue is
    //    chained here.
    VoiceGuideTarget jump;
    jump.active = true;
    jump.at_frame = static_cast<Frame>(kSampleRate) * 4;
    jump.destination_frame = static_cast<Frame>(kSampleRate) * 10;
    jump.kind = MarkerKind::Solo;
    render_window(0, static_cast<Frame>(kSampleRate * 4.1), jump);
    const uint64_t after_leadin = r.diagnostics().announcements_fired;
    CHECK(after_leadin >= 2); // Solo + Guitar chained

    // 2) Jump executes: playhead lands at 10s (discontinuity → reset_voices).
    //    Render [10s, 11s) linearly with NO active jump. The cue at 10s must be
    //    suppressed exactly once, so announcements_fired does NOT grow.
    VoiceGuideTarget none;
    auto ch2 =
        render_window(static_cast<Frame>(kSampleRate) * 10, kSampleRate, none);
    CHECK(r.diagnostics().announcements_fired == after_leadin); // no repeat
    CHECK(peak(ch2[2]) == doctest::Approx(0.0f));               // silence
}
