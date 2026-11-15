# tao 0.34.8, patched for iOS

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

Only iOS code changes; other platforms compile the same tao. Drop this copy
once upstream processes events in the tracking mode.
