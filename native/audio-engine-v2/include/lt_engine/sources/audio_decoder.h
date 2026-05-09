#pragma once

// ---------------------------------------------------------------------------
// AudioDecoder — abstraction over libsndfile+dr_libs or FFmpeg.
//
// Used only from worker/command threads.  Never called from the audio callback.
// ---------------------------------------------------------------------------

#include <lt_engine/core/result.h>
#include <lt_engine/core/types.h>
#include <memory>
#include <string>

namespace lt {

struct AudioFileInfo {
    std::string file_path;
    int         channel_count        = 0;
    int         original_sample_rate = 0;
    Frame       duration_frames      = 0;
    std::string format;    // "wav", "flac", "mp3", "ogg", "aac", "unknown"
};

class AudioDecoder {
public:
    virtual ~AudioDecoder() = default;

    virtual Result<void>         open(const std::string& file_path)   = 0;
    virtual AudioFileInfo        info()                         const  = 0;

    // Read up to `frame_count` interleaved float frames into `out`.
    // Returns number of frames actually read.  0 = EOF.
    virtual int                  read_frames(float* out, int frame_count) = 0;

    // Seek to the given frame position.  Called before read_frames().
    virtual Result<void>         seek(Frame frame)                     = 0;

    virtual void                 close()                               = 0;
};

// Factory — returns the right decoder for `file_path` based on extension
// and magic bytes.
std::unique_ptr<AudioDecoder> make_decoder(const std::string& file_path);

// Convenience: decode entire file to interleaved float32 in one call.
// Resamples to `target_sample_rate` using r8brain/libsamplerate.
Result<std::vector<float>> decode_file_to_float32(
    const std::string& file_path,
    int                target_sample_rate,
    int*               out_channel_count,
    Frame*             out_duration_frames);

} // namespace lt
