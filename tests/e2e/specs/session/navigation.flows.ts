import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import { zoomTimelineWithWheel } from "./support.js";

export function registerSessionNavigationFlows() {
  it("seeks the engine and persists wheel zoom and horizontal pan", async () => {
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const viewBeforeSeek = await AppPage.timelineView();
    const song = await AppPage.songView();
    const clip = song?.clips[0];
    if (!clip) {
      throw new Error("No audio clip is available for timeline seek validation");
    }
    const seekSeconds =
      clip.timelineStartSeconds + Math.min(clip.durationSeconds / 2, 0.5);
    const seekFromLeft =
      seekSeconds * viewBeforeSeek.zoomLevel * 18 - viewBeforeSeek.cameraX;

    await ruler.click({
      x: Math.round(seekFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - seekSeconds,
        ) < 0.05,
      {
        timeout: 30_000,
        timeoutMsg: "Ruler seek never reached the native transport snapshot",
      },
    );

    const viewBeforeZoom = await AppPage.timelineView();
    await zoomTimelineWithWheel(ruler, -200);
    await browser.waitUntil(
      async () =>
        (await AppPage.timelineView()).zoomLevel > viewBeforeZoom.zoomLevel,
      {
        timeout: 10_000,
        timeoutMsg: "Ctrl+wheel did not commit a larger timeline zoom",
      },
    );

    const viewBeforePan = await AppPage.timelineView();
    await browser
      .action("wheel")
      .scroll({
        origin: ruler,
        deltaX: 240,
        deltaY: 0,
        duration: 100,
      })
      .perform();
    await browser.waitUntil(
      async () => (await AppPage.timelineView()).cameraX > viewBeforePan.cameraX,
      {
        timeout: 10_000,
        timeoutMsg: "Horizontal wheel did not commit the timeline camera pan",
      },
    );
  });

  it("routes Space shortcuts to audio playback but not text entry", async () => {
    const track = (await AppPage.songView())?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!track) {
      throw new Error("The audio track is missing before shortcut validation");
    }

    const trackHeader = await $(
      `.lt-track-header-row[data-track-id="${track.id}"]`,
    );
    const muteButton = await trackHeader.$("button=M");
    await muteButton.click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === track.id,
        )?.muted === false,
      {
        timeout: 30_000,
        timeoutMsg: "The track did not unmute before shortcut playback",
      },
    );

    await browser.keys(" ");
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "playing",
      {
        timeout: 30_000,
        timeoutMsg: "Space did not start playback in the native engine",
      },
    );
    await AppPage.waitForTrackSignal(track.id);

    await browser.keys(" ");
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "paused",
      {
        timeout: 30_000,
        timeoutMsg: "Space did not pause playback in the native engine",
      },
    );

    await trackHeader.click({ button: "right" });
    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button*=Renombrar")).click();
    const input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    const nameBeforeSpace = await input.getValue();
    await browser.keys(["Control", "End"]);
    await browser.keys(" ");
    expect(await input.getValue()).toBe(`${nameBeforeSpace} `);
    expect((await AppPage.transportSnapshot()).playbackState).toBe("paused");
    await browser.keys("Escape");
    await input.waitForExist({ reverse: true });

    await browser.keys(["Shift", " "]);
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      {
        timeout: 30_000,
        timeoutMsg: "Shift+Space did not stop the native engine",
      },
    );
  });
}
