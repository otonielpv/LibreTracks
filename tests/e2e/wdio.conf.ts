import path from "node:path";
import { browser } from "@wdio/globals";

// --- What this drives ------------------------------------------------------
//
// The E2E suite drives the REAL, compiled LibreTracks desktop app (native audio
// engine included) through the official @wdio/tauri-service, which manages the
// whole WebDriver bridge for us:
//
//   WebdriverIO  ->  @wdio/tauri-service  ->  tauri-driver  ->  msedgedriver
//                                                                   -> WebView2
//
// We use driverProvider 'external' (cargo-installed tauri-driver + msedgedriver)
// rather than the default 'embedded' provider, because 'embedded' requires the
// tauri-plugin-wdio-webdriver crate compiled into the app. 'external' keeps the
// app source untouched. The service still handles the fiddly bits that broke a
// hand-rolled setup: matching msedgedriver to the installed WebView2 runtime
// (autoDownloadEdgeDriver) and attaching to the app's real webview context
// instead of the initial about:blank.
//
// Windows/Linux only — tauri-driver has no macOS support.

// __dirname === tests/e2e; the repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");

// Release binary produced by `npm run build:desktop:native`
// (scripts/desktop-native.mjs targets target-desktop-native/).
const appBinaryPath =
  process.env.LT_E2E_APP_BINARY ??
  path.join(repoRoot, "target-desktop-native", "release", "libretracks-desktop.exe");

// WDIO 9 auto-registers ts-node when it loads a .ts config; point it at the
// standalone e2e tsconfig so both the config and the specs transpile with the
// CommonJS/Node settings rather than the app's ESM/JSX ones.
process.env.TS_NODE_PROJECT = path.join(__dirname, "tsconfig.json");
process.env.TS_NODE_TRANSPILE_ONLY = "true";

export const config: WebdriverIO.Config = {
  runner: "local",

  specs: [path.join(__dirname, "specs", "**", "*.e2e.ts")],

  maxInstances: 1, // one native window at a time — the engine grabs audio devices.
  maxInstancesPerCapability: 1,

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "external", // use cargo-installed tauri-driver; no app plugin needed.
        autoInstallTauriDriver: true, // cargo install tauri-driver if it's missing.
        autoDownloadEdgeDriver: true, // fetch msedgedriver matching the WebView2 runtime.
        // Quieten the service's periodic window-state probe: it needs the
        // optional @wdio/tauri-plugin compiled into the app, which we don't
        // ship, so it logs a benign WARN every few seconds without it.
        logLevel: "error",
        startTimeout: 90_000, // native launch + audio-engine init is slow on first run.
        // captureFrontendLogs stays OFF: the log-forwarding shim injects a
        // console wrapper that fails in this WebView ("__name is not defined")
        // and floods the report; the app's own logs already go to lt_*.log.
        captureFrontendLogs: false,
      },
    ],
  ],

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000, // native launch + engine init can be slow on first run.
  },

  // Performance patch, installed lazily from beforeCommand because
  // browser.tauri does not exist yet in the `before` hook — the service
  // attaches it afterwards. Without this, a spec touching a dozen elements
  // takes ~2.5 min instead of ~1 s (see the block below for why).
  beforeCommand() {
    const tauri = (
      browser as unknown as {
        tauri?: {
          execute?: (...a: unknown[]) => Promise<unknown>;
          __ltPatched?: boolean;
        };
      }
    ).tauri;
    if (
      !tauri ||
      typeof tauri.execute !== "function" ||
      tauri.__ltPatched === true
    ) {
      return;
    }
    // The service's ensureActiveWindowFocus (run in its own beforeCommand for
    // $, findElement, elementClick, getTitle...) calls
    //   browser.tauri.execute(({core}) => core.invoke('plugin:wdio|get_window_states'))
    // We don't ship the @wdio/tauri-plugin that answers it, so that invoke sits
    // for ~13 s until it times out — on every such command, turning a small
    // spec into minutes. Short-circuit just that probe to an empty result
    // (which the service reads as "no window info, skip focus"); every other
    // tauri.execute call is forwarded untouched.
    const originalExecute = tauri.execute.bind(tauri);
    tauri.execute = (fn: unknown, ...rest: unknown[]) => {
      const source = typeof fn === "function" ? fn.toString() : String(fn);
      if (source.includes("get_window_states")) {
        return Promise.resolve([]);
      }
      return originalExecute(fn, ...(rest as []));
    };
    tauri.__ltPatched = true;
  },
};
