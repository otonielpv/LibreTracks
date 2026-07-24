import { browser, expect, $, $$ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";

/**
 * Region key (musical note) flows. A region's original key is edited from its
 * timeline context menu — "Nota de la canción ▸" opens a submenu of the 24 keys
 * plus "Sin nota" (clear). Both edits are verified against the backend song
 * model's `region.key`, not just the badge, so we prove the command round-tripped.
 *
 * Runs after regions.flows.ts, which has already created at least one song
 * region on the shared canonical project; this flow reuses the first one.
 */
export function registerSessionKeyFlows() {
  it("sets and clears a region's key from its context menu", async () => {
    const song = await AppPage.songView();
    const region = song?.regions[0];
    if (!region) {
      throw new Error(
        "No song region exists — regions.flows.ts must run before key.flows.ts",
      );
    }

    // Right-click the region hotspot on the timeline's top lane.
    const hotspots = await $$(".lt-region-hotspot").getElements();
    expect(hotspots.length).toBeGreaterThan(0);
    await hotspots[0].click({ button: "right" });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    // The rendered label drops the accent ("Nota de la cancion"); match on an
    // accent-free substring so a locale accent tweak stays green.
    const keyEntry = await menu.$("button*=Nota de la");
    await keyEntry.waitForClickable();
    await keyEntry.click();

    // The key submenu lists raw key labels ("C", "G", "Dm", ...). Pick G.
    const keyMenu = await $(".lt-context-menu");
    await keyMenu.waitForDisplayed();
    const gKey = await keyMenu.$("button=G");
    await gKey.waitForClickable();
    await gKey.click();

    await browser.waitUntil(
      async () => {
        const updated = (await AppPage.songView())?.regions.find(
          (candidate) => candidate.id === region.id,
        );
        return updated?.key === "G";
      },
      {
        timeout: 30_000,
        timeoutMsg: "The region key edit never reached the backend song model",
      },
    );

    // Clear it again via "Sin nota" and confirm the model drops the key.
    await hotspots[0].click({ button: "right" });
    const menu2 = await $(".lt-context-menu");
    await menu2.waitForDisplayed();
    const keyEntry2 = await menu2.$("button*=Nota de la");
    await keyEntry2.waitForClickable();
    await keyEntry2.click();

    const keyMenu2 = await $(".lt-context-menu");
    await keyMenu2.waitForDisplayed();
    const noKey = await keyMenu2.$("button*=Sin nota");
    await noKey.waitForClickable();
    await noKey.click();

    await browser.waitUntil(
      async () => {
        const updated = (await AppPage.songView())?.regions.find(
          (candidate) => candidate.id === region.id,
        );
        return updated?.key === null;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Clearing the region key never reached the backend song model",
      },
    );
  });
}
