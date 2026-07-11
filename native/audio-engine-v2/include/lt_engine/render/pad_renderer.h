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
// only the SINGLE active key; changing key swaps in a freshly-decoded clip.
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
    PadConfig config() const;

    // Swap in a freshly-decoded key clip (or nullptr to clear). Cheap; the old
    // clip is released once no render() is mid-read. The read cursor resets to
    // the start of the new clip.
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
    // Read cursor into the active clip (in frames), advanced by render(). Reset
    // to 0 by set_clip(). Only touched from the audio thread.
    std::int64_t read_frame_ = 0;
    // Sequence bumped by set_clip() so the audio thread notices a swap and
    // resets its cursor without a lock.
    std::atomic<std::uint64_t> clip_seq_{0};
    std::uint64_t applied_clip_seq_ = 0;
    // The clip the audio thread is actually reading. set_clip() publishes the
    // new clip into clip_ immediately, but the audio thread only ADOPTS it
    // (swaps active_clip_ + rewinds the cursor) at a silent point of the swap
    // fade, so a key change never clicks. Held here so the buffer stays alive
    // for the whole fade-out of the OLD clip.
    std::shared_ptr<const PadClip> active_clip_;
    // Swap fade: > 0 while fading the old clip out before adopting the new one.
    // Counts down; on reaching 0 the pending clip is adopted and a fade-in
    // begins. swap_gain_ multiplies the output on top of current_output_gain_.
    int   swap_fade_out_remaining_ = 0;
    int   swap_fade_total_ = 0;
    bool  swap_pending_ = false;      // a new clip is waiting to be adopted
    float swap_gain_ = 1.0f;          // 0..1 crossfade envelope for the swap

    float current_output_gain_ = 0.0f;

    std::array<char, 64> route_resolved_{};
    std::array<char, 64> muted_reason_{};
    std::atomic<int> clip_key_{-1};
};

} // namespace lt
