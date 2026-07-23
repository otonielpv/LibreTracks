# End-to-end tests (real app)

These specs drive the **real, compiled LibreTracks desktop app** — native audio
engine included — through Tauri's official WebDriver bridge. They are not a
browser-mocked frontend: `tauri-driver` launches the actual `.exe`, WebView2
hosts the window, and WebdriverIO pilots the live DOM.

```
WebdriverIO  ->  @wdio/tauri-service  ->  tauri-driver  ->  msedgedriver  ->  WebView2 (the app)
```

## Platform

**Windows only.** `tauri-driver` supports Windows and Linux; macOS's WKWebView
does not expose WebDriver, so these specs cannot run on macOS. The config throws
a clear error on non-Windows platforms via the service's own guards.

## Prerequisites

1. **Rust toolchain** (`cargo`) — already required to build the app. The service
   runs `cargo install tauri-driver` automatically the first time
   (`autoInstallTauriDriver: true`).
2. **WebView2 runtime** — ships with Windows 11 / modern Edge. The service
   detects its version and auto-downloads a matching `msedgedriver`
   (`autoDownloadEdgeDriver: true`), so you do **not** vendor a driver.
3. **A built app binary** at
   `target-desktop-native/release/libretracks-desktop.exe`. Build it with:

   ```bash
   npm run build:desktop:native
   ```

   Override the path with `LT_E2E_APP_BINARY=/abs/path/to/app.exe` if needed.

## Running

From the repo root:

```bash
npm run test:e2e
```

Run a single spec:

```bash
npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/app-launch.e2e.ts
```

The first run installs `tauri-driver` and downloads `msedgedriver`, so it is
slower. Launching the app also initialises the audio engine, which takes a few
seconds — timeouts are set generously (`startTimeout` 90 s, per-test 120 s).

## Layout

- `wdio.conf.ts` — runner config. Uses `@wdio/tauri-service` with
  `driverProvider: 'external'` (cargo-installed `tauri-driver`), which keeps the
  Rust app source untouched. (The default `'embedded'` provider would require
  compiling `tauri-plugin-wdio-webdriver` into the app.)
- `tsconfig.json` — standalone CommonJS/Node config for ts-node; deliberately
  separate from the app's ESM/JSX Vite tsconfig.
- `pageobjects/` — Page Objects. Locators prefer role / `aria-label` over CSS
  classes. The app's transport buttons are labelled in Spanish ("Reproducir",
  "Detener", "Metronomo", ...).
- `specs/` — `*.e2e.ts` test files:
  - `app-launch.e2e.ts` — smoke: the WebView boots and React renders.
  - `landing.e2e.ts` — the create/open-session landing renders, offers its four
    entry-point actions, shows the templates/recents columns, transport is
    disabled with no session, and the Settings panel opens.
  - `side-nav.e2e.ts` — the three side-nav panels (Biblioteca, Remote,
    Configuracion) exist and are enabled without a session, and each toggles its
    panel/modal open.
  - `settings.e2e.ts` — the Settings modal's six desktop tabs render, tab
    switching drives `aria-selected` and the visible panel, and the "Atajos"
    (shortcuts) tab lists actions, filters live from its search box, and exposes
    reset-all.

  Specs run against **one long-lived app instance** with no reload between them
  (alphabetical order: `app-launch` → `landing` → `side-nav`). A panel one spec
  opens is still open when the next starts, so specs that open panels call
  `AppPage.resetShell()` in `before`/`after` to stay self-contained.

## Gotchas

- **Clearing a `type="search"` input** — neither `setValue("")` nor
  `clearValue()` reliably empties one in this WebView (the value survives and
  React's `onChange` never fires). Use select-all + Backspace via
  `browser.keys(["Control", "a"])` then `browser.keys(["Backspace"])`, which
  emits the input events React listens for. See the shortcuts filter test in
  `settings.e2e.ts`.

- **`__name is not defined` inside `browser.execute()`** — do not put *named*
  nested functions inside an `execute()` callback. ts-node/esbuild rewrites them
  with a `__name()` helper that is undefined in the WebView. Keep `execute()`
  bodies to plain expressions and anonymous arrows.
- **`captureFrontendLogs` is off** — the service's console-forwarding shim hits
  the `__name` issue above and floods the report. The app's own logs already go
  to `lt_*.log`.
- **Benign warnings** — "Tauri plugin not available" comes from the service's
  optional window-introspection features (`@wdio/tauri-plugin`), which we don't
  ship. `logLevel: 'error'` on the service keeps them quiet; they don't affect
  results.
- **One instance at a time** (`maxInstances: 1`) — the engine grabs audio
  devices, so parallel native windows would contend for them.
- **The `beforeCommand` window-probe patch** — before `$`, `findElement`,
  `elementClick`, `getTitle`, etc. the service runs an "ensure active window
  focus" check that `invoke`s `plugin:wdio|get_window_states`. We don't ship the
  plugin that answers it, so that invoke sits ~13 s until it times out **on
  every such command** — a spec touching a dozen elements took ~2.5 min. The
  `beforeCommand` hook in `wdio.conf.ts` short-circuits just that one probe to an
  empty result (the service reads it as "no window info, skip focus"), which
  brings the suite from ~2.5 min back to a few seconds. Remove the patch only if
  you add `tauri-plugin-wdio-webdriver` to the app (then the probe answers
  instantly on its own).
