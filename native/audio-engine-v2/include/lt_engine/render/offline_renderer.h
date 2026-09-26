#pragma once

// ---------------------------------------------------------------------------
// Offline renderer — "Render audio" for a song (region).
//
// Bounces a timeline range to WAV files faster than realtime, WITHOUT touching
// the live engine: it builds its own Session from the same project JSON that
// LoadSession receives, decodes only the source windows the range needs, and
// renders on the calling thread. Playback keeps running while it works.
//
// What it must reproduce is what the user hears, so every rule comes from the
// realtime path rather than being restated:
//   - the per-clip path (Direct / Varispeed / Stretched) is
//     resolve_pitch_render_decision(), the same call TrackRenderer makes;
//   - Bungee voices are primed with voice_priming::warm/align_on_source, the
//     single implementation the realtime voice manager uses;
//   - pan law and limiter come from mix_math.h, shared with the Mixer;
//   - clip fades and the folder gain/pan chain mirror TrackRenderer and
//     Mixer::effective_controls_from_session line for line.
//
// Mute and solo are deliberately ignored: the caller names the tracks it wants
// in each output file, which is the whole point of the feature ("everything
// but the drums"), so a track muted for tonight's show is still exportable.
// ---------------------------------------------------------------------------

#include <lt_engine/core/result.h>
#include <lt_engine/core/types.h>
#include <lt_engine/render/metronome_renderer.h>
#include <lt_engine/render/voice_guide_renderer.h>

#include <functional>
#include <string>
#include <vector>

namespace lt {

enum class OfflineSampleFormat {
    Pcm16,
    Pcm24,
    Float32,
};

// One file to write. A mix is one output listing every chosen track; stems are
// one output per track. The metronome and voice guide are mixed into whichever
// outputs ask for them (a stems export gives them their own file).
struct OfflineRenderOutput {
    std::string      path;
    std::vector<Id>  track_ids;
    bool             include_metronome = false;
    bool             include_voice_guide = false;
};

struct OfflineRenderRequest {
    std::string project_json;               // same payload as LoadSession
    int         sample_rate = 48000;        // output rate; the session is built at it
    double      start_seconds = 0.0;        // timeline range (the song region)
    double      end_seconds = 0.0;
    std::vector<OfflineRenderOutput> outputs;

    OfflineSampleFormat format = OfflineSampleFormat::Pcm24;
    int    channels = 2;                    // 1 = mono (L+R)/2, 2 = stereo
    bool   normalize = false;               // scale each file's peak to normalize_peak_db
    double normalize_peak_db = -0.3;
    // true: track/folder gain + pan, mono switch and song master volume apply,
    // exactly as in playback. false: every track at unity, centred — raw stems.
    bool   apply_mixer = true;
    bool   dither = true;                   // TPDF, 16-bit only

    MetronomeConfig  metronome;             // used by outputs with include_metronome
    VoiceGuideConfig voice_guide;           // used by outputs with include_voice_guide
    std::string      voice_guide_dir;
    std::string      voice_guide_lang;
};

struct OfflineRenderedFile {
    std::string path;
    Frame       frames = 0;
    float       peak = 0.0f;                // linear peak BEFORE normalize/limiter
};

struct OfflineRenderReport {
    std::vector<OfflineRenderedFile> files;
    // Clips inside the range whose audio file could not be opened. Playback
    // plays them as silence; the export does the same and says so.
    int missing_clips = 0;
    std::vector<std::string> missing_files;
};

// `fraction` in [0,1]. Return false to cancel; the render then stops, deletes
// the files it had started and returns an error whose text is "cancelled".
using OfflineRenderProgress = std::function<bool(double fraction)>;

Result<OfflineRenderReport> render_offline(const OfflineRenderRequest& request,
                                           const OfflineRenderProgress& progress = {});

// JSON boundary used by the C ABI (lt_audio_engine_render_offline).
Result<OfflineRenderRequest> offline_render_request_from_json(const std::string& json);
std::string offline_render_result_to_json(const Result<OfflineRenderReport>& result);

} // namespace lt
