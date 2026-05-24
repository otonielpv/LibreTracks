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

# CMake 4 removed support for projects declaring cmake_minimum_required(VERSION <3.5).
# Several of our FetchContent'd upstreams (libsndfile 1.2.2, doctest, libsamplerate)
# still ship with the old floor and refuse to configure out of the box on macOS CI
# runners that now default to CMake 4.x. Pinning the minimum policy floor here
# applies to every FetchContent_MakeAvailable below without us having to fork the
# upstream CMakeLists.txt files. Harmless on CMake 3.x (the variable is ignored
# when the requested floor is already satisfied by the project's own declaration).
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)

# ── INTERFACE TARGETS ──────────────────────────────────────────────────────
# Define them up-front so subdirectory CMakeLists.txt can always link against
# them unconditionally; real content is added below based on options.
add_library(lt_deps_juce       INTERFACE)
add_library(lt_deps_decoder    INTERFACE)
add_library(lt_deps_resampler  INTERFACE)
add_library(lt_deps_warp       INTERFACE)

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
    # The Steinberg SDK can't be redistributed by us under its license, so we
    # only enable JUCE's ASIO module when the user explicitly points us at a
    # local copy.
    if(WIN32 AND DEFINED LT_ASIO_SDK_DIR)
        set(JUCE_ASIO_SDK_DIR "${LT_ASIO_SDK_DIR}" CACHE PATH "" FORCE)
        set(LT_JUCE_ASIO_ENABLED ON)
        message(STATUS "JUCE ASIO module: ENABLED (SDK at ${LT_ASIO_SDK_DIR})")
    else()
        set(LT_JUCE_ASIO_ENABLED OFF)
        if(WIN32)
            message(STATUS "JUCE ASIO module: disabled (set LT_ASIO_SDK_DIR to enable)")
        endif()
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

    # Enable ASIO at the preprocessor level too — JUCE only compiles its ASIO
    # device type when JUCE_ASIO=1. Without this the SDK path is set but the
    # module silently builds without ASIO support.
    #
    # JUCE's juce_audio_devices.cpp does a plain `#include <iasiodrv.h>` so
    # we ALSO need to add the SDK's header dir to the include path. The
    # Steinberg SDK keeps the headers in `<sdk>/common/`, so that's what we
    # point at — NOT the SDK root.
    if(LT_JUCE_ASIO_ENABLED)
        target_compile_definitions(lt_deps_juce INTERFACE JUCE_ASIO=1)
        target_include_directories(lt_deps_juce INTERFACE "${LT_ASIO_SDK_DIR}/common")
    endif()
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
        set(ENABLE_EXTERNAL_LIBS OFF CACHE BOOL "" FORCE)
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

endif()

if(LT_ENGINE_USE_FFMPEG)
    # FFmpeg/libav is expected from the system, vcpkg, or conan. The discovery
    # path is platform-shaped:
    #   - vcpkg ships a FindFFMPEG.cmake module and the matching variables,
    #     so find_package works out of the box on Windows.
    #   - Homebrew (macOS) and apt (Linux) install FFmpeg with a pkg-config
    #     manifest only — there is no upstream FFmpegConfig.cmake — so a plain
    #     find_package fails. Fall back to pkg-config and synthesise the same
    #     variable interface (FFMPEG_INCLUDE_DIRS / LIBRARY_DIRS / LIBRARIES)
    #     so the linkage below works identically.
    find_package(FFMPEG QUIET COMPONENTS libavformat libavcodec libavutil libswresample)
    if(NOT FFMPEG_FOUND)
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
            libavformat
            libavcodec
            libavutil
            libswresample
        )
    endif()
    target_include_directories(lt_deps_decoder INTERFACE ${FFMPEG_INCLUDE_DIRS})
    target_link_directories(lt_deps_decoder INTERFACE ${FFMPEG_LIBRARY_DIRS})
    target_link_libraries(lt_deps_decoder INTERFACE ${FFMPEG_LIBRARIES})
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

# ── WARP (time-stretch) ───────────────────────────────────────────────────
# RubberBand R3 ("Finer") is the warp backend. Comes from vcpkg via the
# manifest in native/audio-engine-v2/vcpkg.json. find_package first
# (system / vcpkg config), then fallback to a manual find_path /
# find_library. Release/Debug split so MSVC links the right variant.
#
# Signalsmith Stretch was the original default (the offline bench ranked
# it close to RubberBand) but engine-level A/B testing showed it producing
# audible periodic clicks on real polyphonic material. See
# `bench/WARP_BACKEND_COMPARISON.md` for the writeup; the previous
# Signalsmith wrapper lived alongside this code in commit b8663e1.
if(LT_ENGINE_USE_RUBBERBAND)
    find_package(rubberband CONFIG QUIET)
    if(rubberband_FOUND)
        target_link_libraries(lt_deps_warp INTERFACE rubberband::rubberband)
        message(STATUS "Warp backend: RubberBand from find_package")
    else()
        find_path(_lt_rb_inc rubberband/RubberBandStretcher.h)
        find_library(_lt_rb_lib_release NAMES rubberband
            PATHS "${_lt_rb_inc}/.." PATH_SUFFIXES lib NO_DEFAULT_PATH)
        find_library(_lt_rb_lib_debug NAMES rubberband
            PATHS "${_lt_rb_inc}/.." PATH_SUFFIXES debug/lib NO_DEFAULT_PATH)
        if(NOT _lt_rb_lib_release)
            find_library(_lt_rb_lib_release NAMES rubberband)
        endif()
        if(_lt_rb_inc AND _lt_rb_lib_release)
            target_include_directories(lt_deps_warp INTERFACE "${_lt_rb_inc}")
            if(_lt_rb_lib_debug)
                target_link_libraries(lt_deps_warp INTERFACE
                    "$<IF:$<CONFIG:Debug>,${_lt_rb_lib_debug},${_lt_rb_lib_release}>")
            else()
                target_link_libraries(lt_deps_warp INTERFACE
                    "${_lt_rb_lib_release}")
            endif()
            message(STATUS "Warp backend: RubberBand release="
                "${_lt_rb_lib_release} debug=${_lt_rb_lib_debug}")
        else()
            message(WARNING "LT_ENGINE_USE_RUBBERBAND=ON but RubberBand not "
                            "found via find_package or find_path. Backend disabled.")
        endif()
    endif()
endif()
