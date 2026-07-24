import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import { openClipContextMenu } from "./support.js";

export function registerSessionEditingFlows() {
  it("renames and deletes an empty track through its context menu", async () => {
    const songBefore = await AppPage.songView();
    const anchorTrack = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!anchorTrack) {
      throw new Error("The anchor track is missing before track editing");
    }

    const anchorHeader = await $(
      `.lt-track-header-row[data-track-id="${anchorTrack.id}"] .lt-track-header`,
    );
    await anchorHeader.click({ button: "right" });
    let menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Insertar track")).click();

    let input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Disposable");
    await (await $(".lt-dialog-button--primary")).click();

    let disposableId = "";
    await browser.waitUntil(
      async () => {
        const track = (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.name === "E2E Disposable",
        );
        disposableId = track?.id ?? "";
        return disposableId !== "";
      },
      {
        timeout: 30_000,
        timeoutMsg: "The disposable track was never created",
      },
    );

    const disposableHeader = await $(
      `.lt-track-header-row[data-track-id="${disposableId}"] .lt-track-header`,
    );
    await disposableHeader.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button*=Renombrar")).click();

    input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Renamed Track");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.some(
          (candidate) =>
            candidate.id === disposableId &&
            candidate.name === "E2E Renamed Track",
        ) === true,
      {
        timeout: 30_000,
        timeoutMsg: "Renaming the track did not reach the backend model",
      },
    );

    await disposableHeader.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Borrar")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.some(
          (candidate) => candidate.id === disposableId,
        ) === false,
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the empty track did not reach the backend model",
      },
    );
  });

  it("splits and duplicates a clip through timeline editing", async () => {
    const songBefore = await AppPage.songView();
    const originalClip = songBefore?.clips[0];
    if (!originalClip || songBefore.clips.length !== 1) {
      throw new Error("Expected one persisted clip before timeline editing");
    }

    const splitSeconds =
      originalClip.timelineStartSeconds + originalClip.durationSeconds / 2;
    const timelineView = await AppPage.timelineView();
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const splitFromLeft =
      splitSeconds * timelineView.zoomLevel * 18 - timelineView.cameraX;
    await ruler.click({
      x: Math.round(splitFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - splitSeconds,
        ) < 0.2,
      {
        timeout: 30_000,
        timeoutMsg: "The playhead did not reach the clip split point",
      },
    );

    let menu = await openClipContextMenu(originalClip);
    const splitButton = await menu.$("button*=Cortar en cursor");
    await splitButton.waitForClickable();
    await splitButton.click();
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 2,
      {
        timeout: 30_000,
        timeoutMsg: "Splitting the clip did not create two backend clips",
      },
    );

    const splitClips = [...((await AppPage.songView())?.clips ?? [])].sort(
      (left, right) => left.timelineStartSeconds - right.timelineStartSeconds,
    );
    expect(splitClips[0]?.timelineStartSeconds).toBeCloseTo(
      originalClip.timelineStartSeconds,
      3,
    );
    expect(splitClips[0]?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );
    expect(splitClips[1]?.timelineStartSeconds).toBeCloseTo(splitSeconds, 3);
    expect(splitClips[1]?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );

    const firstHalf = splitClips[0];
    if (!firstHalf) {
      throw new Error("The first split clip is missing before duplication");
    }
    const splitIds = new Set(splitClips.map((clip) => clip.id));
    menu = await openClipContextMenu(firstHalf);
    const duplicateButton = await menu.$("button*=Duplicar");
    await duplicateButton.waitForClickable();
    await duplicateButton.click();
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 3,
      {
        timeout: 30_000,
        timeoutMsg: "Duplicating the split clip did not update the backend model",
      },
    );

    const duplicate = (await AppPage.songView())?.clips.find(
      (clip) => !splitIds.has(clip.id),
    );
    expect(duplicate?.trackId).toBe(originalClip.trackId);
    expect(duplicate?.timelineStartSeconds).toBeCloseTo(splitSeconds, 3);
    expect(duplicate?.durationSeconds).toBeCloseTo(
      originalClip.durationSeconds / 2,
      3,
    );
  });
}
