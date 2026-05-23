# ---------------------------------------------------------------------------
# Build options for libretracks-audio-engine-v2
# ---------------------------------------------------------------------------

option(LT_ENGINE_BUILD_TESTS
    "Build the engine test executable"
    OFF)

option(LT_ENGINE_USE_JUCE
    "Use JUCE for audio device management (recommended)"
    ON)

option(LT_ENGINE_ENABLE_ASAN
    "Enable AddressSanitizer for supported debug/development builds"
    OFF)

# Decoder backends. libsndfile can stay enabled for WAV/FLAC while FFmpeg/libav
# handles MP3/M4A/OGG/Opus/etc.
option(LT_ENGINE_USE_FFMPEG
    "Use FFmpeg/libavformat/libavcodec for multi-format decoding"
    OFF)

option(LT_ENGINE_USE_LIBSNDFILE
    "Use libsndfile + header-only decoders for WAV/FLAC/MP3/OGG decoding"
    ON)

# Warp (time-stretch) backend.
# Signalsmith Stretch (MIT, header-only) is the default — see
# `bench/WARP_BACKEND_COMPARISON.md` for the comparison that made us pick it
# over Bungee for the warp path. Bungee remains the pitch-only backend.
option(LT_ENGINE_USE_SIGNALSMITH
    "Use Signalsmith Stretch as the warp (time-stretch) backend"
    ON)

# Resampler backend - exactly one must be ON.
option(LT_ENGINE_USE_R8BRAIN
    "Use r8brain-free-src for high-quality resampling (preferred)"
    ON)

option(LT_ENGINE_USE_LIBSAMPLERATE
    "Use libsamplerate (SRC) for resampling (alternative)"
    OFF)

# ---------------------------------------------------------------------------
# Validate backend constraints
# ---------------------------------------------------------------------------
if(NOT LT_ENGINE_USE_FFMPEG AND NOT LT_ENGINE_USE_LIBSNDFILE)
    message(FATAL_ERROR
        "No decoder backend selected. Enable LT_ENGINE_USE_FFMPEG or LT_ENGINE_USE_LIBSNDFILE.")
endif()

if(LT_ENGINE_USE_R8BRAIN AND LT_ENGINE_USE_LIBSAMPLERATE)
    message(FATAL_ERROR
        "LT_ENGINE_USE_R8BRAIN and LT_ENGINE_USE_LIBSAMPLERATE are mutually exclusive. "
        "Choose one resampler backend.")
endif()

if(NOT LT_ENGINE_USE_R8BRAIN AND NOT LT_ENGINE_USE_LIBSAMPLERATE)
    message(FATAL_ERROR
        "No resampler backend selected. Enable LT_ENGINE_USE_R8BRAIN or LT_ENGINE_USE_LIBSAMPLERATE.")
endif()

# No target-specific commands should appear here.
# This file only declares options and validates mutual exclusion.
