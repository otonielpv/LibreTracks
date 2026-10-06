// Screenshot harness for the MOBILE half of the user guide, on an Android
// emulator. Mobile sibling of tests/e2e/specs/guide-shots.e2e.ts: same marks
// (tests/e2e/utils/annotateOverlay.ts), but driven through the WebView's
// DevTools socket, because WebDriver cannot reach a Tauri Android app.
//
// Needs a DEBUG APK installed (only those expose the WebView to DevTools) and
// Node 24+ (runs this .ts directly). The app is always landscape on phones.
//
//   node tests/android/guide-shots/shots.ts [--clear] [step...]
//
// --clear wipes the app's data first (pm clear) so the landing is the
// first-run one: use a dedicated emulator. Steps default to all of them.
import { execSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { drawMarks, OVERLAY_ID, type Box, type Mark } from "../../e2e/utils/annotateOverlay.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const sharp = createRequire(path.join(repoRoot, "package.json"))("sharp");
const outDir =
  process.env.LT_GUIDESHOTS_DIR ?? path.join(repoRoot, "apps", "website", "public", "guide", "mobile");
mkdirSync(outDir, { recursive: true });

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const ADB = sdk ? `"${sdk}/platform-tools/adb"` : "adb";
const adb = (args: string) => execSync(`${ADB} ${args}`, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = "com.libretracks.app";

// ---- DevTools connection ---------------------------------------------------

let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, (value: { result?: any; error?: any }) => void>();

async function connect() {
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

async function send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  const reply = await new Promise<{ result?: any; error?: any }>((resolve) => pending.set(id, resolve));
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as T;
}

/** Runs a self-contained function in the page and returns its JSON value. */
async function run<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>> {
  const expression = `(async () => { var __name = (f) => f; return await (${fn.toString()})(...${JSON.stringify(args)}); })()`;
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

// ---- Page helpers ----------------------------------------------------------

async function rectOf(selector: string, opts: { nth?: number; text?: string } = {}): Promise<Box | null> {
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

async function waitFor(selector: string, opts: { text?: string; timeout?: number } = {}) {
  const until = Date.now() + (opts.timeout ?? 20_000);
  while (Date.now() < until) {
    if (await rectOf(selector, opts)) return;
    await sleep(400);
  }
  throw new Error(`waitFor: ${selector}${opts.text ? ` "${opts.text}"` : ""} never appeared`);
}

async function viewport() {
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
async function touch(x: number, y: number, holdMs = 60) {
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
async function tap(selector: string, opts: { nth?: number; text?: string; settle?: number } = {}) {
  const r = await rectOf(selector, opts);
  if (!r) throw new Error(`tap: ${selector}${opts.text ? ` "${opts.text}"` : ""} not visible`);
  await touch(r.x + r.w / 2, r.y + r.h / 2);
  await sleep(opts.settle ?? 700);
}

async function longPress(selector: string, opts: { nth?: number; text?: string; ms?: number } = {}) {
  const r = await rectOf(selector, opts);
  if (!r) throw new Error(`longPress: ${selector} not visible`);
  await touch(r.x + r.w / 2, r.y + r.h / 2, opts.ms ?? 900);
  await sleep(700);
}

async function back() {
  adb("shell input keyevent 4");
  await sleep(700);
}

// ---- Captures --------------------------------------------------------------

type Crop = Box | { selector: string; margin?: number } | { marks: number };

async function shot(name: string, crop?: Crop, drawn: Box[] = []) {
  await sleep(500);
  const vp = await viewport();
  let box: Box = { x: 0, y: 0, w: vp.w, h: vp.h };
  if (crop && "marks" in crop) box = union(drawn, crop.marks, vp);
  else if (crop && "selector" in crop) {
    const r = await rectOf(crop.selector);
    if (!r) throw new Error(`crop: ${crop.selector} not visible`);
    box = union([r, ...drawn], crop.margin ?? 12, vp);
  } else if (crop) box = crop;
  // adb screencap, not Page.captureScreenshot: the WebView's DevTools capture
  // leaves the hardware-accelerated timeline canvas blank. The app is
  // fullscreen, so CSS px map to screen px by devicePixelRatio alone.
  const screen = execSync(`${ADB} exec-out screencap -p`, { maxBuffer: 64 * 1024 * 1024 });
  const file = path.join(outDir, `${name}.png`);
  // Phones render at ~2.6x; the docs pipeline assumes 2x captures, so
  // normalise for a consistent on-page size.
  await sharp(screen)
    .extract({
      left: Math.round(box.x * vp.dpr),
      top: Math.round(box.y * vp.dpr),
      width: Math.round(box.w * vp.dpr),
      height: Math.round(box.h * vp.dpr),
    })
    .resize({ width: Math.round(box.w * 2) })
    .png()
    .toFile(file);
  console.log(`[mobileshots] wrote ${name}.png`);
}

function union(boxes: Box[], margin: number, vp: { w: number; h: number }): Box {
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin);
  const x1 = Math.min(vp.w, Math.max(...boxes.map((b) => b.x + b.w)) + margin);
  const y1 = Math.min(vp.h, Math.max(...boxes.map((b) => b.y + b.h)) + margin);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function annotatedShot(
  name: string,
  marks: Mark[],
  opts: { style?: "callouts" | "spotlight"; crop?: Crop } = {},
) {
  const result = await run(drawMarks, marks, opts.style ?? "callouts", OVERLAY_ID);
  if (result.notFound.length) {
    await clear();
    throw new Error(`${name}: no visible element for ${result.notFound.join(", ")}`);
  }
  await shot(name, opts.crop, result.drawn);
  await clear();
}

async function clear() {
  await run((id: string) => document.getElementById(id)?.remove(), OVERLAY_ID);
}

const tour = (id: string) => `[data-lt-tour="${id}"]`;

/**
 * Real-time screen recording with Android's own touch indicators, so the
 * clip shows where the finger goes. `action` drives the app; the result is a
 * silent looping MP4 + a poster, like the desktop clips.
 */
async function recordClip(name: string, action: () => Promise<void>, crop?: Box) {
  adb("shell settings put system show_touches 1");
  const remote = `/sdcard/${name}.mp4`;
  const rec = spawn(ADB.replace(/"/g, ""), ["shell", "screenrecord", "--bit-rate", "12000000", remote], {
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  await sleep(1200);
  recording = true;
  try {
    await action();
  } finally {
    recording = false;
  }
  await sleep(1800);
  // Stop it ON the device with SIGINT so it finalises the MP4; killing the
  // local adb process first leaves a file without its index.
  const exited = new Promise((resolve) => rec.on("exit", resolve));
  adb(`shell "kill -2 $(pidof screenrecord)"`);
  await Promise.race([exited, sleep(10_000)]);
  await sleep(500);
  adb("shell settings put system show_touches 0");
  const local = path.join(outDir, `.${name}.raw.mp4`);
  adb(`pull ${remote} "${local}"`);
  adb(`shell rm ${remote}`);
  const vp = await viewport();
  const c = crop ?? { x: 0, y: 0, w: vp.w, h: vp.h };
  const filter =
    `crop=${Math.round(c.w * vp.dpr)}:${Math.round(c.h * vp.dpr)}:${Math.round(c.x * vp.dpr)}:${Math.round(c.y * vp.dpr)},` +
    `scale=${Math.min(1600, Math.round(c.w * 2))}:-2,fps=30`;
  const mp4 = path.join(outDir, `${name}.mp4`);
  execSync(
    `ffmpeg -y -loglevel error -i "${local}" -vf "${filter}" -an -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart "${mp4}"`,
  );
  execSync(`ffmpeg -y -loglevel error -sseof -0.3 -i "${mp4}" -frames:v 1 -quality 82 "${path.join(outDir, `${name}.webp`)}"`);
  execSync(`rm -f "${local}"`);
  console.log(`[mobileshots] wrote ${name}.mp4`);
}

// ---- Steps -----------------------------------------------------------------

const inv = (cmd: string, args: Record<string, unknown> = {}) =>
  run(
    (c: string, a: Record<string, unknown>) => (window as any).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  );

const steps: Record<string, () => Promise<void>> = {
  /** Spanish UI and no telemetry prompt, through the app's own settings. */
  /**
   * Spanish UI with no first-run prompts. The language comes from Android's
   * per-app locale (the app follows the system language while its own
   * setting is unset); writing the setting from here does not stick, the
   * frontend saves its own copy of the settings over it.
   */
  async setup() {
    for (const label of ["No, gracias", "No, thanks"]) {
      if (await rectOf("button", { text: label })) {
        await tap("button", { text: label });
        break;
      }
    }
    await sleep(1500);
    for (const label of ["Saltar tutorial", "Skip tutorial"]) {
      if (await rectOf("button", { text: label })) {
        if (label === "Saltar tutorial") await shot("tutorial-welcome");
        await tap("button", { text: label });
      }
    }
  },

  async raw() {
    await shot("raw-now");
  },

  async landing() {
    await annotatedShot("landing", [
      { selector: tour("side-nav-sessions"), n: 1, badge: "corner" },
      { selector: '.lt-side-nav button[aria-label="Guardar"]', n: 2, badge: "corner" },
      { selector: tour("mobile-file-actions"), n: 3, badge: "corner" },
      { selector: tour("side-nav-library"), n: 4, badge: "corner" },
      { selector: tour("side-nav-settings"), n: 5, badge: "corner" },
      { selector: tour("side-nav-help"), n: 6, badge: "corner" },
      { selector: tour("landing-create"), n: 7 },
      { selector: tour("landing-import"), n: 8 },
      { selector: tour("landing-cloud"), n: 9 },
      { selector: tour("landing-demo-song"), n: 10 },
    ]);
    await tap(tour("mobile-file-actions"));
    await shot("file-actions");
    await back();
  },

  async demo() {
    // A modal left open by a previous run (Sessions, Settings) sits over
    // the timeline: close it first.
    if (await rectOf("button", { text: "Cerrar" })) await tap("button", { text: "Cerrar" });
    // Right after a sheet closes the first tap can be swallowed by the
    // dismissal; retry instead of failing the whole run.
    for (let i = 0; i < 3 && !(await rectOf(".lt-timeline-shell")); i++) {
      if (await rectOf(tour("landing-demo-song"))) await tap(tour("landing-demo-song"));
      try {
        await waitFor(".lt-timeline-shell", { timeout: 20_000 });
      } catch {
        /* retry */
      }
    }
    await waitFor(".lt-timeline-shell", { timeout: 5_000 });
    await sleep(6000);
  },

  async daw() {
    await annotatedShot("daw-overview", [
      { selector: tour("topbar-tempo"), n: 1, badge: "below" },
      { selector: ".lt-tap-tempo-button", n: 2, badge: "below" },
      { selector: tour("topbar-time-signature"), n: 3, badge: "below" },
      { selector: ".lt-topbar-history", n: 4, badge: "below" },
      { selector: ".lt-transport-buttons", n: 5, badge: "below" },
      { selector: ".lt-transport-readout", n: 6, badge: "below" },
      { selector: ".lt-resource-meter", n: 7, badge: "below" },
      { selector: ".lt-ruler-header-actions", n: 8 },
      { selector: tour("mobile-selection-bar"), n: 9 },
    ]);
    const hdr = ".lt-ruler-header-actions button";
    await annotatedShot(
      "track-header-actions",
      [0, 1, 2, 3].map((i) => ({ selector: hdr, nth: i, n: i + 1, badge: "corner" as const })),
      { crop: { marks: 20 } },
    );
    await tap('button[aria-label="Más acciones"]');
    await shot("add-sheet");
    await back();
    await tap(".lt-resource-meter button, .lt-resource-meter");
    await annotatedShot("resource-panel", [{ selector: ".lt-resource-meter-panel", pad: 2 }], {
      style: "spotlight",
    });
    await back();
  },

  async trackSelect() {
    await tap(".lt-track-header .lt-track-title-row strong", { nth: 0 });
    const bar = ".lt-mobile-selection-actions";
    await annotatedShot("track-selected", [
      { selector: ".lt-track-header.is-selected", n: 1 },
      { selector: `${bar} .lt-mobile-selection-actions-title`, n: 2, badge: "above" },
      { selector: `${bar} .lt-mobile-selection-action`, nth: 0, n: 3, badge: "above" },
      { selector: `${bar} button[aria-label="Más acciones"]`, n: 4, badge: "above" },
      { selector: `${bar} button[aria-label="Mezcla"]`, n: 5, badge: "above" },
      { selector: `${bar} button[aria-label="Seleccionar varias pistas"]`, n: 6, badge: "above" },
      { selector: `${bar} button[aria-label="Quitar selección"]`, n: 7, badge: "above" },
      { selector: `${bar} button[aria-label="Ocultar acciones"]`, n: 8, badge: "above" },
    ]);
    await tap(`${bar} button[aria-label="Mezcla"]`);
    await annotatedShot("track-mix", [{ selector: ".lt-mobile-selection-mix", pad: 2 }], {
      style: "spotlight",
    });
    await tap(`${bar} button[aria-label="Mezcla"]`);
    await tap(`${bar} button[aria-label="Más acciones"]`);
    await shot("track-more");
    await back();
    await tap(`${bar} button[aria-label="Quitar selección"]`);
  },

  async clipSelect() {
    const row = await rectOf(".lt-track-header", { nth: 0 });
    const song = await rectOf(".lt-region-hotspot", { nth: 0 });
    if (!row || !song) throw new Error("no row/song");
    await touch(song.x + song.w * 0.4, row.y + row.h / 2);
    await sleep(900);
    await annotatedShot("clip-selected", [
      { selector: ".lt-mobile-selection-actions", pad: 2 },
    ], { style: "spotlight" });
    await tap('.lt-mobile-selection-actions button[aria-label="Quitar selección"]');
  },

  async longPressSong() {
    await longPress(".lt-region-hotspot", { nth: 0 });
    // Song arrangements are in the build but not announced yet (2026-10):
    // keep "Arreglo" out of the published capture until the feature ships.
    await run(() => {
      document.querySelectorAll<HTMLElement>(".lt-context-menu button").forEach((el) => {
        if ((el.textContent ?? "").trim() === "Arreglo") el.style.display = "none";
      });
    });
    await sleep(300);
    await shot("song-sheet");
    await back();
    await longPress(".lt-marker-hotspot", { nth: 0 });
    await shot("marker-sheet");
    await back();
  },

  async panels() {
    await tap(tour("side-nav-library"));
    await sleep(900);
    await shot("library");
    // The library is a docked panel, not an overlay: Back would leave the
    // session instead of closing it. Its own button toggles it shut.
    await tap(tour("side-nav-library"));
    await tap(tour("side-nav-settings"));
    await sleep(900);
    await shot("settings");
    await back();
  },

  async views() {
    await tap(`${tour("view-mode-switcher")} button`, { nth: 1 });
    await sleep(2000);
    await shot("compact");
    await tap(`${tour("view-mode-switcher")} button`, { nth: 2 });
    await sleep(2000);
    await shot("live");
    await tap(`${tour("view-mode-switcher")} button`, { nth: 0 });
    await sleep(1000);
  },

  async clipTrackMix() {
    await recordClip("track-select-mix", async () => {
      await sleep(600);
      await tap(".lt-track-header .lt-track-title-row strong", { nth: 1, settle: 1400 });
      await tap('.lt-mobile-selection-actions button[aria-label="Mezcla"]', { settle: 2200 });
      await tap('.lt-mobile-selection-actions button[aria-label="Mezcla"]', { settle: 600 });
      await tap('.lt-mobile-selection-actions button[aria-label="Quitar selección"]', { settle: 900 });
    });
  },

  async sessions() {
    await tap(tour("side-nav-sessions"));
    await sleep(1200);
    await shot("sessions");
  },
};

const argv = process.argv.slice(2);
if (argv.includes("--clear")) {
  adb(`shell am force-stop ${APP}`);
  adb(`shell pm clear ${APP}`);
}
adb(`shell cmd locale set-app-locales ${APP} --locales es-ES`);
adb(`shell am start -n ${APP}/com.libretracks.desktop.MainActivity`);
await connect();
await send("Page.enable");
await sleep(argv.includes("--clear") ? 12_000 : 3000);
console.log("[mobileshots] viewport", JSON.stringify(await viewport()));
const wanted = argv.filter((a) => !a.startsWith("--"));
for (const [name, step] of Object.entries(steps)) {
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`[mobileshots] step ${name}`);
  await step();
}
ws.close();
process.exit(0);

// Exported for steps added below this line in later edits.
export { annotatedShot, back, longPress, shot, tap, tour, waitFor };
