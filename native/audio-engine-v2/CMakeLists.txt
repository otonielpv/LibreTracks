cmake_minimum_required(VERSION 3.25)
project(libretracks_audio_engine_v2 VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Export compile commands for IDEs and tooling.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(cmake/options.cmake)
include(cmake/dependencies.cmake)

# ---------------------------------------------------------------------------
# Engine library
# ---------------------------------------------------------------------------
if(LT_ENGINE_BUILD_TESTS)
    add_library(lt_audio_engine_v2 STATIC)
else()
    add_library(lt_audio_engine_v2 SHARED)
endif()

target_compile_features(lt_audio_engine_v2 PUBLIC cxx_std_20)
set_target_properties(lt_audio_engine_v2 PROPERTIES
  CXX_STANDARD 20
  CXX_STANDARD_REQUIRED ON
  CXX_EXTENSIONS OFF
)

target_include_directories(lt_audio_engine_v2
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Gather sources per module
add_subdirectory(src/core)
add_subdirectory(src/transport)
add_subdirectory(src/scheduler)
add_subdirectory(src/session)
add_subdirectory(src/render)
add_subdirectory(src/sources)
add_subdirectory(src/pitch)
add_subdirectory(src/devices)
add_subdirectory(src/diagnostics)
add_subdirectory(src/ffi)

target_compile_definitions(lt_audio_engine_v2 PUBLIC
    LT_ENGINE_V2_BUILD=1
    _SILENCE_CXX20_OLD_SHARED_PTR_ATOMIC_SUPPORT_DEPRECATION_WARNING
)

if(LT_ENGINE_USE_JUCE)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_JUCE=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_JUCE=0)
endif()

if(LT_ENGINE_USE_FFMPEG)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_FFMPEG=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_FFMPEG=0)
endif()

if(LT_ENGINE_USE_LIBSNDFILE)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_LIBSNDFILE=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_LIBSNDFILE=0)
endif()

if(LT_ENGINE_USE_R8BRAIN)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_R8BRAIN=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_R8BRAIN=0)
endif()

if(LT_ENGINE_USE_LIBSAMPLERATE)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_LIBSAMPLERATE=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_LIBSAMPLERATE=0)
endif()

# On Windows, export symbols from the shared library.
if(WIN32)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_ENGINE_EXPORT)
    if(NOT LT_ENGINE_USE_JUCE AND NOT LT_ENGINE_BUILD_TESTS)
        set_target_properties(lt_audio_engine_v2 PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS ON)
    endif()
endif()

target_link_libraries(lt_audio_engine_v2
    PRIVATE
        lt_deps_juce
        lt_deps_decoder
        lt_deps_resampler
        lt_deps_json
)

# ---------------------------------------------------------------------------
# Bungee pitch backend (optional, opt-in).
#
# Bungee (https://github.com/bungee-audio-stretch/bungee, MPL-2.0) is a phase-
# vocoder library with much lower per-voice CPU than RubberBand. We consume the
# upstream-published prebuilt archives because Bungee's source uses GCC-only
# attributes that MSVC cannot compile.
#
# Enable with:
#   cmake -DLT_ENGINE_USE_BUNGEE=ON -DLT_BUNGEE_DIR=<unpacked-release-folder>
#
# When OFF (default), LT_ENGINE_HAVE_BUNGEE is 0 and BungeePitchVoice compiles
# to a no-op stub; the production build is unchanged.
# ---------------------------------------------------------------------------
option(LT_ENGINE_USE_BUNGEE "Link the Bungee pitch backend into the engine" OFF)
if(LT_ENGINE_USE_BUNGEE)
    if(NOT DEFINED LT_BUNGEE_DIR OR NOT EXISTS "${LT_BUNGEE_DIR}/include/bungee/Bungee.h")
        message(FATAL_ERROR
            "LT_ENGINE_USE_BUNGEE=ON requires -DLT_BUNGEE_DIR=<path> pointing at "
            "an unpacked Bungee release (must contain include/bungee/Bungee.h and "
            "a platform binary folder, e.g. windows-x86_64/bungee.lib).")
    endif()
    if(WIN32)
        set(_lt_bungee_libdir "${LT_BUNGEE_DIR}/windows-x86_64")
        set(_lt_bungee_lib    "${_lt_bungee_libdir}/bungee.lib")
        set(_lt_bungee_dll    "${_lt_bungee_libdir}/bungee.dll")
    elseif(APPLE)
        set(_lt_bungee_libdir "${LT_BUNGEE_DIR}/apple-mac")
        set(_lt_bungee_lib    "${_lt_bungee_libdir}/bungee.framework")
        set(_lt_bungee_dll    "${_lt_bungee_lib}")
    elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
        set(_lt_bungee_libdir "${LT_BUNGEE_DIR}/linux-aarch64")
        set(_lt_bungee_lib    "${_lt_bungee_libdir}/libbungee.so")
        set(_lt_bungee_dll    "${_lt_bungee_lib}")
    else()
        set(_lt_bungee_libdir "${LT_BUNGEE_DIR}/linux-x86_64")
        set(_lt_bungee_lib    "${_lt_bungee_libdir}/libbungee.so")
        set(_lt_bungee_dll    "${_lt_bungee_lib}")
    endif()
    if(NOT EXISTS "${_lt_bungee_lib}")
        message(FATAL_ERROR "Expected ${_lt_bungee_lib} not found.")
    endif()
    target_include_directories(lt_audio_engine_v2 PRIVATE "${LT_BUNGEE_DIR}/include")
    target_link_libraries(lt_audio_engine_v2 PRIVATE "${_lt_bungee_lib}")
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_HAVE_BUNGEE=1)
    if(APPLE)
        set_target_properties(lt_audio_engine_v2 PROPERTIES
            BUILD_RPATH "@loader_path"
            INSTALL_RPATH "@loader_path"
        )
    elseif(UNIX)
        set_target_properties(lt_audio_engine_v2 PROPERTIES
            BUILD_RPATH "$ORIGIN"
            INSTALL_RPATH "$ORIGIN"
        )
    endif()
    if(APPLE AND EXISTS "${_lt_bungee_dll}")
        add_custom_command(TARGET lt_audio_engine_v2 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${_lt_bungee_dll}"
                "$<TARGET_FILE_DIR:lt_audio_engine_v2>/bungee.framework"
            COMMENT "Copying Bungee framework next to lt_audio_engine_v2")
    elseif(EXISTS "${_lt_bungee_dll}")
        add_custom_command(TARGET lt_audio_engine_v2 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${_lt_bungee_dll}"
                "$<TARGET_FILE_DIR:lt_audio_engine_v2>"
            COMMENT "Copying Bungee runtime next to lt_audio_engine_v2")
    endif()
    message(STATUS "Pitch backend (optional): Bungee enabled from ${LT_BUNGEE_DIR}")
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_HAVE_BUNGEE=0)
endif()

if(LT_ENGINE_ENABLE_ASAN)
    if(MSVC)
        target_compile_options(lt_audio_engine_v2 PRIVATE /fsanitize=address)
        target_link_options(lt_audio_engine_v2 PRIVATE /fsanitize=address)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(lt_audio_engine_v2 PRIVATE -fsanitize=address -fno-omit-frame-pointer)
        target_link_options(lt_audio_engine_v2 PRIVATE -fsanitize=address)
    endif()
endif()

# ---------------------------------------------------------------------------
# Benchmarks (developer-only, opt-in)
#
# Build with -DLT_ENGINE_BUILD_BENCHES=ON to produce bench_pitch_audio_thread.
# Extra flag -DLT_ENGINE_BENCH_BUNGEE=ON adds a Bungee backend to the bench
# (fetches Bungee v2.4.10 via FetchContent at configure time).
# ---------------------------------------------------------------------------
option(LT_ENGINE_BUILD_BENCHES "Build developer benchmarks" OFF)
option(LT_ENGINE_BENCH_BUNGEE  "Add Bungee backend to the pitch DSP benchmark" OFF)

if(LT_ENGINE_BUILD_BENCHES)
    # Phase 10 prearm bench: measures end-to-end seek latency for prearmed
    # vs reactive paths. Links lt_audio_engine_v2 directly.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/bench/bench_prearm_vs_reactive.cpp")
        add_executable(bench_prearm_vs_reactive bench/bench_prearm_vs_reactive.cpp)
        target_compile_features(bench_prearm_vs_reactive PRIVATE cxx_std_20)
        target_link_libraries(bench_prearm_vs_reactive PRIVATE lt_audio_engine_v2)
        target_include_directories(bench_prearm_vs_reactive PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/include)
        if(LT_ENGINE_USE_BUNGEE AND WIN32 AND DEFINED LT_BUNGEE_DIR)
            set(_lt_prearm_bungee_dll "${LT_BUNGEE_DIR}/windows-x86_64/bungee.dll")
            if(EXISTS "${_lt_prearm_bungee_dll}")
                add_custom_command(TARGET bench_prearm_vs_reactive POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "${_lt_prearm_bungee_dll}"
                        "$<TARGET_FILE_DIR:bench_prearm_vs_reactive>"
                    COMMENT "Copying Bungee DLL for prearm bench")
            endif()
        endif()
    endif()
endif()

# ---------------------------------------------------------------------------
# Optional: standalone test executable used during development
# ---------------------------------------------------------------------------
if(LT_ENGINE_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# ---------------------------------------------------------------------------
# Install rules used by the Tauri build script
# ---------------------------------------------------------------------------
install(TARGETS lt_audio_engine_v2
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)
install(DIRECTORY include/ DESTINATION include)
