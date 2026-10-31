import { browser, $ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { rectOf, runInPage } from "../utils/annotate.js";
import { parkOsCursor } from "../utils/osCursor.js";
import { Recorder, type VideoOptions } from "../utils/record.js";
import { L } from "../utils/uiText.js";

/**
 * Not a test — records the DESKTOP scenes of the release video
 * (docs/RELEASE_PROCESS.md step 11a). Rewritten every release for that
 * release's feature; git history keeps the previous ones. This one is 1.16.0:
 * the Setlist View, mix scenes, MIDI Map mode and controller profiles,
 * network sessions, song templates, OneDrive/Dropbox and automatic warp.
 *
 *   LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-1.16.0 LT_SHOTS_SESSION=<COPY of a real session> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * The session is copied to a temp folder first (the scenes create a scene
 * and a song in it); it is TestMultiplesAnalisis. Script:
 * scripts/tutorial-video/novedades-1.16.0.es.json. The mobile scene is THIS
 * app with the WebView reporting an Android phone (user agent, touch, a
 * landscape phone viewport), which switches the frontend to its phone layout.
 * It is recorded last, so the desktop scenes never see the phone emulation.
 *
 * The machine's own settings are touched only to be read: the network
 * window's device name, PINs and remembered devices are blurred, and the cloud
 * panel's file names and quota too.
 *
 * Optional LT_TUTORIAL_SCENES=05-escenas,07-midi re-encodes only those scenes
 * (the rest still run, so the app reaches the right state).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.16.0");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-release-video-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
const TITLES = {
  intro: ["Novedades de LibreTracks 1.16.0", "Vista Setlist, escenas de mezcla, controladores MIDI y sesiones de red"],
  end: ["LibreTracks 1.16.0", "Gratis en libretracks.com"],
  fixes: "Y además, correcciones",
};
/** The fixes card: the user-visible fixes of the release, shown, not narrated one by one. */
const FIXES = [
  "La canción vuelve a sonar bien tras cambiar a una tarjeta de sonido con otra frecuencia",
  "Los automatismos ya no borran las carpetas de la biblioteca",
  "En Android se puede usar el audio de cualquier carpeta de la biblioteca",
  "Analizar canción ya no pone dos marcas de la guía en el mismo sitio",
  "Las listas de canciones del móvil se mueven con más fluidez",
  "La hoja Archivo del móvil cabe entera en pantalla",
  "F11 pone y quita la pantalla completa",
];

const tour = (id: string) => `[data-lt-tour="${id}"]`;
const W = 1920;
const H = 1080;
let video: VideoOptions;
let viewportW = W;
let viewportH = H;
let durations: Record<string, number> = {};
let scenesDir = "";

async function cdp<T = unknown>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
  const o = browser.options as { hostname?: string; port?: number };
  const url = `http://${o.hostname ?? "127.0.0.1"}:${o.port ?? 4444}/session/${browser.sessionId}/ms/cdp/execute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, params }),
  });
  const body = (await res.json()) as { value: T };
  if (!res.ok) throw new Error(`cdp ${cmd}: ${JSON.stringify(body)}`);
  return body.value;
}

/** data-guide=<name> on the first visible match whose text contains `text` (or equals it). */
async function tagByText(selector: string, text: string, name: string, exact = false) {
  const ok = await runInPage(
    (sel: string, needle: string, tagName: string, isExact: boolean) => {
      document.querySelectorAll(`[data-guide="${tagName}"]`).forEach((el) => el.removeAttribute("data-guide"));
      const el = Array.from(document.querySelectorAll(sel)).find((e) => {
        const r = e.getBoundingClientRect();
        const label = (e.textContent ?? "").replace(/[▸›]/g, "").trim().toLowerCase();
        return r.width > 0 && r.height > 0 && (isExact ? label === needle.toLowerCase() : label.includes(needle.toLowerCase()));
      });
      if (!el) return false;
      el.setAttribute("data-guide", tagName);
      return true;
    },
    selector,
    text,
    name,
    exact,
  );
  if (!ok) throw new Error(`tagByText: ${selector} "${text}" not visible`);
  return `[data-guide="${name}"]`;
}

async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await browser.executeAsync(
    (c: string, a: Record<string, unknown>, done: (v: unknown) => void) => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      w.__TAURI_INTERNALS__.invoke(c, a).then(done, (e) => done({ __error: String(e) }));
    },
    cmd,
    args,
  )) as T;
}

async function setTimelineView(view: { cameraX?: number; zoomLevel?: number }) {
  await runInPage(
    (v: { cameraX?: number; zoomLevel?: number }) =>
      (window as unknown as { __ltE2E: { setTimelineView: (x: unknown) => void } }).__ltE2E.setTimelineView(v),
    view,
  );
  await browser.pause(800);
}

/**
 * A 16:9 page that fits INSIDE the real window. On a single 1080p monitor the
 * window cannot be 1080 tall (title bar, taskbar), and an emulated viewport
 * larger than the window gets scaled to fit, which puts every WebDriver click
 * a few pixels off; one past the screen edge is lost. Frames are still
 * encoded at 1920x1080 (see VideoOptions).
 */
async function emulate169(): Promise<{ w: number; h: number }> {
  const avail = await runInPage(() => ({ w: window.screen.availWidth, h: window.screen.availHeight }));
  await browser.setWindowRect(0, 0, Math.min(1940, avail.w), Math.min(1140, avail.h));
  await browser.pause(800);
  const real = await runInPage(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const h = Math.min(H, real.h, Math.floor((real.w * 9) / 16));
  const w = Math.round((h * 16) / 9);
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await browser.pause(1500);
  console.log(`[release-video] viewport ${w}x${h} (window ${real.w}x${real.h})`);
  return { w, h };
}

function scene(id: string) {
  const rec = new Recorder(
    cdp,
    id,
    { x: 0, y: 0, w: viewportW, h: viewportH },
    scenesDir,
    { x: viewportW * 0.62, y: viewportH * 0.7 },
    video,
  );
  const record = only.length === 0 || only.includes(id);
  const narration = durations[id] ?? 0;
  console.log(`[release-video] scene ${id}`);
  return {
    rec,
    /** Pads to the narration (plus a breath) and writes the clip. */
    async done() {
      await rec.holdUntil(narration + 0.7);
      if (record) await rec.encode();
    },
  };
}

/** Big centred title over the app. */
async function titleCard(text: string, sub: string) {
  await runInPage(
    (t: string, s: string) => {
      const el = document.createElement("div");
      el.id = "lt-tutorial-title";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;background:rgba(8,10,12,.82);font-family:Inter,Segoe UI,sans-serif;color:#fff";
      el.innerHTML =
        `<div style="font-size:64px;font-weight:800;letter-spacing:-1px">${t}</div>` +
        `<div style="margin-top:18px;font-size:28px;color:#57f1db">${s}</div>`;
      document.body.appendChild(el);
    },
    text,
    sub,
  );
}

/** A title over a list (the release's fixes). */
async function listCard(title: string, items: string[]) {
  await runInPage(
    (t: string, list: string[]) => {
      const el = document.createElement("div");
      el.id = "lt-tutorial-title";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;background:rgba(8,10,12,.9);font-family:Inter,Segoe UI,sans-serif;color:#fff";
      const rows = list
        .map(
          (item) =>
            `<li style="margin:10px 0;padding-left:34px;position:relative">` +
            `<span style="position:absolute;left:0;color:#57f1db">✓</span>${item}</li>`,
        )
        .join("");
      el.innerHTML =
        `<div style="font-size:52px;font-weight:800;letter-spacing:-1px;margin-bottom:28px">${t}</div>` +
        `<ul style="list-style:none;margin:0;padding:0;font-size:26px;max-width:1300px">${rows}</ul>`;
      document.body.appendChild(el);
    },
    title,
    items,
  );
}

/** The phone layout: the frontend picks it from an Android user agent. */
const PHONE = { w: 915, h: 412, dpr: 2.6 };
async function toPhone() {
  await cdp("Emulation.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
  });
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp("Emulation.setDeviceMetricsOverride", { width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.dpr, mobile: true });
  await runInPage(() => window.location.reload());
  await browser.pause(5000);
  await AppPage.waitUntilBooted();
  await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
  await browser.pause(5000);
  await runInPage(() => {
    const notice = document.querySelector(".lt-video-setup-notice");
    const buttons = notice ? Array.from(notice.querySelectorAll("button")) : [];
    (buttons[buttons.length - 1] as HTMLButtonElement | undefined)?.click();
  });
  // A finger, not a mouse: hide the recorder's arrow and leave a round dot.
  await runInPage(() => {
    const style = document.createElement("style");
    style.textContent =
      "#lt-guide-cursor svg{display:none}#lt-guide-cursor::after{content:'';position:absolute;left:-15px;top:-15px;" +
      "width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.3);border:2px solid #fff}";
    document.head.appendChild(style);
  });
}

/** A one-finger drag through CDP touch events (the area selection only answers to touch). */
async function touchDrag(rec: Recorder, from: { x: number; y: number }, to: { x: number; y: number }, ms = 1100) {
  rec.cursor = { ...from };
  await rec.hold(0.3);
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  const steps = Math.max(2, Math.round((ms / 1000) * 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    rec.cursor = point;
    await rec.hold(1 / 30);
  }
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await browser.pause(300);
}

/** Letterboxes a phone-shaped clip into 16:9, the band compose's "mobile" subtitles use. */
function letterbox(name: string) {
  const mp4 = path.join(scenesDir, `${name}.mp4`);
  const out = path.join(scenesDir, `${name}.169.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", mp4,
    "-vf", "scale=1920:-2:flags=lanczos,pad=1920:1080:0:(oh-ih)/2:black,setsar=1",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
  ]);
  rmSync(mp4);
  renameSync(out, mp4);
}

async function removeTitleCard() {
  await runInPage(() => document.getElementById("lt-tutorial-title")?.remove());
}

describe("release video (desktop scenes)", function () {
  before(async function () {
    if (process.env.LT_RELEASEVIDEO !== "1") this.skip();
    if (!golden) throw new Error("LT_SHOTS_SESSION is required");
    durations = JSON.parse(readFileSync(path.join(tutorialDir, "narration", "durations.json"), "utf8"));
    scenesDir = path.join(tutorialDir, "scenes");
    mkdirSync(scenesDir, { recursive: true });
    rmSync(workDir, { recursive: true, force: true });
    cpSync(path.dirname(golden), workDir, { recursive: true });
    await AppPage.waitUntilBooted();
    await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
    await AppPage.resetShell();
    await browser.pause(4000);
    // The session carries a video track: with no projector set up the app
    // offers to configure one. «Ahora no» hides it (in memory only).
    await runInPage(() => {
      const notice = document.querySelector(".lt-video-setup-notice");
      const buttons = notice ? Array.from(notice.querySelectorAll("button")) : [];
      (buttons[buttons.length - 1] as HTMLButtonElement | undefined)?.click();
    });
    await browser.pause(500);
    const vp = await emulate169();
    viewportW = vp.w;
    viewportH = vp.h;
    video = { width: W, height: H, dpr: 2, viewport: vp };
  });

  beforeEach(() => parkOsCursor());

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      try {
        await browser.saveScreenshot(path.join(tutorialDir, "FAILED.png"));
      } catch {
        /* the session may be gone */
      }
    }
  });

  it("records the scenes", async function () {
    const regions = async () =>
      [...((await AppPage.songView())?.regions ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
    const all = await regions();
    const song = all.find((r) => /todopoderoso/i.test(r.name)) ?? all[1];
    if (!song) throw new Error("the session needs «Eres Todopoderoso»");
    const length = song.endSeconds - song.startSeconds;
    const zoom = 1400 / (length * 18);
    const fitSong = () => setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, song.startSeconds * zoom * 18 - 160) });
    /** The song band with most of its width on the page. */
    const songBand = async () => {
      await runInPage(() => {
        document.querySelectorAll('[data-guide="rv-song"]').forEach((el) => el.removeAttribute("data-guide"));
        const best = Array.from(document.querySelectorAll(".lt-region-hotspot"))
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { e, seen: r.height > 0 ? Math.min(r.right, window.innerWidth) - Math.max(r.left, 0) : 0 };
          })
          .filter(({ seen }) => seen > 0)
          .sort((a, b) => b.seen - a.seen)[0];
        best?.e.setAttribute("data-guide", "rv-song");
      });
      const box = await rectOf('[data-guide="rv-song"]');
      if (!box) throw new Error("no song band");
      return box;
    };
    const play = `.lt-transport-buttons button[aria-label="${L("Reproducir")}"]`;
    const stop = `.lt-transport-buttons button[aria-label="${L("Detener")}"]`;
    const viewBtn = (n: number) => `${tour("view-mode-switcher")} button:nth-of-type(${n})`;
    const fileMenu = `${tour("topbar-file-menu")} .lt-top-menu-trigger`;
    const fileItem = async (rec: Recorder, text: string, tag: string) => {
      await rec.click(fileMenu, 700);
      await rec.click(await tagByText(".lt-top-menu-dropdown button", L(text), tag), 1200);
    };
    const zone = (name: string) => `[data-setlist-zone="${name}"]`;

    await fitSong();
    await invoke("seek_transport", { positionSeconds: song.startSeconds + 20 });
    await browser.pause(800);

    // 01 — title over the timeline.
    {
      const { rec, done } = scene("01-intro");
      await titleCard(TITLES.intro[0], TITLES.intro[1]);
      await rec.hold(Math.max(3, durations["01-intro"] - 2.2));
      await removeTitleCard();
      await rec.hold(1.5);
      await done();
    }

    // 02 — the Setlist View: the button, then its three zones.
    {
      const { rec, done } = scene("02-setlist");
      await rec.moveTo(viewBtn(2), 700);
      await rec.hold(1.5);
      await rec.click(viewBtn(2), 2000);
      for (const name of ["songs", "overview", "mixer"]) {
        if (!(await rectOf(zone(name)))) continue;
        await rec.zoomTo(zone(name), { margin: 20, maxZoom: 1.5 });
        await rec.hold(2.6);
        await rec.zoomOut(500);
      }
      await done();
    }

    // 03 — pick the song, play, move the cursor with the arrows and jump.
    {
      const { rec, done } = scene("03-setlist-tocar");
      const tile = `.lt-setlist-song-tile[data-region-id="${song.id}"]`;
      if (await rectOf(tile)) await rec.click(tile, 1200);
      await rec.click(play, 400);
      await rec.realtimeWithAudio(2500, loopback);
      await rec.key("ArrowRight", 300);
      await rec.key("ArrowRight", 300);
      await rec.hold(0.8);
      await rec.key("Enter", 300);
      await rec.realtimeWithAudio(6500, loopback);
      await rec.click(stop, 600);
      await done();
    }

    // 04 — Edit: the drawer and its modes, then Done.
    {
      const { rec, done } = scene("04-setlist-editar");
      await rec.click(".lt-setlist-edit-button", 1500);
      const tabs = (await runInPage(() =>
        Array.from(document.querySelectorAll(".lt-setlist-drawer-tab"))
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.width > 0)
          .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })),
      )) as Array<{ x: number; y: number }>;
      for (const point of tabs.slice(0, 5)) {
        await rec.clickAt(point, 900);
        await rec.hold(0.9);
      }
      if (tabs[0]) await rec.clickAt(tabs[0], 800);
      await rec.hold(1);
      await rec.click(".lt-setlist-edit-button", 1200);
      await done();
    }

    // 05 — mix scenes: File › Mix scenes…, the quick «band down» scene.
    {
      const { rec, done } = scene("05-escenas");
      await rec.click(viewBtn(1), 1500);
      await fileItem(rec, "Escenas de mezcla", "rv-scenes");
      await rec.zoomTo(".lt-scene-modal", { margin: 30, maxZoom: 1.3 });
      await rec.hold(1.5);
      if (!(await rectOf(".lt-scene-list-select"))) {
        await rec.click(".lt-scene-add.is-template", 1500);
      } else {
        await rec.moveTo(".lt-scene-add.is-template", 700);
      }
      await rec.hold(1.5);
      await rec.moveTo(".lt-scene-rules", 700);
      await rec.hold(1.8);
      await rec.moveTo(".lt-scene-preview", 700);
      await rec.hold(2);
      await rec.zoomOut(500);
      await rec.click(".lt-scene-modal button.is-primary", 900);
      await done();
    }

    // 06 — the scene button in Live, engaged and released while playing.
    {
      const { rec, done } = scene("06-escenas-directo");
      await invoke("seek_transport", { positionSeconds: song.startSeconds + 40 });
      await rec.click(viewBtn(4), 1800);
      await rec.click(play, 300);
      await rec.realtimeWithAudio(2500, loopback);
      const sceneButton = ".lt-live-scenes .lt-scene-button";
      if (await rectOf(sceneButton)) {
        await rec.click(sceneButton, 200);
        await rec.realtimeWithAudio(4000, loopback);
        await rec.click(sceneButton, 200);
        await rec.realtimeWithAudio(3500, loopback);
      } else {
        console.log("[release-video] 06: no scene button in Live");
      }
      await rec.click(stop, 600);
      await rec.click(viewBtn(1), 1500);
      await done();
    }

    // 07 — MIDI Map mode: Ctrl+M, the tint, a fader picked.
    {
      const { rec, done } = scene("07-midi");
      await AppPage.resetShell();
      await rec.hold(1);
      await browser.keys(["Control", "m"]);
      await browser.pause(900);
      await rec.hold(2.5);
      const layer = ".lt-track-header .lt-midi-mappable-layer.is-interactive";
      if (await rectOf(layer)) {
        await rec.zoomTo({ x: 0, y: 0, w: viewportW * 0.55, h: viewportH * 0.6 }, { margin: 0, maxZoom: 1.6 });
        await rec.click(layer, 1200);
        await rec.hold(2.5);
        await rec.zoomOut(500);
      }
      await rec.key("Escape", 400);
      if (await rectOf(".lt-midi-map-banner")) await rec.key("Escape", 400);
      await done();
    }

    // 08 — Settings › MIDI Learn: the controller profiles and the 1-8 strips.
    {
      const { rec, done } = scene("08-midi-perfiles");
      await AppPage.openSettings();
      await browser.pause(800);
      await rec.click("#lt-settings-tab-midiLearn", 1200);
      await rec.zoomTo(".lt-midi-profiles", { margin: 40, maxZoom: 1.6 });
      await rec.hold(3);
      await rec.zoomOut(500);
      await rec.click(await tagByText(".lt-midi-learn-view-tabs button", L("Mezclador"), "rv-mixer-view"), 1000);
      await rec.hold(3);
      await rec.key("Escape", 600);
      await AppPage.resetShell();
      await done();
    }

    // 09 — network sessions: the side bar's Network window, host and join.
    {
      const { rec, done } = scene("09-red");
      const blur = () =>
        runInPage(() => {
          document
            .querySelectorAll<HTMLElement>(".lt-network-modal input, .lt-network-modal .lt-network-row-name")
            .forEach((el) => {
              el.style.filter = "blur(6px)";
            });
        });
      await rec.moveTo(".lt-network-nav", 700);
      await rec.hold(0.8);
      await rec.click(".lt-network-nav", 200);
      await blur();
      await browser.pause(600);
      await blur();
      await rec.zoomTo(".lt-network-modal", { margin: 30, maxZoom: 1.3 });
      await rec.moveTo(".lt-network-form", 700);
      await rec.hold(3);
      await rec.moveTo(".lt-network-button.is-primary", 700);
      await rec.hold(2);
      await rec.click(".lt-network-tab:nth-of-type(2)", 200);
      await blur();
      await browser.pause(800);
      await blur();
      await rec.hold(3.5);
      await rec.zoomOut(500);
      await rec.click(".lt-network-modal .lt-settings-modal-close", 800);
      await done();
    }

    // 10 — song templates: the arrow next to «+ New song» in Compact.
    {
      const { rec, done } = scene("10-plantillas");
      // Settings › General: the template for every new song and the «one
      // folder per song» layout. Shown only: these are the machine's settings.
      await AppPage.openSettings();
      await browser.pause(800);
      await rec.click("#lt-settings-tab-general", 1000);
      const showField = async (text: string, tag: string) => {
        const field = await tagByText(".lt-settings-field", L(text), tag);
        await runInPage((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), field);
        await browser.pause(600);
        await rec.zoomTo(field, { margin: 40, maxZoom: 1.6 });
        await rec.moveTo(`${field} select`, 600);
        await rec.hold(2.8);
        await rec.zoomOut(400);
      };
      await showField("Plantilla para canciones nuevas", "rv-template-field");
      await showField("Pistas de cada canción", "rv-layout-field");
      await rec.key("Escape", 600);
      await AppPage.resetShell();
      await rec.click(viewBtn(3), 1800);
      const arrow = ".lt-new-song-template-toggle";
      if (await rectOf(arrow)) {
        await runInPage((sel: string) => document.querySelector(sel)?.scrollIntoView({ inline: "center", block: "nearest" }), arrow);
        await browser.pause(800);
        await rec.click(arrow, 900);
        await rec.hold(1.5);
        await rec.click(await tagByText(".lt-new-song-template-menu button", L("Banda (incluida)"), "rv-band"), 2500);
        // The new song is the last column, off to the right: bring it in.
        await runInPage(() => {
          document.querySelectorAll<HTMLElement>(".lt-compact-view *").forEach((el) => {
            if (el.scrollWidth > el.clientWidth + 40 && getComputedStyle(el).overflowX !== "visible") {
              el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
            }
          });
        });
        for (let i = 0; i < 20; i++) await rec.frame(1 / 20);
        await rec.hold(4);
      } else {
        console.log("[release-video] 10: no template arrow");
      }
      await rec.click(viewBtn(1), 1500);
      await done();
    }

    // 11 — the cloud: File › Cloud…, the three providers.
    {
      const { rec, done } = scene("11-nube");
      await rec.click(fileMenu, 700);
      await rec.click(await tagByText(".lt-top-menu-dropdown button", L("Nube"), "rv-cloud"), 200);
      const blurCloud = () =>
        runInPage(() =>
          document
            .querySelectorAll<HTMLElement>(
              ".lt-cloud-modal .lt-cloud-quota > *:not(.lt-cloud-quota-bar):not(.lt-cloud-quota-hint), .lt-cloud-modal .lt-cloud-file-name, .lt-cloud-modal .lt-cloud-file-meta, .lt-cloud-modal .lt-cloud-file-size",
            )
            .forEach((el) => {
              el.style.filter = "blur(6px)";
            }),
        );
      for (let i = 0; i < 12; i++) {
        await blurCloud();
        await browser.pause(250);
      }
      if (await rectOf(".lt-cloud-accounts")) {
        await rec.zoomTo(".lt-cloud-accounts", { margin: 40, maxZoom: 1.6 });
        await blurCloud();
        await rec.hold(4);
        await rec.zoomOut(500);
      }
      await blurCloud();
      await rec.click(".lt-cloud-modal .lt-settings-modal-close", 800);
      await done();
    }

    // 12 — automatic warp: +2 semitones and warp turns on by itself.
    {
      const { rec, done } = scene("12-warp");
      await fitSong();
      const band = await songBand();
      await rec.clickAt({ x: band.x + 200, y: band.y + band.h / 2 }, 700);
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 900);
      await rec.zoomTo(".lt-control-popover-panel", { margin: 40, maxZoom: 1.6 });
      const up = `button[aria-label="${L("Subir un semitono la region seleccionada")}"]`;
      await rec.click(up, 700);
      await rec.click(up, 1200);
      await rec.hold(1.5);
      await rec.zoomOut(500);
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 600);
      await rec.moveTo(tour("toolbar-warp"), 700);
      await rec.hold(2.5);
      // Back to the original key, which turns warp off again.
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 700);
      const down = `button[aria-label="${L("Bajar un semitono la region seleccionada")}"]`;
      await rec.click(down, 500);
      await rec.click(down, 800);
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 600);
      await done();
    }

    // 14 — the fixes, shown on a card (narrated only as a whole).
    {
      const { rec, done } = scene("14-correcciones");
      await removeTitleCard();
      await listCard(TITLES.fixes, FIXES);
      await rec.hold(Math.max(6, durations["14-correcciones"] ?? 6));
      await done();
    }

    // 15 — end card.
    {
      const { rec, done } = scene("15-final");
      await removeTitleCard();
      await titleCard(TITLES.end[0], TITLES.end[1]);
      await rec.hold(durations["15-final"]);
      await done();
      await removeTitleCard();
    }

    // 13 — the Setlist View on a phone, recorded LAST (see the header): the
    // waveform or the mixer, one at a time, with the pane button.
    {
      await toPhone();
      await browser.execute(() => (window as any).__ltE2E.setViewMode("setlist"));
      await browser.pause(2500);
      const rec = new Recorder(cdp, "13-movil", { x: 0, y: 0, w: PHONE.w, h: PHONE.h }, scenesDir,
        { x: PHONE.w * 0.7, y: PHONE.h * 0.6 },
        { width: 1920, height: Math.round((1920 * PHONE.h) / PHONE.w / 2) * 2, dpr: PHONE.dpr, viewport: { w: PHONE.w, h: PHONE.h } });
      const record = only.length === 0 || only.includes("13-movil");
      console.log("[release-video] scene 13-movil");
      await rec.hold(2);
      const pane = ".lt-setlist-pane-toggle";
      for (let i = 0; i < 2; i++) {
        if (!(await rectOf(pane))) break;
        await rec.click(pane, 1200);
        await rec.hold(1.8);
      }
      // On a phone the scenes fold into one button: open it, engage, release.
      const menu = ".lt-scene-menu-button";
      if (await rectOf(menu)) {
        await rec.click(menu, 900);
        await rec.hold(0.8);
        const item = ".lt-scene-menu .lt-scene-button";
        if (await rectOf(item)) {
          await rec.click(item, 900);
          await rec.hold(1.2);
          await rec.click(item, 700);
        }
        await rec.key("Escape", 500);
      } else {
        console.log("[release-video] 13-movil: no scenes button on the phone");
      }
      await rec.holdUntil((durations["13-movil"] ?? 8) + 0.7);
      if (record) {
        await rec.encode();
        letterbox("13-movil");
      }
    }
  });
});
