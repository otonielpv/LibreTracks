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
 * release's feature; git history keeps the previous ones. This one is 1.17.0:
 * redundancy, arrangements edited block by block, the revamped Remote and
 * «Analizar todas las canciones».
 *
 *   LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-1.17.0 LT_SHOTS_SESSION=<COPY of a real session> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * The session is copied to a temp folder first (the scenes apply an
 * arrangement, delete a clip and write analysis markers); it is
 * «Test [70bpm 4-4]». Script: scripts/tutorial-video/novedades-1.17.0.es.json.
 * The Remote is shown inside the app, in two iframes (phone and tablet sized)
 * pointing at its own Remote server; they are another origin, so the taps in
 * them go by coordinates measured on the Remote at those sizes. The mobile
 * scene is THIS app with the WebView reporting an Android phone, recorded
 * last so the desktop scenes never see the phone emulation.
 *
 * The machine's own settings are touched only to be read: the redundancy
 * PINs, addresses and trusted machines are blurred.
 *
 * Optional LT_TUTORIAL_SCENES=05-arreglo-bloque,09-analizar re-encodes only
 * those scenes (the rest still run, so the app reaches the right state).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.17.0");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-release-video-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
const TITLES = {
  intro: ["Novedades de LibreTracks 1.17.0", "Redundancia, arreglos por bloques, Remote renovado y analizar todas las canciones"],
  end: ["LibreTracks 1.17.0", "Gratis en libretracks.com"],
  fixes: "Y además",
};
/** The «and also» card: improvements and fixes, shown, not narrated one by one. */
const FIXES = [
  "El audio a otra frecuencia que la de tu tarjeta se prepara mucho más rápido",
  "Aviso si no queda espacio en el disco para preparar el audio",
  "«Preparando audio» ya no se queda congelado en sesiones grandes",
  "Un paquete .ltpkg que no cabe en el cursor va al final del setlist",
  "La app vuelve a abrirse aunque otro programa use el puerto del Remote",
  "En Android, abrir archivos de la nube o de un USB ya no congela la app",
  "Los controles de las pistas ya no se ven a través de la pantalla de carga",
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
    // The golden session's songs carry an original saved before their markers
    // were re-analysed: opening the arrangement editor saves it again (1.17.0
    // fix), which this video goes through for real.
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
    const fileMenu = `${tour("topbar-file-menu")} .lt-top-menu-trigger`;
    const openArrangement = async (rec: Recorder) => {
      const band = await songBand();
      await rec.rightClick({ x: Math.max(band.x, 0) + 160, y: band.y + band.h / 2 });
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-context-menu button", L("Arreglo"), "rv-arr", true), 1200);
    };

    await fitSong();
    await invoke("seek_transport", { positionSeconds: (await firstSong()).startSeconds + 8 });
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

    // 02 — Settings › Redundancy: the role, the main's PIN, the backup's address.
    {
      const { rec, done } = scene("02-redundancia");
      const blur = () =>
        runInPage(() => {
          document
            .querySelectorAll<HTMLElement>(
              ".lt-redundancy-settings input:not([type]), .lt-redundancy-settings input[type='text'], .lt-redundancy-settings input[inputmode], .lt-redundancy-trusted li",
            )
            .forEach((el) => {
              el.style.filter = "blur(6px)";
            });
        });
      await AppPage.openSettings();
      await browser.pause(800);
      await rec.click("#lt-settings-tab-redundancy", 300);
      for (let i = 0; i < 4; i++) {
        await blur();
        await browser.pause(200);
      }
      await rec.zoomTo(".lt-redundancy-settings", { margin: 20, maxZoom: 1.4 });
      await rec.moveTo(".lt-redundancy-roles", 700);
      await rec.hold(4);
      await done();
    }

    // 03 — further down: the pilot tone, then «Como respaldo» (the main's
    // address and PIN, Connect). The top-bar pill only shows with a backup
    // connected, which one machine cannot show: it is only narrated.
    {
      const { rec, done } = scene("03-redundancia-estado");
      const blur = () =>
        runInPage(() => {
          document
            .querySelectorAll<HTMLElement>(
              ".lt-redundancy-settings input:not([type]), .lt-redundancy-settings input[type='text'], .lt-redundancy-settings input[inputmode], .lt-redundancy-trusted li",
            )
            .forEach((el) => {
              el.style.filter = "blur(6px)";
            });
        });
      const scrollBy = async (fraction: number) => {
        await runInPage((f: number) => {
          const scroller = document.querySelector(".lt-settings-tab-panels");
          if (scroller) scroller.scrollTo({ top: (scroller.scrollHeight - scroller.clientHeight) * f, behavior: "smooth" });
        }, fraction);
        for (let i = 0; i < 24; i++) {
          await blur();
          await rec.frame(1 / 20);
        }
      };
      await scrollBy(1);
      await rec.hold(5);
      await scrollBy(0.55);
      await rec.hold(4);
      await rec.zoomOut(500);
      await rec.key("Escape", 600);
      await AppPage.resetShell();
      await done();
    }

    // 04 — right-click the song › Arreglo, save the original if needed, New,
    // one more chorus at the end, Apply.
    {
      const { rec, done } = scene("04-arreglo");
      await openArrangement(rec);
      await rec.zoomTo(".lt-structure-panel", { margin: 40, maxZoom: 1.5 });
      await rec.hold(1);
      if (await rectOf(".lt-structure-capture-button")) {
        await runInPage(() =>
          document.querySelector(".lt-structure-capture-button")?.scrollIntoView({ block: "center", behavior: "smooth" }),
        );
        for (let i = 0; i < 12; i++) await rec.frame(1 / 15);
        await rec.click(".lt-structure-capture-button", 1200);
      }
      await rec.click(await tagByText(".lt-structure-toolbar button", L("Nuevo"), "rv-arr-new", true), 1000);
      const chorus = await tagByText(".lt-structure-palette .lt-structure-chip", "Coro", "rv-chorus");
      await rec.click(chorus, 1200);
      await rec.click(".lt-structure-footer .is-primary", 1800);
      await rec.zoomOut(600);
      await rec.click(".lt-structure-close", 1200);
      await done();
    }

    // 05 — delete the drums' clip in the LAST chorus only (right-click › Borrar).
    {
      const { rec, done } = scene("05-arreglo-bloque");
      await fitSong();
      const song = await firstSong();
      const view = await AppPage.songView();
      if (!view) throw new Error("05: no song view");
      const choruses = view.sectionMarkers
        .filter((m) => /coro/i.test(m.name) && m.startSeconds >= song.startSeconds && m.startSeconds < song.endSeconds)
        .sort((a, b) => a.startSeconds - b.startSeconds);
      const last = choruses[choruses.length - 1];
      if (!last) throw new Error("05: no chorus marker in the first song");
      const drums = view.tracks.find((t) => /drum|bater/i.test(t.name));
      if (!drums) throw new Error("05: no drums track");
      const at = last.startSeconds + 4;
      const clip = view.clips.find(
        (c) => c.trackId === drums.id && c.timelineStartSeconds <= at && at < c.timelineStartSeconds + c.durationSeconds,
      );
      if (!clip) throw new Error("05: no drums clip in the last chorus");
      // Close in on the last chorus (about 150 s on the page), in the middle.
      {
        const zoom = 1500 / (150 * 18);
        await setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, last.startSeconds * zoom * 18 - 700) });
      }
      // This song's band, by id: at this zoom the next song may show more.
      const band = await rectOf(`.lt-region-hotspot[data-region-id="${song.id}"]`);
      if (!band) throw new Error("05: no band for the first song");
      const x = band.x + ((at - song.startSeconds) / (song.endSeconds - song.startSeconds)) * band.w;
      const header = await runInPage((name: string) => {
        const el = Array.from(document.querySelectorAll(".lt-track-header")).find(
          (e) => (e.textContent ?? "").includes(name) && e.getBoundingClientRect().height > 0,
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { y: r.top + r.height / 2 };
      }, drums.name);
      if (!header) throw new Error("05: drums header not visible");
      await rec.zoomTo({ x: x - 420, y: header.y - 230, w: 840, h: 460 }, { margin: 0, maxZoom: 1.8 });
      await rec.hold(1.2);
      await rec.rightClick({ x, y: header.y });
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-context-menu button", L("Borrar"), "rv-del-clip"), 1500);
      await rec.hold(2.5);
      await rec.zoomOut(600);
      const after = await AppPage.songView();
      if (after?.clips.some((c) => c.id === clip.id)) console.log("[release-video] 05: the clip is still there");
      await done();
    }

    // 06 — the editor shows the block as edited; select it, «Restablecer como el original».
    {
      const { rec, done } = scene("06-arreglo-editado");
      await fitSong();
      await openArrangement(rec);
      await rec.zoomTo(".lt-structure-panel", { margin: 40, maxZoom: 1.5 });
      const edited = ".lt-structure-block:has(.lt-structure-block-edited)";
      if (await rectOf(edited)) {
        await rec.moveTo(edited, 700);
        await rec.hold(2);
        await rec.click(edited, 900);
        await rec.click(await tagByText(".lt-structure-toolbar button", L("Restablecer como el original"), "rv-reset"), 1500);
        await rec.hold(1.5);
      } else {
        console.log("[release-video] 06: no edited block");
      }
      await rec.zoomOut(600);
      await rec.click(".lt-structure-close", 1000);
      await done();
    }

    // 07/08 — the Remote, phone and tablet, inside the app.
    {
      const info = await invoke<{ url?: string; urls?: string[] }>("get_remote_server_info");
      const remoteUrl = (info && (info.url ?? info.urls?.[0])) || "http://127.0.0.1:3030/";
      console.log(`[release-video] remote ${remoteUrl} ${JSON.stringify(info)}`);
      // Touch, so the tablet frame gets the tablet layout (the Remote picks it
      // from the short side plus touch).
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const TABLET = { w: 1180, h: 820, s: 0.8 };
      const PHONE_R = { w: 390, h: 844, s: 0.8 };
      const tabW = TABLET.w * TABLET.s;
      const phW = PHONE_R.w * PHONE_R.s;
      const gap = 70;
      const left = Math.round((viewportW - tabW - gap - phW) / 2);
      const tablet = { x: left, y: Math.round((viewportH - TABLET.h * TABLET.s) / 2) };
      const phone = { x: left + tabW + gap, y: Math.round((viewportH - PHONE_R.h * PHONE_R.s) / 2) };
      await runInPage(
        (url: string, t: { x: number; y: number }, p: { x: number; y: number }, T: typeof TABLET, P: typeof PHONE_R) => {
          const el = document.createElement("div");
          el.id = "lt-tutorial-title";
          el.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:#0b0d10";
          const frame = (x: number, y: number, w: number, h: number, s: number) =>
            `<iframe src="${url}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
            `transform:scale(${s});transform-origin:0 0;border:0;border-radius:${18 / s}px;` +
            `box-shadow:0 0 0 ${10 / s}px #2a2f36"></iframe>`;
          el.innerHTML = frame(t.x, t.y, T.w, T.h, T.s) + frame(p.x, p.y, P.w, P.h, P.s);
          document.body.appendChild(el);
        },
        remoteUrl,
        tablet,
        phone,
        TABLET,
        PHONE_R,
      );
      await browser.pause(4000);
      const inPhone = (x: number, y: number) => ({ x: phone.x + x * PHONE_R.s, y: phone.y + y * PHONE_R.s });
      const inTablet = (x: number, y: number) => ({ x: tablet.x + x * TABLET.s, y: tablet.y + y * TABLET.s });
      await invoke("seek_transport", { positionSeconds: (await firstSong()).startSeconds + 20 });
      await invoke("play_transport");
      {
        const { rec, done } = scene("07-remote");
        rec.cursor = inPhone(200, 500);
        await rec.realtime(Math.max(9000, (durations["07-remote"] ?? 10) * 1000));
        await done();
      }
      {
        const { rec, done } = scene("08-remote-mezcla");
        rec.cursor = inPhone(200, 500);
        // Positions measured on the Remote at these sizes (default presets).
        await rec.clickAt(inPhone(120, 22), 300);
        await rec.realtime(2200);
        await rec.clickAt(inPhone(204, 22), 300);
        await rec.realtime(900);
        await rec.clickAt(inPhone(47, 77), 300);
        await rec.realtime(1600);
        await rec.clickAt(inTablet(938, 27), 300);
        await rec.realtime(2200);
        await done();
      }
      await invoke("stop_transport");
      await removeTitleCard();
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
      await browser.pause(800);
    }

    // 09 — File › Analizar todas las canciones: two songs, Analyze, the wait.
    {
      const { rec, done } = scene("09-analizar");
      await rec.click(fileMenu, 700);
      await rec.click(
        await tagByText(".lt-top-menu-dropdown button", L("Analizar todas las canciones"), "rv-analyze-all"),
        1500,
      );
      const modal = ".lt-batch-analysis-modal";
      if (!(await rectOf(modal))) throw new Error("09: the batch window did not open");
      await rec.zoomTo(modal, { margin: 30, maxZoom: 1.4 });
      await rec.hold(2);
      // The last two songs: short (each one is listened to) and without the
      // arrangement applied in 04, which turns down tempo and marker changes.
      await rec.click(`${modal} .lt-batch-analysis-all input`, 600);
      const rows = `${modal} .lt-batch-analysis-row input`;
      const boxes = (await runInPage(
        (sel: string) =>
          Array.from(document.querySelectorAll(sel))
            .slice(-2)
            .map((e) => {
              const r = e.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }),
        rows,
      )) as Array<{ x: number; y: number }>;
      for (const b of boxes) await rec.clickAt(b, 500);
      await rec.hold(1);
      await rec.click(`${modal} .lt-export-modal-actions .is-primary`, 400);
      // The whole wait is recorded; it is cut by hand before compose.
      // Done = the results list, with a «Revisar» button per song.
      const review = L("Revisar");
      for (let i = 0; i < 1200; i++) {
        await rec.hold(1);
        const finished = await runInPage(
          (sel: string, label: string) =>
            Array.from(document.querySelectorAll(`${sel} button`)).some((b) => (b.textContent ?? "").trim() === label),
          modal,
          review,
        );
        if (finished) break;
      }
      await rec.hold(2);
      await done();
    }

    // 10 — Apply all, then the markers on the timeline.
    {
      const { rec, done } = scene("10-analizar-aplicar");
      const modal = ".lt-batch-analysis-modal";
      await rec.click(`${modal} .lt-export-modal-actions .is-primary`, 2500);
      await rec.hold(2.5);
      await rec.zoomOut(500);
      if (await rectOf(modal)) await rec.key("Escape", 800);
      await fitSong();
      const ruler = await rectOf(tour("timeline-ruler"));
      if (ruler) await rec.zoomTo({ x: ruler.x, y: ruler.y - 20, w: 1300, h: 300 }, { margin: 30 });
      await rec.hold(2.5);
      await rec.zoomOut(500);
      await done();
    }

    // 12 — improvements and fixes, shown on a card (narrated only as a whole).
    {
      const { rec, done } = scene("12-correcciones");
      await removeTitleCard();
      await listCard(TITLES.fixes, FIXES);
      await rec.hold(Math.max(7, durations["12-correcciones"] ?? 7));
      await done();
    }

    // 13 — end card.
    {
      const { rec, done } = scene("13-final");
      await removeTitleCard();
      await titleCard(TITLES.end[0], TITLES.end[1]);
      await rec.hold(durations["13-final"]);
      await done();
      await removeTitleCard();
    }

    // 11 — on a phone, recorded LAST (see the header): the side rail's
    // Import / Export sheet with «Analizar todas las canciones».
    {
      await toPhone();
      await browser.pause(1500);
      const rec = new Recorder(cdp, "11-movil", { x: 0, y: 0, w: PHONE.w, h: PHONE.h }, scenesDir,
        { x: PHONE.w * 0.7, y: PHONE.h * 0.6 },
        { width: 1920, height: Math.round((1920 * PHONE.h) / PHONE.w / 2) * 2, dpr: PHONE.dpr, viewport: { w: PHONE.w, h: PHONE.h } });
      const record = only.length === 0 || only.includes("11-movil");
      console.log("[release-video] scene 11-movil");
      await rec.hold(1.2);
      const fileButton = `button[aria-label="${L("Importar / Exportar")}"]`;
      if (await rectOf(fileButton)) {
        await rec.click(fileButton, 900);
        const item = await tagByText(".lt-mobile-file-menu button", L("Analizar todas las canciones"), "rv-m-analyze").catch(() => "");
        if (item) {
          await rec.moveTo(item, 700);
          await rec.hold(2.5);
        }
      } else {
        console.log("[release-video] 11-movil: no Import / Export button");
      }
      await rec.holdUntil((durations["11-movil"] ?? 6) + 0.7);
      if (record) {
        await rec.encode();
        letterbox("11-movil");
      }
    }
  });
});
