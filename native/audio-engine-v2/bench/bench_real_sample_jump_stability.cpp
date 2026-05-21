#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using namespace lt;

namespace {

constexpr int kSampleRate = 44100;
constexpr int kChannels = 2;
constexpr int kBlock = 512;

std::filesystem::path find_sample() {
    for (auto path : {
             std::filesystem::path("samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("Samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / "samples" / "ACUSTICA 1_01.wav"}) {
        if (std::filesystem::exists(path))
            return std::filesystem::absolute(path);
    }
    return {};
}

JumpTarget frame_target(Frame frame) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = frame;
    return target;
}

Frame first_audio_frame(const std::vector<float>& samples, int channels) {
    constexpr int window = 2048;
    constexpr double threshold = 0.0025;
    const Frame frames = static_cast<Frame>(samples.size() / channels);
    for (Frame start = 0; start + window < frames; start += window / 2) {
        double sum = 0.0;
        for (int i = 0; i < window; ++i) {
            const float l = samples[static_cast<std::size_t>((start + i) * channels)];
            const float r = channels > 1
                ? samples[static_cast<std::size_t>((start + i) * channels + 1)]
                : l;
            sum += 0.5 * (double(l) * l + double(r) * r);
        }
        if (std::sqrt(sum / window) > threshold)
            return start;
    }
    return 0;
}

bool wait_ready(SourceManager& sources, const Id& source_id, Frame source_frame, int frames) {
    sources.request_range(source_id, source_frame, frames);
    const auto source = sources.get_shared(source_id);
    for (int i = 0; i < 2000; ++i) {
        if (source && source->is_range_ready(source_frame, frames))
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}

struct JumpResult {
    bool ready = false;
    bool prepared = false;
    bool executed = false;
    bool finite = true;
    std::size_t cache_misses = 0;
    double boundary_delta = 0.0;
    double max_delta_post = 0.0;
    double max_delta_all = 0.0;
    int near_zero_windows = 0;
    double baseline_rms_error = 0.0;
    double post_vs_direct_rms_error = 0.0;
    double peak_post = 0.0;
    double rms_post = 0.0;
};

struct RenderCapture {
    JumpResult result;
    std::vector<float> post_left;
};

RenderCapture run_jump(bool with_pitch,
                   bool with_prepared_payload,
                   SourceManager& sources,
                   const std::vector<float>& decoded,
                   Frame duration,
                   Frame source_start,
                   Frame target,
                   Frame trigger,
                   int trigger_offset_in_block = 325) {
    auto session = std::make_shared<Session>();
    session->id = with_pitch ? "real-pitched" : "real-unpitched";
    session->sample_rate = kSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = duration;
    song.transpose_semitones = with_pitch ? -2 : 0;
    song.markers.push_back(Marker{"target-marker", "Target", target});

    Track track;
    track.id = with_pitch ? "pitched" : "unpitched";
    track.transpose_behavior = with_pitch
        ? TransposeBehavior::FollowsSongOrRegion
        : TransposeBehavior::NeverTranspose;
    track.clips.push_back(Clip{"clip", "real", 0, 0, duration});
    song.tracks.push_back(track);
    if (with_pitch) {
        Track dry;
        dry.id = "dry-reference";
        dry.transpose_behavior = TransposeBehavior::NeverTranspose;
        dry.gain = 1.0f;
        dry.clips.push_back(Clip{"dry-clip", "real", 0, 0, duration});
        song.tracks.push_back(dry);
    }
    session->songs.push_back(song);

    JumpScheduler scheduler;
    TransportClock clock(kSampleRate);
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);

    BungeeVoiceManager bvm;
    if (with_pitch && bvm.prepare(kSampleRate, kChannels, kBlock)) {
        bvm.rebuild_for_seek(source_start, *session, sources);
        mixer.set_bungee_voice_manager(&bvm);
    }

    const int prefetch_frames = kBlock * 32;
    RenderCapture capture;
    JumpResult& result = capture.result;
    const Frame pre_jump_read = std::max<Frame>(
        0, trigger - trigger_offset_in_block + kBlock * 18);
    const bool dry_trigger_ready = wait_ready(
        sources, "real", std::max<Frame>(0, trigger - trigger_offset_in_block),
        prefetch_frames);
    const bool trigger_ready = wait_ready(
        sources, "real", pre_jump_read, prefetch_frames);
    const bool target_ready = wait_ready(sources, "real", target, prefetch_frames);
    result.ready = dry_trigger_ready && trigger_ready && target_ready;

    std::shared_ptr<const PreparedVoiceMap> prepared_map;
    if (with_pitch && with_prepared_payload) {
        PrearmedJumpManager prearm;
        if (prearm.prepare(kSampleRate, kChannels, kBlock)) {
            constexpr std::uint64_t revision = 1;
            auto prepared = prearm.prepare_target_now(
                *session, sources, PrearmTargetKind::Marker,
                song.id, "target-marker", target, revision);
            if (prepared && prepared->valid) {
                prepared_map = bvm.build_prepared_voice_map(
                    prepared->extract_voice_map());
                result.prepared = static_cast<bool>(prepared_map);
            }
        }
    } else {
        result.prepared = !with_pitch;
    }

    clock.seek(trigger - trigger_offset_in_block);
    clock.play();
    clock.clear_pending_start();

    ScheduledJump jump;
    jump.jump_id = with_pitch ? "jump-pitched" : "jump-unpitched";
    jump.target = frame_target(target);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = trigger;
    jump.suppress_seek_fade = true;
    jump.prepared_voice_map = prepared_map;
    scheduler.schedule(jump);

    constexpr int kRenderBlocks = 32;
    std::vector<float> rendered_left;
    rendered_left.reserve(kBlock * kRenderBlocks);
    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    const auto before_cache = sources.cache_diagnostics();
    for (int block = 0; block < kRenderBlocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, kSampleRate);
        rendered_left.insert(rendered_left.end(), left.begin(), left.end());
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const auto after_cache = sources.cache_diagnostics();
    result.cache_misses = after_cache.blocks_miss - before_cache.blocks_miss;
    result.executed = mixer.scheduled_jump_executed_count() == 1;

    const int boundary = static_cast<int>(trigger - (trigger - trigger_offset_in_block));
    if (boundary > 0 && boundary < kBlock) {
        result.boundary_delta = std::abs(
            double(rendered_left[boundary]) - double(rendered_left[boundary - 1]));
        const int post = static_cast<int>(rendered_left.size()) - boundary;
        double sum = 0.0;
        for (int i = boundary; i < static_cast<int>(rendered_left.size()); ++i) {
            result.finite = result.finite && std::isfinite(rendered_left[static_cast<std::size_t>(i)]);
            result.peak_post = std::max(result.peak_post, std::abs(double(rendered_left[static_cast<std::size_t>(i)])));
            sum += double(rendered_left[static_cast<std::size_t>(i)]) * rendered_left[static_cast<std::size_t>(i)];
            if (i > boundary)
                result.max_delta_all = std::max(
                    result.max_delta_all,
                    std::abs(double(rendered_left[static_cast<std::size_t>(i)])
                             - double(rendered_left[static_cast<std::size_t>(i - 1)])));
            if (i > boundary && i < boundary + (kBlock - boundary))
                result.max_delta_post = std::max(
                    result.max_delta_post,
                    std::abs(double(rendered_left[static_cast<std::size_t>(i)])
                             - double(rendered_left[static_cast<std::size_t>(i - 1)])));
        }
        for (int i = boundary; i + 64 <= static_cast<int>(rendered_left.size()); i += 64) {
            double window_sum = 0.0;
            for (int j = 0; j < 64; ++j) {
                const double v = rendered_left[static_cast<std::size_t>(i + j)];
                window_sum += v * v;
            }
            if (std::sqrt(window_sum / 64.0) < 1.0e-5)
                ++result.near_zero_windows;
        }
        result.rms_post = std::sqrt(sum / std::max(1, post));
        capture.post_left.assign(rendered_left.begin() + boundary, rendered_left.end());
    }
    (void)decoded;
    return capture;
}

std::vector<float> render_direct_pitched(SourceManager& sources,
                                         Frame duration,
                                         Frame target) {
    auto session = std::make_shared<Session>();
    session->id = "direct-pitched";
    session->sample_rate = kSampleRate;
    Song song;
    song.id = "song";
    song.end_frame = duration;
    song.transpose_semitones = -2;
    Track track;
    track.id = "pitched";
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip", "real", 0, 0, duration});
    song.tracks.push_back(track);
    session->songs.push_back(song);

    JumpScheduler scheduler;
    TransportClock clock(kSampleRate);
    clock.seek(target);
    clock.play();
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    BungeeVoiceManager bvm;
    if (bvm.prepare(kSampleRate, kChannels, kBlock)) {
        bvm.rebuild_for_seek(target, *session, sources);
        mixer.set_bungee_voice_manager(&bvm);
    }
    constexpr int kRenderBlocks = 32;
    std::vector<float> rendered;
    rendered.reserve(kBlock * kRenderBlocks);
    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    for (int block = 0; block < kRenderBlocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(out, 2, kBlock, kSampleRate);
        rendered.insert(rendered.end(), left.begin(), left.end());
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return rendered;
}

void print_result(const char* label, const JumpResult& r) {
    std::printf(
        "%s ready=%s prepared=%s executed=%s finite=%s cache_misses=%zu boundary_delta=%.6f max_delta_post=%.6f max_delta_all=%.6f zero_windows=%d baseline_rms_error=%.6f post_vs_direct_rms_error=%.6f peak_post=%.6f rms_post=%.6f\n",
        label,
        r.ready ? "yes" : "NO",
        r.prepared ? "yes" : "NO",
        r.executed ? "yes" : "NO",
        r.finite ? "yes" : "NO",
        r.cache_misses,
        r.boundary_delta,
        r.max_delta_post,
        r.max_delta_all,
        r.near_zero_windows,
        r.baseline_rms_error,
        r.post_vs_direct_rms_error,
        r.peak_post,
        r.rms_post);
}

} // namespace

int main() {
    const auto sample_path = find_sample();
    if (sample_path.empty()) {
        std::puts("sample not found; expected samples/ACUSTICA 1_01.wav");
        return 77;
    }

    int channels = 0;
    Frame frames = 0;
    auto decoded_result = decode_file_to_float32(sample_path.string(), kSampleRate, &channels, &frames);
    if (decoded_result.is_err()) {
        std::fprintf(stderr, "decode failed: %s\n", decoded_result.error().c_str());
        return 2;
    }
    auto decoded = decoded_result.take();
    const Frame onset = first_audio_frame(decoded, channels);
    const Frame source_start = std::min<Frame>(frames - kSampleRate * 2, onset + kSampleRate * 2);
    const Frame target = std::min<Frame>(frames - kSampleRate * 2, 1860902);
    const Frame trigger = 465231;

    SourceManager sources;
    sources.register_source("real", sample_path.string());
    auto stored = sources.store_decoded_source("real", decoded, channels, kSampleRate, frames);
    if (stored.is_err()) {
        std::fprintf(stderr, "store failed: %s\n", stored.error().c_str());
        return 3;
    }

    std::printf("sample=%s channels=%d frames=%lld onset=%lld source_start=%lld target=%lld trigger=%lld\n",
                sample_path.string().c_str(),
                channels,
                static_cast<long long>(frames),
                static_cast<long long>(onset),
                static_cast<long long>(source_start),
                static_cast<long long>(target),
                static_cast<long long>(trigger));

    auto unpitched_capture = run_jump(false, false, sources, decoded, frames, source_start, target, trigger);
    auto pitched_reactive_capture = run_jump(true, false, sources, decoded, frames, source_start, target, trigger);
    auto pitched_prepared_capture = run_jump(true, true, sources, decoded, frames, source_start, target, trigger);
    auto pitched_prepared_tiny_capture = run_jump(true, true, sources, decoded, frames,
                                                  source_start, target, 581538, 418);
    auto pitched_prepared_far_capture = run_jump(true, true, sources, decoded, frames, target, 4652256, 2209846);
    const auto baseline = render_direct_pitched(sources, frames, target);
    const auto far_baseline = render_direct_pitched(sources, frames, 4652256);
    if (!baseline.empty() && !pitched_prepared_capture.post_left.empty()) {
        const std::size_t n = std::min(baseline.size(), pitched_prepared_capture.post_left.size());
        double sum = 0.0;
        std::size_t count = 0;
        for (std::size_t i = 256; i < n; ++i) {
            const double d = double(pitched_prepared_capture.post_left[i]) - double(baseline[i]);
            sum += d * d;
            ++count;
        }
        pitched_prepared_capture.result.baseline_rms_error =
            std::sqrt(sum / static_cast<double>(std::max<std::size_t>(1, count)));
    }
    if (!far_baseline.empty() && !pitched_prepared_far_capture.post_left.empty()) {
        const std::size_t n = std::min(far_baseline.size(), pitched_prepared_far_capture.post_left.size());
        double sum = 0.0;
        std::size_t count = 0;
        for (std::size_t i = 256; i < n; ++i) {
            const double d = double(pitched_prepared_far_capture.post_left[i]) - double(far_baseline[i]);
            sum += d * d;
            ++count;
        }
        pitched_prepared_far_capture.result.post_vs_direct_rms_error =
            std::sqrt(sum / static_cast<double>(std::max<std::size_t>(1, count)));
    }
    const auto& unpitched = unpitched_capture.result;
    const auto& pitched_reactive = pitched_reactive_capture.result;
    const auto& pitched_prepared = pitched_prepared_capture.result;
    const auto& pitched_prepared_tiny = pitched_prepared_tiny_capture.result;
    const auto& pitched_prepared_far = pitched_prepared_far_capture.result;
    print_result("unpitched", unpitched);
    print_result("pitched_reactive", pitched_reactive);
    print_result("pitched_prepared", pitched_prepared);
    print_result("pitched_prepared_tiny94", pitched_prepared_tiny);
    print_result("pitched_prepared_far", pitched_prepared_far);

    const bool ok = unpitched.ready && unpitched.executed && unpitched.finite
        && unpitched.cache_misses == 0
        && pitched_reactive.ready && pitched_reactive.executed && pitched_reactive.finite
        && pitched_reactive.cache_misses == 0
        && pitched_prepared.ready && pitched_prepared.prepared
        && pitched_prepared.executed && pitched_prepared.finite
        && pitched_prepared.cache_misses == 0
        && pitched_prepared_tiny.ready && pitched_prepared_tiny.prepared
        && pitched_prepared_tiny.executed && pitched_prepared_tiny.finite
        && pitched_prepared_tiny.cache_misses == 0
        && pitched_prepared_tiny.near_zero_windows == 0
        && pitched_prepared_far.ready && pitched_prepared_far.prepared
        && pitched_prepared_far.executed && pitched_prepared_far.finite
        && pitched_prepared_far.cache_misses == 0
        && pitched_prepared_far.near_zero_windows == 0;
    return ok ? 0 : 4;
}
