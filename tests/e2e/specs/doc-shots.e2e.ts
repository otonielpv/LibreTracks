import { browser, $ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";

/**
 * Not a test — a screenshot harness for the WEBSITE DOCUMENTATION, and the
 * sibling of marketing-shots.e2e.ts. Where that one captures promo material
 * into the gitignored `marketing/`, this one writes straight into
 * `apps/website/public/screenshots/`, so the images it produces are committed
 * and referenced from the docs pages.
 *
 * It asserts nothing, so it must NOT run as part of the suite: `npm run
 * test:e2e` globs `specs/**\/*.e2e.ts`, which would match this file. The guard
 * below skips it unless LT_DOCSHOTS=1 is set. Run it with:
 *
 *   LT_DOCSHOTS=1 npx wdio run tests/e2e/wdio.conf.ts \
 *     --spec tests/e2e/specs/doc-shots.e2e.ts
 *
 * Optional env: LT_SHOTS_SESSION (a .ltsession to open — use a COPY, the app
 * writes to whatever it opens) and LT_DOCSHOTS_DIR (output folder).
 *
 * Add a capture here when a release lands a feature the docs describe but
 * cannot show. Name files after the FEATURE, not the release, so a later
 * version can re-shoot the same image over the same filename and every docs
 * page that references it stays current.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

const demoSession =
  process.env.LT_SHOTS_SESSION ??
  path.join(
    repoRoot,
    "marketing",
    "video-intro-01",
    "session",
    "LibreTracks Demo",
    "LibreTracks Demo.ltsession",
  );

// Straight into the website's public assets: these images are committed.
const outDir =
  process.env.LT_DOCSHOTS_DIR ??
  path.join(repoRoot, "apps", "website", "public", "screenshots");

async function shot(name: string) {
  await browser.pause(600); // let canvas/waveform paint settle
  await browser.saveScreenshot(path.join(outDir, `${name}.png`));
  console.log(`[docshots] wrote ${name}.png`);
}

describe("documentation screenshots", function () {
  before(async function () {
    if (process.env.LT_DOCSHOTS !== "1") {
      this.skip();
    }
    mkdirSync(outDir, { recursive: true });
    await AppPage.waitUntilBooted();
    await browser.setWindowSize(1440, 900);
  });

  // v1.10.0 — autosave lives in Settings > General and is otherwise invisible,
  // so the docs need a picture of where the control actually is.
  it("captures the General settings tab with auto-save", async () => {
    await AppPage.openSettings();
    const general = await AppPage.settingsTab("general");
    await general.waitForClickable({ timeout: 15_000 });
    await general.click();
    const panel = await AppPage.settingsPanel("general");
    await panel.waitForDisplayed({ timeout: 15_000 });
    // The auto-save controls sit below the fold of the General panel, so a
    // plain capture photographs the top of the tab and misses the feature the
    // shot exists for. Scroll the panel to the control itself.
    await browser.execute(() => {
      // The scroller is the panel, not the page, so scroll it explicitly
      // rather than relying on scrollIntoView finding the right ancestor.
      const target = Array.from(
        document.querySelectorAll(".lt-settings-toggle, .lt-settings-field"),
      ).find((el) => /guardar autom/i.test(el.textContent ?? ""));
      // .lt-settings-tab-panels is the element that actually overflows; the
      // panel and its section are full-height and never scroll.
      const scroller = document.querySelector(".lt-settings-tab-panels");
      if (!target || !scroller) return;
      const t = target.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      scroller.scrollTop += t.top - s.top - 24;
    });
    // The audio-cache section shows a path containing the real Windows account
    // name, and this image is published on the website. Hide that whole
    // section: blanking the input is not enough (React repaints the value) and
    // targeting the input alone proved unreliable.
    await browser.execute(() => {
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".lt-settings-tab-panels .lt-settings-section, " +
            ".lt-settings-tab-panels .lt-settings-field",
        ),
      ).forEach((el) => {
        if (/cach[ée]|cache/i.test(el.textContent ?? "")) {
          el.style.visibility = "hidden";
        }
      });
    });
    await shot("Settings-General-Autosave");
    await AppPage.resetShell();
  });

  // v1.10.0 — resizable song columns. Shot from the compact view with a real
  // multi-song set so the columns and their master faders are all visible.
  it("captures the compact view song columns", async () => {
    await AppPage.reopenSessionUntil(
      demoSession,
      (song) => song.tracks.length >= 5 && song.clips.length >= 5,
      180_000,
    );
    await AppPage.resetShell();
    await browser.pause(6000); // waveforms

    // Do NOT synthesise extra song regions to fill the view: empty columns
    // photograph as an unfinished session, not as a feature. Point
    // LT_SHOTS_SESSION at a real multi-song set instead.
    const song = await AppPage.songView();
    console.log(
      `[docshots] songs=${song?.regions.length} tracks=${song?.tracks.length} ` +
        `clips=${song?.clips.length} markers=${song?.sectionMarkers.length}`,
    );

    const toggle = await $('button[aria-label="Cambiar a vista compacta"]');
    await toggle.waitForClickable({ timeout: 15_000 });
    await toggle.click();
    await browser.pause(1500);
    await shot("Compact-View-Song-Columns");

    await (await $('button[aria-label="Cambiar a vista DAW"]')).click();
    await browser.pause(800);
  });

  /**
   * v1.10.0 — the Remote now shows cue markers alongside section markers and
   * carries its own fonts, so it renders correctly with no internet. The
   * Remote is served on :3030 only while the desktop app runs, so it has to be
   * captured from inside this spec; Chrome headless renders it at phone size.
   *
   * The offline pass is the honest one for the docs: it is the venue case (a
   * phone on the PC's WiFi with no route out), and it is what the self-hosted
   * fonts fixed.
   */
  it("captures the Remote with cue markers", async () => {
    const chrome = [
      `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ].find((p) => existsSync(p));
    if (!chrome) {
      console.log("[docshots] Chrome not found; skipping Remote capture");
      return;
    }

    await (await AppPage.playButton).click();
    await browser.pause(2500);

    // One capture only, and a landscape one: the saved layout is authored on a
    // wide surface, so at a true phone width the columns clip and the marker
    // cards overlap the widgets above them — that photographs as a broken UI
    // rather than as the feature. The height is trimmed to the content so the
    // frame is not mostly empty background.
    for (const [name, w, h] of [["Remote-Markers-Tablet", 1100, 700]] as Array<
      [string, number, number]
    >) {
      execFileSync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          `--window-size=${w},${h}`,
          "--virtual-time-budget=9000",
          // No route to Google Fonts, like a venue WiFi. With the fonts served
          // locally the layout must be identical to the online render.
          "--host-resolver-rules=MAP fonts.googleapis.com 127.0.0.1:1",
          `--screenshot=${path.join(outDir, `${name}.png`)}`,
          "http://127.0.0.1:3030",
        ],
        { stdio: "ignore", timeout: 90_000 },
      );
      console.log(`[docshots] wrote ${name}.png`);
    }

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () => (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "engine did not stop" },
    );
  });
});
