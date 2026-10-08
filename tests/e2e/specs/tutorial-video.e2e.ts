import { browser, $ } from "@wdio/globals";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { rectOf, runInPage } from "../utils/annotate.js";
import { useAppLocale, useVoiceGuideLanguage } from "../utils/appLocale.js";
import { Recorder, type VideoOptions } from "../utils/record.js";
import { L, UI_LANG } from "../utils/uiText.js";

/**
 * Not a test — records the scenes of the narrated "first song" tutorial
 * (scripts/tutorial-video/). Each scene is one clip, at least as long as its
 * narration (durations.json from tts.mjs); compose.mjs joins them with the
 * voice, the app's own audio and subtitles.
 *
 *   LT_TUTORIALVIDEO=1 LT_TUTORIAL_DIR=<dir with narration/> LT_STEMS_DIR=<stems> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/tutorial-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * Two scenes drive the REAL desktop (system save dialog, File Explorer drag)
 * and record it with ffmpeg: the mouse and keyboard move by themselves.
 * Playback moments record the speaker output (loopback.py) so the click, the
 * voice guide and the song are heard.
 *
 * Optional LT_TUTORIAL_SCENES=04-renombrar,08-tempo re-encodes only those
 * scenes (the rest still run, so the app reaches the right state).
 *
 * LT_GUIDESHOTS_LANG=en records the English video: the app and the voice
 * guide in English (both put back afterwards), labels from the app's own
 * translation (uiText.ts). The Windows dialog and Explorer stay as they are.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? ".");
const stemsDir = process.env.LT_STEMS_DIR ?? "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const SONG = "Único Dios";
const STEMS = ["Bateria.wav", "BajoSnt.wav", "Piano.wav", "Tecla 1.wav", "Vocales.wav", "Click.wav", "Guia.wav"];
// Where the session and the stems live on camera: a short path with no user
// name in it (the dialog and Explorer show it).
const SHOWS = "C:\\Shows";
const SESSION_NAME = UI_LANG === "en" ? "Sunday" : "Domingo";
const FOLDER_NAME = UI_LANG === "en" ? "Monitors" : "Monitores";
const TITLES =
  UI_LANG === "en"
    ? { intro: ["Your first song in LibreTracks", "From stems to the stage, step by step"], end: ["libretracks.com", "The complete guide, button by button"] }
    : { intro: ["Tu primera canción en LibreTracks", "De los stems al directo, paso a paso"], end: ["libretracks.com", "La guía completa, botón a botón"] };
const restores: Array<() => Promise<void>> = [];
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");

const tour = (id: string) => `[data-lt-tour="${id}"]`;
const W = 1920;
const H = 1080;
let video: VideoOptions;
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

/** data-guide on the track header whose name is exactly `name`. */
async function headerOf(name: string, tagName: string) {
  const ok = await runInPage(
    (n: string, t: string) => {
      document.querySelectorAll(`[data-guide="${t}"]`).forEach((el) => el.removeAttribute("data-guide"));
      const header = Array.from(document.querySelectorAll(".lt-track-header")).find(
        (h) => (h.querySelector(".lt-track-title-row strong")?.textContent ?? "").trim() === n,
      );
      header?.setAttribute("data-guide", t);
      return Boolean(header);
    },
    name,
    tagName,
  );
  if (!ok) throw new Error(`no track header "${name}"`);
  return `[data-guide="${tagName}"]`;
}

/** A real click with Ctrl held: multi-selection reads the real modifier. */
async function ctrlClick(selector: string) {
  const r = await rectOf(selector);
  if (!r) throw new Error(`ctrlClick: ${selector} not visible`);
  await browser.action("key").down("\uE009").perform(true);
  await browser
    .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
    .move({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform(true);
  await browser.action("key").up("\uE009").perform();
  await browser.pause(300);
}

/** Screen point (for OS input) of a spot of an element, with the page unemulated. */
async function screenPointOf(selector: string, fx = 0.5, fy = 0.5) {
  return runInPage(
    (sel: string, x: number, y: number) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      if (!r) return null;
      const side = (window.outerWidth - window.innerWidth) / 2;
      const top = window.outerHeight - window.innerHeight - side;
      return {
        x: Math.round(window.screenX + side + r.left + r.width * x),
        y: Math.round(window.screenY + top + r.top + r.height * y),
      };
    },
    selector,
    fx,
    fy,
  );
}

/** Records the desktop live (gdigrab) while `action` runs. */
async function recordDesktop(id: string, action: () => Promise<void>) {
  const out = path.join(scenesDir, `${id}.raw.mp4`);
  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "30", "-offset_x", "0", "-offset_y", "0",
      "-video_size", "1920x1080", "-draw_mouse", "1", "-i", "desktop",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  await browser.pause(1200);
  await action();
  ffmpeg.stdin?.write("q");
  await new Promise((resolve) => ffmpeg.on("exit", resolve));
}

async function emulate1080p() {
  await browser.setWindowRect(0, 0, 1940, 1140);
  await browser.pause(800);
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await browser.pause(1500);
}

function scene(id: string) {
  const rec = new Recorder(cdp, id, { x: 0, y: 0, w: W, h: H }, scenesDir, { x: W * 0.62, y: H * 0.7 }, video);
  const record = only.length === 0 || only.includes(id);
  const narration = durations[id] ?? 0;
  console.log(`[tutorial] scene ${id}`);
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

async function removeTitleCard() {
  await runInPage(() => document.getElementById("lt-tutorial-title")?.remove());
}

describe("first-song tutorial video", function () {
  before(async function () {
    if (process.env.LT_TUTORIALVIDEO !== "1") this.skip();
    if (!stemsDir) throw new Error("LT_STEMS_DIR is required");
    durations = JSON.parse(readFileSync(path.join(tutorialDir, "narration", "durations.json"), "utf8"));
    scenesDir = path.join(tutorialDir, "scenes");
    mkdirSync(scenesDir, { recursive: true });
    await AppPage.waitUntilBooted();
    if (UI_LANG === "en") {
      restores.push(await useAppLocale("en"));
      await AppPage.waitUntilBooted();
      restores.push(await useVoiceGuideLanguage("en"));
    }
    await emulate1080p();
    video = { width: W, height: H, dpr: 2, viewport: { w: W, h: H } };
  });

  after(async () => {
    for (const restore of restores.reverse()) await restore();
  });

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
    const view = async () => (await AppPage.songView())!;
    const ps = (script: string) => path.join(repoRoot, "scripts", "tutorial-video", script);
    const powershell = (script: string, args: string[]) =>
      execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps(script), ...args], { stdio: "inherit" });
    const songBar = ".lt-region-hotspot";
    const promptType = async (rec: Recorder, text: string) => {
      await (await $("#lt-dialog-input")).waitForDisplayed({ timeout: 5000 });
      await browser.keys(["Control", "a"]);
      await browser.keys(["Control"]);
      await rec.type(text);
      await rec.hold(0.3);
      await rec.key("Enter", 800);
    };

    // The stems folder, and no leftover session from a previous run.
    rmSync(path.join(SHOWS, SESSION_NAME), { recursive: true, force: true });
    const stems = path.join(SHOWS, "Stems", SONG);
    rmSync(stems, { recursive: true, force: true });
    mkdirSync(stems, { recursive: true });
    for (const f of STEMS) copyFileSync(path.join(stemsDir, f), path.join(stems, f));
    for (const f of STEMS) if (!existsSync(path.join(stems, f))) throw new Error(`missing stem ${f}`);
    await browser.pause(1500);

    // 01 — title over the start screen.
    {
      const { rec, done } = scene("01-intro");
      await titleCard(TITLES.intro[0], TITLES.intro[1]);
      await rec.hold(durations["01-intro"] - 2.2);
      await removeTitleCard();
      await rec.hold(1.5);
      await done();
    }

    // 02 — create the session through the REAL system dialog: the desktop is
    // recorded while os-create.ps1 clicks Create and types folder and name.
    {
      console.log("[tutorial] scene 02-crear");
      await cdp("Emulation.clearDeviceMetricsOverride");
      await browser.setWindowRect(0, 0, 1920, 1040);
      await browser.pause(1800);
      powershell("os-create.ps1", ["-HideConsolesOnly"]);
      await browser.pause(500);
      const create = await screenPointOf(tour("landing-create"));
      if (!create) throw new Error("02-crear: no Create button");
      await recordDesktop("02-crear", async () => {
        powershell("os-create.ps1", ["-ClickX", String(create.x), "-ClickY", String(create.y), "-Folder", SHOWS, "-Name", SESSION_NAME]);
        await (await AppPage.timelineShell).waitForDisplayed({ timeout: 60_000 });
        await browser.pause(2500);
      });
    }

    // 03 — drag the stems from File Explorer onto the timeline (real OS drag).
    {
      console.log("[tutorial] scene 03-arrastrar");
      await browser.setWindowRect(700, 0, 1220, 1040);
      await browser.pause(2000);
      const target = await screenPointOf(".lt-timeline-canvas-pane", 0, 0);
      if (!target) throw new Error("03-arrastrar: no timeline");
      const psArgs = ["-Folder", stems, "-ExplorerRect", "0,0,710,1040", "-DropX", String(target.x + 40), "-DropY", String(target.y + 180)];
      powershell("os-drag.ps1", [...psArgs, "-Phase", "open"]);
      await recordDesktop("03-arrastrar", async () => {
        // Explorer stays open until the recording stops: closing it on camera
        // uncovers whatever window sits behind it.
        powershell("os-drag.ps1", [...psArgs, "-Phase", "drag", "-KeepExplorer"]);
        await browser.pause(6000);
      });
      powershell("os-drag.ps1", [...psArgs, "-Phase", "close"]);
      const song = await view();
      if (song.tracks.length < STEMS.length) throw new Error(`03-arrastrar: ${song.tracks.length} tracks`);
      await emulate1080p();
    }

    // Click and voice guide persist between runs: start with both off, so the
    // scenes really switch them ON on camera.
    for (const id of ["topbar-metronome", "topbar-voice-guide"]) {
      const toggle = await $(`${tour(id)} > button:nth-of-type(1)`);
      if (((await toggle.getAttribute("class")) ?? "").includes("is-active")) {
        await toggle.click();
        await browser.pause(400);
      }
    }

    // 04 — rename the song.
    {
      const { rec, done } = scene("04-renombrar");
      const ruler = await rectOf(tour("timeline-ruler"));
      if (!ruler) throw new Error("no ruler");
      await rec.zoomTo({ x: ruler.x, y: ruler.y - 30, w: 900, h: 260 }, { margin: 30 });
      await rec.rightClick(songBar);
      await rec.click(await tagByText(".lt-context-menu button", L("Renombrar Cancion"), "mi"), 500);
      await promptType(rec, SONG);
      if ((await view()).regions[0]?.name !== SONG) throw new Error("04-renombrar: not renamed");
      await rec.hold(0.8);
      await done();
    }

    // 05 — the song's key.
    {
      const { rec, done } = scene("05-nota");
      await rec.rightClick(songBar);
      await rec.click(await tagByText(".lt-context-menu button", L("Nota de la cancion"), "mi"), 600);
      await rec.click(await tagByText(".lt-context-menu button", "A#", "key", true), 600);
      if ((await view()).regions[0]?.key !== "A#") throw new Error("05-nota: key not set");
      await rec.zoomTo(songBar, { margin: 120 });
      await rec.hold(1.5);
      await done();
    }

    // 06 — the same audio is in the Library.
    {
      const { rec, done } = scene("06-biblioteca");
      await rec.zoomOut(600);
      await rec.zoomTo(tour("side-nav-library"), { margin: 300 });
      await rec.click(tour("side-nav-library"), 900);
      await rec.zoomTo(".lt-library-panel", { margin: 60 });
      await rec.moveTo(tour("library-new-folder"), 800);
      await rec.hold(2.5);
      await rec.zoomOut(700);
      await rec.click(tour("side-nav-library"), 800);
      await done();
    }

    // 07 — a track folder for click and guide.
    {
      const { rec, done } = scene("07-carpetas");
      const headers = await rectOf(tour("track-headers"));
      if (!headers) throw new Error("no headers");
      await rec.zoomTo({ x: headers.x, y: headers.y, w: 900, h: 560 }, { margin: 20 });
      const click = await headerOf("Click", "h-click");
      const guia = await headerOf("Guia", "h-guia");
      await rec.click(`${click} .lt-track-title-row strong`, 300);
      await rec.moveTo(`${guia} .lt-track-title-row strong`, 500);
      await ctrlClick(`${guia} .lt-track-title-row strong`);
      await rec.hold(0.5);
      await rec.rightClick(`${guia} .lt-track-title-row strong`);
      await rec.click(await tagByText(".lt-context-menu button", L("Mover a carpeta"), "mi"), 600);
      await rec.click(await tagByText(".lt-context-menu button", L("Carpeta nueva"), "mi2"), 600);
      await promptType(rec, FOLDER_NAME);
      const tracks = (await view()).tracks;
      const folder = tracks.find((t) => t.name === FOLDER_NAME);
      const clickTrack = tracks.find((t) => t.name === "Click");
      if (!folder || clickTrack?.parentTrackId !== folder.id) throw new Error("07-carpetas: folder not made");
      const folderHead = await headerOf(FOLDER_NAME, "h-mon");
      await rec.click(`${folderHead} .lt-folder-toggle`, 700);
      await rec.hold(1.2);
      await rec.click(`${folderHead} .lt-folder-toggle`, 700);
      await done();
    }

    // 08 — tempo and click, heard.
    {
      const { rec, done } = scene("08-tempo");
      await rec.zoomOut(600);
      await rec.zoomTo(tour("topbar-tempo"), { margin: 200 });
      await rec.click(".lt-tempo-input", 300);
      await browser.keys(["Control", "a"]);
      await browser.keys(["Control"]);
      await rec.type("128");
      await rec.key("Enter", 700);
      await rec.zoomTo(tour("topbar-metronome"), { margin: 220 });
      await rec.click(`${tour("topbar-metronome")} > button:nth-of-type(1)`, 600);
      await rec.zoomOut(700);
      await rec.key("Home", 300);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(6500, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 500);
      await done();
    }

    // 09 — the song's master.
    {
      const { rec, done } = scene("09-master");
      await rec.click(songBar, 500);
      await rec.zoomTo(tour("toolbar-master"), { margin: 260 });
      await rec.click(`${tour("toolbar-master")} .lt-control-popover-trigger`, 600);
      const sr = await rectOf(".lt-control-popover-panel input[type='range']");
      if (sr) {
        await rec.dragTo({ x: sr.x + sr.w * 0.6, y: sr.y + sr.h / 2 }, 900, { from: { x: sr.x + sr.w * 0.78, y: sr.y + sr.h / 2 } });
      }
      await rec.hold(1.5);
      await rec.click(`${tour("toolbar-master")} .lt-control-popover-trigger`, 500);
      await done();
    }

    // 10 — transpose without warp: higher AND faster, the song gets shorter.
    {
      const { rec, done } = scene("10-tono");
      const before = (await view()).regions[0];
      await rec.zoomOut(600);
      await rec.click(songBar, 400);
      await rec.zoomTo(tour("toolbar-transpose"), { margin: 260 });
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 600);
      const up = `button[aria-label="${L("Subir un semitono la region seleccionada")}"]`;
      await rec.click(up, 900);
      await rec.click(up, 1200);
      await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`, 500);
      await rec.zoomOut(800);
      await rec.hold(1.5);
      const after = (await view()).regions[0];
      if (after.transposeSemitones !== 2) throw new Error("10-tono: not transposed");
      if (after.endSeconds - after.startSeconds >= before.endSeconds - before.startSeconds - 1) {
        throw new Error("10-tono: the song did not get shorter");
      }
      await rec.key("Home", 400);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(5000, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 500);
      await done();
    }

    // 11 — warp on: same key, original speed; T off on click and guide.
    {
      const { rec, done } = scene("11-warp");
      await rec.click(songBar, 400);
      await rec.zoomTo(tour("toolbar-warp"), { margin: 260 });
      await rec.click(`${tour("toolbar-warp")} .lt-control-popover-trigger`, 600);
      await rec.click(`button[aria-label="${L("Activar warp en la region seleccionada")}"]`, 1500);
      await rec.click(`${tour("toolbar-warp")} .lt-control-popover-trigger`, 500);
      await rec.zoomOut(800);
      await rec.hold(1);
      if (!(await view()).regions[0].warpEnabled) throw new Error("11-warp: warp not on");
      const headers = await rectOf(tour("track-headers"));
      if (headers) await rec.zoomTo({ x: headers.x, y: headers.y, w: 900, h: 560 }, { margin: 20 });
      for (const name of ["Click", "Guia"]) {
        const h = await headerOf(name, `t-${name}`);
        await rec.click(`${h} .lt-track-toggle-transpose`, 500);
      }
      await rec.zoomOut(700);
      await rec.key("Home", 400);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(5000, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 500);
      await done();
    }

    // Markers are placed relative to the song bar as drawn now.
    const addMarker = async (rec: Recorder, x: number, group: "Secciones" | "Avisos", kind: string) => {
      const ruler = await rectOf(tour("timeline-ruler"));
      if (!ruler) throw new Error("no ruler");
      const before = (await view()).sectionMarkers.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        await rec.rightClick({ x, y: ruler.y + 30 });
        await rec.click(await tagByText(".lt-context-menu button", L("Crear Marca"), "m1"), 400);
        await rec.click(await tagByText(".lt-context-menu button", L(group), "m2"), 400);
        await rec.click(await tagByText(".lt-context-menu button", L(kind), "m3", true), 400);
        await browser.pause(400);
        if (await rectOf(".lt-context-menu")) {
          await rec.click(await tagByText(".lt-context-menu button", L(kind), "m4", true), 400);
        }
        await browser.pause(400);
        if ((await view()).sectionMarkers.length > before) return;
        await browser.keys(["Escape"]);
      }
      throw new Error(`marker ${kind} was not created`);
    };

    // 12 — section markers.
    {
      const { rec, done } = scene("12-secciones");
      const ruler = await rectOf(tour("timeline-ruler"));
      const bar = await rectOf(songBar);
      if (!ruler || !bar) throw new Error("no ruler");
      // Tall enough for both marker rows (cues sit above the sections).
      await rec.zoomTo({ x: ruler.x, y: ruler.y - 70, w: Math.min(1200, bar.x + bar.w - ruler.x + 40), h: 420 }, { margin: 30 });
      await addMarker(rec, bar.x + 6, "Secciones", "Intro");
      await addMarker(rec, bar.x + bar.w * 0.25, "Secciones", "Verso");
      await addMarker(rec, bar.x + bar.w * 0.5, "Secciones", "Coro");
      await rec.hold(0.8);
      await done();
    }

    // 13 — a cue, and changing a marker's type by dragging it between rows.
    {
      const { rec, done } = scene("13-avisos");
      const bar = await rectOf(songBar);
      const ruler13 = await rectOf(tour("timeline-ruler"));
      if (!bar || !ruler13) throw new Error("no bar");
      await rec.zoomTo({ x: ruler13.x, y: ruler13.y - 70, w: Math.min(1200, bar.x + bar.w - ruler13.x + 40), h: 420 }, { margin: 30, ms: 10 });
      await addMarker(rec, bar.x + bar.w * 0.37, "Avisos", "Entra Batería");
      const cue = await rectOf(await tagByText(".lt-marker-hotspot", L("Entra Batería"), "cue"));
      const verso = await tagByText(".lt-marker-hotspot", L("Verso"), "verso");
      const vb = await rectOf(verso);
      if (!cue || !vb) throw new Error("13-avisos: markers not found");
      await rec.dragTo({ x: vb.x + vb.w / 2, y: cue.y + cue.h / 2 }, 900, { from: verso });
      await rec.hold(1.2);
      await rec.dragTo({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 900, { from: { x: vb.x + vb.w / 2, y: cue.y + cue.h / 2 } });
      await rec.hold(1);
      await done();
    }

    // 14 — voice guide on, heard announcing the chorus.
    {
      const { rec, done } = scene("14-guia");
      await rec.zoomTo(tour("topbar-voice-guide"), { margin: 220 });
      await rec.click(`${tour("topbar-voice-guide")} > button:nth-of-type(1)`, 700);
      await rec.zoomOut(700);
      // Seek a little over two bars before the chorus by clicking the ruler.
      const song = await view();
      const coro = song.sectionMarkers.find((m) => m.name.toLowerCase().includes(L("Coro").toLowerCase()));
      const cam = await runInPage(() =>
        (window as unknown as { __ltE2E: { getTimelineView: () => { cameraX: number; zoomLevel: number } } }).__ltE2E.getTimelineView(),
      );
      const ruler = await rectOf(tour("timeline-ruler"));
      if (coro && ruler) {
        const barSeconds = (60 / 128) * 4;
        const at = Math.max(0, coro.startSeconds - 2.4 * barSeconds);
        const x = ruler.x + at * cam.zoomLevel * 18 - cam.cameraX;
        await rec.clickAt({ x, y: ruler.y + 30 }, 500);
      }
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(7500, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 500);
      await done();
    }

    // 15 — outputs, on the Monitores folder.
    {
      const { rec, done } = scene("15-salidas");
      const header = await headerOf(FOLDER_NAME, "h-mon");
      await rec.zoomTo(header, { margin: 180 });
      await rec.click(`${header} .lt-audio-route-trigger`, 700);
      await rec.hold(2.5);
      await browser.keys(["Escape"]);
      await rec.hold(0.5);
      await done();
    }

    // 16 — Live view, play and jump to the chorus.
    {
      const { rec, done } = scene("16-live");
      await rec.zoomOut(600);
      await rec.key("Home", 300);
      await rec.key("Tab", 900);
      await rec.key("Tab", 1200);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(2500, loopback);
      const chorus = await tagByText(".lt-live-cue-grid button, .lt-live-cue-grid [role='button']", L("Coro"), "chorus");
      await rec.zoomTo(".lt-live-cue-panel", { margin: 40, maxZoom: 1.4 });
      await rec.click(chorus, 100);
      await rec.realtimeWithAudio(6000, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 400);
      await done();
    }

    // 17 — save and close.
    {
      const { rec, done } = scene("17-final");
      await rec.zoomOut(600);
      await browser.keys(["Control", "s"]);
      await browser.keys(["Control"]);
      await rec.hold(1.5);
      await titleCard(TITLES.end[0], TITLES.end[1]);
      await rec.hold(3);
      await done();
      await removeTitleCard();
    }
  });
});
