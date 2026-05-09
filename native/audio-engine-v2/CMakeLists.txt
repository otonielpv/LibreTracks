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
add_library(lt_audio_engine_v2 SHARED)

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

target_link_libraries(lt_audio_engine_v2
    PRIVATE
        lt_deps_juce
        lt_deps_rubberband
        lt_deps_decoder
        lt_deps_resampler
)

# On Windows, export symbols from the shared library.
if(WIN32)
    target_compile_definitions(lt_audio_engine_v2 PRIVATE LT_ENGINE_EXPORT)
endif()

# ---------------------------------------------------------------------------
# Optional: standalone test executable used during development
# ---------------------------------------------------------------------------
if(LT_ENGINE_BUILD_TESTS)
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
