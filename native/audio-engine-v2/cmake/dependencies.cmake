# ---------------------------------------------------------------------------
# Dependency integration for libretracks-audio-engine-v2
#
# INTEGRATION STRATEGY SUMMARY
# ─────────────────────────────
# JUCE            — FetchContent (git tag).  JUCE is header/module heavy; FetchContent
#                   avoids packaging differences across platforms.  ASIO SDK must be
#                   supplied separately on Windows (see JUCE_ASIO_SDK_DIR below).
#
# Pitch backend   — Bungee only (consumed via LT_ENGINE_USE_BUNGEE in the top-level
#                   CMakeLists). RubberBand was removed; nothing in this engine
#                   links against it any more.
#
# Decoder
#   libsndfile    — find_package first, FetchContent fallback.  Header-only dr_libs
#                   (dr_mp3, dr_flac) are bundled in vendor/dr_libs/ as single headers.
#   FFmpeg        — find_package only (system or vcpkg/conan supplied).  Building
#                   FFmpeg from source inside CMake is impractical.
#
# Resampler
#   r8brain        — FetchContent (header+source, very small).
#   libsamplerate — find_package first, FetchContent fallback.
#
# Interface targets (lt_deps_*) are used throughout so callers never reference
# the raw upstream target names.
# ---------------------------------------------------------------------------

include(FetchContent)

# Silence FetchContent "Populating ..." noise during configure if not needed.
set(FETCHCONTENT_QUIET ON)

# ── INTERFACE TARGETS ──────────────────────────────────────────────────────
# Define them up-front so subdirectory CMakeLists.txt can always link against
# them unconditionally; real content is added below based on options.
add_library(lt_deps_juce       INTERFACE)
add_library(lt_deps_decoder    INTERFACE)
add_library(lt_deps_resampler  INTERFACE)

# ── JUCE ──────────────────────────────────────────────────────────────────
if(LT_ENGINE_USE_JUCE)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        8.0.4
        GIT_SHALLOW    TRUE
    )
    # Disable JUCE extras that pull in extra dependencies.
    set(JUCE_BUILD_EXTRAS    OFF CACHE BOOL "" FORCE)
    set(JUCE_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)

    # Optional: ASIO support on Windows.
    # Set JUCE_ASIO_SDK_DIR to the path of the Steinberg ASIO SDK if available.
    # cmake -DLT_ASIO_SDK_DIR=C:/ASIO_SDK ...
    if(WIN32 AND DEFINED LT_ASIO_SDK_DIR)
        set(JUCE_ASIO_SDK_DIR "${LT_ASIO_SDK_DIR}" CACHE PATH "" FORCE)
    endif()

    FetchContent_MakeAvailable(JUCE)

    target_link_libraries(lt_deps_juce INTERFACE
        juce::juce_core
        juce::juce_audio_basics
        juce::juce_audio_devices
    )

    # Suppress JUCE's recommendation to define these in consumer code.
    target_compile_definitions(lt_deps_juce INTERFACE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_REPORT_APP_USAGE=0
    )
endif()

# ── DECODER ───────────────────────────────────────────────────────────────
if(LT_ENGINE_USE_LIBSNDFILE)
    find_package(SndFile QUIET)
    if(SndFile_FOUND)
        target_link_libraries(lt_deps_decoder INTERFACE SndFile::sndfile)
    else()
        FetchContent_Declare(libsndfile
            GIT_REPOSITORY https://github.com/libsndfile/libsndfile.git
            GIT_TAG        1.2.2
            GIT_SHALLOW    TRUE
        )
        set(BUILD_PROGRAMS   OFF CACHE BOOL "" FORCE)
        set(BUILD_EXAMPLES   OFF CACHE BOOL "" FORCE)
        set(BUILD_TESTING    OFF CACHE BOOL "" FORCE)
        set(ENABLE_EXTERNAL_LIBS ON CACHE BOOL "" FORCE)
        FetchContent_MakeAvailable(libsndfile)
        target_link_libraries(lt_deps_decoder INTERFACE sndfile)
    endif()

    # dr_libs headers for MP3 and supplemental format support.
    # Prefer the bundled vendor copy if present.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/dr_libs")
        target_include_directories(lt_deps_decoder INTERFACE
            ${CMAKE_CURRENT_SOURCE_DIR}/vendor/dr_libs
        )
    else()
        # dr_libs single-file headers — fetched if the local vendor copy is absent.
        FetchContent_Declare(dr_libs
            GIT_REPOSITORY https://github.com/mackron/dr_libs.git
            GIT_TAG        master
            GIT_SHALLOW    TRUE
        )
        FetchContent_MakeAvailable(dr_libs)
        target_include_directories(lt_deps_decoder INTERFACE ${dr_libs_SOURCE_DIR})
    endif()

elseif(LT_ENGINE_USE_FFMPEG)
    # FFmpeg is expected to be provided by the system, vcpkg, or conan.
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
        libavformat
        libavcodec
        libavutil
        libswresample
    )
    target_link_libraries(lt_deps_decoder INTERFACE PkgConfig::FFMPEG)
endif()

# ── NLOHMANN JSON (header-only, used for JSON serialization in FFI) ───────
FetchContent_Declare(nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
set(JSON_Install    OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json)

# Expose nlohmann to all engine modules via a shared interface target.
add_library(lt_deps_json INTERFACE)
target_link_libraries(lt_deps_json INTERFACE nlohmann_json::nlohmann_json)

# ── RESAMPLER ─────────────────────────────────────────────────────────────
if(LT_ENGINE_USE_R8BRAIN)
    FetchContent_Declare(r8brain
        GIT_REPOSITORY https://github.com/avaneev/r8brain-free-src.git
        GIT_TAG        master
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(r8brain)
    # r8brain is header-only; expose its source dir as include path.
    target_include_directories(lt_deps_resampler INTERFACE
        ${r8brain_SOURCE_DIR}
    )
elseif(LT_ENGINE_USE_LIBSAMPLERATE)
    find_package(SampleRate QUIET)
    if(SampleRate_FOUND)
        target_link_libraries(lt_deps_resampler INTERFACE SampleRate::samplerate)
    else()
        FetchContent_Declare(libsamplerate
            GIT_REPOSITORY https://github.com/libsndfile/libsamplerate.git
            GIT_TAG        0.2.2
            GIT_SHALLOW    TRUE
        )
        set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
        FetchContent_MakeAvailable(libsamplerate)
        target_link_libraries(lt_deps_resampler INTERFACE samplerate)
    endif()
endif()
