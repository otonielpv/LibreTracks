import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A tiny headless-Chrome driver for the screenshot harnesses, spoken over the
 * DevTools protocol (CDP) rather than the `--screenshot` command-line flag.
 *
 * Why not `--screenshot`: it photographs whatever the page renders on load and
 * nothing else. The Remote's Mixer lives behind a tab the user has to press, so
 * a one-shot flag can only ever produce the Controls tab. CDP lets us click the
 * tab, seed localStorage, and pick the exact device size before the capture.
 *
 * No dependency is needed for the socket: Node 22+ ships a global `WebSocket`,
 * and this repo runs Node >= 20 for the app but the E2E harness is Windows-only
 * and runs on the developer's Node (24 at the time of writing). If that ever
 * regresses, `connect()` is the only place that touches the socket API.
 */

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Chrome first, Edge as the fallback: every Windows box that can run the app
 * already has Edge (the WebView2 runtime ships with it), so the Remote shots
 * still work on a machine without Chrome installed.
 */
export function findChrome(): string | null {
  const candidates = [
    process.env.LT_CHROME_BINARY,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

type CdpConnection = {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  once(method: string, timeoutMs: number): Promise<void>;
  close(): void;
};

/** What a capture step gets to drive the page with. */
export type CdpPage = {
  /** Run JS in the page and return its value (must be JSON-serialisable). */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Reload and wait for the load event — used after seeding localStorage. */
  reload(): Promise<void>;
  /**
   * Write a PNG of the current viewport to `file`. `clipHeight` (CSS pixels,
   * from the top) trims dead space off the bottom WITHOUT resizing the
   * viewport — which matters for pages whose widgets stretch to the window:
   * a shorter window gives a shorter widget, a clip gives the same widget with
   * the empty part cropped away.
   */
  screenshot(file: string, clipHeight?: number): Promise<void>;
  pause(ms: number): Promise<void>;
};

async function waitForDevToolsPort(userDataDir: string, timeoutMs = 30_000) {
  // Chrome writes the port it actually bound to into this file, which is why we
  // ask for port 0: two harnesses can then run without fighting over 9222.
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = Number.parseInt(readFileSync(portFile, "utf8").split("\n")[0] ?? "", 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(150);
  }
  throw new Error("Chrome never published DevToolsActivePort");
}

async function findPageTargetUrl(port: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      lastError = `no page target among ${targets.length}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(200);
  }
  throw new Error(`Chrome exposed no page target: ${lastError}`);
}

function connect(webSocketUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (value: never) => void; reject: (error: Error) => void }
    >();
    const eventWaiters: Array<{ method: string; resolve: () => void }> = [];

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (!waiter) return;
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result as never);
        return;
      }
      if (!message.method) return;
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        if (eventWaiters[i]!.method === message.method) {
          eventWaiters.splice(i, 1)[0]!.resolve();
        }
      }
    };
    socket.onerror = () => reject(new Error("CDP socket error"));
    socket.onopen = () =>
      resolve({
        send(method, params) {
          const id = nextId++;
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, {
              resolve: resolveCall as (value: never) => void,
              reject: rejectCall,
            });
            socket.send(JSON.stringify({ id, method, params: params ?? {} }));
          });
        },
        once(method, timeoutMs) {
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = { method, resolve: () => resolveEvent() };
            eventWaiters.push(waiter);
            setTimeout(() => {
              const index = eventWaiters.indexOf(waiter);
              if (index === -1) return; // already fired
              eventWaiters.splice(index, 1);
              rejectEvent(new Error(`CDP event ${method} never fired`));
            }, timeoutMs);
          });
        },
        close() {
          socket.close();
        },
      });
  });
}

/**
 * Open `url` in a throwaway headless browser at an exact device size and hand
 * the page to `run`. The profile is a fresh temp dir every time, so the page
 * always starts from the app's default state (no saved Remote layout, no
 * dismissed guards) unless the capture seeds it.
 */
export async function withHeadlessPage(
  options: {
    chromePath: string;
    url: string;
    width: number;
    height: number;
    /** 2 gives a retina-sharp PNG; 1 matches the desktop WebView captures. */
    deviceScaleFactor?: number;
    /** Drives navigator.languages, which is how the Remote picks its locale. */
    acceptLanguage?: string;
  },
  run: (page: CdpPage) => Promise<void>,
): Promise<void> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "lt-shots-"));
  const child = spawn(
    options.chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      `--user-data-dir=${userDataDir}`,
      `--window-size=${options.width},${options.height}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp: CdpConnection | null = null;
  try {
    const port = await waitForDevToolsPort(userDataDir);
    cdp = await connect(await findPageTargetUrl(port));

    const { userAgent } = await cdp.send<{ userAgent: string }>("Browser.getVersion");
    await cdp.send("Emulation.setUserAgentOverride", {
      // The Remote reads navigator.languages to pick English or Spanish, and
      // acceptLanguage is what actually moves that list.
      userAgent: userAgent.replace("HeadlessChrome", "Chrome"),
      acceptLanguage: options.acceptLanguage ?? "en-US,en",
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor ?? 2,
      mobile: false,
    });
    await cdp.send("Page.enable");

    const connection = cdp;
    const navigate = async (target: string) => {
      const loaded = connection.once("Page.loadEventFired", 60_000);
      await connection.send("Page.navigate", { url: target });
      await loaded;
    };
    await navigate(options.url);

    const page: CdpPage = {
      async evaluate<T>(expression: string) {
        const { result } = await connection.send<{
          result: { value?: T };
          exceptionDetails?: { text: string };
        }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        return result.value as T;
      },
      async reload() {
        const loaded = connection.once("Page.loadEventFired", 60_000);
        await connection.send("Page.reload", {});
        await loaded;
      },
      async screenshot(file: string, clipHeight?: number) {
        const { data } = await connection.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: false,
            // `clip.scale` MULTIPLIES the emulated device scale factor rather
            // than replacing it, so it stays at 1: passing the scale factor
            // here produced 4x images.
            ...(clipHeight
              ? {
                  clip: {
                    x: 0,
                    y: 0,
                    width: options.width,
                    height: Math.min(options.height, clipHeight),
                    scale: 1,
                  },
                }
              : {}),
          },
        );
        writeFileSync(file, Buffer.from(data, "base64"));
      },
      pause: sleep,
    };

    await run(page);
  } finally {
    try {
      await cdp?.send("Browser.close");
    } catch {
      // Already gone — the kill below is the backstop.
    }
    cdp?.close();
    child.kill();
    // Chrome takes a moment to let go of its profile; a failed cleanup must not
    // fail the capture, the temp dir is disposable either way.
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
