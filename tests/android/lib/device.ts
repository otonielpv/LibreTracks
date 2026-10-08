// Driving the LibreTracks Android app on an emulator or a phone: the WebView's
// DevTools socket for reading the page and running code in it, and adb for
// real touches and system UI. Shared by the guide screenshots
// (guide-shots/shots.ts) and the narrated tutorial (tutorial-video/record.ts).
//
// Needs a DEBUG apk (only those expose the WebView to DevTools) and Node 24+.
import { execSync } from "node:child_process";
import type { Box } from "../../e2e/utils/annotateOverlay.ts";

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
export const ADB = sdk ? `"${sdk}/platform-tools/adb"` : "adb";
export const adb = (args: string) => execSync(`${ADB} ${args}`, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const APP = "com.libretracks.app";

// ---- DevTools connection ---------------------------------------------------

let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, (value: { result?: any; error?: any }) => void>();

export async function connect() {
  let socket: string | undefined;
  for (let i = 0; i < 60 && !socket; i++) {
    socket = adb("shell cat /proc/net/unix").match(/@(webview_devtools_remote_\d+)/)?.[1];
    if (!socket) await sleep(2000);
  }
  if (!socket) throw new Error("no webview devtools socket (is the DEBUG apk running?)");
  adb(`forward tcp:9334 localabstract:${socket}`);
  const pages = (await (await fetch("http://127.0.0.1:9334/json")).json()) as Array<any>;
  const page = pages.find((p) => p.type === "page") ?? pages[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
}

export async function send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  const reply = await new Promise<{ result?: any; error?: any }>((resolve) => pending.set(id, resolve));
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as T;
}

/** Runs a self-contained function in the page and returns its JSON value. */
export async function run<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>> {
  const expression = `(async () => { var __name = (f) => f; return await (${fn.toString()})(...${JSON.stringify(args)}); })()`;
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

// ---- Page helpers ----------------------------------------------------------

export async function rectOf(selector: string, opts: { nth?: number; text?: string } = {}): Promise<Box | null> {
  return run(
    (sel: string, nth: number, text: string | null) => {
      const el = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        return !text || (e.textContent ?? "").toLowerCase().includes(text.toLowerCase());
      })[nth];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    selector,
    opts.nth ?? 0,
    opts.text ?? null,
  );
}

export async function waitFor(selector: string, opts: { text?: string; timeout?: number } = {}) {
  const until = Date.now() + (opts.timeout ?? 20_000);
  while (Date.now() < until) {
    if (await rectOf(selector, opts)) return;
    await sleep(400);
  }
  throw new Error(`waitFor: ${selector}${opts.text ? ` "${opts.text}"` : ""} never appeared`);
}

export async function viewport() {
  return run(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
}

/**
 * Touch through Android's input system (`adb shell input`), not CDP: only
 * real input events draw the "show touches" circles the clips rely on, and
 * it is exactly the path a finger takes. The app is fullscreen, so CSS px
 * map to screen px by devicePixelRatio alone.
 */
let dprCache = 0;
let recording = false;
/** While on, every touch also draws a yellow ripple (recordings). */
export function setTouchRipple(on: boolean) {
  recording = on;
}
export async function touch(x: number, y: number, holdMs = 60) {
  if (!dprCache) dprCache = (await viewport()).dpr;
  if (recording) {
    // Android's own "show touches" dots are too faint to read in a scaled
    // clip: draw the same yellow ripple the desktop clips use.
    await run(
      (cx: number, cy: number, ms: number) => {
        const dot = document.createElement("div");
        dot.style.cssText =
          `position:fixed;left:${cx - 22}px;top:${cy - 22}px;width:44px;height:44px;` +
          "border-radius:50%;border:3px solid #FFC21A;background:rgba(255,194,26,.35);" +
          "z-index:2147483647;pointer-events:none;transition:transform .5s ease-out, opacity .5s ease-out";
        document.body.appendChild(dot);
        requestAnimationFrame(() => {
          setTimeout(() => {
            dot.style.transform = "scale(1.6)";
            dot.style.opacity = "0";
          }, ms);
        });
        setTimeout(() => dot.remove(), ms + 700);
      },
      x,
      y,
      Math.max(200, holdMs),
    );
  }
  const px = Math.round(x * dprCache);
  const py = Math.round(y * dprCache);
  if (holdMs > 300) adb(`shell input swipe ${px} ${py} ${px} ${py} ${holdMs}`);
  else adb(`shell input tap ${px} ${py}`);
}

/** A real finger tap on the centre of the element. */
export async function tap(selector: string, opts: { nth?: number; text?: string; settle?: number } = {}) {
  const r = await rectOf(selector, opts);
  if (!r) throw new Error(`tap: ${selector}${opts.text ? ` "${opts.text}"` : ""} not visible`);
  await touch(r.x + r.w / 2, r.y + r.h / 2);
  await sleep(opts.settle ?? 700);
}

export async function longPress(selector: string, opts: { nth?: number; text?: string; ms?: number } = {}) {
  const r = await rectOf(selector, opts);
  if (!r) throw new Error(`longPress: ${selector} not visible`);
  await touch(r.x + r.w / 2, r.y + r.h / 2, opts.ms ?? 900);
  await sleep(700);
}

export async function back() {
  adb("shell input keyevent 4");
  await sleep(700);
}

// ---- System UI (the file picker and other screens that are not the app) ----

export type UiNode = { text: string; desc: string; id: string; x: number; y: number };

/** What Android has on screen, from uiautomator (screen px). */
export function uiNodes(): UiNode[] {
  adb("shell uiautomator dump /data/local/tmp/ui.xml");
  const xml = adb("shell cat /data/local/tmp/ui.xml");
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[0])?.[1] ?? "";
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds")) ?? ["", "0", "0", "0", "0"];
    return {
      text: attr("text"),
      desc: attr("content-desc"),
      id: attr("resource-id").split("/").pop() ?? "",
      x: (+b[1] + +b[3]) / 2,
      y: (+b[2] + +b[4]) / 2,
    };
  });
}

/** Taps the system UI element whose text or description is `label`. */
export async function uiTap(label: string, opts: { holdMs?: number; timeout?: number } = {}) {
  const until = Date.now() + (opts.timeout ?? 10_000);
  for (;;) {
    const node = uiNodes().find((n) => n.text === label || n.desc === label);
    if (node) {
      const x = Math.round(node.x);
      const y = Math.round(node.y);
      if (opts.holdMs) adb(`shell input swipe ${x} ${y} ${x} ${y} ${opts.holdMs}`);
      else adb(`shell input tap ${x} ${y}`);
      await sleep(1500);
      return;
    }
    if (Date.now() > until) throw new Error(`ui: no "${label}" on screen`);
    await sleep(500);
  }
}

export function disconnect() {
  ws.close();
}
