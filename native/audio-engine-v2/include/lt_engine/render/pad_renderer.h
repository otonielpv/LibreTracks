#pragma once

#include <lt_engine/core/types.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Ambient-pad clip — a single decoded key of a pad, kept interleaved-stereo in
// memory. Built off the audio thread (see load_pad_clip); the renderer only
// reads it through a shared_ptr swap, so it is realtime-safe to consult from
// render().
//
// A pad ships one long (~15 min) audio file per musical key. Loading all 12
// keys to RAM at once is prohibitive (~300 MB each), so the bank here holds
// only the active key plus the previous key for the brief live crossfade.
// ---------------------------------------------------------------------------
struct PadClip {
    std::vector<float> samples;    // interleaved stereo at `sample_rate`
    int    channels    = 2;        // decoded channel count (1 or 2)
    double sample_rate = 0.0;      // sample rate the clip was decoded at
    int    key         = -1;       // 0..11 (C..B); -1 = none
    bool empty() const noexcept { return samples.empty() || channels <= 0; }
};

// Decode a single pad key from disk into an interleaved-stereo clip. Expects
//   <pads_dir>/<pad_id>/<key_name>.<ext>   (e.g. .../warm/C.mp3)
// where key_name is one of C, Cs, D, Ds, E, F, Fs, G, Gs, A, As, B (the sharp
// spelling avoids '#' in filenames). The first extension found wins. Decodes to
// `target_sample_rate`, keeping up to 2 channels. Runs off the audio thread.
// Returns an empty clip (empty() == true) when the file is missing or fails.
std::shared_ptr<PadClip> load_pad_clip(const std::string& pads_dir,
                                       const std::string& pad_id,
                                       int key,
                                       int target_sample_rate);

struct PadConfig {
    bool  enabled = false;
    float volume = 1.0f;
    std::string output_route = "master";
    int   key = 0;                 // 0..11 (C..B) — the currently selected key
    std::string pad_id;            // installed pad folder name (diagnostics only)
    // Soft-entrance duration in seconds. When >0, enabling the pad (or an
    // automation cue turning it on) ramps the level up over this time instead of
    // the near-instant 5 ms default.
    float fade_in_seconds = 0.0f;
    // Soft-exit duration in seconds. When >0, disabling the pad ramps the level
    // down over this time, and a key/pack swap crossfades over this time so the
    // outgoing pad leaves gently instead of being replaced almost instantly.
    float fade_out_seconds = 0.0f;
};

struct PadDiagnostics {
    bool        enabled = false;
    float       volume = 1.0f;
    std::string route_resolved = "master";
    int         key = 0;
    std::string pad_id;
    bool        clip_loaded = false;
    int         clip_key = -1;     // key of the clip currently in the bank
    float       current_gain = 0.f;
    std::string muted_reason = "disabled";
};

// ---------------------------------------------------------------------------
// PadRenderer — ambient pad playback. Loops one decoded key continuously with
// its own volume and output routing, independent of the song transport and of
// the song master gain (mixed alongside the metronome / voice guide).
//
// Realtime-safe: render() takes no locks and allocates nothing; the clip is
// swapped via shared_ptr. A short crossfade at the loop seam keeps the wrap
// click-free, and gain ramps smoothly on enable/disable.
// ---------------------------------------------------------------------------
class PadRenderer {
public:
    void set_config(const PadConfig& config);
    void set_enabled(bool enabled);
    void set_volume(float volume);
    void set_fade_in_seconds(float seconds);
    void set_fade_out_seconds(float seconds);
    PadConfig config() const;

    // Publish a freshly-decoded key clip (or nullptr to clear). The audio
    // thread keeps the old clip alive while it crossfades to the new one at the
    // equivalent loop position, so live key/pack changes neither click nor
    // restart the ambience from its attack.
    void set_clip(std::shared_ptr<const PadClip> clip) noexcept;

    void render(float** output_channels,
                int num_channels,
                int num_frames,
                double sample_rate) noexcept;

    PadDiagnostics diagnostics() const;

private:
    enum class RouteMode : int { Master = 0, Monitor = 1, Ext = 2 };

    std::atomic<bool>  enabled_{false};
    std::atomic<float> volume_{1.0f};
    std::atomic<float> fade_in_seconds_{0.0f};
    std::atomic<float> fade_out_seconds_{0.0f};
    std::atomic<int>   key_{0};
    std::atomic<int>   route_mode_{static_cast<int>(RouteMode::Master)};
    std::atomic<int>   route_start_{0};
    std::atomic<int>   route_end_{1};
    std::array<char, 64> output_route_{};
    std::array<char, 64> pad_id_{};

    // Active clip. Pinned by a shared_ptr so a swap can't free the buffer while
    // render() still reads it. bank_present_ mirrors clip != nullptr for a
    // lock-free diagnostics read.
    std::shared_ptr<const PadClip> clip_;
    std::atomic<bool> clip_present_{false};
    // Read cursor into the active clip (in frames), advanced by render(). Only
    // touched from the audio thread.
    std::int64_t read_frame_ = 0;
    // Sequence bumped by set_clip() so the audio thread notices a swap without
    // taking a lock.
    std::atomic<std::uint64_t> clip_seq_{0};
    std::uint64_t applied_clip_seq_ = 0;
    // The clip the audio thread is actually reading. During a live swap both
    // active_clip_ and outgoing_clip_ are rendered concurrently.
    std::shared_ptr<const PadClip> active_clip_;
    std::shared_ptr<const PadClip> outgoing_clip_;
    std::int64_t outgoing_read_frame_ = 0;
    int crossfade_remaining_ = 0;
    int crossfade_total_ = 0;

    float current_output_gain_ = 0.0f;
    // Linear per-sample step the output gain moves toward its target by. Captured
    // when a level change begins (enable/disable/volume) from the appropriate
    // ramp duration, then held across blocks so a multi-second musical fade is a
    // straight, predictable ramp rather than an ever-slowing one-pole tail.
    float gain_step_ = 0.0f;
    // Tracks the enabled state the audio thread last saw, so render() can detect
    // the enable→disable / disable→enable edge and pick the fade-in vs fade-out
    // ramp for the level change (vs the fast default for volume tweaks).
    bool was_enabled_ = false;

    std::array<char, 64> route_resolved_{};
    std::array<char, 64> muted_reason_{};
    std::atomic<int> clip_key_{-1};
};

} // namespace lt
