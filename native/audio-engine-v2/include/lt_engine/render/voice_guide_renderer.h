#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Voice-guide clip bank — decoded, in-memory mono audio for the spoken section
// announcements and the beat count-in. Built off the audio thread (see the
// loader); the renderer only ever reads it through a shared_ptr swap, so it is
// realtime-safe to consult from render().
//
// Layout mirrors the asset tree voices/<lang>/{sections,counts}:
//   sections[kind]  -> "Intro", "Verse", "Chorus", ...  (one per MarkerKind)
//   counts[n]       -> spoken number n ("two", "three", ...). Index by beat
//                      number; index 0 and 1 are unused (beat 1 is the section).
// A clip is "absent" when its samples vector is empty; the renderer then simply
// plays nothing for that slot (e.g. a Custom marker with no recording).
// ---------------------------------------------------------------------------
struct VoiceGuideClip {
    std::vector<float> samples;   // mono, at the bank's sample_rate
};

// A section type's clips: the unnumbered base plus numbered variants (Verse 2,
// Chorus 3, ...). variants[n] is the clip for "<kind>_<n>.wav"; index 0 unused.
struct VoiceGuideSection {
    static constexpr int kMaxVariant = 9;   // pack ships up to 6; headroom to 8
    VoiceGuideClip base;
    std::array<VoiceGuideClip, kMaxVariant> variants{};
};

struct VoiceGuideClipBank {
    static constexpr int kKindCount = 40;   // MarkerKind values incl. cues + Custom
    static constexpr int kMaxCount  = 17;   // supports up to 16-beat bars + slack

    double sample_rate = 0.0;               // sample rate the clips were decoded at
    std::array<VoiceGuideSection, kKindCount> sections{};
    std::array<VoiceGuideClip, kMaxCount>     counts{};
    // Dynamic-cue clips, indexed by MarkerKind value. Only cue kinds populate a
    // slot (sections/Custom stay empty); a one-shot spoken instruction with no
    // numbered variants and no count-in.
    std::array<VoiceGuideClip, kKindCount>    cues{};

    // Resolve a section's clip for the given variant, falling back to the base
    // clip when the numbered variant is absent. `variant <= 0` means base.
    const VoiceGuideClip* section_for(MarkerKind kind, int variant) const noexcept;
    const VoiceGuideClip* count_for(int beat_number) const noexcept;
    // Resolve a dynamic cue's clip, or nullptr when the kind is not a cue or has
    // no recording in this bank (e.g. an English-only or Spanish-only cue).
    const VoiceGuideClip* cue_for(MarkerKind kind) const noexcept;
};

// Decode a language's voice bank from disk into memory. Expects the asset tree
//   <voices_dir>/<lang>/sections/<kind>.wav   (intro, verse, chorus, ...)
//   <voices_dir>/<lang>/counts/<n>.wav        (1..kMaxCount-1)
// Each file is decoded to `target_sample_rate` and downmixed to mono. Missing
// files are simply left empty (the renderer plays nothing for that slot), so a
// partial bank is valid. Runs off the audio thread. Returns a bank even if some
// clips are absent; returns nullptr only if the language directory is unusable.
std::shared_ptr<VoiceGuideClipBank> load_voice_guide_bank(
    const std::string& voices_dir, const std::string& lang, int target_sample_rate);

struct VoiceGuideConfig {
    bool  enabled = false;
    float volume = 1.0f;
    std::string output_route = "monitor";  // defaults to the monitor bus
    int   lead_bars = 1;                    // bars of announcement before a marker
    bool  count_in_enabled = true;          // false = section name only, no count
};

struct VoiceGuideDiagnostics {
    bool        enabled = false;
    float       volume = 0.f;
    std::string route_resolved = "monitor";
    int         lead_bars = 1;
    Frame       next_marker_frame = -1;
    std::string next_marker_kind;           // token, "" when none upcoming
    uint64_t    announcements_fired = 0;    // section clips started
    uint64_t    counts_fired = 0;           // count clips started
    std::string muted_reason;
    float       current_gain = 0.f;
    bool        bank_loaded = false;
};

// A target the voice guide should announce at a specific timeline frame,
// independent of the playhead's linear position. Used for scheduled jumps: the
// section the player is jumping TO is announced/counted before the jump fires
// at `at_frame`. The mixer fills this from the JumpScheduler each block.
struct VoiceGuideTarget {
    bool       active = false;     // false = no scheduled-jump announcement
    Frame      at_frame = 0;       // frame at which the section "lands" (jump fires)
    MarkerKind kind = MarkerKind::Custom;
    int        variant = 0;
};

// ---------------------------------------------------------------------------
// VoiceGuideRenderer — Playback-style spoken section cue + beat count-in.
//
// Synchronised to the same tempo/time-signature grid the metronome uses. The
// lead bar(s) before a target carry a full spoken count "1..N"; the section
// name is placed to END right at the downbeat so it never overlaps the count.
// The target is normally the next marker ahead of the playhead, but a scheduled
// jump overrides it (announce the jump destination before the jump fires).
// Realtime-safe: render() takes no locks and allocates nothing; the clip bank
// is swapped via shared_ptr.
// ---------------------------------------------------------------------------
class VoiceGuideRenderer {
public:
    void set_config(const VoiceGuideConfig& config);
    void set_enabled(bool enabled);
    void set_volume(float volume);
    VoiceGuideConfig config() const;

    // Swap in a freshly-loaded clip bank (or nullptr to clear). Cheap; the old
    // bank is released once no render() is mid-read.
    void set_clip_bank(std::shared_ptr<const VoiceGuideClipBank> bank) noexcept;

    void render(float** output_channels,
                int num_channels,
                int num_frames,
                double sample_rate,
                Frame timeline_frame,
                const Session* session,
                const VoiceGuideTarget& jump_target = {}) noexcept;

    VoiceGuideDiagnostics diagnostics() const;

private:
    enum class RouteMode : int { Master = 0, Monitor = 1, Ext = 2 };

    // One playing clip. Triggering a new clip "chokes" any still-playing voice
    // with a short fade-out so section/count announcements never overlap and
    // talk over each other (the Playback behaviour). The pool size lets the
    // fading tail of the previous voice ring out under the new one.
    struct Voice {
        const float* samples = nullptr; // points into a clip bank vector (bank outlives the voice)
        int total = 0;
        int index = 0;                  // next sample to read; index >= total == done
        float gain = 0.0f;
        // Choke fade: when >= 0, the voice is releasing — fade_remaining frames
        // left of a `fade_total`-frame linear ramp to silence, then it stops.
        int fade_remaining = -1;
        int fade_total = 0;
        bool active() const noexcept { return samples != nullptr && index < total; }
    };
    static constexpr int kVoiceCount = 6;

    void trigger_clip(const VoiceGuideClip* clip, float gain, double sample_rate) noexcept;
    void choke_active_voices(double sample_rate) noexcept;
    void reset_voices() noexcept;

    // Resolve the first SECTION marker at or after `frame` (non-Custom, not a
    // cue). This is the count-in downbeat target. Returns nullptr if none.
    static const Marker* upcoming_marker(const Song* song, Frame frame) noexcept;

    // Resolve the first dynamic-CUE marker at or after `frame`. Cues are
    // announced as one-shots (or chained into a nearby section's lead-in).
    static const Marker* upcoming_cue(const Song* song, Frame frame) noexcept;

    std::atomic<bool> enabled_{false};
    std::atomic<float> volume_{1.0f};
    std::atomic<int> lead_bars_{1};
    std::atomic<bool> count_in_enabled_{true};
    std::atomic<int> route_mode_{static_cast<int>(RouteMode::Monitor)};
    std::atomic<int> route_start_{2};
    std::atomic<int> route_end_{3};
    std::array<char, 64> output_route_{};

    std::shared_ptr<const VoiceGuideClipBank> bank_;
    std::atomic<bool> bank_present_{false};

    Frame last_render_end_ = -1;
    // The beat frame at which we last started the section clip and each count,
    // so a clip fires exactly once even across block boundaries.
    Frame last_section_frame_ = -1;
    Frame last_count_frame_ = -1;
    // The frame at which we last started a one-shot cue, so a loose cue fires
    // exactly once across block boundaries (chained cues key off the section).
    Frame last_cue_frame_ = -1;
    // Frame of the most recent cue chained into a section's lead-in, so the
    // same cue is not also fired as a loose one-shot.
    Frame last_chained_cue_frame_ = -1;
    std::array<Voice, kVoiceCount> voices_{};
    float current_output_gain_ = 0.0f;

    std::atomic<Frame> next_marker_frame_{-1};
    std::array<char, 32> next_marker_kind_{};
    std::atomic<uint64_t> announcements_fired_{0};
    std::atomic<uint64_t> counts_fired_{0};
    std::array<char, 64> muted_reason_{};
    std::array<char, 64> route_resolved_{};
};

} // namespace lt
