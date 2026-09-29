#pragma once

// ---------------------------------------------------------------------------
// driver_call_guard — run a call into third-party audio driver code so that
// nothing it does can take the process down.
//
// ASIO drivers are DLLs that load into our process. When one throws while we
// probe it (seen in the field: an Acer Nitro with ASIO4ALL, Focusrite and
// Yamaha Steinberg USB installed), the exception unwound out of list_devices,
// across the FFI and into Tauri's WebView2 IPC callback, where Rust aborts:
// the app closed seconds after every launch. Wrapping the driver call here
// turns that into a failed result the caller can log and skip.
//
// JUCE-free so the tests can exercise it without a real driver.
// ---------------------------------------------------------------------------

#include <functional>

namespace lt {

struct DriverCallResult {
    bool        ok    = true;
    // Static description of what went wrong; nullptr when ok.
    const char* error = nullptr;
};

// Runs `fn` and reports whether it completed. Catches every C++ exception and,
// on Windows, SEH faults such as access violations. Objects a fault skips over
// leak: losing a probe is better than losing the process.
DriverCallResult call_driver_guarded(const std::function<void()>& fn);

} // namespace lt
