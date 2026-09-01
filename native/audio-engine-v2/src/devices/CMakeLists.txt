target_sources(lt_audio_engine_v2 PRIVATE
    audio_device_manager.cpp
    audio_device_manager_oboe.cpp
)

if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    # audio_device_manager_ios.mm is the RemoteIO device backend; it compiles
    # itself out when LT_ENGINE_USE_JUCE is on, so both can coexist while the
    # port is validated on real hardware.
    target_sources(lt_audio_engine_v2 PRIVATE
        ios_audio_session.mm
        audio_device_manager_ios.mm
    )
    target_link_libraries(lt_audio_engine_v2 PRIVATE
        "-framework AVFoundation"
        "-framework AudioToolbox"
    )
    set_source_files_properties(
        ios_audio_session.mm
        audio_device_manager_ios.mm
        PROPERTIES COMPILE_FLAGS "-fobjc-arc"
    )
endif()
