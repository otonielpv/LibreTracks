# tao 0.34.8, patched for iOS and Android

Unmodified copy of `tao` 0.34.8 from crates.io except for
`src/platform_impl/ios/event_loop.rs` and `src/platform_impl/ios/app_state.rs`
(look for `LIBRETRACKS PATCH`), wired in through `[patch.crates-io]` in the
root `Cargo.toml`.

**Why:** tao registers its run-loop observers only in `kCFRunLoopDefaultMode`.
While a finger drags a scroll view, iOS runs the main loop in
`UITrackingRunLoopMode`, so the observers never fire and every event Rust sends
to the WebView (Tauri `emit`, among them `audio:meters`) waits until the finger
lifts. Reported 2026-11-15: the Compacta and Setlist mixer meters froze while
scrolling them on iPad/iPhone.

**Change:** the three observers go in `kCFRunLoopCommonModes`. Entering the
tracking mode then reports `kCFRunLoopEntry`, which upstream treats as
`unimplemented!()`; it is now a no-op. The state transitions that used to
`bug!` on an unexpected state (wake-up, main events cleared, events cleared)
return instead, in case UIKit nests the tracking loop inside another phase.

## Android: `_exit` instead of `exit` when the event loop ends

`src/platform_impl/android/mod.rs` (`EventLoop::run`). Upstream ends the
process with `std::process::exit`, which runs the C++ static destructors while
system threads (hwui RenderThread, EGL, gralloc mapper, MediaCodec buffer
pool, FenceMonitor) are still running. They then lock a destroyed mutex and
bionic aborts (`HandleUsingDestroyedMutex`), or `eglTerminate` segfaults.
Google Play listed it as several crash clusters on close (Nov 2026). `_exit`
skips those destructors; tao/Tauri exit handlers have already run.

Apart from these two, other platforms compile the same tao. Drop this copy
once upstream processes iOS events in the tracking mode and stops calling
`exit` on Android.
