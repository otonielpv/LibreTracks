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
)

target_link_libraries(lt_engine_tests
    PRIVATE
        lt_audio_engine_v2
        doctest::doctest
)

target_include_directories(lt_engine_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)

add_custom_command(TARGET lt_engine_tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:lt_audio_engine_v2>
        $<TARGET_FILE_DIR:lt_engine_tests>
)

include(doctest)
doctest_discover_tests(lt_engine_tests)
