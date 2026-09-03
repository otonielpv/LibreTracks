#pragma once

// ---------------------------------------------------------------------------
// BungeePitchVoice
//
// Audio-thread pitch shifting using the Bungee library
// (https://github.com/bungee-audio-stretch/bungee, MPL-2.0).
//
// One instance per (clip x active-pitch) voice. Built on the control thread,
// rendered from the audio thread block-by-block. The wrapped Bungee::Stream
// API supports forward playback only; for seek/jump the recommended pattern
// (per upstream issue #16) is to destroy and reconstruct the voice.
//
// Compiled into a no-op when LT_ENGINE_HAVE_BUNGEE is 0 so the engine
// builds normally on systems where Bungee is not available.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

#include <cstdint>
#include <memory>

namespace lt {

class BungeePitchVoice {
public:
    BungeePitchVoice();
    ~BungeePitchVoice();

    // ── Diagnóstico de dónde muere una voz ───────────────────────────────
    //
    // Destruir una voz libera los buffers de Bungee: toma el lock del
    // allocator. Si eso ocurre dentro del callback, es un stall del hilo de
    // audio. La hebra de control retira los mapas salientes precisamente para
    // que no pase (`BungeeVoiceManager::Impl::publish_from_control`), y este
    // contador es lo que lo demuestra en vez de darlo por supuesto.
    //
    // Sólo cuenta con LT_ENGINE_RT_GUARD activo (tests): identificar el hilo
    // de audio necesita la marca del paso 02. En producción el destructor no
    // hace nada extra.
    static std::uint64_t destroyed_on_audio_thread_count() noexcept;
    static void reset_destroyed_on_audio_thread_count() noexcept;

    BungeePitchVoice(const BungeePitchVoice&) = delete;
    BungeePitchVoice& operator=(const BungeePitchVoice&) = delete;
    BungeePitchVoice(BungeePitchVoice&&) noexcept;
    BungeePitchVoice& operator=(BungeePitchVoice&&) noexcept;

    // ── Lifetime (control thread) ────────────────────────────────────────

    // Construct the underlying Stretcher and Stream. Call once before any
    // render_block(). Safe to call again to reconfigure (allocates).
    // Returns true on success; false means the build was compiled without
    // Bungee or configuration failed.
    bool configure(int sample_rate,
                   int channel_count,
                   int max_input_frames_per_block);

    // True when configure() succeeded and the voice is ready to render.
    bool is_ready() const noexcept;

    // Returns "bungee_basic" when active, "unavailable" otherwise.
    const char* backend_name() const noexcept;

    // ── DSP (audio thread, must not allocate) ────────────────────────────

    // Render up to output_frames frames into out[0..channels-1].
    // input is planar source audio: input[ch] points to input_frames floats.
    // pitch_scale is a frequency multiplier; 1.0 = no change, 0.5 = octave
    // down, 2.0 = octave up. Bungee accepts a new pitch value every call,
    // gaplessly.
    //
    // The time-stretch ratio is NOT a parameter: Bungee derives its speed from
    // the ratio of the frame counts you pass
    //     speed = input_frames / output_frames
    // so the caller sets the ratio purely by choosing how much source to hand
    // over for the output it wants. Passing a separate ratio alongside those
    // counts invited them to disagree, and when they did the disagreement was
    // silent — it showed up only as a track drifting away from the click over
    // several minutes.
    //
    // Everything given in `input` is consumed. The caller decides the span,
    // because only the caller knows where the timeline is.
    int render_block(const float* const* input,
                     int input_frames,
                     float* const* output,
                     int output_frames,
                     double pitch_scale) noexcept;

    // Output frames already produced by Bungee and waiting in the realtime
    // FIFO.
    int queued_output_frames() const noexcept;

    // ── Latency / position introspection (per Bungee issue #38) ─────────
    //
    // Per the Bungee maintainer, the correct way to know the current
    // algorithmic delay is to query the Stream wrapper after at least one
    // process() call has returned output. Bungee Stream APIs:
    //   inputPosition()  - total input frames fed so far
    //   outputPosition() - input-frame position corresponding to current out
    //   latency()        - inputPosition() - outputPosition()
    //
    // These are reported in INPUT-rate frames. Before the first process()
    // call has produced output, latency() may return 0 or be undefined per
    // issue #23; callers should call render_block() at least once before
    // relying on this value.

    // Total input frames passed to the underlying Stream so far.
    long long input_position() const noexcept;

    // Input-frame position corresponding to the most recent output sample.
    double output_position() const noexcept;

    // Current algorithmic delay in input-rate frames. 0 when no Bungee voice
    // is alive (stub build). May be 0 until the first render_block() returns
    // a non-zero frame count.
    double latency_frames() const noexcept;


    // True once Bungee's analysis pipeline is full and the next render_block()
    // will produce useful, timeline-aligned audio.
    //
    // This asks whether latency has CONVERGED, not whether it is small. The
    // previous test — latency_frames() < max_input_frames — could never be
    // satisfied: latency settles at 4864 frames at hop=-1 and 9728 at hop=0,
    // while max_input_frames is one block times four (2048 at a 512-frame
    // block). It returned false for the entire life of every voice, so the
    // warm loops that consult it always ran to their frame budget instead of
    // stopping when the voice was actually ready.
    //
    // Convergence is the property those callers want and it holds for any hop
    // setting, so nothing here needs revisiting if the granularity changes.
    // Latency reaches its resting value after roughly 2048 input frames.
    bool   is_warm() const noexcept;

    // ── Feed position ────────────────────────────────────────────────────
    //
    // The voice does NOT track where the timeline is. It tracks only how far
    // into the source it has been fed, so the next feed can start exactly
    // where the last one stopped. Bungee concatenates every buffer it is given
    // into one logical stream, so this contiguity is the caller's entire
    // responsibility — a gap skips material and an overlap repeats it, and the
    // stretcher can detect neither.
    //
    // Where playback IS, is the renderer's business, derived from the timeline
    // frame on every block. This voice used to keep its own accumulating
    // estimate of that, which is how a fraction of a frame per block turned
    // into a track running ahead of the click by the last chorus. Position is
    // now computed, never integrated.
    //
    // set_feed_anchor() is how the control thread hands over a prepared voice:
    //   anchor_source_frame  the source frame the voice will emit NEXT
    //   fed_through          the source frame input has been fed up to
    // Their difference is the pipeline lead — the head start Bungee needs over
    // what it is emitting — and it is held constant from then on, so the live
    // latency() reading never leaks into a read address.
    void      set_feed_anchor(long long anchor_source_frame,
                              long long fed_through) noexcept;
    long long fed_through() const noexcept;
    long long feed_lead_frames() const noexcept;

    // Move the feed position without feeding, for blocks that deliberately do
    // no work (a muted track). Keeps the voice lined up for the un-mute.
    void      advance_fed_through(long long frames) noexcept;

    // Force the feed position, abandoning contiguity. For discontinuities the
    // voice could not have anticipated; the caller owns masking the seam.
    void      reanchor_feed(long long fed_through) noexcept;

    void      clear_queued_output() noexcept;

    // ── Applied clip mapping (for incremental retime) ────────────────────
    //
    // The manager records the clip placement this voice was last built/retimed
    // for: timeline start, source start, and warp time-ratio (all in frames /
    // unitless ratio). retime_existing_for_session() compares the live session's
    // mapping for the same clip_id against these — and only hard-retimes (cursor
    // reset + FIFO clear) when they actually CHANGED. A voice whose clip didn't
    // move keeps its warm pipeline, so editing one clip never glitches the
    // others' playback. Set by the manager right after configure/prime.
    void set_clip_mapping(long long timeline_start_frame,
                          long long source_start_frame,
                          double time_ratio) noexcept;
    long long mapped_timeline_start() const noexcept;
    long long mapped_source_start() const noexcept;
    double    mapped_time_ratio() const noexcept;

    // Re-arm the post-construction fade-in so the next `fade_ms` of OUTPUT
    // frames the caller receives are ramped from 0→1 (equal-power). Used by
    // BungeeVoiceManager after warm_voice() has consumed the initial fade
    // window with zero input — so the audio thread still gets the masking
    // ramp when it first asks for real audio. Default 5 ms.
    void arm_fade_in(int fade_ms = 5) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
