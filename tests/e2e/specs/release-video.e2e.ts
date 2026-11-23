import { browser, $ } from "@wdio/globals";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * release's features; git history keeps the previous ones. This one is
 * 1.18.0: track EQ, the Rhythm panel, lyrics sent to FreeShow, prepared pitch
 * changes, clip fades, Alt+drag copies, clear solos and «Fade in y reproducir».
 *
 *   LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-1.18.0 LT_SHOTS_SESSION=<COPY of a real session> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts --mochaOpts.timeout 2400000
 *
 * Session: «TestLetras2» (one song, «Digno», linked to the FreeShow show
 * «Digno (Worthy)»). FreeShow must be open on this machine with its API on;
 * its Output page (port 5513) is shown in a frame inside the app while the
 * song plays, since the recorder only sees LibreTracks' own page.
 *
 * The app runs with the machine's real settings: the scene that turns on
 * prepared pitch changes turns them off again at the end. Scenes with sound
 * record the app's audio through scripts/tutorial-video/loopback.py.
 *
 * The mobile scene is THIS app with the WebView reporting an Android phone,
 * recorded last so the desktop scenes never see the phone emulation.
 *
 * Optional LT_TUTORIAL_SCENES=02-eq,10-fades re-encodes only those scenes
 * (the rest still run, so the app reaches the right state).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.18.0");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-release-video-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
const FREESHOW_OUTPUT = process.env.LT_FREESHOW_OUTPUT ?? "http://127.0.0.1:5513/";
const TITLES = {
  intro: ["Novedades de LibreTracks 1.18.0", "Ecualizador por pista, loops de batería, letra en proyección, Planning Center y tono preparado"],
  end: ["LibreTracks 1.18.0", "Gratis en libretracks.com"],
  fixes: "Y además",
};
/** The «and also» card: improvements and fixes, shown, not narrated one by one. */
const FIXES = [
  "Aviso de voz guía nuevo: «Metales»",
  "Los paquetes .ltpkg conservan la mezcla, las carpetas y los cambios de tempo",
  "Mover o copiar secciones ya no pone el tempo a 0",
  "Añadir canciones a un setlist grande ya no cierra la app",
  "Se comprueba el espacio libre antes de escribir en disco",
  "En iPhone la pantalla ya no se queda en blanco",
  "Un coro copiado con sus tiempos en el editor de letra ya no pasa de golpe",
  "Al abrir otra sesión ya no sigue sonando el clic de la anterior",
  "Menos memoria al reproducir sesiones grandes",
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


/** FreeShow's Output page in a frame over the bottom right corner of the app. */
async function showFreeShowOutput() {
  await runInPage((url: string) => {
    document.getElementById("lt-rv-freeshow")?.remove();
    const el = document.createElement("div");
    el.id = "lt-rv-freeshow";
    el.style.cssText =
      "position:fixed;right:28px;bottom:28px;width:640px;height:396px;z-index:2147483645;background:#000;" +
      "border-radius:10px;box-shadow:0 0 0 6px #2a2f36,0 12px 40px rgba(0,0,0,.6);overflow:hidden;font-family:Inter,Segoe UI,sans-serif";
    el.innerHTML =
      `<div style="height:36px;line-height:36px;padding:0 14px;background:#1b1f24;color:#57f1db;font-size:16px;font-weight:700">FreeShow · salida</div>` +
      `<iframe src="${url}" style="border:0;width:640px;height:360px;display:block;background:#000"></iframe>`;
    document.body.appendChild(el);
  }, FREESHOW_OUTPUT);
  await browser.pause(2500);
}

async function hideFreeShowOutput() {
  await runInPage(() => document.getElementById("lt-rv-freeshow")?.remove());
}

/** The prepared pitch setting, on or off, through Settings › General › Edición. */
async function setPreparedPitch(rec: Recorder | null, on: boolean) {
  await AppPage.openSettings();
  await browser.pause(800);
  await AppPage.settingsTab("editing");
  await browser.pause(600);
  // Opening the General group lands on Interfaz: Edición still needs its click.
  await runInPage(() => (document.getElementById("lt-settings-tab-editing") as HTMLElement | null)?.click());
  await browser.pause(800);
  const label = await tagByText("label.lt-settings-toggle", L("Cambio de tono preparado (equipos lentos)"), "rv-prep");
  await runInPage((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), label);
  await browser.pause(600);
  const checked = await runInPage(
    (sel: string) => (document.querySelector(`${sel} input`) as HTMLInputElement | null)?.checked ?? false,
    label,
  );
  if (rec) {
    await rec.zoomTo(label, { margin: 60, maxZoom: 1.6 });
    await rec.hold(1.2);
  }
  if (checked !== on) {
    if (rec) await rec.click(`${label} input`, 900);
    else await $(`${label} input`).click();
    await browser.pause(800);
    if (await rectOf(".lt-dialog-card")) {
      if (rec) {
        await rec.hold(2);
        await rec.click(".lt-dialog-card .lt-dialog-button--primary", 900);
      } else {
        await $(".lt-dialog-card .lt-dialog-button--primary").click();
      }
    }
  }
  if (rec) {
    await rec.hold(1.2);
    await rec.zoomOut(500);
    await rec.key("Escape", 600);
  } else {
    await browser.keys("Escape");
  }
  await AppPage.resetShell();
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

  after(async function () {
    // The machine's own settings: prepared pitch goes back off.
    if (process.env.LT_RELEASEVIDEO !== "1") return;
    try {
      await cdp("Emulation.clearDeviceMetricsOverride");
      await cdp("Emulation.setUserAgentOverride", { userAgent: "" });
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
      await runInPage(() => window.location.reload());
      await browser.pause(5000);
      await AppPage.waitUntilBooted();
      await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
      await browser.pause(3000);
      await setPreparedPitch(null, false);
    } catch (error) {
      console.log(`[release-video] WARNING: could not turn prepared pitch back off: ${String(error)}`);
    }
  });

  it("records the scenes", async function () {
    const regions = async () =>
      [...((await AppPage.songView())?.regions ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
    const firstSong = async () => {
      const song = (await regions())[0];
      if (!song) throw new Error("the session has no songs");
      return song;
    };
    const fitSong = async () => {
      const song = await firstSong();
      const zoom = 1500 / ((song.endSeconds - song.startSeconds) * 18);
      await setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, song.startSeconds * zoom * 18 - 120) });
    };
    const songBand = async () => {
      const song = await firstSong();
      const box = await rectOf(`.lt-region-hotspot[data-region-id="${song.id}"]`);
      if (!box) throw new Error("no song band");
      return box;
    };
    /** x on the page of a song time, through the song's band. */
    const xAt = async (seconds: number) => {
      const song = await firstSong();
      const band = await songBand();
      return band.x + ((seconds - song.startSeconds) / (song.endSeconds - song.startSeconds)) * band.w;
    };
    const trackHeader = (name: string) =>
      runInPage((needle: string) => {
        document.querySelectorAll('[data-guide="rv-header"]').forEach((el) => el.removeAttribute("data-guide"));
        const el = Array.from(document.querySelectorAll(".lt-track-header")).find((e) => {
          const text = (e.querySelector(".lt-track-title-row strong")?.textContent ?? "").trim();
          return text.toLowerCase().startsWith(needle.toLowerCase()) && e.getBoundingClientRect().height > 0;
        });
        if (!el) return false;
        el.setAttribute("data-guide", "rv-header");
        return true;
      }, name);
    const laneRow = async (trackId: string) => {
      const box = await rectOf(`.lt-track-lane-row[data-track-id="${trackId}"]`);
      if (!box) throw new Error(`no lane for ${trackId}`);
      return box;
    };
    const markersInSong = async () => {
      const song = await firstSong();
      const view = await AppPage.songView();
      return (view?.sectionMarkers ?? [])
        .filter((m) => m.startSeconds >= song.startSeconds && m.startSeconds < song.endSeconds)
        .sort((a, b) => a.startSeconds - b.startSeconds);
    };
    const markerNamed = async (re: RegExp, nth = 0) => {
      const found = (await markersInSong()).filter((m) => re.test(m.name))[nth];
      if (!found) throw new Error(`no marker ${re}`);
      return found;
    };

    const fileMenu = `${tour("topbar-file-menu")} .lt-top-menu-trigger`;

    await fitSong();
    const chorus = await markerNamed(/coro/i);
    await invoke("seek_transport", { positionSeconds: chorus.startSeconds });
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

    // 02 — the EQ button of the drums, drag a node, the wheel for its width.
    {
      const { rec, done } = scene("02-eq");
      if (!(await trackHeader("Drums"))) throw new Error("02: no drums header");
      const eqButton = '[data-guide="rv-header"] .lt-track-eq-button';
      await rec.zoomTo('[data-guide="rv-header"]', { margin: 80, maxZoom: 1.8 });
      await rec.moveTo(eqButton, 700);
      await rec.hold(1.2);
      await rec.zoomOut(400);
      await rec.click(eqButton, 1200);
      await rec.zoomTo(".lt-eq-editor", { margin: 30, maxZoom: 1.5 });
      await rec.hold(1);
      const node = '[data-testid="lt-eq-node-2"]';
      const box = await rectOf(node);
      if (box) {
        const from = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        await rec.dragToCdp({ x: from.x + 40, y: from.y - 70 }, 1200, { from });
        await rec.hold(0.8);
        const to = { x: from.x + 40, y: from.y - 70 };
        for (let i = 0; i < 5; i++) {
          await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: to.x, y: to.y, deltaX: 0, deltaY: -120 });
          await rec.hold(0.25);
        }
      } else {
        console.log("[release-video] 02: no EQ node 2");
      }
      await rec.hold(1.5);
      await done();
    }

    // 03 — playing: the analyser, the presets, then the master's EQ.
    {
      const { rec, done } = scene("03-eq-mas");
      await invoke("play_transport");
      const rta = await tagByText(".lt-eq-editor .lt-eq-button", "RTA", "rv-rta", true).catch(() => "");
      if (rta) {
        const pressed = await runInPage((s: string) => document.querySelector(s)?.getAttribute("aria-pressed") === "true", rta);
        if (!pressed) await rec.click(rta, 300);
      }
      await rec.realtimeWithAudio(5000, loopback);
      await rec.click(".lt-eq-presets > button.lt-eq-button", 700);
      await rec.realtimeWithAudio(3500, loopback);
      await rec.key("Escape", 400);
      if (await rectOf(".lt-eq-presets-menu")) await rec.key("Escape", 400);
      await rec.zoomOut(400);
      if (await rectOf(".lt-eq-close")) await rec.click(".lt-eq-close", 700);
      await invoke("stop_transport");
      await rec.click(`${tour("toolbar-master")} .lt-control-popover-trigger`, 900);
      if (await rectOf(".lt-song-master-eq-button")) {
        await rec.zoomTo(".lt-song-master-eq-button", { margin: 160, maxZoom: 1.6 });
        await rec.moveTo(".lt-song-master-eq-button", 700);
        await rec.hold(2);
        await rec.zoomOut(400);
      }
      await rec.key("Escape", 600);
      await AppPage.resetShell();
      await done();
    }

    // 04 — the Rhythm panel: a pattern, play, variation B.
    {
      const { rec, done } = scene("04-ritmo");
      await rec.click("button.lt-rhythm-button", 1500);
      const panel = '[data-testid="rhythm-panel"]';
      if (!(await rectOf(panel))) throw new Error("04: the Rhythm panel did not open");
      await rec.zoomTo(panel, { margin: 30, maxZoom: 1.6 });
      await rec.hold(1);
      const select = await $("select.lt-rhythm-pattern-select");
      if (await select.isExisting()) {
        await rec.moveTo("select.lt-rhythm-pattern-select", 600);
        for (const index of [1, 2, 3]) {
          await select.selectByIndex(index);
          await rec.hold(0.6);
        }
      }
      await rec.click("button.lt-rhythm-play", 300);
      await rec.realtimeWithAudio(4500, loopback);
      const variationB = `.lt-rhythm-row .lt-rhythm-row__variations button[aria-label="${L("Variación")} B"]`;
      if (await rectOf(variationB)) {
        await rec.click(variationB, 200);
        await rec.realtimeWithAudio(4000, loopback);
      } else {
        await rec.realtimeWithAudio(3000, loopback);
      }
      await done();
    }

    // 05 — one shot pads over the loop, then stop and close.
    {
      const { rec, done } = scene("05-ritmo-pads");
      const pads = (await runInPage(() =>
        Array.from(document.querySelectorAll('[data-testid="rhythm-one-shots"] button.lt-rhythm-pad:not(.is-empty)'))
          .slice(0, 4)
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }),
      )) as Array<{ x: number; y: number }>;
      for (const pad of pads) {
        await rec.clickAt(pad, 100);
        await rec.realtimeWithAudio(1300, loopback);
      }
      await rec.realtimeWithAudio(1500, loopback);
      if (await rectOf("button.lt-rhythm-play.is-playing")) await rec.click("button.lt-rhythm-play", 600);
      await rec.zoomOut(400);
      await rec.click("button.lt-rhythm-button", 900);
      await done();
    }

    // 06 — Settings › Letras: on, FreeShow, search the network, test.
    {
      const { rec, done } = scene("06-letra-ajustes");
      await AppPage.openSettings();
      await browser.pause(800);
      await rec.click("#lt-settings-tab-lyrics", 900);
      if (await rectOf(".lt-lyrics-tutorial-skip")) await rec.click(".lt-lyrics-tutorial-skip", 700);
      await rec.zoomTo(".lt-lyrics-settings", { margin: 20, maxZoom: 1.4 });
      const enable = ".lt-lyrics-settings > label.lt-settings-toggle input[type=checkbox]";
      const enabled = await runInPage((s: string) => (document.querySelector(s) as HTMLInputElement | null)?.checked ?? false, enable);
      if (enabled) await rec.moveTo(enable, 600);
      else await rec.click(enable, 800);
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-lyrics-programs button.lt-lyrics-btn", "FreeShow", "rv-freeshow"), 900);
      if (await rectOf(".lt-lyrics-tutorial-skip")) {
        await rec.hold(1.5);
        await rec.click(".lt-lyrics-tutorial-skip", 700);
      }
      await rec.click(".lt-lyrics-scan button.lt-lyrics-btn", 400);
      for (let i = 0; i < 40 && !(await rectOf("button.lt-lyrics-found-item")); i++) await rec.hold(0.5);
      if (await rectOf("button.lt-lyrics-found-item")) {
        await rec.hold(0.8);
        await rec.click("button.lt-lyrics-found-item", 900);
      } else {
        console.log("[release-video] 06: the scan found nothing");
      }
      const probe = await tagByText(".lt-lyrics-row button.lt-lyrics-btn", L("Probar conexión"), "rv-probe").catch(() => "");
      if (probe) {
        await rec.click(probe, 400);
        for (let i = 0; i < 20 && !(await rectOf(".lt-lyrics-probe")); i++) await rec.hold(0.5);
      }
      await rec.hold(2.5);
      await rec.zoomOut(500);
      await rec.key("Escape", 600);
      await AppPage.resetShell();
      await done();
    }

    // 07 — right-click the song › «Proyección…».
    {
      const { rec, done } = scene("07-letra-cancion");
      await fitSong();
      const band = await songBand();
      await rec.rightClick({ x: Math.max(band.x, 0) + 260, y: band.y + band.h / 2 });
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-context-menu button", L("Proyección…"), "rv-lyrics-panel"), 1500);
      if (await rectOf(".lt-lyrics-modal")) {
        await rec.zoomTo(".lt-lyrics-modal", { margin: 30, maxZoom: 1.4 });
        await rec.hold(2);
        const row = ".lt-lyrics-modal table.lt-lyrics-table tbody tr:nth-child(4)";
        if (await rectOf(row)) await rec.moveTo(row, 800);
        await rec.hold(3);
        await rec.zoomOut(500);
        // Escape does not close it: its own «Listo» button does.
        const doneButton = await tagByText(".lt-lyrics-modal button", L("Listo"), "rv-lyrics-done", true).catch(() => "");
        if (doneButton) await rec.click(doneButton, 800);
      } else {
        console.log("[release-video] 07: no lyrics panel");
      }
      await AppPage.resetShell();
      await done();
    }

    // 08 — play across two sections. Pass A records LibreTracks; pass B puts
    // FreeShow's own window in front and grabs it (gdigrab) while the same
    // stretch plays again, since LibreTracks sends the lyrics from its engine
    // whether its window shows or not. scripts/tutorial-video/overlay-freeshow.mjs
    // lays B over A, lined up on the moment playback starts in each.
    {
      const { rec, done } = scene("08-letra-directo");
      const verse = await markerNamed(/verso/i);
      const from = Math.max(0, verse.startSeconds - 4);
      const playMs = Math.max(13000, (durations["08-letra-directo"] ?? 11) * 1000 + 1500);
      await invoke("seek_transport", { positionSeconds: from });
      await browser.pause(600);
      await rec.hold(0.8);
      const playAt = rec.seconds;
      await invoke("play_transport");
      await rec.realtimeWithAudio(playMs, loopback);
      await invoke("stop_transport");
      await done();
      if (only.length === 0 || only.includes("08-letra-directo")) {
        const extra = path.join(tutorialDir, "extra");
        mkdirSync(extra, { recursive: true });
        const out = path.join(extra, "08-freeshow.mp4");
        // FreeShow must be maximized right behind this window (the user leaves
        // it so, with its show list closed): minimizing LibreTracks shows it.
        // ddagrab, not gdigrab: FreeShow paints with the GPU and gdigrab gets black.
        await browser.minimizeWindow();
        // The driver's console windows (msedgewebview2, tauri-driver) sit on
        // top of everything: minimized too, so only FreeShow is on screen.
        execFileSync("powershell", ["-NoProfile", "-Command",
          `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; ` +
          `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'msedgewebview2|msedgedriver|tauri-driver' } | ` +
          `ForEach-Object { [U.W]::ShowWindow($_.MainWindowHandle, 6) | Out-Null }`,
        ]);
        await browser.pause(1500);
        await invoke("seek_transport", { positionSeconds: from });
        await browser.pause(600);
        const avail = { w: 1920, h: 1032 };
        const grab = spawn("ffmpeg", [
          "-y", "-loglevel", "error", "-f", "lavfi",
          "-i", `ddagrab=framerate=30:draw_mouse=0:video_size=${avail.w}x${avail.h}:offset_x=0:offset_y=0,hwdownload,format=bgra`,
          "-t", String(playMs / 1000 + 3),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out,
        ], { stdio: "inherit" });
        const grabStart = Date.now();
        await browser.pause(1500);
        const lead = (Date.now() - grabStart) / 1000;
        await invoke("play_transport");
        await new Promise((resolve) => grab.on("exit", resolve));
        await invoke("stop_transport");
        writeFileSync(path.join(extra, "08-freeshow.json"), JSON.stringify({ sceneAt: playAt, grabAt: lead }, null, 2));
        const vp = await emulate169();
        viewportW = vp.w;
        viewportH = vp.h;
      }
    }

    // 08b — Planning Center: the account in File › Nube…, then the song's
    // menu › «Letra desde Planning Center…», search, song, arrangement.
    {
      const { rec, done } = scene("08b-planning");
      await AppPage.resetShell();
      await rec.click(fileMenu, 700);
      await rec.click(await tagByText(".lt-top-menu-dropdown button", L("Nube…"), "rv-cloud"), 1500);
      const account = '[data-testid="pco-account"]';
      if (await rectOf(account)) {
        // The organisation and the user's name are blurred.
        await runInPage(() =>
          document.querySelectorAll<HTMLElement>('[data-testid="pco-account"] .lt-cloud-account-state').forEach((el) => {
            el.style.filter = "blur(5px)";
          }),
        );
        await rec.zoomTo(account, { margin: 120, maxZoom: 1.6 });
        await rec.hold(2.2);
        await rec.zoomOut(400);
      } else {
        console.log("[release-video] 08b: no Planning Center row in the cloud panel");
      }
      // Escape does not close the cloud panel: its × does.
      const closeCloud = 'section[aria-labelledby="lt-cloud-modal-title"] .lt-settings-modal-close';
      if (await rectOf(closeCloud)) await rec.click(closeCloud, 800);
      await AppPage.resetShell();
      await fitSong();
      const band = await songBand();
      await rec.rightClick({ x: Math.max(band.x, 0) + 260, y: band.y + band.h / 2 });
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-context-menu button", L("Letra desde Planning Center…"), "rv-pco"), 1500);
      const dialog = ".lt-chart-import";
      if (!(await rectOf(dialog))) throw new Error("08b: the Planning Center dialog did not open");
      await rec.zoomTo(dialog, { margin: 30, maxZoom: 1.4 });
      const input = await $(".lt-chart-import-search input");
      if (await input.isExisting()) {
        await rec.click(".lt-chart-import-search input", 300);
        // setValue on the element itself: React sees the typing (rec.type and
        // clearValue left the controlled field empty).
        await input.setValue("Digno");
        await rec.hold(0.6);
        await rec.click(".lt-chart-import-search button", 400);
      }
      for (let i = 0; i < 30 && !(await rectOf(".lt-chart-import-list button")); i++) await rec.hold(0.5);
      const song = await tagByText(".lt-chart-import-list > li > button", "Digno", "rv-pco-song").catch(() => "");
      if (song) {
        await rec.click(song, 900);
        const arrangement = ".lt-chart-import-arrangements button:not([disabled])";
        for (let i = 0; i < 30 && !(await rectOf(arrangement)); i++) await rec.hold(0.5);
        if (await rectOf(arrangement)) {
          await rec.moveTo(arrangement, 600);
          await rec.hold(0.8);
          await rec.click(arrangement, 1200);
        } else {
          console.log("[release-video] 08b: no arrangement with text");
        }
      } else {
        console.log("[release-video] 08b: no «Digno» in the results");
      }
      await done();
    }

    // 08c — «Ajustar a la secuencia»: what would change, Apply, then save.
    {
      const { rec, done } = scene("08c-planning-ajustar");
      const adjust = ".lt-chart-import-backdrop";
      for (let i = 0; i < 20 && !(await rectOf(adjust)); i++) await rec.hold(0.5);
      if (await rectOf(adjust)) {
        await rec.zoomTo(".lt-chart-import-backdrop .lt-settings-modal", { margin: 30, maxZoom: 1.4 });
        await rec.hold(3);
        await runInPage(() =>
          document.querySelector(".lt-chart-import-backdrop .lt-settings-modal-body")?.scrollBy({ top: 360, behavior: "smooth" }),
        );
        for (let i = 0; i < 20; i++) await rec.frame(1 / 15);
        await rec.hold(2);
        await rec.click(".lt-chart-import-backdrop .lt-inline-actions .is-primary", 1200);
      } else {
        console.log("[release-video] 08c: no adjust dialog");
      }
      if (await rectOf(".lt-chart-editor")) {
        await rec.zoomTo(".lt-chart-editor", { margin: 30, maxZoom: 1.4 });
        await rec.hold(3);
        await rec.click(".lt-chart-editor-actions .is-primary", 1200);
      }
      await rec.zoomOut(500);
      await AppPage.resetShell();
      await done();
    }

    // 09 — prepared pitch: the setting, +2, Aplicar, the preparation.
    {
      const { rec, done } = scene("09-tono");
      await setPreparedPitch(rec, true);
      const band = await songBand();
      await rec.clickAt({ x: Math.max(band.x, 0) + 260, y: band.y + band.h / 2 }, 600);
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 900);
      const up = `button[aria-label*="${L("Subir un semitono")}"]`;
      if (await rectOf(up)) {
        await rec.zoomTo(up, { margin: 200, maxZoom: 1.6 });
        await rec.click(up, 500);
        await rec.click(up, 900);
      }
      await rec.zoomOut(400);
      if (await rectOf("button.lt-pending-pitch-apply")) {
        await rec.moveTo("button.lt-pending-pitch-apply", 600);
        await rec.hold(0.8);
        await rec.click("button.lt-pending-pitch-apply", 600);
      } else {
        console.log("[release-video] 09: no Aplicar button");
      }
      await rec.key("Escape", 400);
      // The whole preparation is recorded; the middle is cut by hand before compose.
      const indicator = ".lt-pitch-prep-indicator";
      for (let i = 0; i < 8 && !(await rectOf(indicator)); i++) await rec.hold(0.5);
      if (await rectOf(indicator)) await rec.zoomTo(indicator, { margin: 200, maxZoom: 1.6 });
      for (let i = 0; i < 900 && (await rectOf(indicator)); i++) await rec.hold(1);
      await rec.zoomOut(400);
      await invoke("seek_transport", { positionSeconds: chorus.startSeconds });
      await invoke("play_transport");
      await rec.realtimeWithAudio(4000, loopback);
      await invoke("stop_transport");
      await done();
    }

    // 10 — select a clip, drag its fade in, its curve, then the fade out.
    {
      const { rec, done } = scene("10-fades");
      const song = await firstSong();
      // About 40 s of the song's start on the page, so the fades are wide.
      const zoom = 1500 / (40 * 18);
      await setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, song.startSeconds * zoom * 18 - 200) });
      const view = await AppPage.songView();
      const piano = view?.tracks.find((t) => /piano/i.test(t.name));
      const clip = piano && view?.clips.find((c) => c.trackId === piano.id);
      if (!piano || !clip) throw new Error("10: no piano clip");
      const row = await laneRow(piano.id);
      const left = await xAt(clip.timelineStartSeconds);
      const mid = { x: left + 300, y: row.y + row.h / 2 };
      await rec.zoomTo({ x: left - 60, y: row.y - 120, w: 900, h: row.h + 240 }, { margin: 0, maxZoom: 1.8 });
      await rec.clickAt(mid, 700);
      const corner = { x: left + 3, y: row.y + 5 };
      await rec.dragToCdp({ x: left + 260, y: row.y + 5 }, 1300, { from: corner });
      await rec.hold(0.8);
      const dot = { x: left + 130, y: row.y + row.h / 2 };
      await rec.dragToCdp({ x: left + 90, y: row.y + row.h * 0.2 }, 1100, { from: dot });
      await rec.hold(1.2);
      await rec.zoomOut(500);
      // The fade out: the clip's end.
      const end = clip.timelineStartSeconds + clip.durationSeconds;
      await setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, end * zoom * 18 - 1300) });
      const row2 = await laneRow(piano.id);
      const right = await xAt(end);
      await rec.zoomTo({ x: right - 840, y: row2.y - 120, w: 900, h: row2.h + 240 }, { margin: 0, maxZoom: 1.8 });
      await rec.dragToCdp({ x: right - 260, y: row2.y + 5 }, 1300, { from: { x: right - 3, y: row2.y + 5 } });
      await rec.hold(1.5);
      await rec.zoomOut(500);
      await done();
    }

    // 11 — Alt+drag a marker: a copy stays where it lands.
    {
      const { rec, done } = scene("11-copiar");
      await fitSong();
      const bridge = await markerNamed(/puente/i);
      const hotspot = await runInPage((name: string) => {
        document.querySelectorAll('[data-guide="rv-marker"]').forEach((el) => el.removeAttribute("data-guide"));
        const el = Array.from(document.querySelectorAll(".lt-marker-hotspot")).find(
          (e) => (e.textContent ?? "").trim().startsWith(name) && e.getBoundingClientRect().width > 0,
        );
        if (!el) return null;
        el.setAttribute("data-guide", "rv-marker");
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(14, r.width / 2), y: r.top + r.height / 2 };
      }, bridge.name);
      if (hotspot) {
        await rec.zoomTo({ x: hotspot.x - 300, y: hotspot.y - 60, w: 900, h: 320 }, { margin: 0, maxZoom: 1.8 });
        await rec.hold(1);
        // CDP modifier bit 1 = Alt.
        await rec.dragToCdp({ x: hotspot.x + 220, y: hotspot.y }, 1400, { from: hotspot, modifiers: 1 });
        await rec.hold(2.5);
        await rec.zoomOut(500);
      } else {
        console.log("[release-video] 11: no bridge marker hotspot");
      }
      await done();
    }

    // 12 — solo two tracks, clear them at once, then «Fade in y reproducir».
    {
      const { rec, done } = scene("12-mezclador");
      for (const name of ["Drums", "Bass"]) {
        if (await trackHeader(name)) await rec.click('[data-guide="rv-header"] .lt-track-toggle-solo', 500);
      }
      await rec.zoomTo("button.lt-clear-solo", { margin: 220, maxZoom: 1.7 });
      await rec.moveTo("button.lt-clear-solo", 600);
      await rec.hold(1);
      await rec.click("button.lt-clear-solo", 900);
      await rec.zoomOut(500);
      await invoke("seek_transport", { positionSeconds: chorus.startSeconds });
      await rec.zoomTo("button.lt-fade-stop", { margin: 260, maxZoom: 1.7 });
      await rec.moveTo("button.lt-fade-stop", 600);
      await rec.hold(1.2);
      await rec.click("button.lt-fade-stop", 100);
      await rec.realtimeWithAudio(6000, loopback);
      await rec.zoomOut(500);
      await invoke("stop_transport");
      await done();
    }

    // 14 — fixes card (narrated only as a whole).
    {
      const { rec, done } = scene("14-correcciones");
      await removeTitleCard();
      await listCard(TITLES.fixes, FIXES);
      await rec.hold(Math.max(8, durations["14-correcciones"] ?? 8));
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

    // 13 — on a phone, recorded LAST (see the header): select a track › EQ,
    // then the Rhythm panel.
    {
      await toPhone();
      await browser.pause(1500);
      const rec = new Recorder(cdp, "13-movil", { x: 0, y: 0, w: PHONE.w, h: PHONE.h }, scenesDir,
        { x: PHONE.w * 0.7, y: PHONE.h * 0.6 },
        { width: 1920, height: Math.round((1920 * PHONE.h) / PHONE.w / 2) * 2, dpr: PHONE.dpr, viewport: { w: PHONE.w, h: PHONE.h } });
      const record = only.length === 0 || only.includes("13-movil");
      console.log("[release-video] scene 13-movil");
      await rec.hold(1);
      if (await trackHeader("Drums")) {
        // A real touch: in the phone layout a mouse click does not select the track.
        const name = await rectOf('[data-guide="rv-header"] .lt-track-title-row strong');
        if (name) {
          const at = { x: name.x + name.w / 2, y: name.y + name.h / 2 };
          rec.cursor = at;
          await rec.hold(0.4);
          await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
          await browser.pause(80);
          await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await rec.hold(1);
        }
        const eq = "button.lt-track-eq-button.lt-mobile-selection-action";
        if (await rectOf(eq)) {
          await rec.click(eq, 1500);
          await rec.hold(2.2);
          if (await rectOf(".lt-eq-close")) await rec.click(".lt-eq-close", 800);
        } else {
          console.log("[release-video] 13: no EQ in the selection bar");
        }
      }
      if (await rectOf("button.lt-rhythm-button")) {
        await rec.click("button.lt-rhythm-button", 1500);
        await rec.hold(2.5);
      } else {
        console.log("[release-video] 13: no Rhythm button on the phone");
      }
      await rec.holdUntil((durations["13-movil"] ?? 7) + 0.7);
      if (record) {
        await rec.encode();
        letterbox("13-movil");
      }
    }

    // 13b — the phone turns upright for the lyrics editor. The desktop app
    // cannot rotate, so the page is given a portrait phone viewport while the
    // editor is open, as the phone does (usePortraitWhileOpen).
    {
      await runInPage(() => (window as unknown as { __ltE2E: { setViewMode: (m: string) => void } }).__ltE2E.setViewMode("live"));
      await browser.pause(1500);
      const edit = `button[aria-label="${L("Editar letra y sincronía")}"]`;
      if (await rectOf(edit)) {
        await $(edit).click();
        await browser.pause(800);
      } else {
        console.log("[release-video] 13b: no lyrics edit button in Live");
      }
      const PORTRAIT = { w: 412, h: 915 };
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: PORTRAIT.w, height: PORTRAIT.h, deviceScaleFactor: PHONE.dpr, mobile: true,
        screenOrientation: { type: "portraitPrimary", angle: 0 },
      });
      await browser.pause(1500);
      const outH = 1080;
      const outW = Math.round((outH * PORTRAIT.w) / PORTRAIT.h / 2) * 2;
      const rec = new Recorder(cdp, "13b-movil-vertical", { x: 0, y: 0, w: PORTRAIT.w, h: PORTRAIT.h }, scenesDir,
        { x: PORTRAIT.w * 0.6, y: PORTRAIT.h * 0.5 },
        { width: outW, height: outH, dpr: PHONE.dpr, viewport: { w: PORTRAIT.w, h: PORTRAIT.h } });
      const record = only.length === 0 || only.includes("13b-movil-vertical");
      console.log("[release-video] scene 13b-movil-vertical");
      await rec.hold(1.2);
      const area = ".lt-chart-editor-text textarea";
      if (await rectOf(area)) {
        await rec.moveTo(area, 700);
        await rec.hold(1);
        await runInPage((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "start", behavior: "smooth" }), area);
        for (let i = 0; i < 20; i++) await rec.frame(1 / 15);
      }
      await rec.holdUntil((durations["13b-movil-vertical"] ?? 5) + 0.7);
      if (record) {
        await rec.encode();
        // Upright clip in the middle of a 16:9 frame.
        const mp4 = path.join(scenesDir, "13b-movil-vertical.mp4");
        const out = path.join(scenesDir, "13b-movil-vertical.169.mp4");
        execFileSync("ffmpeg", [
          "-y", "-loglevel", "error", "-i", mp4,
          "-vf", "scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:black,setsar=1",
          "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
        ]);
        rmSync(mp4);
        renameSync(out, mp4);
      }
    }
  });
});
