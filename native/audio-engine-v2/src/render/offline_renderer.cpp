#include <lt_engine/render/offline_renderer.h>

#include <lt_engine/core/fs_path.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/pitch/voice_priming.h>
#include <lt_engine/render/mix_math.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/session/session.h>
#include <lt_engine/session/session_adapter.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/resampler.h>
#include <lt_engine/sources/source_manager.h>

#include <nlohmann/json.hpp>

#if defined(__ANDROID__)
#include <android/log.h>
#else
#include <lt_engine/debug/logging.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <unordered_map>
#include <unordered_set>

namespace lt {

namespace {

using json = nlohmann::json;

// Output frames per render step. Any size gives the same audio for the Direct
// and Varispeed paths (both are closed-form in the timeline frame); it only
// sets how often the per-block decisions (path, region master gain, mono
// detection) are re-evaluated, which the realtime mixer does per callback.
constexpr int kBlockFrames = 1024;
// Bungee input headroom: a warp ratio of up to 4 feeds 4x the output block.
// Same sizing as TrackRenderer::prepare.
constexpr int kMaxInFrames = kBlockFrames * 4;
// Longest range accepted. The mix bus lives in RAM (2 floats per frame), so
// this bounds memory at ~2.6 GB even at 96 kHz. A song is minutes long; three
// hours is a whole concert and far past anything the UI can ask for.
constexpr double kMaxRenderSeconds = 3.0 * 60.0 * 60.0;

const char* const kCancelled = "cancelled";

// Where the time goes, per track. On Android it lands in logcat under
// LTRender, the only place a phone's numbers can be read; elsewhere it goes to
// the engine's debug log.
void render_log(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
#if defined(__ANDROID__)
    __android_log_vprint(ANDROID_LOG_INFO, "LTRender", fmt, args);
#else
    lt_debug_vlog(fmt, args);
#endif
    va_end(args);
}

double ms_since(std::chrono::steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start).count();
}

// ── Source windows ─────────────────────────────────────────────────────────
//
// Only the part of a file a clip actually plays is decoded, at the render
// rate, into two planes (mono duplicated, extra channels dropped — the same
// two channels the realtime renderer reads). Decoding whole files would put a
// 27-stem song at ~3 GB of floats, which a phone cannot hold.
struct WindowedAudio {
    Frame origin = 0;           // absolute source frame of l[0]/r[0]
    Frame source_frames = 0;    // whole source length at the render rate
    std::vector<float> l;
    std::vector<float> r;

    Frame window_end() const noexcept {
        return origin + static_cast<Frame>(l.size());
    }

    // Fill `frames` frames from absolute source frame `start`. Anything outside
    // the decoded window — or outside the file — is silence, which is what the
    // realtime source returns past its end.
    int read(Frame start, int frames, float* out_l, float* out_r) const noexcept {
        for (int i = 0; i < frames; ++i) {
            const Frame f = start + i;
            if (f >= origin && f < window_end()) {
                const auto idx = static_cast<std::size_t>(f - origin);
                out_l[i] = l[idx];
                out_r[i] = r[idx];
            } else {
                out_l[i] = 0.0f;
                out_r[i] = 0.0f;
            }
        }
        return frames;
    }
};

// Decode [window_start, window_end) of `path`, in render-rate frames.
//
// First choice is the engine's own PCM cache of the source at this rate: the
// conversion playback already paid for. Reading it is a plain file read;
// decoding the original again is not — on Android an MP3 goes through
// MediaCodec at ~8x realtime (measured on a Galaxy Tab A7: 32-37 s per
// 4:45 track), which is what made a render take minutes. The cache is used
// back to the original. The cache is accepted by the same rule playback uses
// to reuse it (SourceManager::try_install_from_cache_file: right rate, some
// frames), plus "nobody in this process is writing it right now". A cache
// only ends up with frames once its write is finalised, so a file that is
// still growing reads as empty and is skipped either way.
//
// Otherwise, when the file already runs at the render rate the decoder seeks
// straight to the window, and if not it streams from frame 0 through the same
// stateful resampler that fills the realtime PCM cache and keeps only the
// window: a resampler started mid-file never lines up with one started at
// frame 0 (measured), and the export must line up with what the cache plays.
//
// `on_progress` gets the fraction of the window decoded; false cancels.
Result<WindowedAudio> decode_window(const Id& source_id,
                                    const std::string& path,
                                    int sample_rate,
                                    Frame window_start,
                                    Frame window_end,
                                    const std::function<bool(double)>& on_progress) {
    const auto decode_started = std::chrono::steady_clock::now();
    std::unique_ptr<AudioDecoder> decoder;
    const char* origin_label = "original";
    const std::string cached = pcm_cache_file_for(source_id, path, sample_rate);
    if (!pcm_cache_write_in_progress(cached)) {
        if (auto cache_decoder = make_decoder(cached);
            cache_decoder && cache_decoder->open(cached).is_ok()) {
            const AudioFileInfo cache_info = cache_decoder->info();
            if (cache_info.original_sample_rate == sample_rate
                && cache_info.channel_count > 0
                && cache_info.duration_frames > 0) {
                decoder = std::move(cache_decoder);
                origin_label = "engine PCM cache";
            } else {
                cache_decoder->close();
            }
        }
    }
    if (!decoder) {
        decoder = make_decoder(path);
        if (!decoder)
            return Result<WindowedAudio>::err("no decoder for " + path);
        auto opened = decoder->open(path);
        if (opened.is_err())
            return Result<WindowedAudio>::err(opened.error());
    }

    const AudioFileInfo info = decoder->info();
    const int channels = std::max(1, info.channel_count);
    const int original_rate = info.original_sample_rate > 0 ? info.original_sample_rate
                                                            : sample_rate;
    const bool same_rate = original_rate == sample_rate;

    WindowedAudio audio;
    audio.source_frames = same_rate
        ? info.duration_frames
        : static_cast<Frame>(std::llround(static_cast<double>(info.duration_frames)
                                          * sample_rate / original_rate));
    window_start = std::clamp<Frame>(window_start, 0, std::max<Frame>(0, audio.source_frames));
    window_end = std::clamp<Frame>(window_end, window_start,
                                   std::max<Frame>(window_start, audio.source_frames));
    audio.origin = window_start;
    const auto window_frames = static_cast<std::size_t>(window_end - window_start);
    audio.l.assign(window_frames, 0.0f);
    audio.r.assign(window_frames, 0.0f);
    if (window_frames == 0)
        return Result<WindowedAudio>::ok(std::move(audio));

    constexpr int kChunk = 16384;
    std::vector<float> interleaved(static_cast<std::size_t>(kChunk) * channels);

    // Store interleaved frames that start at absolute render-rate frame `at`.
    auto store = [&](const float* frames, Frame count, Frame at) {
        for (Frame i = 0; i < count; ++i) {
            const Frame f = at + i;
            if (f < window_start || f >= window_end) continue;
            const auto idx = static_cast<std::size_t>(f - window_start);
            const float* frame = frames + static_cast<std::size_t>(i) * channels;
            audio.l[idx] = frame[0];
            audio.r[idx] = channels >= 2 ? frame[1] : frame[0];
        }
    };

    if (same_rate) {
        if (window_start > 0) {
            auto sought = decoder->seek(window_start);
            if (sought.is_err())
                return Result<WindowedAudio>::err(sought.error());
        }
        Frame at = window_start;
        while (at < window_end) {
            const int want = static_cast<int>(std::min<Frame>(kChunk, window_end - at));
            const int got = decoder->read_frames(interleaved.data(), want);
            if (got <= 0) break;
            store(interleaved.data(), got, at);
            at += got;
            if (on_progress && !on_progress(static_cast<double>(at - window_start)
                                            / static_cast<double>(window_frames)))
                return Result<WindowedAudio>::err(kCancelled);
        }
    } else {
        auto resampler = make_streaming_resampler(channels, original_rate, sample_rate);
        std::vector<float> resampled;
        Frame produced = 0;
        bool eof = false;
        while (!eof && produced < window_end) {
            const int got = decoder->read_frames(interleaved.data(), kChunk);
            eof = got <= 0;
            resampled.clear();
            const Frame out = resampler->process_chunk(interleaved.data(),
                                                       std::max(0, got), eof, resampled);
            if (out > 0) {
                store(resampled.data(), out, produced);
                produced += out;
            }
            if (on_progress && !on_progress(std::min(1.0, static_cast<double>(produced)
                                                     / static_cast<double>(window_end))))
                return Result<WindowedAudio>::err(kCancelled);
        }
    }
    decoder->close();
    render_log("decode %s from %s (%s): %d Hz (%s), window %.1f s at %.1f s, %.0f ms\n",
               path.c_str(), origin_label, cached.c_str(), original_rate,
               same_rate ? "direct seek" : "resampled from 0",
               static_cast<double>(window_frames) / sample_rate,
               static_cast<double>(window_start) / sample_rate, ms_since(decode_started));
    return Result<WindowedAudio>::ok(std::move(audio));
}

// ── Per-clip render state ──────────────────────────────────────────────────

struct ClipRuntime {
    const Clip*   clip = nullptr;
    WindowedAudio audio;
    bool          readable = false;
    // Stretched path only. Built lazily on the first block the clip plays
    // through Bungee, primed exactly like BungeeVoiceManager's
    // build_voice_for_spec.
    std::unique_ptr<BungeePitchVoice> voice;
};

struct Scratch {
    std::vector<float> clip_l, clip_r;   // one clip's block (TrackRenderer::scratch_)
    std::vector<float> in_l, in_r;       // Bungee / varispeed input
    std::vector<float> bus_l, bus_r;     // the track bus for this block

    Scratch()
        : clip_l(kBlockFrames), clip_r(kBlockFrames),
          in_l(kMaxInFrames), in_r(kMaxInFrames),
          bus_l(kBlockFrames), bus_r(kBlockFrames) {}
};

// Source-frame span a clip may read while it plays [overlap_start,
// overlap_end), padded for Bungee's pipeline lead and the priming pass.
struct SourceWindow {
    Frame start = 0;
    Frame end = 0;
};

SourceWindow clip_source_window(const Track& track,
                                           const Clip& clip,
                                           const Song& song,
                                           Frame overlap_start,
                                           Frame overlap_end,
                                           int sample_rate) {
    double k_min = 1.0;
    double k_max = 1.0;
    for (const Frame probe : {overlap_start, std::max(overlap_start, overlap_end - 1)}) {
        const auto d = resolve_pitch_render_decision(track, clip, song, probe);
        double k = 1.0;
        if (d.path == ClipPathKind::Varispeed) k = d.pitch_scale;
        else if (d.path == ClipPathKind::Stretched) k = d.warp_time_ratio;
        if (!(k > 0.0) || !std::isfinite(k)) k = 1.0;
        k_min = std::min(k_min, k);
        k_max = std::max(k_max, k);
    }
    const double off0 = static_cast<double>(overlap_start - clip.timeline_start_frame);
    const double off1 = static_cast<double>(overlap_end - clip.timeline_start_frame);
    // One second each side covers the Bungee lead (~5-10k frames) with room.
    const Frame margin = static_cast<Frame>(sample_rate) + 16384;
    const Frame a = clip.source_start_frame + static_cast<Frame>(std::floor(off0 * k_min)) - margin;
    const Frame b = clip.source_start_frame + static_cast<Frame>(std::ceil(off1 * k_max)) + margin;
    return {a, b};
}

// Mirror of TrackRenderer::prepare_clip_block.
struct ClipBlock {
    int   block_offset = 0;
    Frame source_frame = 0;
    int   frames_to_read = 0;
};

bool prepare_clip_block(const Clip& clip, Frame timeline_frame, int block_frames,
                        ClipBlock& out) noexcept {
    const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (timeline_frame >= clip_end) return false;
    if (timeline_frame + block_frames <= clip.timeline_start_frame) return false;

    int block_offset = 0;
    Frame source_frame = clip.source_start_frame;
    if (timeline_frame < clip.timeline_start_frame) {
        block_offset = static_cast<int>(clip.timeline_start_frame - timeline_frame);
    } else {
        source_frame = clip.source_start_frame + (timeline_frame - clip.timeline_start_frame);
    }
    int frames_to_read = block_frames - block_offset;
    frames_to_read = std::min(frames_to_read,
                              static_cast<int>(clip_end - (timeline_frame + block_offset)));
    if (frames_to_read <= 0) return false;
    out.block_offset = block_offset;
    out.source_frame = source_frame;
    out.frames_to_read = frames_to_read;
    return true;
}

// Mirror of TrackRenderer::render_path_varispeed.
void render_varispeed(const ClipRuntime& cr, const ClipBlock& cb, double pitch_scale,
                      Scratch& s) noexcept {
    const Clip& clip = *cr.clip;
    const long long timeline_offset_in_clip =
        static_cast<long long>(cb.source_frame - clip.source_start_frame);
    const double source_start = static_cast<double>(clip.source_start_frame)
        + static_cast<double>(timeline_offset_in_clip) * pitch_scale;
    const int frames_needed = static_cast<int>(std::ceil(
        static_cast<double>(cb.frames_to_read) * pitch_scale)) + 1;
    if (frames_needed <= 0 || frames_needed > kMaxInFrames) {
        std::fill_n(s.clip_l.begin(), cb.frames_to_read, 0.0f);
        std::fill_n(s.clip_r.begin(), cb.frames_to_read, 0.0f);
        return;
    }
    const Frame read_start_floor = static_cast<Frame>(std::floor(source_start));
    // The window reader returns silence before frame 0 and past the end, which
    // is what the realtime path's explicit zero-padding produces.
    cr.audio.read(read_start_floor, frames_needed, s.in_l.data(), s.in_r.data());
    const double cursor0 = source_start - static_cast<double>(read_start_floor);
    for (int i = 0; i < cb.frames_to_read; ++i) {
        const double pos = cursor0 + static_cast<double>(i) * pitch_scale;
        const int idx0 = static_cast<int>(std::floor(pos));
        if (idx0 < 0 || idx0 + 1 >= frames_needed) {
            s.clip_l[static_cast<std::size_t>(i)] = 0.0f;
            s.clip_r[static_cast<std::size_t>(i)] = 0.0f;
            continue;
        }
        const float frac = static_cast<float>(pos - static_cast<double>(idx0));
        const auto i0 = static_cast<std::size_t>(idx0);
        s.clip_l[static_cast<std::size_t>(i)] = s.in_l[i0] + (s.in_l[i0 + 1] - s.in_l[i0]) * frac;
        s.clip_r[static_cast<std::size_t>(i)] = s.in_r[i0] + (s.in_r[i0 + 1] - s.in_r[i0]) * frac;
    }
}

// Build and prime a Bungee voice so its next output is `source_frame`.
// Mirror of build_voice_for_spec in bungee_voice_manager.cpp.
Result<void> build_voice(ClipRuntime& cr, Frame source_frame, double pitch_scale,
                         double time_ratio, int sample_rate) {
    auto voice = std::make_unique<BungeePitchVoice>();
    if (!voice->configure(sample_rate, 2, kMaxInFrames))
        return Result<void>::err(
            "time-stretch (Bungee) is not available in this build, so a song with "
            "warp cannot be rendered");
    voice_priming::warm(*voice, sample_rate, 2, kMaxInFrames, time_ratio, pitch_scale);
    const WindowedAudio& audio = cr.audio;
    const voice_priming::SourceSpanReader read =
        [&audio](Frame start, int frames, float* const* into) {
            return audio.read(start, frames, into[0], into[1]);
        };
    const auto aligned = voice_priming::align_on_source(
        *voice, audio.source_frames, read, source_frame, 2, kMaxInFrames,
        pitch_scale, time_ratio);
    voice->set_feed_anchor(static_cast<long long>(aligned.anchor),
                           static_cast<long long>(aligned.fed_through));
    voice->arm_fade_in(0);
    cr.voice = std::move(voice);
    return Result<void>::ok();
}

// Mirror of TrackRenderer::render_path_stretched (minus its diagnostics).
Result<void> render_stretched(ClipRuntime& cr, const ClipBlock& cb,
                              Semitones effective_semitones, double warp_time_ratio,
                              int sample_rate, Scratch& s) {
    const Clip& clip = *cr.clip;
    const double safe_ratio = warp_time_ratio > 0.0 ? warp_time_ratio : 1.0;
    const double pitch_scale = std::pow(2.0, static_cast<double>(effective_semitones) / 12.0);
    const long long clip_source_start = static_cast<long long>(clip.source_start_frame);
    const long long timeline_offset = static_cast<long long>(cb.source_frame) - clip_source_start;

    if (!cr.voice) {
        const Frame first_source_frame = static_cast<Frame>(
            clip_source_start
            + std::llround(static_cast<double>(timeline_offset) * safe_ratio));
        auto built = build_voice(cr, first_source_frame, pitch_scale, safe_ratio, sample_rate);
        if (built.is_err())
            return built;
    }
    BungeePitchVoice& bv = *cr.voice;

    const long long required_fed_through =
        clip_source_start
        + std::llround(static_cast<double>(timeline_offset + cb.frames_to_read) * safe_ratio)
        + bv.feed_lead_frames();
    long long feed_wanted = required_fed_through - bv.fed_through();
    if (feed_wanted < 0 || feed_wanted > kMaxInFrames) {
        bv.reanchor_feed(required_fed_through);
        feed_wanted = 0;
    }
    const int feed_frames = static_cast<int>(feed_wanted);
    if (feed_frames > 0)
        cr.audio.read(static_cast<Frame>(bv.fed_through()), feed_frames,
                      s.in_l.data(), s.in_r.data());

    const float* in_ptrs[2] = {s.in_l.data(), s.in_r.data()};
    float* out_ptrs[2] = {s.clip_l.data(), s.clip_r.data()};
    const int produced = bv.render_block(in_ptrs, feed_frames, out_ptrs,
                                         cb.frames_to_read, pitch_scale);
    bv.advance_fed_through(feed_frames);
    if (produced < cb.frames_to_read) {
        std::fill(s.clip_l.begin() + std::max(0, produced),
                  s.clip_l.begin() + cb.frames_to_read, 0.0f);
        std::fill(s.clip_r.begin() + std::max(0, produced),
                  s.clip_r.begin() + cb.frames_to_read, 0.0f);
    }
    return Result<void>::ok();
}

// Mirror of TrackRenderer::finalise_clip_block. The mixer passes a unity track
// gain to the renderer and applies the track's own gain downstream, so only
// the clip gain belongs here.
void finalise_clip_block(const Clip& clip, const ClipBlock& cb, Scratch& s) noexcept {
    const int read = cb.frames_to_read;
    const Frame played = cb.source_frame - clip.source_start_frame;
    if (clip.fade_in_frames > 0) {
        for (int f = 0; f < read; ++f) {
            const Frame pos = played + f;
            if (pos < clip.fade_in_frames) {
                const float g = static_cast<float>(pos) / clip.fade_in_frames;
                s.clip_l[static_cast<std::size_t>(f)] *= g;
                s.clip_r[static_cast<std::size_t>(f)] *= g;
            }
        }
    }
    if (clip.fade_out_frames > 0) {
        for (int f = 0; f < read; ++f) {
            const Frame pos = played + f;
            const Frame from_end = clip.length_frames - pos;
            if (from_end < clip.fade_out_frames && from_end >= 0) {
                const float g = static_cast<float>(from_end) / clip.fade_out_frames;
                s.clip_l[static_cast<std::size_t>(f)] *= g;
                s.clip_r[static_cast<std::size_t>(f)] *= g;
            }
        }
    }
    float* dst_l = s.bus_l.data() + cb.block_offset;
    float* dst_r = s.bus_r.data() + cb.block_offset;
    for (int f = 0; f < read; ++f) {
        dst_l[f] += s.clip_l[static_cast<std::size_t>(f)] * clip.gain;
        dst_r[f] += s.clip_r[static_cast<std::size_t>(f)] * clip.gain;
    }
}

// Folder-chained gain and pan, as Mixer::effective_controls_from_session reads
// them from the session. Mute and solo are not consulted (see the header).
std::pair<float, float> effective_gain_pan(const Song& song, const Track& track) noexcept {
    constexpr int kMaxFolderDepth = 8;   // Mixer::kMaxFolderDepth
    float gain = 1.0f;
    float pan = 0.0f;
    const Track* current = &track;
    int depth = 0;
    while (current && depth < kMaxFolderDepth) {
        gain *= current->gain;
        pan = clamp_pan(pan + current->pan);
        if (current->parent_track_id.empty()) break;
        const Track* parent = nullptr;
        for (const auto& candidate : song.tracks) {
            if (candidate.id == current->parent_track_id) {
                parent = &candidate;
                break;
            }
        }
        current = parent;
        ++depth;
    }
    return {gain, pan};
}

// Mixer::region_master_gain_at.
float region_master_gain_at(const Session& session, Frame timeline_frame) noexcept {
    for (const auto& song : session.songs)
        for (const auto& region : song.regions)
            if (timeline_frame >= region.start_frame && timeline_frame < region.end_frame)
                return region.master_gain;
    return 1.0f;
}

const Source* find_source(const Session& session, const Id& id) {
    for (const auto& source : session.sources)
        if (source.id == id) return &source;
    return nullptr;
}

struct RenderContext {
    const OfflineRenderRequest& request;
    const Session& session;
    Frame range_start = 0;
    Frame range_end = 0;
    // Progress bookkeeping: one unit per track (or cue layer) per output.
    double units_done = 0.0;
    double units_total = 1.0;
    const OfflineRenderProgress& progress;
    OfflineRenderReport& report;

    bool report_progress(double unit_fraction) const {
        if (!progress) return true;
        const double fraction = (units_done + unit_fraction) / std::max(1.0, units_total);
        return progress(std::clamp(fraction, 0.0, 1.0));
    }
};

// Render one track across the range and add it to the output bus.
Result<void> render_track(RenderContext& ctx, const Song& song, const Track& track,
                          float* acc_l, float* acc_r) {
    const int sample_rate = ctx.request.sample_rate;
    const bool apply_mixer = ctx.request.apply_mixer;

    const auto decode_started = std::chrono::steady_clock::now();
    std::size_t clip_count = 0;
    for (const auto& clip : track.clips)
        if (clip.timeline_start_frame < ctx.range_end
            && clip.timeline_start_frame + clip.length_frames > ctx.range_start)
            ++clip_count;
    std::vector<ClipRuntime> clips;
    for (const auto& clip : track.clips) {
        const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
        const Frame overlap_start = std::max(ctx.range_start, clip.timeline_start_frame);
        const Frame overlap_end = std::min(ctx.range_end, clip_end);
        if (overlap_end <= overlap_start) continue;

        ClipRuntime cr;
        cr.clip = &clip;
        const Source* source = find_source(ctx.session, clip.source_id);
        const std::string path = source && !source->file_path.empty() ? source->file_path
                                                                        : clip.source_id;
        const SourceWindow window = clip_source_window(track, clip, song, overlap_start,
                                                       overlap_end, sample_rate);
        // Decoding is the first half of this track's share of the bar, split
        // evenly between its clips; mixing is the second half.
        const std::size_t clip_index = clips.size();
        const auto on_decode = [&](double fraction) {
            return ctx.report_progress(0.5 * (static_cast<double>(clip_index) + fraction)
                                       / static_cast<double>(std::max<std::size_t>(1, clip_count)));
        };
        auto decoded = decode_window(clip.source_id, path, sample_rate, window.start,
                                     window.end, on_decode);
        if (decoded.is_err() && decoded.error() == kCancelled)
            return Result<void>::err(kCancelled);
        if (decoded.is_ok()) {
            cr.audio = decoded.take();
            cr.readable = true;
        } else {
            ++ctx.report.missing_clips;
            if (std::find(ctx.report.missing_files.begin(), ctx.report.missing_files.end(),
                          path) == ctx.report.missing_files.end())
                ctx.report.missing_files.push_back(path);
        }
        clips.push_back(std::move(cr));
    }

    const double decode_ms = ms_since(decode_started);
    const auto dsp_started = std::chrono::steady_clock::now();
    int path_blocks[3] = {0, 0, 0};

    std::pair<float, float> controls{1.0f, 0.0f};
    if (apply_mixer)
        controls = effective_gain_pan(song, track);
    const auto [track_gain, track_pan] = controls;

    Scratch s;
    const Frame total = ctx.range_end - ctx.range_start;
    int block_index = 0;
    for (Frame timeline_frame = ctx.range_start; timeline_frame < ctx.range_end;
         timeline_frame += kBlockFrames, ++block_index) {
        const int n = static_cast<int>(std::min<Frame>(kBlockFrames, ctx.range_end - timeline_frame));
        std::fill_n(s.bus_l.begin(), n, 0.0f);
        std::fill_n(s.bus_r.begin(), n, 0.0f);

        bool any = false;
        for (auto& cr : clips) {
            if (!cr.readable) continue;
            ClipBlock cb;
            if (!prepare_clip_block(*cr.clip, timeline_frame, n, cb)) continue;
            const auto d = resolve_pitch_render_decision(track, *cr.clip, song, timeline_frame);
            ++path_blocks[static_cast<int>(d.path)];
            switch (d.path) {
                case ClipPathKind::Direct:
                    cr.audio.read(cb.source_frame, cb.frames_to_read,
                                  s.clip_l.data(), s.clip_r.data());
                    break;
                case ClipPathKind::Varispeed:
                    render_varispeed(cr, cb, d.pitch_scale, s);
                    break;
                case ClipPathKind::Stretched: {
                    auto stretched = render_stretched(cr, cb, d.effective_semitones,
                                                      d.warp_time_ratio, sample_rate, s);
                    if (stretched.is_err())
                        return stretched;
                    break;
                }
            }
            finalise_clip_block(*cr.clip, cb, s);
            any = true;
        }

        if (any) {
            // Mixer phase B for one track, without the per-block ramps (the
            // controls do not move during a render).
            float peak_l = 0.0f, peak_r = 0.0f;
            for (int f = 0; f < n; ++f) {
                peak_l = std::max(peak_l, std::abs(s.bus_l[static_cast<std::size_t>(f)]));
                peak_r = std::max(peak_r, std::abs(s.bus_r[static_cast<std::size_t>(f)]));
            }
            const bool left_only = peak_l > 1.0e-7f && peak_r <= 1.0e-7f;
            const bool right_only = peak_r > 1.0e-7f && peak_l <= 1.0e-7f;
            const bool mono_downmix = apply_mixer && track.mono_downmix;
            const float gain = apply_mixer
                ? track_gain * region_master_gain_at(ctx.session, timeline_frame)
                : 1.0f;
            const float left_gain = pan_left_gain(track_pan);
            const float right_gain = pan_right_gain(track_pan);
            float* out_l = acc_l + (timeline_frame - ctx.range_start);
            float* out_r = acc_r + (timeline_frame - ctx.range_start);
            for (int f = 0; f < n; ++f) {
                float src_l = s.bus_l[static_cast<std::size_t>(f)];
                float src_r = s.bus_r[static_cast<std::size_t>(f)];
                if (mono_downmix) {
                    const float summed = 0.5f * (src_l + src_r);
                    src_l = summed;
                    src_r = summed;
                } else if (left_only) {
                    src_r = src_l;
                } else if (right_only) {
                    src_l = src_r;
                }
                out_l[f] += src_l * gain * left_gain;
                out_r[f] += src_r * gain * right_gain;
            }
        }

        if ((block_index & 15) == 0) {
            const double done = static_cast<double>(timeline_frame - ctx.range_start + n)
                / static_cast<double>(std::max<Frame>(1, total));
            if (!ctx.report_progress(0.5 + 0.5 * done))
                return Result<void>::err(kCancelled);
        }
    }
    render_log("track '%s': %zu clip(s), decode %.0f ms, dsp %.0f ms "
               "(blocks direct=%d varispeed=%d stretched=%d) for %.1f s\n",
               track.name.c_str(), clips.size(), decode_ms, ms_since(dsp_started),
               path_blocks[0], path_blocks[1], path_blocks[2],
               static_cast<double>(total) / sample_rate);
    return Result<void>::ok();
}

// Metronome / voice guide: the same renderers the mixer runs after the tracks,
// forced to the master route (a render has no monitor bus).
template <typename RenderBlock>
Result<void> render_cue_layer(RenderContext& ctx, RenderBlock&& render_block,
                              float* acc_l, float* acc_r) {
    const Frame total = ctx.range_end - ctx.range_start;
    int block_index = 0;
    for (Frame timeline_frame = ctx.range_start; timeline_frame < ctx.range_end;
         timeline_frame += kBlockFrames, ++block_index) {
        const int n = static_cast<int>(std::min<Frame>(kBlockFrames, ctx.range_end - timeline_frame));
        float* planes[2] = {acc_l + (timeline_frame - ctx.range_start),
                            acc_r + (timeline_frame - ctx.range_start)};
        render_block(planes, n, timeline_frame);
        if ((block_index & 63) == 0) {
            const double done = static_cast<double>(timeline_frame - ctx.range_start + n)
                / static_cast<double>(std::max<Frame>(1, total));
            if (!ctx.report_progress(done))
                return Result<void>::err(kCancelled);
        }
    }
    return Result<void>::ok();
}

// ── WAV writing ────────────────────────────────────────────────────────────

std::FILE* open_for_write(const std::string& path) {
#if defined(_WIN32)
    return _wfopen(to_wide(path).c_str(), L"wb");
#else
    return std::fopen(path.c_str(), "wb");
#endif
}

void remove_file(const std::string& path) {
#if defined(_WIN32)
    _wremove(to_wide(path).c_str());
#else
    std::remove(path.c_str());
#endif
}

void put_u16(std::vector<unsigned char>& b, std::uint16_t v) {
    b.push_back(static_cast<unsigned char>(v & 0xff));
    b.push_back(static_cast<unsigned char>((v >> 8) & 0xff));
}

void put_u32(std::vector<unsigned char>& b, std::uint32_t v) {
    for (int i = 0; i < 4; ++i)
        b.push_back(static_cast<unsigned char>((v >> (8 * i)) & 0xff));
}

void put_tag(std::vector<unsigned char>& b, const char* tag) {
    b.insert(b.end(), tag, tag + 4);
}

// TPDF dither source: xorshift, deterministic so a render is reproducible.
struct Dither {
    std::uint32_t state = 0x9E3779B9u;
    float next() noexcept {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return static_cast<float>(state) / 4294967296.0f;
    }
    float tpdf_lsb() noexcept { return next() - next(); }
};

Result<void> write_wav(const std::string& path, const std::vector<float>& l,
                       const std::vector<float>& r, int channels, int sample_rate,
                       OfflineSampleFormat format, bool dither) {
    const int bytes_per_sample = format == OfflineSampleFormat::Pcm16 ? 2
        : format == OfflineSampleFormat::Pcm24 ? 3 : 4;
    const bool is_float = format == OfflineSampleFormat::Float32;
    const std::uint64_t frames = l.size();
    const std::uint64_t data_bytes = frames * static_cast<std::uint64_t>(channels)
        * static_cast<std::uint64_t>(bytes_per_sample);
    if (data_bytes > 0xFFFFFFFFull - 64)
        return Result<void>::err("the rendered file would exceed the 4 GB WAV limit");

    std::vector<unsigned char> header;
    const std::uint32_t fmt_size = is_float ? 18 : 16;
    const std::uint32_t fact_bytes = is_float ? 12 : 0;
    put_tag(header, "RIFF");
    put_u32(header, static_cast<std::uint32_t>(4 + (8 + fmt_size) + fact_bytes + 8 + data_bytes));
    put_tag(header, "WAVE");
    put_tag(header, "fmt ");
    put_u32(header, fmt_size);
    put_u16(header, is_float ? 3 : 1);
    put_u16(header, static_cast<std::uint16_t>(channels));
    put_u32(header, static_cast<std::uint32_t>(sample_rate));
    put_u32(header, static_cast<std::uint32_t>(sample_rate * channels * bytes_per_sample));
    put_u16(header, static_cast<std::uint16_t>(channels * bytes_per_sample));
    put_u16(header, static_cast<std::uint16_t>(bytes_per_sample * 8));
    if (is_float) {
        put_u16(header, 0);   // cbSize
        put_tag(header, "fact");
        put_u32(header, 4);
        put_u32(header, static_cast<std::uint32_t>(frames));
    }
    put_tag(header, "data");
    put_u32(header, static_cast<std::uint32_t>(data_bytes));

    std::FILE* file = open_for_write(path);
    if (!file)
        return Result<void>::err("cannot create " + path);
    bool ok = std::fwrite(header.data(), 1, header.size(), file) == header.size();

    Dither rng;
    constexpr std::size_t kChunkFrames = 8192;
    std::vector<unsigned char> buffer;
    buffer.reserve(kChunkFrames * static_cast<std::size_t>(channels * bytes_per_sample));
    for (std::size_t start = 0; ok && start < frames; start += kChunkFrames) {
        const std::size_t end = std::min<std::size_t>(frames, start + kChunkFrames);
        buffer.clear();
        for (std::size_t i = start; i < end; ++i) {
            for (int ch = 0; ch < channels; ++ch) {
                const float x = channels == 1 ? 0.5f * (l[i] + r[i]) : (ch == 0 ? l[i] : r[i]);
                if (is_float) {
                    std::uint32_t bits;
                    std::memcpy(&bits, &x, 4);
                    put_u32(buffer, bits);
                } else if (bytes_per_sample == 2) {
                    float v = x * 32767.0f;
                    if (dither) v += rng.tpdf_lsb();
                    const auto q = static_cast<std::int32_t>(
                        std::lround(std::clamp(v, -32768.0f, 32767.0f)));
                    put_u16(buffer, static_cast<std::uint16_t>(static_cast<std::int16_t>(q)));
                } else {
                    const double v = std::clamp(static_cast<double>(x) * 8388607.0,
                                                -8388608.0, 8388607.0);
                    const auto q = static_cast<std::int32_t>(std::llround(v));
                    const auto u = static_cast<std::uint32_t>(q);
                    buffer.push_back(static_cast<unsigned char>(u & 0xff));
                    buffer.push_back(static_cast<unsigned char>((u >> 8) & 0xff));
                    buffer.push_back(static_cast<unsigned char>((u >> 16) & 0xff));
                }
            }
        }
        ok = std::fwrite(buffer.data(), 1, buffer.size(), file) == buffer.size();
    }
    ok = (std::fclose(file) == 0) && ok;
    if (!ok) {
        remove_file(path);
        return Result<void>::err("could not write " + path + " (disk full?)");
    }
    return Result<void>::ok();
}

// ── Track lookup ───────────────────────────────────────────────────────────

struct TrackRef {
    const Song*  song = nullptr;
    const Track* track = nullptr;
};

// Expand a folder into the audio tracks under it, so asking for "Guitars"
// renders every guitar. Keeps first-seen order and drops duplicates.
void collect_audio_tracks(const Session& session, const Id& id,
                          std::vector<TrackRef>& out, std::unordered_set<Id>& seen) {
    for (const auto& song : session.songs) {
        for (const auto& track : song.tracks) {
            if (track.id != id) continue;
            if (track.kind == TrackKind::Folder) {
                for (const auto& child : song.tracks)
                    if (child.parent_track_id == track.id)
                        collect_audio_tracks(session, child.id, out, seen);
            } else if (seen.insert(track.id).second) {
                out.push_back({&song, &track});
            }
            return;
        }
    }
}

} // namespace

Result<OfflineRenderReport> render_offline(const OfflineRenderRequest& request,
                                           const OfflineRenderProgress& progress) {
    using R = Result<OfflineRenderReport>;
    if (request.sample_rate < 8000 || request.sample_rate > 384000)
        return R::err("unsupported sample rate");
    if (request.channels != 1 && request.channels != 2)
        return R::err("channels must be 1 or 2");
    if (!(request.end_seconds > request.start_seconds) || request.start_seconds < 0.0)
        return R::err("empty render range");
    if (request.end_seconds - request.start_seconds > kMaxRenderSeconds)
        return R::err("render range is too long");
    if (request.outputs.empty())
        return R::err("nothing to render");

    auto parsed = session_from_project_json(request.project_json, request.sample_rate);
    if (parsed.is_err())
        return R::err(parsed.error());
    const Session session = parsed.take();

    OfflineRenderReport report;
    const Frame range_start = static_cast<Frame>(std::llround(request.start_seconds * request.sample_rate));
    const Frame range_end = static_cast<Frame>(std::llround(request.end_seconds * request.sample_rate));
    const Frame total = range_end - range_start;
    if (total <= 0)
        return R::err("empty render range");

    // Resolve every output's tracks up front so a bad id fails before any work.
    std::vector<std::vector<TrackRef>> output_tracks;
    double units_total = 0.0;
    bool wants_guide = false;
    for (const auto& output : request.outputs) {
        if (output.path.empty())
            return R::err("output path missing");
        std::vector<TrackRef> refs;
        std::unordered_set<Id> seen;
        for (const auto& id : output.track_ids)
            collect_audio_tracks(session, id, refs, seen);
        if (refs.empty() && !output.include_metronome && !output.include_voice_guide)
            return R::err("an output has no tracks to render");
        units_total += static_cast<double>(refs.size())
            + (output.include_metronome ? 1.0 : 0.0)
            + (output.include_voice_guide ? 1.0 : 0.0)
            + 0.25;   // finalise + write
        wants_guide = wants_guide || output.include_voice_guide;
        output_tracks.push_back(std::move(refs));
    }

    std::shared_ptr<VoiceGuideClipBank> guide_bank;
    if (wants_guide && !request.voice_guide_dir.empty())
        guide_bank = load_voice_guide_bank(request.voice_guide_dir, request.voice_guide_lang,
                                           request.sample_rate);

    RenderContext run{request, session, range_start, range_end, 0.0,
                      units_total, progress, report};

    std::vector<std::string> written;
    auto fail = [&](const std::string& error) {
        for (const auto& path : written) remove_file(path);
        return R::err(error);
    };

    for (std::size_t oi = 0; oi < request.outputs.size(); ++oi) {
        const auto& output = request.outputs[oi];
        std::vector<float> acc_l(static_cast<std::size_t>(total), 0.0f);
        std::vector<float> acc_r(static_cast<std::size_t>(total), 0.0f);

        for (const auto& ref : output_tracks[oi]) {
            auto rendered = render_track(run, *ref.song, *ref.track, acc_l.data(), acc_r.data());
            if (rendered.is_err())
                return fail(rendered.error());
            run.units_done += 1.0;
        }

        if (output.include_metronome) {
            MetronomeRenderer metronome;
            MetronomeConfig config = request.metronome;
            config.enabled = true;
            config.output_route = "master";
            metronome.set_config(config);
            const double sr = static_cast<double>(request.sample_rate);
            auto done = render_cue_layer(run,
                [&](float** planes, int n, Frame frame) {
                    metronome.render(planes, 2, n, sr, frame, &session);
                }, acc_l.data(), acc_r.data());
            if (done.is_err())
                return fail(done.error());
            run.units_done += 1.0;
        }

        if (output.include_voice_guide) {
            VoiceGuideRenderer guide;
            VoiceGuideConfig config = request.voice_guide;
            config.enabled = true;
            config.output_route = "master";
            guide.set_config(config);
            guide.set_clip_bank(guide_bank);
            const double sr = static_cast<double>(request.sample_rate);
            auto done = render_cue_layer(run,
                [&](float** planes, int n, Frame frame) {
                    guide.render(planes, 2, n, sr, frame, &session);
                }, acc_l.data(), acc_r.data());
            if (done.is_err())
                return fail(done.error());
            run.units_done += 1.0;
        }

        float peak = 0.0f;
        for (std::size_t i = 0; i < acc_l.size(); ++i)
            peak = std::max(peak, std::max(std::abs(acc_l[i]), std::abs(acc_r[i])));
        if (request.channels == 1) {
            peak = 0.0f;
            for (std::size_t i = 0; i < acc_l.size(); ++i)
                peak = std::max(peak, std::abs(0.5f * (acc_l[i] + acc_r[i])));
        }

        if (request.normalize && peak > 1.0e-9f) {
            const float target = static_cast<float>(std::pow(10.0, request.normalize_peak_db / 20.0));
            const float g = target / peak;
            for (std::size_t i = 0; i < acc_l.size(); ++i) {
                acc_l[i] *= g;
                acc_r[i] *= g;
            }
        } else if (!request.normalize) {
            // What the device gets in playback: the master limiter is
            // transparent below 0.98, so it only touches a mix that would clip.
            for (std::size_t i = 0; i < acc_l.size(); ++i) {
                acc_l[i] = soft_limit_output(acc_l[i]);
                acc_r[i] = soft_limit_output(acc_r[i]);
            }
        }

        if (!run.report_progress(0.0))
            return fail(kCancelled);
        auto wrote = write_wav(output.path, acc_l, acc_r, request.channels,
                               request.sample_rate, request.format,
                               request.dither && request.format == OfflineSampleFormat::Pcm16);
        if (wrote.is_err())
            return fail(wrote.error());
        written.push_back(output.path);
        report.files.push_back({output.path, total, peak});
        run.units_done += 0.25;
        if (!run.report_progress(0.0))
            return fail(kCancelled);
    }

    return R::ok(std::move(report));
}

// ── JSON boundary ──────────────────────────────────────────────────────────

Result<OfflineRenderRequest> offline_render_request_from_json(const std::string& text) {
    using R = Result<OfflineRenderRequest>;
    try {
        const json j = json::parse(text);
        OfflineRenderRequest req;
        req.project_json = j.at("project_json").get<std::string>();
        req.sample_rate = j.value("sample_rate", 48000);
        req.start_seconds = j.at("start_seconds").get<double>();
        req.end_seconds = j.at("end_seconds").get<double>();
        const std::string format = j.value("format", std::string("pcm24"));
        if (format == "pcm16") req.format = OfflineSampleFormat::Pcm16;
        else if (format == "pcm24") req.format = OfflineSampleFormat::Pcm24;
        else if (format == "float32") req.format = OfflineSampleFormat::Float32;
        else return R::err("unknown format " + format);
        req.channels = j.value("channels", 2);
        req.normalize = j.value("normalize", false);
        req.normalize_peak_db = j.value("normalize_peak_db", -0.3);
        req.apply_mixer = j.value("apply_mixer", true);
        req.dither = j.value("dither", true);
        for (const auto& jo : j.at("outputs")) {
            OfflineRenderOutput out;
            out.path = jo.at("path").get<std::string>();
            out.track_ids = jo.value("track_ids", std::vector<std::string>{});
            out.include_metronome = jo.value("include_metronome", false);
            out.include_voice_guide = jo.value("include_voice_guide", false);
            req.outputs.push_back(std::move(out));
        }
        if (j.contains("metronome") && j["metronome"].is_object()) {
            const auto& m = j["metronome"];
            req.metronome.volume = m.value("volume", 0.75f);
            req.metronome.accent_enabled = m.value("accent_enabled", true);
            req.metronome.accent_preset = m.value("accent_preset", 0);
            req.metronome.beat_preset = m.value("beat_preset", 0);
            req.metronome.accent_pitch = m.value("accent_pitch", 0.0f);
            req.metronome.beat_pitch = m.value("beat_pitch", 0.0f);
            req.metronome.subdivision = m.value("subdivision", 1);
            req.metronome.subdivision_preset = m.value("subdivision_preset", 0);
            req.metronome.subdivision_pitch = m.value("subdivision_pitch", 0.0f);
            req.metronome.subdivision_gain = m.value("subdivision_gain", 0.5f);
        }
        if (j.contains("voice_guide") && j["voice_guide"].is_object()) {
            const auto& v = j["voice_guide"];
            req.voice_guide.volume = v.value("volume", 1.0f);
            req.voice_guide.lead_bars = v.value("lead_bars", 1);
            req.voice_guide.count_in_enabled = v.value("count_in_enabled", true);
            req.voice_guide_dir = v.value("voices_dir", std::string());
            req.voice_guide_lang = v.value("lang", std::string());
        }
        return R::ok(std::move(req));
    } catch (const std::exception& e) {
        return R::err(std::string("invalid render request: ") + e.what());
    }
}

std::string offline_render_result_to_json(const Result<OfflineRenderReport>& result) {
    json out;
    out["ok"] = result.is_ok();
    if (result.is_err()) {
        out["error"] = result.error();
        out["cancelled"] = result.error() == kCancelled;
        return out.dump();
    }
    const auto& report = result.unwrap();
    json files = json::array();
    for (const auto& f : report.files)
        files.push_back({{"path", f.path}, {"frames", f.frames}, {"peak", f.peak}});
    out["files"] = files;
    out["missing_clips"] = report.missing_clips;
    out["missing_files"] = report.missing_files;
    return out.dump();
}

} // namespace lt
