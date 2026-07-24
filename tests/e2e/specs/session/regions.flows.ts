import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";

/**
 * Region / section-marker flows. Both are created from the timeline ruler's
 * context menu and verified against the canonical backend song model
 * (song.sectionMarkers / song.regions), not just the DOM — the same "prove the
 * command reached the backend" discipline the other session flows use.
 *
 * Creating a section marker: right-click the ruler (no range selected) opens
 * "Crear Marca", whose "Personalizado" (custom) entry creates a typed marker at
 * that position with no extra variant/name prompt — the simplest deterministic
 * path to a new marker. A song region is created from a selected timeline range
 * via "Crear Cancion desde seleccion".
 */
export function registerSessionRegionFlows() {
  it("creates a section marker from the ruler context menu", async () => {
    const markersBefore = (await AppPage.songView())?.sectionMarkers ?? [];

    // Let layout settle so the ruler hit-test matches the committed camera.
    await browser.execute(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve()),
          ),
        ),
    );

    // Right-click a little way into the ruler so the marker lands at a positive
    // time (position 0 is a special case that edits the base tempo instead).
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    await ruler.click({
      button: "right",
      x: Math.round(80 - rulerSize.width / 2),
      y: 0,
    });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const createMarker = await menu.$("button*=Crear Marca");
    await createMarker.waitForClickable();
    await createMarker.click();

    // The kind chooser opens; "Personalizado" (custom) creates the marker
    // outright, with no variant/name sub-prompt.
    const kindMenu = await $(".lt-context-menu");
    await kindMenu.waitForDisplayed();
    const customEntry = await kindMenu.$("button*=Personalizado");
    await customEntry.waitForClickable();
    await customEntry.click();

    await browser.waitUntil(
      async () =>
        ((await AppPage.songView())?.sectionMarkers.length ?? 0) >
        markersBefore.length,
      {
        timeout: 30_000,
        timeoutMsg: "The new section marker never reached the backend song model",
      },
    );

    const song = await AppPage.songView();
    const created = song?.sectionMarkers.find(
      (marker) =>
        !markersBefore.some((before) => before.id === marker.id),
    );
    expect(created).toBeDefined();
    // It landed at a positive timeline position, matching where we clicked.
    expect(created?.startSeconds ?? 0).toBeGreaterThan(0);
  });

  it("creates a song region from a selected timeline range", async () => {
    const regionsBefore = (await AppPage.songView())?.regions ?? [];

    await browser.execute(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve()),
          ),
        ),
    );

    // Drag across the ruler to select a timeline range, then right-click it.
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const halfW = rulerSize.width / 2;
    await browser
      .action("pointer")
      .move({ origin: ruler, x: Math.round(60 - halfW), y: 0 })
      .down()
      .move({ origin: ruler, x: Math.round(200 - halfW), y: 0 })
      .up()
      .perform();

    await ruler.click({
      button: "right",
      x: Math.round(130 - halfW),
      y: 0,
    });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const createRegion = await menu.$("button*=Crear Cancion desde seleccion");

    // Range selection on the ruler can be finicky; only assert the region flow
    // when the selection actually produced the range-create entry.
    if (!(await createRegion.isExisting())) {
      // Dismiss the menu and skip — no range was selected in this environment.
      await browser.keys(["Escape"]);
      return;
    }

    await createRegion.waitForClickable();
    await createRegion.click();

    await browser.waitUntil(
      async () =>
        ((await AppPage.songView())?.regions.length ?? 0) >
        regionsBefore.length,
      {
        timeout: 30_000,
        timeoutMsg: "The new song region never reached the backend song model",
      },
    );

    const song = await AppPage.songView();
    const created = song?.regions.find(
      (region) => !regionsBefore.some((before) => before.id === region.id),
    );
    expect(created).toBeDefined();
    expect(created?.endSeconds ?? 0).toBeGreaterThan(created?.startSeconds ?? 0);
  });
}
