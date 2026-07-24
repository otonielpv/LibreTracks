import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";

/**
 * Automation lane flows: the synthetic automation track hosts cues (timed jobs
 * fired when the playhead reaches them) and is where mix scenes are managed.
 * Both are verified against the backend song model (song.automationCues /
 * song.mixScenes / song.automationTrack), the same "prove it reached the
 * backend" discipline as the other flows.
 *
 * Chain: add the automation track from a track's context menu, then right-click
 * the lane to create a cue and to open the mix-scene manager. Runs after audio
 * flows so at least one real track exists to anchor the automation track after.
 */
export function registerSessionAutomationFlows() {
  it("adds the automation track from a track context menu", async () => {
    const song = await AppPage.songView();
    const anchor = song?.tracks.find((t) => t.kind !== "folder");
    if (!anchor) {
      throw new Error("No track to anchor the automation track after");
    }
    if (song?.automationTrack) {
      // Already present from an earlier run of this shared session — fine.
      await expect(await $(".lt-track-lane.is-automation")).toBeDisplayed();
      return;
    }

    const header = await $(
      `.lt-track-header-row[data-track-id="${anchor.id}"] .lt-track-header`,
    );
    await header.click({ button: "right" });
    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const addAutomation = await menu.$("button*=pista de automatismos");
    await addAutomation.waitForClickable();
    await addAutomation.click();

    await browser.waitUntil(
      async () => Boolean((await AppPage.songView())?.automationTrack),
      {
        timeout: 30_000,
        timeoutMsg: "The automation track never reached the backend song model",
      },
    );
    await expect(await $(".lt-track-lane.is-automation")).toBeDisplayed();
  });

  it("creates an automation cue on the lane", async () => {
    const cuesBefore = (await AppPage.songView())?.automationCues?.length ?? 0;

    const lane = await $(".lt-track-lane.is-automation");
    await lane.waitForDisplayed({ timeout: 15_000 });
    // Right-click a little way into the lane so the cue lands at a positive time.
    const laneSize = await lane.getSize();
    await lane.click({
      button: "right",
      x: Math.round(60 - laneSize.width / 2),
      y: 0,
    });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const createCue = await menu.$("button*=Crear automatismo");
    await createCue.waitForClickable();
    await createCue.click();

    // The cue draft modal opens with a default action; confirm it.
    const confirm = await $(".lt-settings-modal .is-primary, .is-primary");
    await confirm.waitForClickable({ timeout: 15_000 });
    await confirm.click();

    await browser.waitUntil(
      async () =>
        ((await AppPage.songView())?.automationCues?.length ?? 0) > cuesBefore,
      {
        timeout: 30_000,
        timeoutMsg: "The new automation cue never reached the backend song model",
      },
    );
    const song = await AppPage.songView();
    expect((song?.automationCues?.length ?? 0)).toBeGreaterThan(cuesBefore);
    expect(song?.automationCues?.[0]?.atSeconds ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("creates a mix scene from the automation lane manager", async () => {
    const scenesBefore = (await AppPage.songView())?.mixScenes?.length ?? 0;

    // "Gestionar escenas" lives in the automation TRACK's context menu, opened
    // by right-clicking its header column (the track-info area), not the lane.
    // The synthetic automation track's header carries a stable is-automation
    // class, so we don't need its (synthetic) id from the model.
    const header = await $(".lt-track-header.is-automation");
    await header.waitForDisplayed({ timeout: 15_000 });
    await header.click({ button: "right" });
    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const manageScenes = await menu.$("button*=Gestionar escenas");
    await manageScenes.waitForClickable();
    await manageScenes.click();

    const newScene = await $("button*=Nueva escena");
    await newScene.waitForClickable({ timeout: 15_000 });
    await newScene.click();

    await browser.waitUntil(
      async () =>
        ((await AppPage.songView())?.mixScenes?.length ?? 0) > scenesBefore,
      {
        timeout: 30_000,
        timeoutMsg: "The new mix scene never reached the backend song model",
      },
    );
    expect((await AppPage.songView())?.mixScenes?.length ?? 0).toBeGreaterThan(
      scenesBefore,
    );

    // Close the scene manager so its backdrop doesn't intercept later clicks
    // (the modal closes via its "Cerrar" button, not Escape).
    const backdrop = await $(".lt-modal-backdrop");
    const closeButton = await backdrop.$("button*=Cerrar");
    await closeButton.waitForClickable({ timeout: 15_000 });
    await closeButton.click();
    await backdrop.waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: "The mix scene modal did not close",
    });
  });
}
