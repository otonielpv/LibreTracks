import { browser, $ } from "@wdio/globals";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { rectOf, runInPage } from "../utils/annotate.js";
import { Recorder, type VideoOptions } from "../utils/record.js";

/**
 * Not a test — records the scenes of the narrated "first song" tutorial
 * (scripts/tutorial-video/). Each scene is one clip, at least as long as its
 * narration (durations.json from tts.mjs); compose.mjs joins them with the
 * voice and subtitles.
 *
 *   LT_TUTORIALVIDEO=1 LT_TUTORIAL_DIR=<dir with narration/> LT_STEMS_DIR=<stems> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/tutorial-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * Optional LT_TUTORIAL_SCENES=03-importar,05-cancion to re-record some scenes
 * (the ones before still run, so the app reaches the right state, but are not
 * re-encoded).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? ".");
const stemsDir = process.env.LT_STEMS_DIR ?? "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const SONG = "Único Dios";
const STEMS = ["Bateria.wav", "BajoSnt.wav", "Piano.wav", "Tecla 1.wav", "Vocales.wav", "Click.wav", "Guia.wav"];

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

function scene(id: string) {
  const rec = new Recorder(cdp, id, { x: 0, y: 0, w: W, h: H }, scenesDir, { x: W * 0.62, y: H * 0.7 }, video);
  const record = only.length === 0 || only.includes(id);
  const narration = durations[id] ?? 0;
  return {
    rec,
    /** Pads to the narration (plus a breath) and writes the clip. */
    async done() {
      await rec.holdUntil(narration + 0.7);
      if (record) await rec.encode();
    },
  };
}

/** Big centred title over the app, for the opening. */
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
    if (!tutorialDir || !stemsDir) throw new Error("LT_TUTORIAL_DIR and LT_STEMS_DIR are required");
    durations = JSON.parse(readFileSync(path.join(tutorialDir, "narration", "durations.json"), "utf8"));
    scenesDir = path.join(tutorialDir, "scenes");
    mkdirSync(scenesDir, { recursive: true });
    await AppPage.waitUntilBooted();
    await browser.setWindowSize(1940, 1140);
    await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    video = { width: W, height: H, dpr: 2, viewport: { w: W, h: H } };
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
    this.timeout(30 * 60_000);
    // A clean place for the session and a "folder of stems" to import from.
    const work = path.join(os.tmpdir(), "lt-tutorial");
    rmSync(work, { recursive: true, force: true });
    const stems = path.join(work, SONG);
    mkdirSync(stems, { recursive: true });
    const stemPaths = STEMS.map((f) => {
      const to = path.join(stems, f);
      copyFileSync(path.join(stemsDir, f), to);
      return to;
    });
    for (const p of stemPaths) if (!existsSync(p)) throw new Error(`missing stem ${p}`);
    await browser.pause(1500);

    // 01 — title over the start screen.
    {
      const { rec, done } = scene("01-intro");
      console.log("[tutorial] scene 01-intro");
      await titleCard("Tu primera canción en LibreTracks", "De los stems al directo");
      await rec.hold(durations["01-intro"] - 2.2);
      await removeTitleCard();
      await rec.hold(1.5);
      await done();
    }

    // 02 — create the session. The save dialog is the system's and cannot be
    // driven, so the click is shown and the session is created by the same
    // handler the dialog would have called.
    {
      const { rec, done } = scene("02-crear");
      console.log("[tutorial] scene 02-crear");
      await rec.hold(1.2);
      await rec.zoomTo(tour("landing-create"), { margin: 260 });
      await rec.moveTo(tour("landing-create"), 800);
      await rec.hold(0.6);
      await AppPage.createSession("Mi repertorio", work);
      await browser.pause(1500);
      await rec.zoomOut(10);
      await rec.hold(2);
      await done();
    }

    // 03 — drag the stems from File Explorer onto the timeline. A real OS
    // drag: the page emulation is lifted, the app sits on the right half of
    // the screen, os-drag.ps1 moves the real mouse and the desktop is
    // recorded live with ffmpeg.
    {
      const id = "03-arrastrar";
      await cdp("Emulation.clearDeviceMetricsOverride");
      await browser.setWindowRect(700, 0, 1220, 1040);
      await browser.pause(2000);
      const target = await runInPage(() => {
        const lanes = document.querySelector(".lt-timeline-canvas-pane") as HTMLElement | null;
        const r = lanes?.getBoundingClientRect();
        const chrome = window.outerHeight - window.innerHeight;
        const side = (window.outerWidth - window.innerWidth) / 2;
        return r
          ? { x: Math.round(window.screenX + side + r.left + 40), y: Math.round(window.screenY + chrome + r.top + 180) }
          : null;
      });
      if (!target) throw new Error(`${id}: no timeline`);
      const ps = path.join(repoRoot, "scripts", "tutorial-video", "os-drag.ps1");
      const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps,
        "-Folder", stems, "-ExplorerRect", "0,0,710,1040", "-DropX", String(target.x), "-DropY", String(target.y)];
      execFileSync("powershell", [...psArgs, "-Phase", "open"], { stdio: "inherit" });
      const out = path.join(scenesDir, `${id}.raw.mp4`);
      const ffmpeg = spawn(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "30", "-offset_x", "0", "-offset_y", "0",
          "-video_size", "1920x1080", "-draw_mouse", "1", "-i", "desktop",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      await browser.pause(1500);
      // Explorer stays open until the recording stops: closing it on camera
      // uncovers whatever window sits behind it.
      execFileSync("powershell", [...psArgs, "-Phase", "drag", "-KeepExplorer"], { stdio: "inherit" });
      await browser.pause(6000); // tracks and waveforms appear
      ffmpeg.stdin?.write("q");
      await new Promise((resolve) => ffmpeg.on("exit", resolve));
      execFileSync("powershell", [...psArgs, "-Phase", "close"], { stdio: "inherit" });
      const song = await AppPage.songView();
      if ((song?.tracks.length ?? 0) < STEMS.length) {
        throw new Error(`${id}: only ${song?.tracks.length ?? 0} tracks after the drop`);
      }
      console.log(`[tutorial] ${id}: ${song?.tracks.length} tracks, ${song?.regions.length} songs`);
      // Back to the emulated 1080p page for the next scenes.
      await browser.setWindowRect(0, 0, 1940, 1140);
      await browser.pause(800);
      await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
      await browser.pause(1500);
    }

    // 04 — the same audio is in the Library.
    {
      const { rec, done } = scene("04-biblioteca");
      console.log("[tutorial] scene 04-biblioteca");
      await rec.hold(0.4);
      await rec.zoomTo(tour("side-nav-library"), { margin: 300 });
      await rec.click(tour("side-nav-library"), 900);
      await rec.zoomTo(".lt-library-panel", { margin: 60 });
      await rec.moveTo(tour("library-new-folder"), 800);
      await rec.hold(2.5);
      await rec.zoomOut(700);
      await rec.click(tour("side-nav-library"), 800);
      await done();
    }

    // Click and voice guide persist in the app's settings between runs: start
    // with both off, so scenes 06 and 08 really switch them ON on camera.
    for (const id of ["topbar-metronome", "topbar-voice-guide"]) {
      const toggle = await $(`${tour(id)} > button:nth-of-type(1)`);
      if (((await toggle.getAttribute("class")) ?? "").includes("is-active")) {
        await toggle.click();
        await browser.pause(400);
      }
    }

    // 06 — tempo and click.
    {
      const { rec, done } = scene("06-tempo");
      console.log("[tutorial] scene 06-tempo");
      await rec.zoomTo(tour("topbar-tempo"), { margin: 200 });
      await rec.click(".lt-tempo-input", 300);
      await browser.keys(["Control", "a"]);
      await browser.keys(["Control"]);
      await rec.type("128");
      await rec.key("Enter", 700);
      await rec.zoomTo(tour("topbar-metronome"), { margin: 220 });
      await rec.click(`${tour("topbar-metronome")} > button:nth-of-type(1)`, 600);
      await rec.zoomOut(700);
      await rec.click('button[aria-label="Reproducir"]', 300);
      await rec.realtime(3500);
      await rec.click('button[aria-label="Detener"]', 500);
      await done();
    }

    // 07 — section markers from the ruler.
    {
      const { rec, done } = scene("07-marcas");
      console.log("[tutorial] scene 07-marcas");
      const ruler = await rectOf(tour("timeline-ruler"));
      if (!ruler) throw new Error("no ruler");
      const songBar = await rectOf(".lt-region-hotspot");
      await rec.zoomTo({ x: ruler.x, y: ruler.y - 40, w: Math.min(1100, (songBar?.x ?? ruler.x) + (songBar?.w ?? 900) - ruler.x), h: 320 }, { margin: 40 });
      const addMarker = async (x: number, kind: string) => {
        console.log(`[tutorial] marker ${kind} at ${x}`);
        await rec.rightClick({ x, y: ruler.y + 30 });
        console.log("[tutorial]  menu open");
        await rec.click(await tagByText(".lt-context-menu button", "Crear Marca", "m1"), 400);
        console.log("[tutorial]  crear marca");
        await rec.click(await tagByText(".lt-context-menu button", "Secciones", "m2"), 400);
        console.log("[tutorial]  secciones");
        await rec.click(await tagByText(".lt-context-menu button", kind, "m3", true), 400);
        console.log("[tutorial]  kind");
        // Kinds with numbered variants open one more menu: take the plain one.
        await browser.pause(400);
        if (await rectOf(".lt-context-menu")) {
          await rec.click(await tagByText(".lt-context-menu button", kind, "m4", true), 400);
        }
        await browser.pause(400);
      };
      const markerCount = async () => (await AppPage.songView())?.sectionMarkers.length ?? 0;
      const addMarkerChecked = async (x: number, kind: string) => {
        const before = await markerCount();
        await addMarker(x, kind);
        if ((await markerCount()) === before) {
          console.log(`[tutorial] ${kind} did not land, retrying`);
          await browser.keys(["Escape"]);
          await addMarker(x, kind);
        }
      };
      const bar = await rectOf(".lt-region-hotspot");
      if (!bar) throw new Error("07-marcas: no song bar");
      await addMarkerChecked(bar.x + 6, "Intro");
      await addMarkerChecked(bar.x + bar.w * 0.3, "Verso");
      await addMarkerChecked(bar.x + bar.w * 0.55, "Coro");
      await rec.hold(0.8);
      const markers = (await AppPage.songView())?.sectionMarkers.length ?? 0;
      if (markers < 3) throw new Error(`07-marcas: ${markers} markers`);
      await done();
    }

    // 08 — voice guide on.
    {
      const { rec, done } = scene("08-guia");
      console.log("[tutorial] scene 08-guia");
      await rec.zoomTo(tour("topbar-voice-guide"), { margin: 220 });
      await rec.click(`${tour("topbar-voice-guide")} > button:nth-of-type(1)`, 700);
      await rec.hold(1.2);
      await done();
    }

    // 09 — outputs: open the Click track's output selector.
    {
      const { rec, done } = scene("09-salidas");
      console.log("[tutorial] scene 09-salidas");
      await rec.zoomOut(700);
      const header = await tagByText(".lt-track-header:not(.is-folder):not(.is-automation)", "Click", "click-header");
      await runInPage((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), header);
      await browser.pause(500);
      await rec.zoomTo(header, { margin: 160 });
      await rec.click(`${header} .lt-audio-route-trigger`, 700);
      await rec.hold(2.5);
      await browser.keys(["Escape"]);
      await rec.hold(0.5);
      await done();
    }

    // 10 — Live view, play and jump to the chorus.
    {
      const { rec, done } = scene("10-live");
      console.log("[tutorial] scene 10-live");
      await rec.zoomOut(600);
      await rec.key("Tab", 900);
      await rec.key("Tab", 1200);
      await rec.click('button[aria-label="Reproducir"]', 300);
      await rec.realtime(2000);
      const chorus = await tagByText(".lt-live-cue-grid button, .lt-live-cue-grid [role='button']", "Coro", "chorus");
      await rec.zoomTo(".lt-live-cue-panel", { margin: 40, maxZoom: 1.4 });
      await rec.click(chorus, 200);
      await rec.realtime(5000);
      await rec.click('button[aria-label="Detener"]', 400);
      await done();
    }

    // 11 — save and close on the Live view.
    {
      const { rec, done } = scene("11-final");
      console.log("[tutorial] scene 11-final");
      await rec.zoomOut(600);
      await browser.keys(["Control", "s"]);
      await browser.keys(["Control"]);
      await rec.hold(1.5);
      await titleCard("libretracks.com", "Guía completa en la web");
      await rec.hold(3);
      await done();
      await removeTitleCard();
    }
  });
});
