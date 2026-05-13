include(FetchContent)
enable_testing()

FetchContent_Declare(doctest
    GIT_REPOSITORY https://github.com/doctest/doctest.git
    GIT_TAG        v2.4.11
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(doctest)
list(APPEND CMAKE_MODULE_PATH "${doctest_SOURCE_DIR}/scripts/cmake")

add_executable(lt_engine_tests
    main.cpp
    test_session_validation.cpp
    test_transport_clock.cpp
    test_jump_scheduler.cpp
    test_command_json.cpp
    test_audio_dump.cpp
    test_audio_decoder.cpp
    test_audio_fixtures.cpp
    test_fade_processor.cpp
    test_metronome_renderer.cpp
    pitch_resolution_tests.cpp
    pitch_cache_tests.cpp
    pitch_alignment_tests.cpp
    pitch_frequency_tests.cpp
    pitch_seek_tests.cpp
    pitch_preparation_tests.cpp
    prepared_pitch_cache_tests.cpp
    prepared_pitch_alignment_tests.cpp
    pitch_proxy_async_tests.cpp
    pitch_proxy_continuity_tests.cpp
    transport_audio_sync_tests.cpp
)

target_link_libraries(lt_engine_tests
    PRIVATE
        lt_audio_engine_v2
        doctest::doctest
)

target_include_directories(lt_engine_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)

if(LT_ENGINE_USE_RUBBERBAND AND NOT LT_ENGINE_ALLOW_PITCH_STUB)
    target_compile_definitions(lt_engine_tests PRIVATE LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND=1)
else()
    target_compile_definitions(lt_engine_tests PRIVATE LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND=0)
endif()

add_custom_command(TARGET lt_engine_tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:lt_audio_engine_v2>
        $<TARGET_FILE_DIR:lt_engine_tests>
)

include(doctest)
doctest_discover_tests(lt_engine_tests)
