// Fidelity of the prepared-audio strategy across seeks.
//
// Renders the SAME timeline twice — once through live warp/pitch DSP, once
// reading the prepared WAV as a direct clip — driving both with the real
// CmdSeekAbsolute / CmdPlay / CmdPause handlers, and writes the raw output so
// scripts/report-audio-fidelity.mjs can measure alignment, envelope error and
// discontinuities.
//
// It deliberately does NOT assert sample equality. The live route rebuilds
// Bungee voices at the seek target while the prepared file carries the history
// of one continuous render from frame 0, so their phase differs by
// construction. Deciding which difference is acceptable is the analyzer's job.
//
// The seek runs synchronously between two renders instead of on a concurrent
// thread: that keeps both routes on an identical block-by-block timeline, so a
// difference in the audio cannot be an artefact of when the command landed.
// Concurrent seek latency is what bench_streaming_playback measures.
//
// Disk is removed from the experiment on purpose: the whole source is resident
// before the capture and any cache miss inside the measured window aborts the
// run. A starved block must never be reported as a fidelity difference.
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include "streaming_benchmark_engine.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;
constexpr int kSampleRate = 48000;

namespace {

// The first four move the transport. The last three move a mixer control while
// playing: the prepared file is written BEFORE gain, pan and mute, so those must
// still act on it exactly as they act on the live route. Nothing proves that
// today — the boundary is documented and never measured.
enum class Scenario { Start, Forward, Backward, Resume, None, Gain, Pan, Mute };

Scenario parse_scenario(const std::string& name) {
    if (name == "start") return Scenario::Start;
    if (name == "forward") return Scenario::Forward;
    if (name == "backward") return Scenario::Backward;
    if (name == "resume") return Scenario::Resume;
    if (name == "none") return Scenario::None;
    if (name == "gain") return Scenario::Gain;
    if (name == "pan") return Scenario::Pan;
    if (name == "mute") return Scenario::Mute;
    throw std::runtime_error(
        "Scenario must be start, forward, backward, resume, none, gain, pan or mute");
}

bool moves_transport(Scenario scenario) noexcept {
    return scenario == Scenario::Start || scenario == Scenario::Forward
        || scenario == Scenario::Backward || scenario == Scenario::Resume;
}

// Half gain is exactly -6,02 dB, a value a wrong result cannot land on by
// accident; hard left and mute are the unambiguous ends of the other two.
constexpr float kGainUnderTest = 0.5f;
constexpr float kPanUnderTest = -1.0f;

// `none` runs the identical capture and touches nothing. It exists because the
// level before and after the event is NOT the same material: at warp 1,2 the
// two half-second windows land on different parts of the fixture, and the
// material's own change is several dB. Without subtracting this reference,
// halving the gain reads as +2,15 dB. It is the reference of an A/B, not a
// scenario anybody needs to look at on its own.

// Resident before the capture so playback never reads from disk. Waiting here
// is the point: a miss during the window would be indistinguishable from a
// fidelity difference in the analyzer.
void make_resident(SourceManager& sources, const Id& id) {
    const auto source = sources.get_shared(id);
    if (!source) throw std::runtime_error("Source not installed: " + id);
    const Frame duration = source->duration_frames();
    if (duration <= 0 || duration > 0x7fffffff)
        throw std::runtime_error("Unusable source length: " + id);
    sources.request_range(id, 0, static_cast<int>(duration), true);
    const auto deadline = Clock::now() + std::chrono::seconds(60);
    while (!source->is_range_ready(0, static_cast<int>(duration))) {
        if (Clock::now() > deadline) throw std::runtime_error("Residency timeout: " + id);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
}

} // namespace

int main(int argc, char** argv) try {
    if (argc != 9) throw std::runtime_error(
        "Usage: bench_fidelity_jump SOURCE_DIR OUT_DIR BLOCK ROUTE(live|prepared) "
        "SCENARIO(start|forward|backward|resume|none|gain|pan|mute) RATIO SEMITONES TIMELINE_SECONDS");
    const std::filesystem::path source_dir(argv[1]);
    const std::filesystem::path out_dir(argv[2]);
    const int block = std::stoi(argv[3]);
    const std::string route = argv[4];
    const std::string scenario_name = argv[5];
    const Scenario scenario = parse_scenario(scenario_name);
    const double ratio = std::stod(argv[6]);
    const int semitones = std::stoi(argv[7]);
    const int seconds = std::stoi(argv[8]);
    if (route != "live" && route != "prepared")
        throw std::runtime_error("Route must be live or prepared");
    if ((block != 128 && block != 512) || !std::isfinite(ratio) || ratio < 0.5 || ratio > 2.0
        || semitones < -12 || semitones > 12 || seconds < 20 || seconds > 300)
        throw std::runtime_error("Invalid fidelity configuration");
    std::filesystem::create_directories(out_dir);

    const bool live = route == "live";
    const Frame timeline_frames = Frame(seconds) * kSampleRate;
    // Every scenario is anchored the same way so the two routes and the four
    // scenarios stay comparable: 2 s of settled playback, one event, 4 s after.
    //
    // The four positions are chosen so that every event lands on continuous
    // material. At warp 1,2 these read source seconds 4,8 / 36 / 14,4 / 7,2,
    // which fall on the fixture's tone, tone, bursts and chirp. An earlier
    // anchor put the start on the impulse window — sparse single frames on
    // digital silence — and the comparison then reported a 2,9 dB "settling
    // transient" measured between −52 and −140 dBFS, where there was nothing
    // to compare. Moving a position here means re-checking where it lands.
    const Frame anchor = Frame(4) * kSampleRate;
    const Frame forward_target = Frame(30) * kSampleRate;
    const Frame backward_target = Frame(12) * kSampleRate;
    const int pre_blocks = (2 * kSampleRate) / block;
    const int post_blocks = (4 * kSampleRate) / block;
    const int total_blocks = pre_blocks + post_blocks;

    StreamingBenchmarkEngine engine;
    SourceManager& sources = engine.sources();
    auto session = std::make_shared<Session>();
    session->id = "fidelity";
    session->sample_rate = kSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = timeline_frames;
    song.bpm = 120.0;
    Region region;
    region.id = "region";
    region.start_frame = 0;
    region.end_frame = timeline_frames;
    // The prepared file already contains warp and pitch; replaying it through
    // the DSP again would measure the wrong thing.
    region.warp_enabled = live;
    region.warp_source_bpm = live ? song.bpm / ratio : song.bpm;
    region.transpose_semitones = static_cast<Semitones>(live ? semitones : 0);
    song.regions.push_back(region);

    const Id id = "fidelity-source";
    const auto path = (source_dir / "0.wav").string();
    sources.register_source(id, path);
    if (!sources.try_install_native_file(id, kSampleRate))
        throw std::runtime_error("Cannot stream native file: " + path);
    const auto source = sources.get_shared(id);
    const Frame source_needed = live
        ? static_cast<Frame>(std::ceil(timeline_frames * ratio)) + kSampleRate
        : timeline_frames;
    if (!source || source->channel_count() != 2 || source->duration_frames() < source_needed)
        throw std::runtime_error("Source must be stereo and long enough for the timeline: " + path);

    Track track;
    track.id = "track";
    track.gain = 1.0f;
    track.pan = 0.0f;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip", id, 0, 0, timeline_frames, 1.0f});
    song.tracks.push_back(std::move(track));
    session->songs.push_back(std::move(song));
    engine.prepare(session, block);
    make_resident(sources, id);

    // Start exactly as the application does: SeekAbsolute to the position while
    // stopped, then Play (apps/desktop/src-tauri/src/audio/engine.rs::play).
    engine.seek(anchor);
    engine.play();
    const Frame misses_before = sources.total_cache_miss_frames();
    TrackRenderer::reset_diagnostics();
    const auto voices_before = engine.voice_diagnostics();

    auto& mixer = engine.mixer();
    std::vector<float> left(block), right(block);
    float* output[] = {left.data(), right.data()};
    std::vector<float> capture;
    capture.reserve(static_cast<std::size_t>(total_blocks) * block * 2);
    std::vector<long long> timeline;
    timeline.reserve(total_blocks);
    double max_abs = 0;
    int event_block = pre_blocks;
    Frame event_target = anchor;

    for (int b = 0; b < total_blocks; ++b) {
        if (b == pre_blocks) {
            switch (scenario) {
                case Scenario::Start:
                    // No event here: the measured event is the start itself.
                    event_block = 0;
                    break;
                case Scenario::Forward:
                    event_target = forward_target;
                    engine.seek(forward_target);
                    break;
                case Scenario::Backward:
                    event_target = backward_target;
                    engine.seek(backward_target);
                    break;
                case Scenario::Resume:
                    // Resume the way the app resumes: Pause, then the
                    // unconditional SeekAbsolute(current) that precedes Play.
                    engine.pause();
                    event_target = engine.position();
                    engine.seek(event_target);
                    engine.play();
                    break;
                case Scenario::None:
                    break;  // The reference: same capture, nothing touched.
                // The transport does not move for these: the capture stays on
                // the same timeline and only the mixer control changes.
                case Scenario::Gain:
                    engine.command(CmdSetTrackGain{"track", kGainUnderTest});
                    break;
                case Scenario::Pan:
                    engine.command(CmdSetTrackPan{"track", kPanUnderTest});
                    break;
                case Scenario::Mute:
                    engine.command(CmdSetTrackMute{"track", true});
                    break;
            }
        }
        timeline.push_back(static_cast<long long>(engine.position()));
        mixer.render(output, 2, block, kSampleRate);
        for (int f = 0; f < block; ++f) {
            capture.push_back(left[f]);
            capture.push_back(right[f]);
            max_abs = std::max({max_abs, std::abs(double(left[f])), std::abs(double(right[f]))});
        }
    }

    const auto misses = sources.total_cache_miss_frames() - misses_before;
    const auto diag = TrackRenderer::diagnostics();
    const auto voices = engine.voice_diagnostics();
    const std::string stem = route + "-" + scenario_name + "-b" + std::to_string(block);
    {
        std::ofstream raw(out_dir / (stem + ".f32"), std::ios::binary);
        raw.write(reinterpret_cast<const char*>(capture.data()),
                  static_cast<std::streamsize>(capture.size() * sizeof(float)));
        raw.close();
        if (!raw) throw std::runtime_error("Capture write failed");
    }
    std::ofstream json(out_dir / (stem + ".json"));
    if (!json) throw std::runtime_error("Cannot create JSON");
    json << "{\"route\":\"" << route << "\",\"scenario\":\"" << scenario_name
         << "\",\"block\":" << block << ",\"sample_rate\":" << kSampleRate
         << ",\"warp_ratio\":" << (live ? ratio : 1.0)
         << ",\"semitones\":" << (live ? semitones : 0)
         << ",\"timeline_seconds\":" << seconds
         << ",\"anchor_frame\":" << anchor << ",\"event_target_frame\":" << event_target
         << ",\"pre_blocks\":" << pre_blocks << ",\"post_blocks\":" << post_blocks
         << ",\"event_block\":" << event_block
         << ",\"moves_transport\":" << (moves_transport(scenario) ? 1 : 0)
         << ",\"control_value\":"
         << (scenario == Scenario::Gain ? kGainUnderTest
             : scenario == Scenario::Pan ? kPanUnderTest
             : scenario == Scenario::Mute ? 0.0f : 1.0f)
         << ",\"is_reference\":" << (scenario == Scenario::None ? 1 : 0)
         << ",\"capture\":\"" << stem << ".f32\""
         << ",\"channels\":2,\"frames\":" << static_cast<long long>(total_blocks) * block
         << ",\"max_abs\":" << max_abs
         << ",\"missing_source_frames\":" << misses
         << ",\"active_voices_start\":" << voices_before.active_voice_count
         << ",\"active_voices_end\":" << voices.active_voice_count
         << ",\"path_direct\":" << diag.path_direct_count
         << ",\"path_stretched\":" << diag.path_stretched_count
         << ",\"path_varispeed\":" << diag.path_varispeed_count
         << ",\"missing_voice_blocks\":" << diag.pitch_missing_stream_silence_count
         << ",\"timeline_frames\":[";
    for (std::size_t i = 0; i < timeline.size(); ++i)
        json << (i ? "," : "") << timeline[i];
    json << "]}\n";
    json.close();
    if (!json) throw std::runtime_error("JSON write failed");

    // Only the conditions that would make the capture meaningless are fatal.
    // Audio differences between the routes are observations for the analyzer.
    const auto expected = static_cast<std::uint64_t>(total_blocks);
    if (misses)
        throw std::runtime_error("Source read missed while capturing; the window was not resident");
    if (max_abs >= 0.98)
        throw std::runtime_error("Output reached the master soft limiter; lower the fixture level");
    if (diag.pitch_missing_stream_silence_count)
        throw std::runtime_error("A stretched render had no voice");
    // A muted stretched track takes the renderer's silent path, which advances
    // the voice cursor without producing a stretched block, so the per-block
    // count only holds where the transport is what moved. The route each
    // capture took is still checked, just not block by block.
    const bool strict_counts = moves_transport(scenario);
    if (live && (voices.active_voice_count != 1
                 || (strict_counts ? diag.path_stretched_count != expected
                                   : diag.path_stretched_count == 0)))
        throw std::runtime_error("Live route did not run the Bungee voice it should have");
    if (!live && (voices.active_voice_count != 0
                  || (strict_counts ? diag.path_direct_count != expected
                                    : diag.path_direct_count == 0)))
        throw std::runtime_error("Prepared route did not run the direct path it should have");
    std::cout << "captured " << stem << " max_abs=" << max_abs << "\n";
    return 0;
} catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 2;
}
