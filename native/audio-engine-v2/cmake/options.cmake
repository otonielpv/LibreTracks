# ---------------------------------------------------------------------------
# Build options for libretracks-audio-engine-v2
# ---------------------------------------------------------------------------

option(LT_ENGINE_BUILD_TESTS
    "Build the engine test executable"
    OFF)

option(LT_ENGINE_USE_JUCE
    "Use JUCE for audio device management (recommended)"
    ON)

option(LT_ENGINE_USE_RUBBERBAND
    "Use Rubber Band Library for pitch shifting"
    ON)

# Decoder backend — exactly one must be ON.
option(LT_ENGINE_USE_FFMPEG
    "Use FFmpeg/libavformat/libavcodec for multi-format decoding (preferred)"
    OFF)

option(LT_ENGINE_USE_LIBSNDFILE
    "Use libsndfile + header-only decoders for WAV/FLAC/MP3/OGG decoding (alternative)"
    ON)

# Resampler backend — exactly one must be ON.
option(LT_ENGINE_USE_R8BRAIN
    "Use r8brain-free-src for high-quality resampling (preferred)"
    ON)

option(LT_ENGINE_USE_LIBSAMPLERATE
    "Use libsamplerate (SRC) for resampling (alternative)"
    OFF)

# ---------------------------------------------------------------------------
# Validate mutual-exclusion constraints
# ---------------------------------------------------------------------------
if(LT_ENGINE_USE_FFMPEG AND LT_ENGINE_USE_LIBSNDFILE)
    message(FATAL_ERROR
        "LT_ENGINE_USE_FFMPEG and LT_ENGINE_USE_LIBSNDFILE are mutually exclusive. "
        "Choose one decoder backend.")
endif()

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

# Propagate defines so C++ code can key on them.
if(LT_ENGINE_USE_JUCE)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_JUCE)
endif()

if(LT_ENGINE_USE_RUBBERBAND)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_RUBBERBAND)
endif()

if(LT_ENGINE_USE_FFMPEG)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_FFMPEG)
elseif(LT_ENGINE_USE_LIBSNDFILE)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_LIBSNDFILE)
endif()

if(LT_ENGINE_USE_R8BRAIN)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_R8BRAIN)
elseif(LT_ENGINE_USE_LIBSAMPLERATE)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_USE_LIBSAMPLERATE)
endif()
