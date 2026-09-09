#include <lt_engine/render/prepared_track_renderer.h>

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/track_renderer.h>

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <thread>
#include <unordered_set>
#include <vector>

namespace lt {
namespace {

using Clock = std::chrono::steady_clock;

void write_le32(std::ostream& out, std::uint32_t value) {
    const char bytes[] = {static_cast<char>(value), static_cast<char>(value >> 8),
                          static_cast<char>(value >> 16), static_cast<char>(value >> 24)};
    out.write(bytes, 4);
}

// libsndfile normalizes 16-bit PCM by 2^15 when reading into float, so scaling
// by 32768 here makes the round trip exact and the clamp symmetric.
int quantize_pcm16(float value) noexcept {
    return static_cast<int>(std::clamp<long>(std::lrintf(value * 32768.0f), -32768, 32767));
}

const Song* find_song(const Session& session, const Id& song_id) {
    for (const auto& song : session.songs)
        if (song.id == song_id) return &song;
    return nullptr;
}

const Track* find_track(const Song& song, const Id& track_id) {
    for (const auto& track : song.tracks)
        if (track.id == track_id) return &track;
    return nullptr;
}

// Waits until every source the track reads is resident. See the header for why
// this is residency rather than a sliding window.
bool make_sources_resident(SourceManager& sources, const Track& track, std::string& error) {
    std::unordered_set<Id> needed;
    for (const auto& clip : track.clips) needed.insert(clip.source_id);

    for (const auto& id : needed) {
        const auto source = sources.get_shared(id);
        if (!source) {
            error = "source not loaded: " + id;
            return false;
        }
        const Frame duration = source->duration_frames();
        if (duration <= 0) {
            error = "source has no audio: " + id;
            return false;
        }
        // request_range takes an int length; a source longer than that is well
        // past anything this feature is meant for, and silently truncating it
        // would render the tail as silence.
        if (duration > static_cast<Frame>(std::numeric_limits<int>::max())) {
            error = "source too long to prepare: " + id;
            return false;
        }
        const int length = static_cast<int>(duration);
        sources.request_range(id, 0, length, true);
        const auto deadline = Clock::now() + std::chrono::minutes(5);
        while (!source->is_range_ready(0, length)) {
            if (Clock::now() > deadline) {
                error = "timed out waiting for source: " + id;
                return false;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(4));
        }
    }
    return true;
}

} // namespace

PreparedRenderResult render_prepared_track(const PreparedRenderRequest& request,
                                           PreparedRenderProgressFn on_progress,
                                           void* progress_ctx) {
    PreparedRenderResult result;
    const auto fail = [&result](std::string message) {
        result.ok = false;
        result.error = std::move(message);
        return result;
    };

    if (!request.session || !request.sources) return fail("no session");
    if (request.block_frames <= 0 || request.block_frames > 65536)
        return fail("invalid block size");
    const Song* song = find_song(*request.session, request.song_id);
    if (!song) return fail("song not found: " + request.song_id);
    const Track* track = find_track(*song, request.track_id);
    if (!track) return fail("track not found: " + request.track_id);
    if (track->kind != TrackKind::Audio) return fail("track carries no audio");
    if (track->clips.empty()) return fail("track has no clips to prepare");

    // The file covers the track's own span, not the song's: a short clip in a
    // long song must not cost the silence around it.
    Frame span_start = track->clips.front().timeline_start_frame;
    Frame span_end = span_start;
    for (const auto& clip : track->clips) {
        span_start = std::min(span_start, clip.timeline_start_frame);
        span_end = std::max(span_end, clip.timeline_start_frame + clip.length_frames);
    }
    const Frame total_frames = span_end - span_start;
    if (total_frames <= 0) return fail("track span is empty");

    const int sample_rate = request.session->sample_rate > 0 ? request.session->sample_rate : 48000;
    const int block = request.block_frames;
    const bool pcm16 = request.format == PreparedSampleFormat::Pcm16;
    const std::uint32_t sample_bytes = pcm16 ? 2u : 4u;
    const std::uint32_t frame_bytes = 2u * sample_bytes;  // Always stereo.

    std::string error;
    if (!make_sources_resident(*request.sources, *track, error)) return fail(std::move(error));

    // Private voices: the live map belongs to the audio thread and is
    // positioned wherever the user is, not where this render starts.
    BungeeVoiceManager voices;
    if (!voices.prepare(sample_rate, 2, block * 4))
        return fail("time stretcher unavailable");
    voices.rebuild_for_session(*request.session, *request.sources, span_start);

    TrackRenderer renderer;
    renderer.prepare(block);

    std::filesystem::path output(request.output_path);
    if (output.has_parent_path()) {
        std::error_code ignored;
        std::filesystem::create_directories(output.parent_path(), ignored);
    }
    // Anything that leaves this function without a finished file removes it:
    // a partial render must never look like a complete one.
    struct Cleanup {
        const std::filesystem::path* path;
        bool keep = false;
        ~Cleanup() {
            if (keep) return;
            std::error_code ignored;
            std::filesystem::remove(*path, ignored);
        }
    } cleanup{&output};

    const auto data_bytes = static_cast<std::uint32_t>(total_frames) * frame_bytes;
    {
        std::ofstream wav(output, std::ios::binary);
        if (!wav) return fail("cannot create " + request.output_path);
        wav.write("RIFF", 4);
        write_le32(wav, 36 + data_bytes);
        wav.write("WAVEfmt ", 8);
        write_le32(wav, 16);
        write_le32(wav, (2u << 16) | (pcm16 ? 1u : 3u));  // Channels, then PCM or float.
        write_le32(wav, static_cast<std::uint32_t>(sample_rate));
        write_le32(wav, static_cast<std::uint32_t>(sample_rate) * frame_bytes);
        write_le32(wav, ((sample_bytes * 8u) << 16) | frame_bytes);  // Bits, then align.
        wav.write("data", 4);
        write_le32(wav, data_bytes);

        std::vector<float> left(block, 0.0f);
        std::vector<float> right(block, 0.0f);
        float* channels[2] = {left.data(), right.data()};
        std::vector<char> bytes(static_cast<std::size_t>(block) * frame_bytes);
        const auto misses_before = request.sources->total_cache_miss_frames();

        for (Frame rendered = 0; rendered < total_frames; rendered += block) {
            const int frames_now =
                static_cast<int>(std::min<Frame>(block, total_frames - rendered));
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            // track_gain_override = 1: gain, pan and mute belong to the mixer
            // and stay live over the prepared file.
            renderer.render(*track, span_start + rendered, frames_now, channels, 2,
                            *request.sources, &voices, sample_rate, 0, song, false, 1.0f);

            for (int frame = 0; frame < frames_now; ++frame) {
                for (int channel = 0; channel < 2; ++channel) {
                    const float value = channel ? right[frame] : left[frame];
                    if (!std::isfinite(value)) return fail("render produced a non-finite sample");
                    const auto offset =
                        static_cast<std::size_t>(frame * 2 + channel) * sample_bytes;
                    if (pcm16) {
                        if (std::abs(value) >= 1.0f) ++result.clipped_samples;
                        const int quantized = quantize_pcm16(value);
                        bytes[offset] = static_cast<char>(quantized & 0xff);
                        bytes[offset + 1] = static_cast<char>((quantized >> 8) & 0xff);
                    } else {
                        const auto raw = std::bit_cast<std::uint32_t>(value);
                        for (int byte = 0; byte < 4; ++byte)
                            bytes[offset + byte] = static_cast<char>(raw >> (byte * 8));
                    }
                }
            }
            wav.write(bytes.data(), static_cast<std::streamsize>(frames_now) * frame_bytes);
            if (!wav) return fail("write failed for " + request.output_path);

            if (on_progress && !on_progress(progress_ctx, rendered + frames_now, total_frames)) {
                result.cancelled = true;
                result.error = "cancelled";
                return result;
            }
        }

        // Residency was supposed to make this impossible. If it happened the
        // file has silence where audio should be, and handing it to playback
        // would be worse than having no prepared file at all.
        if (request.sources->total_cache_miss_frames() != misses_before)
            return fail("source read missed while preparing; the render would have gaps");

        wav.close();
        if (!wav) return fail("could not finish writing " + request.output_path);
    }

    std::error_code size_error;
    const auto written = std::filesystem::file_size(output, size_error);
    if (size_error) return fail("cannot measure the written file");

    cleanup.keep = true;
    result.ok = true;
    result.timeline_start_frame = span_start;
    result.frames = total_frames;
    result.output_bytes = static_cast<std::uint64_t>(written);
    return result;
}

} // namespace lt
