import { browser, $ } from "@wdio/globals";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import AppPage from "../pageobjects/app.page.js";
import { Recorder } from "../utils/record.js";
import {
  annotate,
  clearAnnotations,
  rectOf,
  runInPage,
  unionBox,
  type Box,
  type Mark,
} from "../utils/annotate.js";

/**
 * Not a test — the screenshot harness for the USER GUIDE on the website.
 * Sibling of doc-shots.e2e.ts, but every image here is meant to explain a
 * control, so most captures carry callouts drawn over the live UI
 * (utils/annotate.ts) and are cropped to the area they explain: the docs
 * column is ~900px wide, and a full 1600px window shrunk into it is unreadable.
 *
 * Skipped unless LT_GUIDESHOTS=1. Run with:
 *
 *   LT_GUIDESHOTS=1 LT_SHOTS_SESSION=<copy of a real .ltsession> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/guide-shots.e2e.ts
 *
 * LT_SHOTS_SESSION is copied to a temp folder before every run, so the
 * original is never written to.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
// LT_SHOTS_SESSION is the GOLDEN copy: every run works on a fresh copy of its
// folder, because several captures edit the session (create a folder, drop a
// song) and the next run must start from the same state.
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-guide-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const outDir =
  process.env.LT_GUIDESHOTS_DIR ??
  path.join(repoRoot, "apps", "website", "public", "guide", "desktop");

const tour = (id: string) => `[data-lt-tour="${id}"]`;
const transportButton = (n: number) => `.lt-transport-buttons > button:nth-of-type(${n})`;

type Crop = Box | { selector: string; margin?: number } | { marks: number };

/** Chrome DevTools Protocol through msedgedriver's vendor endpoint. */
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

async function viewport() {
  return runInPage(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }));
}

async function shot(name: string, crop?: Crop, drawn: Box[] = []) {
  await browser.pause(600);
  const file = path.join(outDir, `${name}.png`);
  const png = Buffer.from(await browser.takeScreenshot(), "base64");
  if (!crop) {
    await sharp(png).toFile(file);
  } else {
    const vp = await viewport();
    let box: Box;
    if ("marks" in crop) {
      box = unionBox(drawn, crop.marks, vp);
    } else if ("selector" in crop) {
      const r = await rectOf(crop.selector);
      if (!r) throw new Error(`crop: ${crop.selector} not visible`);
      box = unionBox([r, ...drawn], crop.margin ?? 16, vp);
    } else {
      box = crop;
    }
    const s = vp.dpr;
    await sharp(png)
      .extract({
        left: Math.round(box.x * s),
        top: Math.round(box.y * s),
        width: Math.round(box.w * s),
        height: Math.round(box.h * s),
      })
      .toFile(file);
  }
  console.log(`[guideshots] wrote ${name}.png`);
}

async function annotatedShot(
  name: string,
  marks: Mark[],
  opts: { style?: "callouts" | "spotlight"; crop?: Crop } = {},
) {
  const drawn = await annotate(marks, { style: opts.style });
  await shot(name, opts.crop, drawn);
  await clearAnnotations();
}

/** Puts data-guide=<name> on the nth visible match, so marks can target inside it. */
async function tag(selector: string, name: string, nth = 0) {
  const ok = await runInPage(
    (sel: string, tagName: string, index: number) => {
      document
        .querySelectorAll(`[data-guide="${tagName}"]`)
        .forEach((el) => el.removeAttribute("data-guide"));
      const el = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })[index];
      if (!el) return false;
      el.setAttribute("data-guide", tagName);
      return true;
    },
    selector,
    name,
    nth,
  );
  if (!ok) throw new Error(`tag: ${selector}[${nth}] not visible`);
  return `[data-guide="${name}"]`;
}

/** data-guide=<name> on the nth visible match whose text contains `text`. */
async function tagByText(selector: string, text: string, name: string) {
  const ok = await runInPage(
    (sel: string, needle: string, tagName: string) => {
      document
        .querySelectorAll(`[data-guide="${tagName}"]`)
        .forEach((el) => el.removeAttribute("data-guide"));
      const el = Array.from(document.querySelectorAll(sel)).find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (e.textContent ?? "").toLowerCase().includes(needle.toLowerCase());
      });
      if (!el) return false;
      el.setAttribute("data-guide", tagName);
      return true;
    },
    selector,
    text,
    name,
  );
  if (!ok) throw new Error(`tagByText: ${selector} "${text}" not visible`);
  return `[data-guide="${name}"]`;
}

/** Opens the working session unless it is already on screen. */
async function ensureSession() {
  if (await rectOf(".lt-timeline-shell")) return;
  await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
  await AppPage.resetShell();
  await browser.pause(5000);
}

/** Like tagByText, but the trimmed text must equal `text` ("Coro", not "Pre Coro"). */
async function tagByExactText(selector: string, text: string, name: string) {
  const ok = await runInPage(
    (sel: string, needle: string, tagName: string) => {
      document.querySelectorAll(`[data-guide="${tagName}"]`).forEach((el) => el.removeAttribute("data-guide"));
      const el = Array.from(document.querySelectorAll(sel)).find((e) => {
        const r = e.getBoundingClientRect();
        const label = (e.textContent ?? "").replace(/[▸›]/g, "").trim().toLowerCase();
        return r.width > 0 && r.height > 0 && label === needle.toLowerCase();
      });
      if (!el) return false;
      el.setAttribute("data-guide", tagName);
      return true;
    },
    selector,
    text,
    name,
  );
  if (!ok) throw new Error(`tagByExactText: ${selector} "${text}" not visible`);
  return `[data-guide="${name}"]`;
}

async function setTimelineView(view: { cameraX?: number; zoomLevel?: number }) {
  await runInPage(
    (v: { cameraX?: number; zoomLevel?: number }) =>
      (window as unknown as { __ltE2E: { setTimelineView: (x: unknown) => void } }).__ltE2E.setTimelineView(v),
    view,
  );
  await browser.pause(800);
  const now = await runInPage(() =>
    (window as unknown as { __ltE2E: { getTimelineView: () => unknown } }).__ltE2E.getTimelineView(),
  );
  console.log(`[guideshots] timeline view ${JSON.stringify(view)} -> ${JSON.stringify(now)}`);
}

async function rightClickAt(x: number, y: number) {
  // The emulated viewport (1920x1080) can be larger than the real window,
  // which Windows clamps to the screen; WebDriver refuses pointer moves
  // outside the real one.
  const win = await browser.getWindowRect();
  x = Math.min(x, win.width - 30);
  y = Math.min(y, win.height - 70);
  await browser
    .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
    .move({ x: Math.round(x), y: Math.round(y) })
    .down({ button: 2 })
    .up({ button: 2 })
    .perform();
  await browser.pause(500);
}

async function rightClick(selector: string, at: { fx?: number; fy?: number } = {}) {
  const r = await rectOf(selector);
  if (!r) throw new Error(`rightClick: ${selector} not visible`);
  await rightClickAt(r.x + r.w * (at.fx ?? 0.5), r.y + r.h * (at.fy ?? 0.5));
}

/**
 * Menu entries for features that exist in the build but are not announced
 * yet (song arrangements, 2026-10). Hidden from the guide captures until the
 * feature is public; remove an entry here when it ships.
 */
const UNANNOUNCED_MENU_ITEMS = ["Arreglo"];

async function hideUnannouncedMenuItems() {
  await runInPage((labels: string[]) => {
    document.querySelectorAll<HTMLElement>(".lt-context-menu button").forEach((el) => {
      if (labels.includes((el.textContent ?? "").trim())) el.style.display = "none";
    });
  }, UNANNOUNCED_MENU_ITEMS);
}

/** Context menu + the element it was opened on, everything else dimmed. */
async function menuShot(name: string, origin: string | null) {
  if (!(await rectOf(".lt-context-menu"))) {
    console.log(`[guideshots] SKIPPED ${name}: no context menu opened`);
    return;
  }
  await hideUnannouncedMenuItems();
  const marks: Mark[] = [{ selector: ".lt-context-menu", pad: 2 }];
  // Lit but not outlined: an outline would cross the menu's own text when
  // the two overlap.
  if (origin) marks.push({ selector: origin, pad: 2, noBox: true });
  await annotatedShot(name, marks, { style: "spotlight", crop: { marks: 40 } });
  await browser.keys(["Escape"]);
  await browser.pause(300);
}

async function openToolbarGroup(id: string) {
  await (await $(`${tour(id)} .lt-control-popover-trigger`)).click();
  await browser.pause(500);
}

async function closeToolbarGroup(id: string) {
  const trigger = await $(`${tour(id)} .lt-control-popover-trigger`);
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click();
  await browser.pause(300);
}

async function toolbarPanelShot(id: string, name: string) {
  await openToolbarGroup(id);
  await annotatedShot(
    name,
    [
      { selector: tour(id), pad: 2 },
      { selector: ".lt-control-popover-panel", pad: 2 },
    ],
    { style: "spotlight", crop: { marks: 30 } },
  );
  await closeToolbarGroup(id);
}

describe("user guide screenshots", function () {
  before(async function () {
    if (process.env.LT_GUIDESHOTS !== "1") {
      this.skip();
    }
    if (!golden) throw new Error("LT_SHOTS_SESSION is required");
    rmSync(workDir, { recursive: true, force: true });
    cpSync(path.dirname(golden), workDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    await AppPage.waitUntilBooted();
    await browser.setWindowSize(1940, 1140);
    // Windows clamps the window to the screen, so the real viewport is a bit
    // shorter than 1080. The emulated one must match it exactly: if it is
    // larger the page is scaled to fit and every pointer action lands a few
    // pixels off — harmless on a big button, fatal on a drop target.
    const real = await runInPage(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (process.env.LT_GUIDESHOTS_DPR) {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: real.w,
        height: real.h,
        deviceScaleFactor: Number(process.env.LT_GUIDESHOTS_DPR),
        mobile: false,
      });
    }
    console.log("[guideshots] viewport", JSON.stringify(await viewport()));
  });

  it("landing", async () => {
    await browser.pause(1500);
    await annotatedShot(
      "landing-overview",
      [
        { selector: tour("landing-create"), n: 1 },
        { selector: tour("landing-open"), n: 2 },
        { selector: tour("landing-import"), n: 3 },
        { selector: tour("landing-import-external"), n: 4 },
        { selector: tour("landing-cloud"), n: 5 },
        { selector: ".lt-empty-state-templates", n: 6, pad: 6 },
      ],
      { crop: { selector: ".lt-empty-state-card", margin: 20 } },
    );
  });

  it("daw screen", async () => {
    await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
    await AppPage.resetShell();
    await browser.pause(6000);

    // Zones of the whole window, full frame: the page shows it at column
    // width and the reader clicks to zoom.
    await annotatedShot("daw-zones", [
      { selector: tour("topbar-file-menu"), n: 1 },
      { selector: tour("topbar-tempo"), n: 2 },
      { selector: ".lt-transport-buttons", n: 3 },
      { selector: ".lt-transport-readout", n: 4 },
      { selector: ".lt-resource-meter", n: 5 },
      { selector: ".lt-side-nav", n: 6, pad: 0 },
      { selector: ".lt-timeline-topline", n: 7, pad: 0 },
      { selector: tour("timeline-ruler"), n: 8, pad: 0 },
      { selector: tour("track-headers"), n: 9, pad: 0 },
      { selector: ".lt-track-layers", n: 10, pad: -3 },
    ]);

    const split = (id: string, n: number) => `${tour(id)} > button:nth-of-type(${n})`;
    await annotatedShot(
      "topbar-left",
      [
        { selector: tour("topbar-file-menu"), n: 1 },
        { selector: tour("topbar-tempo"), n: 2 },
        { selector: ".lt-tap-tempo-button", n: 3 },
        { selector: tour("topbar-time-signature"), n: 4 },
        { selector: ".lt-topbar-history > button:nth-of-type(1)", n: 5, badge: "below" },
        { selector: ".lt-topbar-history > button:nth-of-type(2)", n: 6, badge: "below" },
      ],
      { crop: { marks: 14 } },
    );

    await annotatedShot(
      "topbar-transport",
      [
        { selector: transportButton(1), n: 1, badge: "below", pad: 1 },
        { selector: transportButton(2), n: 2, badge: "below", pad: 1 },
        { selector: transportButton(3), n: 3, badge: "below", pad: 1 },
        { selector: transportButton(4), n: 4, badge: "below", pad: 1 },
        { selector: split("topbar-metronome", 1), n: 5, badge: "below", pad: 1 },
        { selector: split("topbar-metronome", 2), n: 6, badge: "below", pad: 1 },
        { selector: split("topbar-voice-guide", 1), n: 7, badge: "below", pad: 1 },
        { selector: split("topbar-voice-guide", 2), n: 8, badge: "below", pad: 1 },
        { selector: split("topbar-pads", 1), n: 9, badge: "below", pad: 1 },
        { selector: split("topbar-pads", 2), n: 10, badge: "below", pad: 1 },
        { selector: ".lt-transport-buttons > button:last-of-type", n: 11, badge: "below" },
      ],
      { crop: { marks: 14 } },
    );

    await annotatedShot(
      "topbar-right",
      [
        { selector: ".lt-resource-meter", n: 1 },
        { selector: ".lt-transport-readout .lt-readout-block:nth-of-type(1)", n: 2, badge: "below" },
        { selector: ".lt-transport-readout .lt-readout-block:nth-of-type(2)", n: 3, badge: "below" },
        { selector: ".lt-transport-readout .lt-readout-block:nth-of-type(3)", n: 4, badge: "below" },
        { selector: ".lt-transport-readout .lt-readout-block:nth-of-type(4)", n: 5, badge: "below" },
        { selector: ".lt-transport-readout .transport-pill", n: 6, badge: "below" },
      ],
      { crop: { marks: 14 } },
    );

    await (await $(`${tour("topbar-file-menu")} .lt-top-menu-trigger`)).click();
    await browser.pause(500);
    await annotatedShot("file-menu", [{ selector: ".lt-top-menu-dropdown", pad: 2 }], {
      style: "spotlight",
      crop: { selector: ".lt-top-menu-dropdown", margin: 40 },
    });
    await browser.keys(["Escape"]);
  });

  it("clip: metronome settings", async () => {
    const rec = new Recorder(cdp, "metronome-settings", { x: 780, y: 0, w: 960, h: 640 }, outDir);
    await rec.hold(0.6);
    await rec.click(`${tour("topbar-metronome")} > button:nth-of-type(2)`);
    await rec.hold(2.2);
    await rec.moveTo({ x: 1500, y: 480 }, 600);
    await rec.hold(1.2);
    await rec.encode();
    await browser.keys(["Escape"]);
  });

  it("toolbar", async () => {
    const view = (n: number) => `${tour("view-mode-switcher")} button:nth-of-type(${n})`;
    // One 1920px row is unreadable at column width: two halves, numbering
    // continued from the first into the second.
    await annotatedShot(
      "toolbar-left",
      [
        { selector: view(1), n: 1, badge: "below", pad: 1 },
        { selector: view(2), n: 2, badge: "below", pad: 1 },
        { selector: view(3), n: 3, badge: "below", pad: 1 },
        { selector: tour("toolbar-snap"), n: 4, badge: "below", pad: 1 },
        { selector: ".lt-timeline-controls > button:nth-of-type(2)", n: 5, badge: "below", pad: 1 },
        { selector: tour("toolbar-vamp"), n: 6 },
        { selector: tour("toolbar-marker-jump"), n: 7 },
      ],
      { crop: { marks: 16 } },
    );
    await annotatedShot(
      "toolbar-right",
      [
        { selector: tour("toolbar-song-jump"), n: 8 },
        { selector: tour("toolbar-master"), n: 9 },
        { selector: tour("toolbar-transpose"), n: 10 },
        { selector: tour("toolbar-warp"), n: 11 },
        { selector: 'button[aria-label="Cancelar salto"]', n: 12 },
      ],
      { crop: { marks: 16 } },
    );

    await toolbarPanelShot("toolbar-vamp", "toolbar-vamp-panel");
    await toolbarPanelShot("toolbar-marker-jump", "toolbar-marker-jump-panel");
    await toolbarPanelShot("toolbar-song-jump", "toolbar-song-jump-panel");

    // Master, transpose and warp only show their controls for a selected song.
    await (await $(".lt-region-hotspot")).click();
    await browser.pause(500);
    await toolbarPanelShot("toolbar-master", "toolbar-master-panel");
    await toolbarPanelShot("toolbar-transpose", "toolbar-transpose-panel");
    await toolbarPanelShot("toolbar-warp", "toolbar-warp-panel");
  });

  it("ruler and track headers", async () => {
    // Open the first song's folder so the shots show real stems, not a block.
    const toggle = await $(".lt-track-header.is-folder .lt-folder-toggle");
    if (await toggle.isExisting()) {
      await toggle.click();
      await browser.pause(2500);
    }

    await annotatedShot(
      "ruler",
      [
        { selector: ".lt-region-hotspot", n: 1, nth: 1 },
        { selector: ".lt-marker-hotspot", n: 2, text: "Última" },
        { selector: ".lt-marker-hotspot", n: 3, text: "Coro" },
        { selector: ".lt-tempo-hotspot:not(.lt-time-signature-hotspot)", n: 4 },
      ],
      { crop: { marks: 24 } },
    );

    const track = await tag(
      ".lt-track-header:not(.is-folder):not(.is-automation):not(.lt-midi-track-header)",
      "track",
    );
    await annotatedShot(
      "track-header",
      [
        { selector: `${track} .lt-track-title-row strong`, n: 1, badge: "above", noBox: true },
        { selector: `${track} .lt-track-toggle-mute`, n: 2, badge: "above", noBox: true },
        { selector: `${track} .lt-track-toggle-solo`, n: 3, badge: "above", noBox: true },
        { selector: `${track} .lt-track-volume`, n: 4, badge: "above", noBox: true },
        { selector: `${track} .lt-track-audio-to`, n: 5, badge: "above", noBox: true },
        { selector: `${track} .lt-track-toggle-transpose`, n: 6, badge: "below", noBox: true },
        { selector: `${track} .lt-track-pan`, n: 7, badge: "below", noBox: true },
        { selector: `${track} .lt-track-meter`, n: 8, badge: "below", noBox: true },
      ],
      { style: "spotlight", crop: { selector: track, margin: 36 } },
    );

    const folder = await tag(".lt-track-header.is-folder", "folder");
    await annotatedShot(
      "folder-header",
      [
        { selector: `${folder} .lt-folder-toggle`, n: 1, pad: 2 },
        { selector: `${folder} .lt-track-audio-to`, n: 2, badge: "above" },
      ],
      { crop: { selector: folder, margin: 36 } },
    );
  });

  it("context menus", async () => {
    await rightClick(".lt-region-hotspot", { fx: 0.3 });
    await menuShot("menu-song", ".lt-region-hotspot");

    await rightClick(".lt-marker-hotspot");
    await menuShot("menu-marker", ".lt-marker-hotspot");

    await rightClick(".lt-tempo-hotspot:not(.lt-time-signature-hotspot)");
    await menuShot("menu-tempo", ".lt-tempo-hotspot:not(.lt-time-signature-hotspot)");

    // Empty ruler past the last song.
    const ruler = await rectOf(tour("timeline-ruler"));
    if (ruler) {
      await rightClickAt(ruler.x + ruler.w - 60, ruler.y + ruler.h * 0.5);
      await menuShot("menu-ruler", null);
    }

    const track = await tag(
      ".lt-track-header:not(.is-folder):not(.is-automation):not(.lt-midi-track-header)",
      "track",
    );
    await rightClick(`${track} .lt-track-title-row`);
    await menuShot("menu-track", track);


    // A clip lives on the canvas: aim at its track row, inside its song.
    const row = await rectOf(track);
    const song = await rectOf(".lt-region-hotspot");
    if (row && song) {
      await rightClickAt(song.x + Math.min(160, song.w / 2), row.y + row.h / 2);
      await menuShot("menu-clip", null);
    }

    await rightClick(".lt-track-header.is-automation");
    await menuShot("menu-automation", ".lt-track-header.is-automation");
  });

  it("side nav, library, remote, tutorial", async () => {
    await ensureSession();
    await AppPage.resetShell();
    await annotatedShot(
      "side-nav",
      [
        { selector: tour("side-nav-library"), n: 1, badge: "corner" },
        { selector: tour("side-nav-remote"), n: 2, badge: "corner" },
        { selector: tour("side-nav-settings"), n: 3, badge: "corner" },
        { selector: tour("side-nav-help"), n: 4, badge: "corner" },
      ],
      { crop: { x: 0, y: 100, w: 260, h: 380 } },
    );

    await AppPage.openLibrary();
    await browser.pause(1200);
    await annotatedShot(
      "library-panel",
      [
        { selector: tour("library-new-folder"), n: 1 },
        { selector: tour("library-import"), n: 2 },
        { selector: ".lt-library-folder-group, .lt-library-root-group", n: 3, nth: 0 },
        { selector: ".lt-library-asset-list [aria-label]", n: 4, nth: 0 },
      ],
      { crop: { marks: 30 } },
    );
    await rightClick(".lt-library-asset-list [aria-label]");
    await menuShot("menu-library-asset", ".lt-library-asset-list [aria-label]");
    await rightClick(".lt-library-folder-group, .lt-library-root-group", { fy: 0.05 });
    await menuShot("menu-library-folder", null);
    await AppPage.resetShell();

    await (await $(tour("side-nav-remote"))).click();
    await browser.pause(1500);
    // The URLs carry this PC's LAN address and host name.
    await runInPage(() => {
      document
        // The QR encodes the same address and host name.
        .querySelectorAll<HTMLElement>('[aria-labelledby="lt-remote-modal-title"] a, [aria-labelledby="lt-remote-modal-title"] svg, [aria-labelledby="lt-remote-modal-title"] canvas, [aria-labelledby="lt-remote-modal-title"] img')
        .forEach((el) => {
          el.style.filter = el.tagName === "A" ? "blur(5px)" : "blur(9px)";
        });
    });
    await shot("remote-modal", { selector: '[aria-labelledby="lt-remote-modal-title"]', margin: 16 });
    await browser.keys(["Escape"]);
    await browser.pause(500);
    await AppPage.resetShell();

    await (await $(`${tour("side-nav-help")} button, ${tour("side-nav-help")}`)).click();
    await browser.pause(700);
    await annotatedShot("tutorial-menu", [{ selector: ".lt-tour-menu", pad: 2 }], {
      style: "spotlight",
      crop: { marks: 40 },
    });
    await browser.keys(["Escape"]);
    await AppPage.resetShell();
  });

  it("settings tabs", async () => {
    await ensureSession();
    await AppPage.openSettings();
    const tabs = ["audio", "general", "video", "shortcuts", "diagnostics", "midi", "midiLearn"];
    await annotatedShot(
      "settings-overview",
      [
        ...tabs.map((id, i) => ({ selector: `#lt-settings-tab-${id}`, n: i + 1, pad: 1 })),
        { selector: ".lt-settings-modal-close", n: tabs.length + 1, pad: 2 },
      ],
      { crop: { selector: ".lt-settings-modal", margin: 12 } },
    );
    for (const id of tabs) {
      const tab = await AppPage.settingsTab(id);
      if (!(await tab.isExisting())) {
        console.log(`[guideshots] SKIPPED settings-${id}: no tab`);
        continue;
      }
      await tab.click();
      await browser.pause(900);
      // The audio-cache path shows the real Windows account name.
      await runInPage(() => {
        document.querySelectorAll<HTMLInputElement>(".lt-settings-tab-panels input").forEach((el) => {
          if (/[A-Za-z]:[\\/]|\/Users\//.test(el.value)) el.style.filter = "blur(5px)";
        });
      });
      // Long tabs: one capture per screenful of the panel, scrolling the
      // panel itself; a tab that fits is captured once.
      const pages = await runInPage(() => {
        const scroller = document.querySelector(".lt-settings-tab-panels");
        if (!scroller) return 1;
        scroller.scrollTop = 0;
        const overflow = scroller.scrollHeight - scroller.clientHeight;
        if (overflow <= 8) return 1;
        return Math.min(5, 1 + Math.ceil(overflow / (scroller.clientHeight - 80)));
      });
      // Lists (shortcuts, MIDI Learn) only need their first screen: the page
      // explains how they work, not every row. The filename keeps its "-1".
      const pagesToShoot = ["shortcuts", "midiLearn"].includes(id) ? 1 : pages;
      for (let page = 0; page < pagesToShoot; page++) {
        await runInPage((p: number) => {
          const scroller = document.querySelector(".lt-settings-tab-panels");
          if (scroller) scroller.scrollTop = p * (scroller.clientHeight - 80);
        }, page);
        await browser.pause(400);
        await shot(`settings-${id}${pages > 1 ? `-${page + 1}` : ""}`, {
          selector: ".lt-settings-tab-panels",
          margin: 4,
        });
      }
    }
    await browser.keys(["Escape"]);
    await AppPage.resetShell();
  });

  it("clips: library", async () => {
    await ensureSession();
    await AppPage.resetShell();
    await AppPage.openLibrary();
    await browser.pause(1200);
    const panel = await rectOf(".lt-library-panel");
    if (!panel) throw new Error("no library panel");

    // 1) Create a folder and move two audios into it.
    const rec = new Recorder(cdp, "library-folder", { x: panel.x, y: panel.y, w: panel.w + 40, h: 720 }, outDir, {
      x: panel.x + panel.w * 0.7,
      y: panel.y + 300,
    });
    await rec.hold(0.5);
    const root = await tag(".lt-library-root-group > :first-child", "root-head");
    await rec.rightClick(root);
    await rec.click(await tagByText(".lt-context-menu button", "Crear carpeta", "menu-item"));
    await (await $("#lt-dialog-input")).waitForDisplayed({ timeout: 5000 });
    await rec.type("Ensayo");
    await rec.hold(0.4);
    await rec.key("Enter", 900);
    const folderHead = await tagByText(".lt-library-folder-group > :first-child", "Ensayo", "folder-head");
    await rec.dragTo(folderHead, 1100, {
      from: await tagByText(".lt-library-asset-list [aria-label]", "Drums.mp3", "asset-a"),
    });
    await rec.hold(0.3);
    await rec.dragTo(folderHead, 1100, {
      from: await tagByText(".lt-library-asset-list [aria-label]", "Keys.mp3", "asset-b"),
    });
    await rec.hold(1.5);
    // The clip is only worth publishing if the move really happened.
    const inFolder = await runInPage(() => {
      const head = document.querySelector('[data-guide="folder-head"]');
      return head?.closest(".lt-library-folder-group")?.querySelectorAll(".lt-library-asset-list [aria-label]").length ?? 0;
    });
    if (inFolder !== 2) throw new Error(`library-folder: expected 2 assets in Ensayo, found ${inFolder}`);
    await rec.encode();

    // 2) Drag a whole folder to the timeline: it becomes a song.
    // Zoom out until the end of the last song and empty space are in view.
    // zoomLevel multiplies 18 px/s; the minimum fits the whole session with
    // empty timeline after the last song.
    const lanes = await rectOf(".lt-track-layers");
    if (!lanes) throw new Error("no lanes");
    await setTimelineView({ zoomLevel: 0.0625 });
    await browser.pause(800);
    // Drop right after the last song as it is drawn NOW: the app clamps the
    // scroll when everything fits, so a computed position can be wrong.
    const lastRight = await runInPage(() =>
      Math.max(
        ...Array.from(document.querySelectorAll(".lt-region-hotspot")).map((el) => el.getBoundingClientRect().right),
      ),
    );
    const dropX = Math.min(lanes.x + lanes.w - 30, lastRight + 14);
    console.log(`[guideshots] folder drop at x=${dropX} (last song ends at ${lastRight}, lanes end ${lanes.x + lanes.w})`);
    const vp = await viewport();
    const songsBefore = (await AppPage.songView())?.regions.length ?? 0;
    const rec2 = new Recorder(cdp, "library-folder-to-song", { x: 0, y: 0, w: vp.w, h: vp.h }, outDir, {
      x: panel.x + panel.w * 0.6,
      y: 700,
    });
    await rec2.hold(0.5);
    await rec2.dragTo({ x: dropX, y: lanes.y + 220 }, 1600, {
      from: await tagByText(".lt-library-folder-group > :first-child", "Eres Todo", "folder-src"),
    });
    await rec2.hold(2.2);
    const songsAfter = (await AppPage.songView())?.regions.length ?? 0;
    if (songsAfter !== songsBefore + 1) {
      throw new Error(`library-folder-to-song: songs ${songsBefore} -> ${songsAfter}, no song was created`);
    }
    await rec2.encode();
    await AppPage.resetShell();
  });

  it("clips: markers", async () => {
    await ensureSession();
    await setTimelineView({ zoomLevel: 1, cameraX: 0 });
    const ruler = await rectOf(tour("timeline-ruler"));
    if (!ruler) throw new Error("no ruler");
    const rec = new Recorder(cdp, "marker-create", { x: ruler.x, y: ruler.y - 40, w: 900, h: 560 }, outDir);
    await rec.hold(0.5);
    // Empty spot of the bars row, inside the first song.
    await rec.rightClick({ x: ruler.x + 330, y: ruler.y + 40 });
    await rec.click(await tagByText(".lt-context-menu button", "Crear Marca", "menu-item"));
    await rec.hold(0.6);
    // The kind menu opens on two groups: Secciones / Avisos.
    await rec.click(await tagByText(".lt-context-menu button", "Secciones", "menu-group"));
    await rec.hold(0.4);
    await rec.click(await tagByExactText(".lt-context-menu button", "Coro", "menu-kind"));
    await rec.hold(0.6);
    await annotatedShot("marker-kind-menu", [{ selector: ".lt-context-menu", pad: 2 }], {
      style: "spotlight",
      crop: { marks: 40 },
    });
    await rec.click(await tagByText(".lt-context-menu button", "2", "menu-variant"));
    await rec.hold(2);
    await rec.encode();

    // Section <-> cue: drag a section flag up into the cue row.
    const coro = await tagByText(".lt-marker-hotspot", "Coro 2", "coro");
    const cueRow = await rectOf(await tagByText(".lt-marker-hotspot", "Entra", "cue-row"));
    const coroBox = await rectOf(coro);
    if (!coroBox || !cueRow) throw new Error("no markers");
    const rec2 = new Recorder(cdp, "marker-lane-drag", { x: ruler.x, y: ruler.y - 20, w: 900, h: 260 }, outDir);
    await rec2.hold(0.6);
    await rec2.dragTo(
      { x: coroBox.x + coroBox.w / 2, y: cueRow.y + cueRow.h / 2 },
      900,
      { from: coro },
    );
    await rec2.hold(1.2);
    await rec2.dragTo(
      { x: coroBox.x + coroBox.w / 2, y: coroBox.y + coroBox.h / 2 },
      900,
      { from: { x: coroBox.x + coroBox.w / 2, y: cueRow.y + cueRow.h / 2 } },
    );
    await rec2.hold(1.5);
    await rec2.encode();
  });

  it("clips: songs", async () => {
    await ensureSession();
    await AppPage.resetShell();
    // Close enough to read the song bar; the end of the last song sits about
    // 400px into the lanes, with empty timeline after it.
    const ruler = await rectOf(tour("timeline-ruler"));
    if (!ruler) throw new Error("no ruler");
    const zoom = 0.25;
    const lastEndSeconds = Math.max(...((await AppPage.songView())?.regions ?? []).map((r) => r.endSeconds));
    await setTimelineView({ zoomLevel: zoom });
    await browser.pause(800);
    await setTimelineView({ cameraX: Math.max(0, lastEndSeconds * zoom * 18 - 400) });
    const lastRight = await runInPage(() =>
      Math.max(...Array.from(document.querySelectorAll(".lt-region-hotspot")).map((el) => el.getBoundingClientRect().right)),
    );
    const regionsOf = async () => (await AppPage.songView())?.regions ?? [];
    const before = await regionsOf();
    const clip = { x: Math.max(0, lastRight - 420), y: ruler.y - 10, w: 1100, h: 380 };

    // 1) Draw a range on the empty ruler and turn it into a song.
    const rowY = ruler.y + 30; // bars row, clear of the marker lanes
    const rec = new Recorder(cdp, "song-from-range", clip, outDir, { x: lastRight - 120, y: ruler.y + 200 });
    await rec.hold(0.5);
    await rec.dragTo({ x: lastRight + 300, y: rowY }, 1000, { from: { x: lastRight + 40, y: rowY } });
    await rec.hold(0.5);
    await rec.rightClick({ x: lastRight + 170, y: rowY });
    await rec.click(await tagByText(".lt-context-menu button", "Crear Cancion desde", "menu-item"));
    await rec.hold(1.5);
    const afterCreate = await regionsOf();
    if (afterCreate.length !== before.length + 1) throw new Error("song-from-range: no song created");
    await rec.encode();

    const newest = [...afterCreate].sort((a, b) => b.startSeconds - a.startSeconds)[0];
    // The newest song is the rightmost bar. Select it: its resize handles
    // only respond on the selected song.
    await runInPage(() => {
      const bars = Array.from(document.querySelectorAll(".lt-region-hotspot"));
      bars.forEach((el) => el.removeAttribute("data-guide"));
      const last = bars.sort((l, r) => r.getBoundingClientRect().left - l.getBoundingClientRect().left)[0];
      last?.setAttribute("data-guide", "new-song");
    });
    const songBar = '[data-guide="new-song"]';
    const handle = `${songBar} .lt-region-resize-handle.is-end`;
    // 2) Stretch its end.
    const rec2 = new Recorder(cdp, "song-resize", clip, outDir, { x: lastRight + 100, y: ruler.y + 200 });
    await rec2.hold(0.4);
    const h = await rectOf(handle);
    if (!h) throw new Error("no handle");
    await rec2.dragToCdp({ x: h.x + h.w / 2 + 180, y: h.y + h.h / 2 }, 900, { from: handle });
    await rec2.hold(1.2);
    const resized = (await regionsOf()).find((r) => r.id === newest.id);
    if (!resized || resized.endSeconds <= newest.endSeconds) throw new Error("song-resize: end did not move");
    await rec2.encode();

    // 3) Move it along the timeline.
    const bar = await rectOf(songBar);
    if (!bar) throw new Error("no song bar");
    const rec3 = new Recorder(cdp, "song-move", clip, outDir, { x: bar.x + bar.w / 2, y: ruler.y + 200 });
    await rec3.hold(0.4);
    await rec3.dragTo({ x: bar.x + bar.w * 0.35 + 120, y: bar.y + bar.h / 2 }, 900, {
      from: { x: bar.x + bar.w * 0.35, y: bar.y + bar.h / 2 },
    });
    await rec3.hold(1.2);
    const moved = (await regionsOf()).find((r) => r.id === newest.id);
    if (!moved || moved.startSeconds <= newest.startSeconds) throw new Error("song-move: song did not move");
    await rec3.encode();
  });

  it("clips: clips and tracks", async () => {
    await ensureSession();
    await AppPage.resetShell();
    const view = async () => (await AppPage.songView())!;
    /** data-guide=<tag> on the track header whose name is exactly `name`. */
    const headerOf = async (name: string, tagName: string) => {
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
    };

    // Frame the second song ("Único Dios", whose only audio is the Batería
    // clip) large enough to read.
    const song = (await view()).regions.find((r) => r.name === "Único Dios");
    if (!song) throw new Error("no Único Dios");
    await setTimelineView({ zoomLevel: 0.25 });
    await browser.pause(800);
    await setTimelineView({ cameraX: Math.max(0, song.startSeconds * 0.25 * 18 - 120) });
    const lanes = await rectOf(".lt-track-layers");
    const ruler = await rectOf(tour("timeline-ruler"));
    if (!lanes || !ruler) throw new Error("no lanes");
    const xAt = (seconds: number) => lanes.x + seconds * 0.25 * 18 - Math.max(0, song.startSeconds * 0.25 * 18 - 120);
    const bateria = await rectOf(await headerOf("Batería", "bateria"));
    const drums = await rectOf(await headerOf("Drums", "drums"));
    if (!bateria || !drums) throw new Error("no rows");
    const clip = { x: lanes.x - 260, y: ruler.y - 10, w: 1100, h: Math.min(drums.y + drums.h + 20, 1000) - ruler.y + 10 };

    // 1) Split a clip at the cursor.
    const mid = song.startSeconds + (song.endSeconds - song.startSeconds) / 2;
    const clipsBefore = (await view()).clips.length;
    const rec = new Recorder(cdp, "clip-split", clip, outDir, { x: xAt(mid) + 120, y: bateria.y - 40 });
    await rec.hold(0.4);
    await rec.clickAt({ x: xAt(mid), y: ruler.y + 30 });
    await rec.clickAt({ x: xAt(mid - 20), y: bateria.y + bateria.h / 2 });
    await rec.hold(0.4);
    await rec.key("s", 900);
    await rec.hold(1.2);
    if ((await view()).clips.length !== clipsBefore + 1) throw new Error("clip-split: clip was not split");
    await rec.encode();

    // 2) Move a clip to the track right above. A vertical clip drag stops at
    // the first folder row it meets, so the target must be adjacent: open
    // "Dios es Real" and use its last child, which sits on top of Batería.
    void drums;
    const folderToggle = await runInPage(() => {
      const header = Array.from(document.querySelectorAll(".lt-track-header.is-folder")).find(
        (h) => (h.querySelector(".lt-track-title-row strong")?.textContent ?? "").trim() === "Dios es Real",
      );
      const toggle = header?.querySelector(".lt-folder-toggle") as HTMLElement | null;
      if (!toggle) return false;
      if (toggle.textContent?.trim() === "+") toggle.click();
      return true;
    });
    if (!folderToggle) throw new Error("no Dios es Real folder");
    await browser.pause(1500);
    const tracksNow = (await view()).tracks;
    const bateriaIdx = tracksNow.findIndex((t) => t.name === "Batería");
    const above = tracksNow[bateriaIdx - 1];
    if (!above || above.kind === "folder") throw new Error("no audio track right above Batería");
    const bateriaId = tracksNow[bateriaIdx].id;
    const left = (await view()).clips
      .filter((c) => c.trackId === bateriaId)
      .sort((a2, b2) => a2.timelineStartSeconds - b2.timelineStartSeconds)[0];
    const bRow = await rectOf(await headerOf("Batería", "bateria"));
    if (!left || !bRow) throw new Error("no clip to move");
    const upRow = { y: bRow.y - bRow.h / 2 };
    const clip2 = { x: clip.x, y: Math.max(0, bRow.y - 260), w: clip.w, h: 420 };
    const rec2 = new Recorder(cdp, "clip-to-track", clip2, outDir, { x: xAt(left.timelineStartSeconds + 40), y: bRow.y + 120 });
    await rec2.hold(0.4);
    const grab = { x: xAt(left.timelineStartSeconds + 15), y: bRow.y + bRow.h / 2 };
    await rec2.dragTo({ x: grab.x, y: upRow.y }, 1000, { from: grab });
    await rec2.hold(1.2);
    const after = (await view()).clips.find((c) => c.id === left.id);
    if (after?.trackId !== above.id) throw new Error(`clip-to-track: clip stayed on ${after?.trackId}`);
    await rec2.encode();

    // 3) Reorder: drag "Drums" above the folder right on top of it.
    const names = async () => (await view()).tracks.map((t) => t.name);
    const orderBefore = await names();
    const drumsHead = await rectOf(await headerOf("Drums", "drums"));
    const folderAbove = await rectOf(await headerOf("Único Dios", "unico"));
    if (!drumsHead || !folderAbove) throw new Error("no headers to reorder");
    const rec3 = new Recorder(
      cdp,
      "track-reorder",
      { x: 80, y: Math.max(0, folderAbove.y - 200), w: 900, h: 420 },
      outDir,
      { x: drumsHead.x + 180, y: drumsHead.y + 120 },
    );
    await rec3.hold(0.4);
    const from = { x: drumsHead.x + 70, y: drumsHead.y + 12 };
    await rec3.dragTo({ x: from.x, y: folderAbove.y + 4 }, 1100, { from });
    await rec3.hold(1.2);
    const orderAfter = await names();
    if (orderAfter.join("|") === orderBefore.join("|")) throw new Error("track-reorder: order did not change");
    await rec3.encode();
  });

  it("clips: tempo", async () => {
    await ensureSession();
    await AppPage.resetShell();
    const view = async () => (await AppPage.songView())!;
    const song = (await view()).regions.find((r) => r.name === "Único Dios");
    if (!song) throw new Error("no Único Dios");
    await setTimelineView({ zoomLevel: 0.25 });
    await browser.pause(800);
    const cam = Math.max(0, song.startSeconds * 0.25 * 18 - 120);
    await setTimelineView({ cameraX: cam });
    const lanes = await rectOf(".lt-track-layers");
    const ruler = await rectOf(tour("timeline-ruler"));
    if (!lanes || !ruler) throw new Error("no ruler");
    const xAt = (seconds: number) => lanes.x + seconds * 0.25 * 18 - cam;
    const clip = { x: lanes.x - 40, y: ruler.y - 10, w: 1000, h: 300 };
    const at = song.startSeconds + (song.endSeconds - song.startSeconds) * 0.45;
    const replaceDialogValue = async (rec: Recorder, value: string) => {
      await (await $("#lt-dialog-input")).waitForDisplayed({ timeout: 5000 });
      await browser.keys(["Control", "a"]);
      await browser.keys(["Control"]);
      await rec.type(value);
      await rec.hold(0.4);
      await rec.key("Enter", 900);
    };

    const tempoBefore = (await view()).tempoMarkers.length;
    const rec = new Recorder(cdp, "tempo-change", clip, outDir, { x: xAt(at) + 160, y: ruler.y + 200 });
    await rec.hold(0.4);
    await rec.rightClick({ x: xAt(at), y: ruler.y + 30 });
    await rec.click(await tagByText(".lt-context-menu button", "Cambiar BPM del timeline", "menu-item"));
    await replaceDialogValue(rec, "132");
    await rec.hold(1.4);
    if ((await view()).tempoMarkers.length !== tempoBefore + 1) throw new Error("tempo-change: no tempo marker created");
    await rec.encode();

    const sigBefore = (await view()).timeSignatureMarkers.length;
    const at2 = song.startSeconds + (song.endSeconds - song.startSeconds) * 0.7;
    const rec2 = new Recorder(cdp, "time-signature-change", clip, outDir, { x: xAt(at2) + 160, y: ruler.y + 200 });
    await rec2.hold(0.4);
    await rec2.rightClick({ x: xAt(at2), y: ruler.y + 30 });
    await rec2.click(await tagByText(".lt-context-menu button", "Crear marca de comp", "menu-item"));
    await replaceDialogValue(rec2, "6/8");
    await rec2.hold(1.4);
    if ((await view()).timeSignatureMarkers.length !== sigBefore + 1) {
      throw new Error("time-signature-change: no time signature marker created");
    }
    await rec2.encode();
  });

  it("clips: pitch and warp", async () => {
    await ensureSession();
    await AppPage.resetShell();
    const view = async () => (await AppPage.songView())!;
    const regionNamed = async (name: string) => (await view()).regions.find((r) => r.name === name)!;
    // Each block frames the timeline itself: the previous one may have left
    // the camera scrolled away from what this one needs.
    await setTimelineView({ zoomLevel: 0.0625 });
    await browser.pause(800);
    await setTimelineView({ cameraX: 0 });
    const before = await regionNamed("Voy Cantando");
    if (!before) throw new Error("no Voy Cantando");
    const toolbar = await rectOf(".lt-timeline-topline");
    const ruler = await rectOf(tour("timeline-ruler"));
    const vp = await viewport();
    if (!toolbar || !ruler) throw new Error("no toolbar");
    const lastRight = await runInPage(() =>
      Math.max(...Array.from(document.querySelectorAll(".lt-region-hotspot")).map((el) => el.getBoundingClientRect().right)),
    );
    // From the toolbar down to the first lanes, and only as wide as the songs:
    // full width shrinks the change out of sight at column size.
    const clipLeft = Math.max(0, ruler.x - 20);
    const clip = {
      x: clipLeft,
      y: toolbar.y - 6,
      w: Math.min(vp.w - clipLeft, lastRight + 160 - clipLeft),
      h: ruler.y + ruler.h + 60 - toolbar.y,
    };
    const bar = await runInPage(() => {
      const bars = Array.from(document.querySelectorAll(".lt-region-hotspot"));
      bars.forEach((el) => el.removeAttribute("data-guide"));
      const target = bars.find((el) => (el.textContent ?? "").includes("Voy Cantando"));
      target?.setAttribute("data-guide", "voy");
      return Boolean(target);
    });
    if (!bar) throw new Error("no Voy Cantando bar");

    // 1) +2 semitones with warp off: varispeed, the song gets shorter.
    const rec = new Recorder(cdp, "transpose-varispeed", clip, outDir, { x: vp.w * 0.6, y: ruler.y + 120 });
    await rec.hold(0.5);
    await rec.click('[data-guide="voy"]');
    await rec.click(`${tour("toolbar-transpose")} .lt-control-popover-trigger`);
    const up = 'button[aria-label="Subir un semitono la region seleccionada"]';
    await rec.click(up, 900);
    await rec.click(up, 1200);
    await rec.hold(1.6);
    const afterPitch = await regionNamed("Voy Cantando");
    if (afterPitch.transposeSemitones !== 2) throw new Error(`transpose: semitones ${afterPitch.transposeSemitones}`);
    const shorter = afterPitch.endSeconds - afterPitch.startSeconds < before.endSeconds - before.startSeconds - 1;
    if (!shorter) throw new Error("transpose: song did not get shorter without warp");
    await rec.encode();
    await closeToolbarGroup("toolbar-transpose");

    // 2) Warp on: the song keeps the new key and gets its length back.
    const rec2 = new Recorder(cdp, "warp-on", clip, outDir, { x: vp.w * 0.6, y: ruler.y + 120 });
    await rec2.hold(0.5);
    await rec2.click(`${tour("toolbar-warp")} .lt-control-popover-trigger`);
    await rec2.click('button[aria-label="Activar warp en la region seleccionada"]', 1500);
    await rec2.hold(1.8);
    const afterWarp = await regionNamed("Voy Cantando");
    if (!afterWarp.warpEnabled) throw new Error("warp: not enabled");
    const restored =
      Math.abs(afterWarp.endSeconds - afterWarp.startSeconds - (before.endSeconds - before.startSeconds)) < 1;
    if (!restored) throw new Error("warp: song length was not restored");
    await rec2.encode();
    await closeToolbarGroup("toolbar-warp");
  });

  it("popovers and routing", async () => {
    await ensureSession();
    await AppPage.resetShell();

    /** Opens a topbar popover by its arrow and captures it, a screenful at a time. */
    const popoverShots = async (splitId: string, name: string) => {
      // Voice guide and pads hide their settings while off: switch them on
      // for the capture and back off afterwards.
      const toggle = await $(`${tour(splitId)} > button:nth-of-type(1)`);
      const wasOn = ((await toggle.getAttribute("class")) ?? "").includes("is-active");
      if (!wasOn && splitId !== "topbar-metronome") {
        await toggle.click();
        await browser.pause(1200);
      }
      await (await $(`${tour(splitId)} > button:nth-of-type(2)`)).click();
      await browser.pause(800);
      const pages = await runInPage(() => {
        const panel = document.querySelector(".lt-pads-popover") as HTMLElement | null;
        if (!panel) return 0;
        const scroller =
          (Array.from(panel.querySelectorAll<HTMLElement>("*")).find((el) => el.scrollHeight > el.clientHeight + 8 &&
            getComputedStyle(el).overflowY !== "visible") ?? panel);
        scroller.setAttribute("data-guide", "pop-scroller");
        scroller.scrollTop = 0;
        const overflow = scroller.scrollHeight - scroller.clientHeight;
        return overflow <= 8 ? 1 : Math.min(4, 1 + Math.ceil(overflow / (scroller.clientHeight - 60)));
      });
      if (!pages) throw new Error(`${name}: popover did not open`);
      for (let page = 0; page < pages; page++) {
        await runInPage((p: number) => {
          const sc = document.querySelector('[data-guide="pop-scroller"]') as HTMLElement | null;
          if (sc) sc.scrollTop = p * (sc.clientHeight - 60);
        }, page);
        await browser.pause(300);
        await annotatedShot(`${name}${pages > 1 ? `-${page + 1}` : ""}`, [{ selector: ".lt-pads-popover", pad: 2 }], {
          style: "spotlight",
          crop: { marks: 24 },
        });
      }
      await browser.keys(["Escape"]);
      await browser.pause(400);
      if (!wasOn && splitId !== "topbar-metronome") {
        await toggle.click();
        await browser.pause(600);
      }
    };

    await popoverShots("topbar-metronome", "metronome-popover");
    await popoverShots("topbar-voice-guide", "voice-guide-popover");
    await popoverShots("topbar-pads", "pads-popover");

    // The pad manager (official packs + the user's own pads).
    const padToggle = await $(`${tour("topbar-pads")} > button:nth-of-type(1)`);
    const padWasOn = ((await padToggle.getAttribute("class")) ?? "").includes("is-active");
    if (!padWasOn) {
      await padToggle.click();
      await browser.pause(1200);
    }
    await (await $(`${tour("topbar-pads")} > button:nth-of-type(2)`)).click();
    await browser.pause(700);
    await (await $(await tagByText(".lt-pads-popover button", "Gestor de pads", "pad-manager"))).click();
    await browser.pause(1200);
    await shot("pad-manager", { selector: '.lt-modal-backdrop [role="dialog"], .lt-modal-backdrop section', margin: 12 });
    await browser.keys(["Escape"]);
    await browser.pause(500);
    await browser.keys(["Escape"]);
    if (!padWasOn) {
      await padToggle.click();
      await browser.pause(600);
    }

    // A track's output selector, open.
    // A track inside a folder: the case that also offers "Heredado (Carpeta)".
    await runInPage(() => {
      const header = Array.from(document.querySelectorAll(".lt-track-header.is-folder")).find(
        (h) => (h.querySelector(".lt-track-title-row strong")?.textContent ?? "").trim() === "Dios es Real",
      );
      const toggleEl = header?.querySelector(".lt-folder-toggle") as HTMLElement | null;
      if (toggleEl && toggleEl.textContent?.trim() === "+") toggleEl.click();
    });
    await browser.pause(1500);
    const track = await tagByText(".lt-track-header:not(.is-folder):not(.is-automation)", "Keys", "track");
    await (await $(`${track} .lt-audio-route-trigger`)).click();
    await browser.pause(600);
    await annotatedShot(
      "track-route-list",
      [
        { selector: `${track} .lt-audio-route-trigger`, pad: 2, noBox: true },
        { selector: ".lt-audio-route-list", pad: 2 },
      ],
      { style: "spotlight", crop: { marks: 30 } },
    );
    await browser.keys(["Escape"]);
  });

  it("midi", async () => {
    await ensureSession();
    await AppPage.resetShell();
    await setTimelineView({ zoomLevel: 0.25 });
    await browser.pause(800);
    await setTimelineView({ cameraX: 0 });
    // The MIDI clip on "MIDI Luces": its editor, opened from its menu.
    await rightClick(".lt-track-lane.is-midi .lt-automation-hotspot");
    await menuShot("menu-midi-clip", ".lt-track-lane.is-midi .lt-automation-hotspot");
    await rightClick(".lt-track-lane.is-midi .lt-automation-hotspot");
    await (await $(await tagByText(".lt-context-menu button", "Editar MIDI", "menu-item"))).click();
    await browser.pause(900);
    await shot("midi-clip-editor", { selector: '[role="dialog"]', margin: 12 });
    // The MIDI editor does not close on Escape: use its own Cancel button.
    await (await $(await tagByText('[role="dialog"] button', "Cancelar", "dialog-cancel"))).click();
    await browser.pause(500);

    // The MIDI track's own menu and its routing window.
    // The MIDI track row, not the automation lane (which shares the header class).
    const header = await tagByText(".lt-midi-track-header:not(.is-automation)", "MIDI Luces", "midi-header");
    // Aim at the name text: the header's centre is the power button.
    const name = `${header} .lt-midi-header-text`;
    await rightClick(name, { fx: 0.3 });
    await menuShot("menu-midi-track", header);
    await rightClick(name, { fx: 0.3 });
    await (await $(await tagByText(".lt-context-menu button", "Enrutado MIDI", "menu-item"))).click();
    await browser.pause(800);
    await shot("midi-route", { selector: '[aria-labelledby="lt-midi-route-title"]', margin: 12 });
    await (await $(await tagByText('[aria-labelledby="lt-midi-route-title"] button', "Cancelar", "dialog-cancel"))).click();
  });

  it("automation", async () => {
    await ensureSession();
    await AppPage.resetShell();
    await setTimelineView({ zoomLevel: 0.25 });
    await browser.pause(800);
    await setTimelineView({ cameraX: 0 });
    // A cue of the session: a click opens its editor.
    const cue = ".lt-track-lane.is-automation .lt-automation-cue-hotspot, .lt-track-lane.is-automation button";
    await (await $(cue)).click();
    await browser.pause(900);
    await shot("automation-cue-editor", { selector: '.lt-modal-backdrop [role="dialog"], .lt-modal-backdrop section', margin: 12 });
    await (await $(await tagByText(".lt-modal-backdrop button", "Cancelar", "dialog-cancel"))).click();
    await browser.pause(500);

    await rightClick(cue);
    await menuShot("menu-automation-cue", cue);

    // Mix scenes, from the automation header's menu.
    await rightClick(".lt-track-header.is-automation", { fx: 0.4 });
    await (await $(await tagByText(".lt-context-menu button", "Gestionar escenas", "menu-item"))).click();
    await browser.pause(900);
    // An empty manager explains nothing: create one scene to show its editor.
    await (await $(await tagByText(".lt-modal-backdrop button", "Nueva escena", "new-scene"))).click();
    await browser.pause(900);
    await shot("mix-scenes", { selector: '.lt-modal-backdrop [role="dialog"], .lt-modal-backdrop section', margin: 12 });
    await (await $(await tagByText(".lt-modal-backdrop button", "Cerrar", "dialog-close"))).click();
    await browser.pause(400);
  });

  it("compact and live views", async () => {
    await ensureSession();
    await AppPage.resetShell();
    const viewBtn = (n: number) => `${tour("view-mode-switcher")} button:nth-of-type(${n})`;

    await (await $(viewBtn(2))).click();
    await browser.pause(2000);
    const col = await tag(".lt-compact-song-column", "col0");
    await annotatedShot("compact-view", [
      { selector: `${col} .lt-song-reorder-handle`, n: 1, badge: "above", pad: 2 },
      { selector: `${col} .lt-compact-song-play`, n: 2, badge: "above", pad: 2 },
      { selector: `${col} .lt-compact-song-name`, n: 3, badge: "above" },
      { selector: `${col} .lt-compact-song-master, ${col} .lt-compact-song-fader`, n: 4, badge: "below" },
      { selector: `${col} .lt-compact-clip-entry`, n: 5 },
      { selector: ".lt-compact-column-resizer", n: 6, badge: "below", pad: 2 },
      { selector: ".lt-compact-view-add-song", n: 7 },
      { selector: ".lt-compact-view-import-song", n: 8 },
      { selector: ".lt-compact-mixer", n: 9, pad: 0 },
    ]);
    // The desktop mixer is always visible (the show/hide toggle is mobile only,
    // and ".lt-compact-mixer-toggle" also matches every strip's M/S buttons).
    const strip = await tag(".lt-compact-mixer-strip", "strip0");
    await annotatedShot(
      "compact-mixer",
      [
        { selector: `${strip} .lt-compact-mixer-strip-name`, n: 1, badge: "above" },
        { selector: `${strip} .lt-compact-mixer-strip-toggles`, n: 2, badge: "above" },
        { selector: `${strip} .lt-compact-mixer-pan`, n: 3 },
        { selector: `${strip} .lt-compact-mixer-fader`, n: 4 },
        { selector: `${strip} .lt-compact-mixer-audio-to`, n: 5, badge: "below" },
      ],
      { crop: { selector: ".lt-compact-mixer", margin: 12 } },
    );

    await (await $(viewBtn(3))).click();
    await browser.pause(2500);
    await annotatedShot("live-view", [
      { selector: ".lt-live-header", n: 1, pad: 2 },
      { selector: ".lt-live-settings", n: 2, pad: 2 },
      { selector: ".lt-live-cue-panel", n: 3, pad: 2 },
      { selector: ".lt-live-setlist", n: 4, pad: 2 },
    ]);
    await (await $(viewBtn(1))).click();
    await browser.pause(1200);
  });

  it("export, render and cloud", async () => {
    await ensureSession();
    await AppPage.resetShell();
    const clickItem = async (selector: string, text: string) => {
      await (await $(await tagByText(selector, text, "share-item"))).click();
      await browser.pause(1200);
    };
    const closeModal = async (modal: string) => {
      await (await $(await tagByText(`${modal} button`, "Cancelar", "share-cancel"))).click();
      await browser.pause(800);
    };

    // Song: export and render live in the song bar's menu.
    await rightClick(".lt-region-hotspot", { fx: 0.3 });
    await clickItem(".lt-context-menu button", "Exportar Cancion");
    const songModal = '[aria-labelledby="lt-export-modal-title"]';
    await annotatedShot(
      "export-song-modal",
      [
        { selector: `${songModal} .lt-export-option`, nth: 0, n: 1 },
        { selector: `${songModal} .lt-export-option`, nth: 1, n: 2 },
      ],
      { crop: { selector: songModal, margin: 16 } },
    );
    await closeModal(songModal);

    await rightClick(".lt-region-hotspot", { fx: 0.3 });
    await clickItem(".lt-context-menu button", "Renderizar audio");
    const renderModal = '[aria-labelledby="lt-render-modal-title"]';
    await annotatedShot(
      "render-modal",
      [
        { selector: `${renderModal} .lt-render-track-tools`, n: 1 },
        { selector: `${renderModal} .lt-render-track-list`, n: 2 },
        { selector: `${renderModal} .lt-export-option`, nth: 0, n: 3 },
        { selector: `${renderModal} .lt-export-option`, nth: 1, n: 4 },
        { selector: `${renderModal} .lt-render-grid`, n: 5 },
        { selector: `${renderModal} .lt-render-check`, nth: 0, n: 6 },
        { selector: `${renderModal} .lt-render-check`, nth: 1, n: 7 },
        { selector: `${renderModal} .lt-render-check`, nth: 2, n: 8 },
        { selector: `${renderModal} .lt-render-check`, nth: 3, n: 9 },
        { selector: `${renderModal} .lt-render-file-name`, n: 10 },
      ],
      { crop: { selector: renderModal, margin: 16 } },
    );
    await closeModal(renderModal);

    // Session: export and the cloud live in the File menu.
    const fileMenu = `${tour("topbar-file-menu")} .lt-top-menu-trigger`;
    await (await $(fileMenu)).click();
    await browser.pause(600);
    await clickItem(".lt-top-menu-dropdown button", "Exportar sesi");
    // With the cloud available, export (and import) ask where first.
    if (await rectOf(".lt-storage-choice-modal")) {
      await shot("storage-choice", { selector: ".lt-storage-choice-modal", margin: 16 });
      await clickItem(".lt-storage-choice-modal button", "Este equipo");
    }
    const sessionModal = '[aria-labelledby="lt-export-session-modal-title"]';
    await annotatedShot(
      "export-session-modal",
      [
        { selector: `${sessionModal} .lt-export-option`, nth: 0, n: 1 },
        { selector: `${sessionModal} .lt-export-option`, nth: 1, n: 2 },
        { selector: `${sessionModal} .lt-export-option`, nth: 2, n: 3 },
      ],
      { crop: { selector: sessionModal, margin: 16 } },
    );
    await closeModal(sessionModal);

    await (await $(fileMenu)).click();
    await browser.pause(600);
    await clickItem(".lt-top-menu-dropdown button", "Nube");
    // The harness runs with the developer's own Drive account: wait for the
    // lists, then blur everything that is theirs (space used, file names).
    for (let i = 0; i < 30; i++) {
      const loading = await runInPage(() =>
        Array.from(document.querySelectorAll(".lt-cloud-modal .lt-cloud-note")).some((n) => /cargando/i.test(n.textContent ?? "")),
      );
      if (!loading) break;
      await browser.pause(500);
    }
    await runInPage(() =>
      document
        .querySelectorAll<HTMLElement>(
          ".lt-cloud-modal .lt-cloud-quota > *:not(.lt-cloud-quota-bar):not(.lt-cloud-quota-hint), .lt-cloud-modal .lt-cloud-file-name, .lt-cloud-modal .lt-cloud-file-meta, .lt-cloud-modal .lt-cloud-file-size",
        )
        .forEach((el) => {
          el.style.filter = "blur(6px)";
        }),
    );
    await shot("cloud-panel", { selector: ".lt-cloud-modal", margin: 16 });
    await (await $(".lt-cloud-modal .lt-settings-modal-close")).click();
    await browser.pause(600);
  });
});
