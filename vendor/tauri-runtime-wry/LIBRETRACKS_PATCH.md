# tauri-runtime-wry 2.10.1, patched for iOS and macOS

Unmodified copy of `tauri-runtime-wry` 2.10.1 from crates.io except for
`src/lib.rs` (look for `LIBRETRACKS PATCH`), wired in through
`[patch.crates-io]` in the root `Cargo.toml`.

**Why:** the UI runs in WebKit's web content process. When the system kills it
for memory, or it crashes, the WKWebView stays on screen but blank until
something reloads it. wry exposes `with_on_web_content_process_terminate_handler`
for exactly this, but Tauri never sets it, so nothing reloaded and a performer
was left looking at an empty window while the audio kept playing. Found while
fixing an Android report (2026-11-17) where a big setlist outgrew the renderer.

**Change:** `create_webview` sets that handler on macOS and iOS. It asks the
public `WEB_CONTENT_TERMINATED_HOOK` whether to reload (the app logs the event
and limits reloads, see `apps/desktop/src-tauri/src/platform/web_content_guard.rs`)
and, if so, sends the same `WebviewMessage::Reload` that `Webview::reload()` uses.
With no hook installed it always reloads.

Only macOS/iOS code changes; other platforms compile the same crate. Drop this
copy once Tauri sets the handler itself. When bumping Tauri, re-copy the new
version from the registry and re-apply the two `LIBRETRACKS PATCH` blocks.
