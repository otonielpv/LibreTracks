import { $, browser } from "@wdio/globals";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { remote } from "webdriverio";
import sharp from "sharp";
import AppPage from "../pageobjects/app.page.js";
import { unionBox } from "../utils/annotate.js";
import { drawMarks, OVERLAY_ID, type Box, type Mark } from "../utils/annotateOverlay.js";

/**
 * Not a test — captures the Remote (apps/remote) for the user guide, as a
 * tablet sees it: the desktop app serves the capture session and a second,
 * ordinary Edge with tablet emulation opens its Remote address.
 *
 *   LT_REMOTESHOTS=1 LT_SHOTS_SESSION=<copy of a real .ltsession> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/remote-shots.e2e.ts
 *
 * Output: apps/website/public/guide/remote/.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-remote-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const outDir = process.env.LT_REMOTESHOTS_DIR ?? path.join(repoRoot, "apps", "website", "public", "guide", "remote");

type Device = { name: string; width: number; height: number; dpr: number };
const TABLET: Device = { name: "tablet", width: 1180, height: 820, dpr: 2 };

let remoteUrl = "";

/**
 * msedgedriver matching the installed Edge. webdriverio's own pick lagged
 * behind (151 for an Edge 154); the Tauri service already downloaded the
 * right one for WebView2, which ships the same version as Edge.
 */
function edgeDriverPath(): string {
  const app = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application";
  const versions = readdirSync(app).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
  const major = Math.max(...versions.map((v) => Number(v.split(".")[0])));
  const root = path.join(os.tmpdir(), "msedgedriver");
  const candidates = readdirSync(root)
    .filter((d) => d.startsWith(`${major}-`) && existsSync(path.join(root, d, "msedgedriver.exe")))
    .map((d) => path.join(root, d, "msedgedriver.exe"))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error(`no msedgedriver ${major} under ${root}`);
  return candidates[0];
}

async function openRemote(device: Device) {
  const edge = await remote({
    logLevel: "warn",
    capabilities: {
      browserName: "MicrosoftEdge",
      "wdio:edgedriverOptions": { binary: edgeDriverPath() },
      "ms:edgeOptions": {
        args: ["--headless=new", "--hide-scrollbars", `--lang=es-ES`],
        mobileEmulation: {
          deviceMetrics: { width: device.width, height: device.height, pixelRatio: device.dpr, touch: true },
          userAgent:
            "Mozilla/5.0 (Linux; Android 14; SM-X810) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
        prefs: { intl: { accept_languages: "es-ES,es" } },
      },
    },
  });
  await edge.url(remoteUrl);
  await edge.pause(3000);
  return edge;
}

describe("remote guide shots", function () {
  before(async function () {
    if (process.env.LT_REMOTESHOTS !== "1") this.skip();
    if (!golden) throw new Error("LT_SHOTS_SESSION is required");
    rmSync(workDir, { recursive: true, force: true });
    cpSync(path.dirname(golden), workDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    await AppPage.waitUntilBooted();
    await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
    await browser.pause(3000);
    // The Remote panel lists the addresses; take the port from them and use
    // the loopback address (the LAN one is the same server).
    await (await $('[data-lt-tour="side-nav-remote"]')).click();
    await browser.pause(1500);
    const links = (await browser.execute(() =>
      Array.from(document.querySelectorAll('[aria-labelledby="lt-remote-modal-title"] a')).map((a) => (a as HTMLAnchorElement).href),
    )) as string[];
    const port = links.map((l) => /:(\d+)/.exec(new URL(l).host)?.[1]).find(Boolean);
    if (!port) throw new Error(`no remote address in ${JSON.stringify(links)}`);
    await browser.keys(["Escape"]);
    await browser.pause(500);
    remoteUrl = `http://127.0.0.1:${port}/`;
    console.log(`[remoteshots] ${remoteUrl}`);
  });

  let edge: WebdriverIO.Browser;

  /** browser.execute on the Remote with the `__name` shim (see annotate.ts). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function inRemote<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<T> {
    const script = `var __name = function (f) { return f; };
return (${fn.toString()}).apply(null, arguments);`;
    return edge.execute(script, ...args) as Promise<T>;
  }
  async function rectIn(selector: string): Promise<Box | null> {
    return inRemote((sel: string) => {
      const el = Array.from(document.querySelectorAll(sel)).find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, selector);
  }
  async function clickIn(selector: string, nth = 0, wait = 800) {
    const ok = await inRemote(
      (sel: string, i: number) => {
        const el = Array.from(document.querySelectorAll(sel)).filter((e) => e.getBoundingClientRect().width > 0)[i] as
          | HTMLElement
          | undefined;
        el?.click();
        return Boolean(el);
      },
      selector,
      nth,
    );
    if (!ok) throw new Error(`click: ${selector} #${nth} not visible`);
    await edge.pause(wait);
  }
  async function tab(index: number) {
    await clickIn(".layout-tab-select", index);
  }
  /** Annotated capture; `crop` is a selector (plus margin) or a box, in CSS px. */
  async function shot(name: string, marks: Mark[], crop?: { selector: string; margin?: number } | Box) {
    const drawn =
      marks.length > 0
        ? await inRemote(drawMarks, marks, "callouts", OVERLAY_ID).then((r: { drawn: Box[]; notFound: string[] }) => {
            if (r.notFound.length > 0) throw new Error(`${name}: no visible element for ${r.notFound.join(", ")}`);
            return r.drawn;
          })
        : [];
    await edge.pause(400);
    const png = Buffer.from(await edge.takeScreenshot(), "base64");
    await inRemote((id: string) => document.getElementById(id)?.remove(), OVERLAY_ID);
    const file = path.join(outDir, `${name}.png`);
    if (!crop) {
      await sharp(png).toFile(file);
    } else {
      const vp = { w: TABLET.width, h: TABLET.height };
      let box: Box;
      if ("selector" in crop) {
        const r = await rectIn(crop.selector);
        if (!r) throw new Error(`${name}: crop ${crop.selector} not visible`);
        box = unionBox([r, ...drawn], crop.margin ?? 12, vp);
      } else {
        box = crop;
      }
      const k = TABLET.dpr;
      await sharp(png)
        .extract({ left: Math.round(box.x * k), top: Math.round(box.y * k), width: Math.round(box.w * k), height: Math.round(box.h * k) })
        .toFile(file);
    }
    console.log(`[remoteshots] wrote ${name}.png`);
  }

  it("tablet", async () => {
    edge = await openRemote(TABLET);
    try {
      // Controls: every block of the default layout.
      await tab(0);
      await shot("remote-controls", [
        { selector: ".layout-tabbar", n: 1, pad: 2 },
        { selector: ".status-pill", n: 2 },
        { selector: ".layout-edit-button", n: 3 },
        { selector: ".remote-size-stepper", n: 4 },
        { selector: ".layout-widget-type-readouts", n: 5, pad: -2 },
        { selector: ".layout-widget-type-transportButtons", n: 6, pad: -2 },
        { selector: ".layout-widget-type-timeline", n: 7, pad: -2 },
        { selector: ".transport-control-card-group", nth: 0, n: 8, pad: -2 },
        { selector: ".transport-control-card-group", nth: 1, n: 9, pad: -2 },
        { selector: ".transport-control-card-song", n: 10, pad: -2 },
        { selector: ".remote-global-cancel-button", n: 11, pad: -2 },
        { selector: ".region-actions-row", n: 12, pad: -2 },
        { selector: ".jump-to-song-button", n: 13, pad: -2 },
        { selector: ".layout-widget-type-markerGrid", n: 14, pad: -2 },
      ]);

      // Mixer.
      await tab(1);
      await shot("remote-mixer", [
        { selector: ".mixer-filter-toggle", n: 1 },
        { selector: ".mixer-master-widget", n: 2 },
        { selector: ".mixer-strip-header", n: 3 },
        { selector: ".pan-section", n: 4 },
        { selector: ".volume-section", n: 5 },
        { selector: ".toggle-row", n: 6 },
        { selector: ".mixer-strip.is-folder", n: 7, pad: -2 },
      ]);

      // Tools.
      await tab(2);
      await shot("remote-tools", [
        { selector: ".layout-widget-type-metronomeSettings", n: 1, pad: -2 },
        { selector: ".layout-widget-type-voiceGuideSettings", n: 2, pad: -2 },
        { selector: ".layout-widget-type-pads", n: 3, pad: -2 },
      ]);

      // Edit mode: the widget palette first (it opens with the editor), then
      // the toolbar and a widget's own handles with the palette put away.
      await tab(0);
      await clickIn(".layout-edit-button", 0, 1200);
      await shot("remote-palette", [], { selector: ".layout-palette", margin: 4 });
      await clickIn(".layout-palette-close");
      await shot(
        "remote-edit",
        [
          { selector: ".layout-edit-done", n: 1 },
          { selector: ".layout-edit-cancel", n: 2 },
          { selector: ".layout-placement-toggle", n: 3 },
          { selector: ".layout-tab-height", n: 4 },
          { selector: ".layout-edit-toolbar-actions", n: 5 },
          { selector: ".layout-tab.is-active", n: 6, pad: 2 },
          { selector: ".layout-tab-add", n: 7 },
          { selector: ".layout-widget-drag", n: 8 },
          { selector: ".layout-widget-sizers", n: 9 },
          { selector: ".layout-widget-resize", n: 10 },
        ],
        { x: 0, y: 0, w: TABLET.width, h: 330 },
      );
      await clickIn(".layout-edit-cancel");
    } finally {
      await edge.deleteSession();
    }
  });
});
