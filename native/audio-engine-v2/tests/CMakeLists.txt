include(FetchContent)

FetchContent_Declare(doctest
    GIT_REPOSITORY https://github.com/doctest/doctest.git
    GIT_TAG        v2.4.11
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(doctest)

add_executable(lt_engine_tests
    main.cpp
    test_session_validation.cpp
    test_transport_clock.cpp
    test_jump_scheduler.cpp
    test_command_json.cpp
)

target_link_libraries(lt_engine_tests
    PRIVATE
        lt_audio_engine_v2
        doctest::doctest
)

target_include_directories(lt_engine_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)

include(doctest)
doctest_discover_tests(lt_engine_tests)
