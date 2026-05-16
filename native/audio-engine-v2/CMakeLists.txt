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

if(LT_ENGINE_USE_RUBBERBAND)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_RUBBERBAND=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_USE_RUBBERBAND=0)
endif()

if(LT_ENGINE_ALLOW_PITCH_STUB)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_ALLOW_PITCH_STUB=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_ALLOW_PITCH_STUB=0)
endif()

if(LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH)
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH=1)
else()
    target_compile_definitions(lt_audio_engine_v2 PUBLIC LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH=0)
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
        lt_deps_rubberband
        lt_deps_decoder
        lt_deps_resampler
        lt_deps_json
)

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

if(LT_ENGINE_BUILD_BENCHES AND LT_ENGINE_USE_RUBBERBAND)
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/bench/bench_pitch_audio_thread.cpp")
        add_executable(bench_pitch_audio_thread bench/bench_pitch_audio_thread.cpp)
        target_compile_features(bench_pitch_audio_thread PRIVATE cxx_std_20)
        target_link_libraries(bench_pitch_audio_thread PRIVATE lt_deps_rubberband)
        target_include_directories(bench_pitch_audio_thread PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

        if(LT_ENGINE_BENCH_BUNGEE)
            # Consume the prebuilt Bungee Windows binary release. Bungee's source
            # uses GCC-specific attributes that don't compile under MSVC, so we use
            # the upstream-published prebuilt DLL + import lib instead.
            # Set LT_BUNGEE_DIR to the unpacked release folder (e.g. bungee-v2.4.24).
            if(NOT DEFINED LT_BUNGEE_DIR OR NOT EXISTS "${LT_BUNGEE_DIR}/include/bungee/Bungee.h")
                message(FATAL_ERROR
                    "LT_ENGINE_BENCH_BUNGEE=ON requires -DLT_BUNGEE_DIR=<path> "
                    "pointing at an unpacked Bungee release (must contain "
                    "include/bungee/Bungee.h and a platform binary folder).")
            endif()
            if(WIN32)
                set(_lt_bungee_libdir "${LT_BUNGEE_DIR}/windows-x86_64")
                set(_lt_bungee_lib    "${_lt_bungee_libdir}/bungee.lib")
                set(_lt_bungee_dll    "${_lt_bungee_libdir}/bungee.dll")
            else()
                message(FATAL_ERROR "Bench Bungee wiring currently only set up for Windows x86_64.")
            endif()
            if(NOT EXISTS "${_lt_bungee_lib}")
                message(FATAL_ERROR "Expected ${_lt_bungee_lib} not found.")
            endif()
            target_include_directories(bench_pitch_audio_thread PRIVATE "${LT_BUNGEE_DIR}/include")
            target_link_libraries(bench_pitch_audio_thread PRIVATE "${_lt_bungee_lib}")
            target_compile_definitions(bench_pitch_audio_thread PRIVATE HAVE_BUNGEE=1)
            if(WIN32 AND EXISTS "${_lt_bungee_dll}")
                add_custom_command(TARGET bench_pitch_audio_thread POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "${_lt_bungee_dll}"
                        "$<TARGET_FILE_DIR:bench_pitch_audio_thread>"
                    COMMENT "Copying Bungee DLL for bench")
            endif()
            message(STATUS "Bench: Bungee backend enabled (prebuilt at ${LT_BUNGEE_DIR})")
        endif()

        if(WIN32 AND DEFINED LT_RUBBERBAND_RUNTIME_DIR)
            add_custom_command(TARGET bench_pitch_audio_thread POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_directory
                    "${LT_RUBBERBAND_RUNTIME_DIR}"
                    "$<TARGET_FILE_DIR:bench_pitch_audio_thread>"
                COMMENT "Copying RubberBand DLLs for bench")
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
