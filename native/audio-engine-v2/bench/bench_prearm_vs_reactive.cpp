// bench_prearm_vs_reactive.cpp
//
// Compares end-to-end seek latency between two paths:
//
//   REACTIVE: at jump time, call BungeeVoiceManager::rebuild_for_seek
//   synchronously, then render blocks until first non-zero output.
//
//   PREARMED: build PrearmedJumpManager prepared sets ahead of time
//   (off the audio-thread clock). At jump time, take_ready + swap_in +
//   render until first non-zero output.
//
// The metric is wall-clock from "jump fired" to "first audible output."
// This includes:
//   - the voice-construction cost the audio thread pays (or doesn't, if
//     prearm already did it)
//   - Bungee's structural ~85 ms latency window (same for both paths but
//     prefeed-equipped prearm fills the first block so the window is gone)
//
// Run: bench_prearm_vs_reactive.exe
//
// Output: a single table for several voice counts.

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int   kSR           = 48000;
constexpr int   kCh           = 2;
constexpr int   kBlockFrames  = 480;
constexpr Frame kClipLen      = 48000 * 30; // 30s source per track
constexpr Frame kJumpTarget   = 48000;       // jump to 1s into the timeline
constexpr Semitones kSemitones = -2;
constexpr float kSilenceThresh = 1.0e-4f;

std::ofstream g_log;
void out(const char* fmt, ...) {
    char buf[1024];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    std::fputs(buf, stdout); std::fflush(stdout);
    if (g_log.is_open()) { g_log << buf; g_log.flush(); }
}

std::vector<float> make_sine(Frame n_frames) {
    std::vector<float> samples(static_cast<std::size_t>(n_frames) * kCh, 0.0f);
    for (Frame f = 0; f < n_frames; ++f) {
        const float v = 0.5f * std::sin(2.0f * 3.14159265358979f * 440.0f
                                          * static_cast<float>(f) / kSR);
        samples[static_cast<std::size_t>(f) * kCh]     = v;
        samples[static_cast<std::size_t>(f) * kCh + 1] = v;
    }
    return samples;
}

void build_session(int n_voices, SourceManager& sources, Session& session) {
    Song song;
    song.id = "song-bench";
    song.start_frame = 0;
    song.end_frame = kClipLen;
    song.transpose_semitones = kSemitones;
    song.markers.push_back(Marker{"marker-1", "M1", kJumpTarget});

    auto samples = make_sine(kClipLen);
    for (int v = 0; v < n_voices; ++v) {
        const std::string src_id = "src-" + std::to_string(v);
        sources.register_source(src_id, "");
        sources.store_decoded_source(src_id, samples, kCh, kSR, kClipLen);

        Track track;
        track.id = "track-" + std::to_string(v);
        track.gain = 1.0f;
        track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
        track.clips.push_back(Clip{"clip-" + std::to_string(v),
                                    src_id, 0, 0, kClipLen});
        song.tracks.push_back(std::move(track));
    }
    session.songs.push_back(std::move(song));
}

// Render blocks until we see meaningful output (rms > kSilenceThresh).
// Returns frame index of the block where audio appeared, or -1 if it
// didn't appear within the max budget. Reuses a single TrackRenderer
// instance to mirror audio-thread behaviour.
struct RenderUntilResult {
    long long total_us           = -1; // wall-clock from start of scan
    int       blocks_to_audio    = -1; // 0-based block index where rms > thresh
    int       blocks_rendered    = 0;
};
RenderUntilResult render_until_audio(const Song& song,
                                      const SourceManager& sources,
                                      BungeeVoiceManager& bvm,
                                      int max_blocks) {
    RenderUntilResult r;
    TrackRenderer renderer;
    renderer.prepare(kBlockFrames);

    std::vector<float> mixL(static_cast<std::size_t>(kBlockFrames), 0.f);
    std::vector<float> mixR(static_cast<std::size_t>(kBlockFrames), 0.f);
    const auto t_start = Clock::now();

    for (int b = 0; b < max_blocks; ++b) {
        const Frame tl = kJumpTarget + Frame(b * kBlockFrames);
        std::fill(mixL.begin(), mixL.end(), 0.f);
        std::fill(mixR.begin(), mixR.end(), 0.f);

        for (const auto& track : song.tracks) {
            std::vector<float> L(static_cast<std::size_t>(kBlockFrames), 0.f);
            std::vector<float> R(static_cast<std::size_t>(kBlockFrames), 0.f);
            float* out[2] = {L.data(), R.data()};
            renderer.render(track, tl, kBlockFrames, out, kCh, sources,
                            /*pc*/ nullptr, /*pe*/ nullptr, &bvm,
                            kSR, kSemitones, /*active_song*/ nullptr);
            for (int i = 0; i < kBlockFrames; ++i) {
                mixL[static_cast<std::size_t>(i)] += L[static_cast<std::size_t>(i)];
                mixR[static_cast<std::size_t>(i)] += R[static_cast<std::size_t>(i)];
            }
        }
        ++r.blocks_rendered;

        double sum_sq = 0.0;
        for (int i = 0; i < kBlockFrames; ++i) {
            sum_sq += mixL[static_cast<std::size_t>(i)] * mixL[static_cast<std::size_t>(i)];
            sum_sq += mixR[static_cast<std::size_t>(i)] * mixR[static_cast<std::size_t>(i)];
        }
        const float rms = static_cast<float>(std::sqrt(sum_sq / (2.0 * kBlockFrames)));
        if (rms > kSilenceThresh && r.blocks_to_audio < 0) {
            r.blocks_to_audio = b;
            r.total_us = std::chrono::duration_cast<std::chrono::microseconds>(
                Clock::now() - t_start).count();
            // Don't break — keep rendering to amortize Bungee state, but we
            // have what we need. Actually break is fine — no warm-up effect.
            break;
        }
    }
    return r;
}

void bench_one(int n_voices) {
    SourceManager sources;
    Session       session;
    build_session(n_voices, sources, session);

    // ── Reactive path ────────────────────────────────────────────────────
    BungeeVoiceManager bvm_reactive;
    bvm_reactive.prepare(kSR, kCh, kBlockFrames);
    const auto t_reactive_start = Clock::now();
    bvm_reactive.rebuild_for_seek(kJumpTarget, session, sources);
    const long long reactive_rebuild_us = std::chrono::duration_cast<std::chrono::microseconds>(
        Clock::now() - t_reactive_start).count();
    auto reactive = render_until_audio(session.songs[0], sources,
                                        bvm_reactive, /*max_blocks*/ 50);

    // ── Prearmed path ────────────────────────────────────────────────────
    BungeeVoiceManager bvm_prearm;
    bvm_prearm.prepare(kSR, kCh, kBlockFrames);

    PrearmedJumpManager prearm;
    prearm.prepare(kSR, kCh, kBlockFrames);
    const auto t_prearm_build_start = Clock::now();
    prearm.prepare_all_targets(session, sources, /*revision*/ 1);
    const long long prearm_build_us = std::chrono::duration_cast<std::chrono::microseconds>(
        Clock::now() - t_prearm_build_start).count();

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-bench";
    key.target_id        = "marker-1";
    key.timeline_frame   = kJumpTarget;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    const auto t_prearm_jump_start = Clock::now();
    auto prepared = prearm.take_ready(key);
    if (prepared) {
        bvm_prearm.swap_in_prepared_voices(prepared->extract_voice_map());
    }
    const long long prearm_swap_us = std::chrono::duration_cast<std::chrono::microseconds>(
        Clock::now() - t_prearm_jump_start).count();
    auto prearmed = render_until_audio(session.songs[0], sources,
                                        bvm_prearm, /*max_blocks*/ 50);

    out("%-8d %-14lld %-14lld %-14lld %-14d %-14lld %-14lld %-14d\n",
        n_voices,
        reactive_rebuild_us / 1000,
        (long long)0,
        reactive.total_us / 1000,
        reactive.blocks_to_audio,
        prearm_build_us / 1000,
        prearm_swap_us / 1000,
        prearmed.blocks_to_audio);
}

} // namespace

int main() {
    g_log.open("C:\\Users\\otoni\\bench_prearm.txt");
    out("[bench] logging to C:\\Users\\otoni\\bench_prearm.txt\n");

    out("================================================================\n");
    out("Prearmed vs Reactive seek latency\n");
    out("48 kHz, 480-frame block, -2 semitones, 30s sine source per voice\n");
    out("================================================================\n");
    out("%-8s %-14s %-14s %-14s %-14s %-14s %-14s %-14s\n",
        "voices",
        "reactive_re",     // ms — rebuild_for_seek on jump
        "reactive_sw",     // ms — N/A for reactive (no separate swap)
        "reactive_t1",     // ms — total wall-clock to first audio
        "reactive_blk",    // block index of first audio
        "prearm_build",    // ms — prepare_all_targets cost (pays once, ahead of time)
        "prearm_swap",     // ms — take_ready + swap on jump
        "prearm_blk");     // block index of first audio
    out("(*) reactive_re + render = reactive_t1; prearm_swap is the\n");
    out("    USER-VISIBLE jump cost (prearm_build was paid earlier).\n");
    out("----------------------------------------------------------------\n");

    for (int n : {1, 4, 9}) bench_one(n);

    out("\n");
    return 0;
}
