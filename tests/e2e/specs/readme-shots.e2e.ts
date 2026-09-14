import { browser, $, $$ } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { findChrome, withHeadlessPage, type CdpPage } from "../utils/headlessChrome.js";

/**
 * Not a test — the screenshot harness for the two READMEs, and the third
 * sibling of marketing-shots.e2e.ts (promo material, gitignored) and
 * doc-shots.e2e.ts (website docs). This one writes the images the repo front
 * page shows, so what it produces is committed.
 *
 * It asserts nothing, so it must NOT run as part of the suite: `npm run
 * test:e2e` globs `specs/**\/*.e2e.ts`, which would match this file. The guard
 * below skips it unless LT_README_SHOTS=1 is set. Run it with:
 *
 *   LT_README_SHOTS=1 LT_SHOTS_SESSION="<a COPY of a .ltsession>" \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/readme-shots.e2e.ts
 *
 * WHERE THE IMAGES LAND, and why it is asymmetric: the Spanish set overwrites
 * `screenshots/*.png` in place because README.es.md *and both user manuals*
 * already point there, and the English set goes to `screenshots/en/` for
 * README.md. Overwriting the root files with English images would silently
 * translate the Spanish manual's illustrations.
 *
 * Each shot is taken twice, once per app language, from a single session load:
 * the app locale is switched through Settings > General between passes, which
 * is the same path a user takes, and the original locale is restored at the end
 * (the E2E app shares the developer's real app settings).
 *
 * Locators here avoid Spanish aria-labels on purpose — half of these shots are
 * taken with the app in English, which breaks most of AppPage's getters.
 */

type Locale = "es" | "en";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

// A real multi-song set beats the 5-stem demo: the compact and live views are
// about running a repertoire, and they photograph empty without one.
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

const screenshotsRoot =
  process.env.LT_README_SHOTS_DIR ?? path.join(repoRoot, "screenshots");

const languages = (process.env.LT_README_SHOTS_LANGS ?? "es,en")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is Locale => value === "es" || value === "en");

/** Where the empty session used for the "Vacio" shot is created. */
const workDir =
  process.env.LT_README_SHOTS_WORKDIR ?? path.join(tmpdir(), "lt-readme-shots");

const outDirFor = (locale: Locale) =>
  locale === "es" ? screenshotsRoot : path.join(screenshotsRoot, locale);

async function shot(locale: Locale, name: string) {
  await browser.pause(600); // let canvas/waveform paint settle
  // The status overlay shows whatever the last action was ("Selections
  // cleared." after the Escape that closes Settings), which dates the image
  // with a message that has nothing to do with what it illustrates.
  await browser.execute(() => {
    document
      .querySelectorAll<HTMLElement>(".lt-status-overlay")
      .forEach((element) => {
        element.style.visibility = "hidden";
      });
  });
  await browser.saveScreenshot(path.join(outDirFor(locale), `${name}.png`));
  console.log(`[readme-shots] ${locale}/${name}.png`);
}

/** Side-nav settings button — `data-lt-tour` is the only language-proof anchor. */
const settingsNavButton = () => $('[data-lt-tour="side-nav-settings"]');

/** Current app locale as persisted in app settings ("" means "system default"). */
async function persistedLocale(): Promise<string> {
  const settings = await browser.execute(
    () =>
      (
        window as unknown as {
          __ltE2E: { getSettings: () => Promise<{ locale?: string | null }> };
        }
      ).__ltE2E.getSettings(),
  );
  return settings?.locale ?? "";
}

/**
 * Switch the app language through the real Settings control and wait until the
 * UI has actually re-rendered in it (the side-nav label is the cheapest proof).
 */
async function setLocale(locale: Locale) {
  if ((await persistedLocale()) !== locale) {
    const nav = await settingsNavButton();
    await nav.waitForClickable({ timeout: 20_000 });
    await nav.click();

    const generalTab = await $("#lt-settings-tab-general");
    await generalTab.waitForClickable({ timeout: 15_000 });
    await generalTab.click();
    const panel = await $("#lt-settings-panel-general");
    await panel.waitForDisplayed({ timeout: 15_000 });

    // The language <select> is the one offering both locales; matching on that
    // rather than on position keeps it working when General grows a field.
    const select = await panel.$('select:has(option[value="es"])');
    await select.waitForDisplayed({ timeout: 15_000 });
    await select.selectByAttribute("value", locale);

    await browser.waitUntil(async () => (await persistedLocale()) === locale, {
      timeout: 20_000,
      timeoutMsg: `settings never persisted locale=${locale}`,
    });
    await browser.keys(["Escape"]); // close Settings
  }

  await browser.waitUntil(
    async () => {
      const label = await (await settingsNavButton()).getAttribute("aria-label");
      return label === (locale === "es" ? "Configuracion" : "Settings");
    },
    { timeout: 20_000, timeoutMsg: `UI never re-rendered in ${locale}` },
  );
  await browser.pause(400);
}

/** DAW / Compact / Live buttons, in that order — addressed by position. */
async function switchView(mode: "daw" | "compact" | "live") {
  const buttons = await $$(".lt-view-mode-switcher button").getElements();
  if (buttons.length !== 3) {
    throw new Error(`expected 3 view-mode buttons, found ${buttons.length}`);
  }
  await buttons[{ daw: 0, compact: 1, live: 2 }[mode]]!.click();
  await browser.pause(1200);
}

/**
 * Expand every collapsed folder in the track headers. The session is saved with
 * its folders closed, which photographs as rows of empty lanes: the arrangement
 * shot exists to show clips and waveforms, so open them first.
 */
async function expandTrackFolders() {
  for (let pass = 0; pass < 6; pass += 1) {
    const expanded = await browser.execute(() => {
      const toggle = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".lt-folder-toggle"),
      ).find((button) => button.textContent?.trim() === "+");
      if (!toggle) return false;
      toggle.click();
      return true;
    });
    if (!expanded) break;
    await browser.pause(500);
  }
  await browser.pause(1500); // waveforms for the revealed lanes
}

/**
 * Click a transport button by its Material icon name. The aria-labels are
 * translated, the icon names are not — which is the whole point here.
 */
async function clickTransportIcon(icon: string) {
  const clicked = await browser.execute((iconName: string) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".lt-transport-buttons button"),
    ).find(
      (candidate) =>
        candidate.querySelector(".material-symbols-outlined")?.textContent?.trim() ===
        iconName,
    );
    if (!button) return false;
    button.click();
    return true;
  }, icon);
  if (!clicked) throw new Error(`transport button "${icon}" not found`);
}

/** Play until a track is audibly rendering, so meters photograph lit. */
async function playUntilAudible() {
  await clickTransportIcon("play_arrow");
  const song = await AppPage.songView();
  const audible = song?.tracks.find((track) => track.kind === "audio" && !track.muted);
  if (audible) {
    try {
      await AppPage.waitForTrackSignal(audible.id, 0.01, 25_000);
    } catch {
      console.log("[readme-shots] no track signal; capturing anyway");
    }
  }
  await browser.pause(1500);
}

async function stopPlayback() {
  await clickTransportIcon("stop");
  await browser.waitUntil(
    async () => (await AppPage.transportSnapshot()).playbackState === "stopped",
    { timeout: 20_000, timeoutMsg: "engine did not stop" },
  );
}

/**
 * How tall the Remote's own content is, in CSS pixels. The Controls tab lays
 * out in fixed rows, so on a tall window it leaves a third of the frame black;
 * the capture is clipped to this instead of guessing a height, because the tab
 * is as tall as the set has markers.
 *
 * It measures the placed WIDGETS, not the shell: the layout canvas is a grid
 * that spans the viewport whatever it holds, so measuring the container just
 * reports the window height back and trims nothing. And it clips rather than
 * resizing the window — the widgets stretch to the viewport, so a shorter
 * window yields a shorter marker grid with its last row cut in half.
 */
async function remoteContentHeight(page: CdpPage): Promise<number | undefined> {
  const bottom = await page.evaluate<number>(
    `(() => {
       let bottom = 0;
       document.querySelectorAll('.layout-widget').forEach((element) => {
         const rect = element.getBoundingClientRect();
         if (rect.width > 0 && rect.height > 0) bottom = Math.max(bottom, rect.bottom);
       });
       return Math.ceil(bottom);
     })()`,
  );
  console.log(`[readme-shots] remote content bottom=${bottom}`);
  return bottom > 0 ? bottom + 16 : undefined;
}

describe("readme screenshots", function () {
  let originalLocale = "";

  before(async function () {
    if (process.env.LT_README_SHOTS !== "1") {
      this.skip();
    }
    for (const locale of languages) mkdirSync(outDirFor(locale), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    await AppPage.waitUntilBooted();
    // 16:10 — the ratio the README table renders these at.
    await browser.setWindowSize(1440, 900);
    originalLocale = await persistedLocale();
    console.log(`[readme-shots] languages=${languages.join(",")} locale was "${originalLocale}"`);
  });

  after(async function () {
    if (process.env.LT_README_SHOTS !== "1") return;
    // The harness drives the developer's real app settings; put the language
    // back the way it was found.
    if (originalLocale === "es" || originalLocale === "en") {
      await setLocale(originalLocale);
    }
  });

  // Landing first, while no session is open: there is no way back to this
  // screen once one is, short of restarting the app.
  it("captures the landing screen", async () => {
    for (const locale of languages) {
      await setLocale(locale);
      await AppPage.resetShell();
      await shot(locale, "Inicio");
    }
  });

  it("captures an empty session", async () => {
    await AppPage.createSession("Demo", workDir);
    await browser.pause(1500);
    for (const locale of languages) {
      await setLocale(locale);
      await AppPage.resetShell();
      await shot(locale, "Vacio");
    }
  });

  it("captures the DAW, compact and live views", async () => {
    await AppPage.reopenSessionUntil(
      demoSession,
      (song) => song.tracks.length >= 5 && song.clips.length >= 5,
      180_000,
    );
    await AppPage.resetShell();
    const song = await AppPage.songView();
    console.log(
      `[readme-shots] tracks=${song?.tracks.length} clips=${song?.clips.length} ` +
        `regions=${song?.regions.length} markers=${song?.sectionMarkers.length}`,
    );
    await browser.pause(6000); // a big session needs a moment to paint waveforms
    await expandTrackFolders();

    for (const locale of languages) {
      await setLocale(locale);

      await switchView("daw");
      await shot(locale, "Proyecto");

      await switchView("compact");
      await playUntilAudible();
      await shot(locale, "Compacta");
      await stopPlayback();

      await switchView("live");
      await shot(locale, "Live");

      await switchView("daw");
    }
  });

  /**
   * The Remote is a web surface the desktop serves on :3030 while it runs, so
   * it can only be captured from inside this spec — once the suite ends, the
   * app exits and the server with it. Headless Chrome renders it at tablet
   * size, and CDP presses the Mixer tab for the second shot.
   */
  it("captures the mobile Remote", async () => {
    const chromePath = findChrome();
    if (!chromePath) {
      console.log("[readme-shots] no Chrome/Edge found; skipping Remote captures");
      return;
    }
    // Open the Remote panel once so the desktop is definitely serving.
    await (await $('[data-lt-tour="side-nav-remote"]')).click();
    await browser.pause(2000);
    await AppPage.resetShell();

    // A live transport photographs better than an idle one.
    await playUntilAudible();
    try {
      for (const locale of languages) {
        await withHeadlessPage(
          {
            chromePath,
            url: "http://127.0.0.1:3030",
            // Tablet landscape: the default layout is authored wide, and a
            // phone-shaped landscape window trips the Remote's rotate guard.
            // Tall on purpose — the Controls tab is then trimmed to its own
            // content below rather than photographed against dead black.
            width: 1180,
            height: 900,
            deviceScaleFactor: 2,
            acceptLanguage: locale === "es" ? "es-ES,es;q=0.9" : "en-US,en;q=0.9",
          },
          async (page) => {
            await page.pause(4000); // let it connect and paint the live state
            await page.screenshot(
              path.join(outDirFor(locale), "Remote.png"),
              await remoteContentHeight(page),
            );
            console.log(`[readme-shots] ${locale}/Remote.png`);

            const tabs = await page.evaluate<string[]>(
              `Array.from(document.querySelectorAll('.layout-tabbar .layout-tab-select')).map((b) => b.textContent)`,
            );
            console.log(`[readme-shots] remote tabs: ${JSON.stringify(tabs)}`);
            // Default layout is [Controls, Mixer, Tools]; index 1 is the mixer.
            const switched = await page.evaluate<boolean>(
              `(() => {
                 const tabs = Array.from(document.querySelectorAll('.layout-tabbar .layout-tab-select'));
                 if (tabs.length < 2) return false;
                 tabs[1].click();
                 return true;
               })()`,
            );
            if (!switched) {
              console.log("[readme-shots] no Mixer tab found; skipping Remote_Mixer");
              return;
            }
            // The mixer stretches its faders to fill the window, so it is
            // captured whole rather than clipped like the Controls tab.
            await page.pause(2500);
            await page.screenshot(path.join(outDirFor(locale), "Remote_Mixer.png"));
            console.log(`[readme-shots] ${locale}/Remote_Mixer.png`);
          },
        );
      }
    } finally {
      await stopPlayback();
    }
  });
});
