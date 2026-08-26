target_sources(lt_audio_engine_v2 PRIVATE
    audio_device_manager.cpp
    audio_device_manager_oboe.cpp
)

if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    target_sources(lt_audio_engine_v2 PRIVATE ios_audio_session.mm)
    target_link_libraries(lt_audio_engine_v2 PRIVATE
        "-framework AVFoundation"
        "-framework AudioToolbox"
    )
    set_source_files_properties(ios_audio_session.mm PROPERTIES
        COMPILE_FLAGS "-fobjc-arc"
    )
endif()
