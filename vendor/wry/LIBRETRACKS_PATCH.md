# wry 0.54.4, patched for Android

Unmodified copy of `wry` 0.54.4 from crates.io except for
`src/android/main_pipe.rs` (look for `LIBRETRACKS PATCH`), wired in through
`[patch.crates-io]` in the root `Cargo.toml`.

**Why:** the queue of messages for the WebView (`CHANNEL`) was `bounded(8)`.
Its only consumer runs on the Android main thread, but the main thread also
sends to it (`onActivityDestroy`, `Jni` closures). When the Rust side had
already filled the queue (every Tauri `emit` is an `Eval` message), the main
thread blocked on a queue only it could drain: an ANR. Google Play reported it
in Nov 2026 with `WryActivity.onActivityDestroy -> MainPipe::send` on the main
thread.

**Change:** the channel is unbounded. The Rust event loop no longer gets
back-pressure from a busy main thread; the backlog it can build is a few
seconds of events at most.

Drop this copy once upstream stops blocking the main thread on that queue.
