target_sources(lt_audio_engine_v2 PRIVATE
    decoded_source.cpp
    source_manager.cpp
    audio_decoder.cpp
    resampler.cpp
    worker_pool.cpp
    preparation_queue.cpp
    block_cache.cpp
    io_throttle.cpp
    original_source_cache.cpp
    streaming_source.cpp
    prebuffer_worker.cpp
)

if(LT_ENGINE_USE_FFMPEG)
    target_sources(lt_audio_engine_v2 PRIVATE
        libav_decoder.cpp
    )
endif()
