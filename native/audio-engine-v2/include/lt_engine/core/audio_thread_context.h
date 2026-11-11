#pragma once

// Marks the threads that are rendering an audio block right now: the device
// callback inside Mixer::render and the render-pool workers running phase A.
//
// Unlike lt::rt::ScopedRealtimeSection (rt_guard.h), which only exists in
// instrumented test builds, this is compiled into release: code that has a
// realtime-safe path and a general one (SourceManager::request_blocks) asks it
// which to take. Callers outside a render — the control thread, tests driving a
// source directly — keep the general path and its synchronous behaviour.

namespace lt::audio_context {

namespace detail {
inline thread_local int render_depth = 0;
} // namespace detail

inline bool in_render() noexcept { return detail::render_depth > 0; }

class ScopedRender {
public:
    ScopedRender() noexcept { ++detail::render_depth; }
    ~ScopedRender() noexcept { --detail::render_depth; }
    ScopedRender(const ScopedRender&) = delete;
    ScopedRender& operator=(const ScopedRender&) = delete;
};

} // namespace lt::audio_context
