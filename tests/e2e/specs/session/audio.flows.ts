import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  AUDIO_FILE_NAME,
  UNUSED_AUDIO_FILE_NAME,
  openClipContextMenu,
  type SessionFixture,
} from "./support.js";

export function registerSessionAudioFlows(fixture: SessionFixture) {
  it("adds an audio track through the timeline context menu", async () => {
    const headers = await AppPage.trackHeadersPane;
    await headers.click({ button: "right", x: 0, y: 50 });

    const menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    const addTrack = await menu.$("button=Añadir track de audio");
    await addTrack.waitForClickable();
    await addTrack.click();

    const input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Audio Track");
    await $(".lt-dialog-button--primary").click();

    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return song?.tracks.some((track) => track.name === "E2E Audio Track");
      },
      {
        timeout: 30_000,
        timeoutMsg: "The created track never reached the backend song model",
      },
    );

    const header = await $(".lt-track-header*=E2E Audio Track");
    await expect(header).toBeDisplayed();
  });

  it("imports audio into the enabled library without adding a clip", async () => {
    await AppPage.openLibrary();
    await expect(await AppPage.libraryImportButton).toBeEnabled();

    const clipsBefore = (await AppPage.songView())?.clips.length ?? 0;
    await AppPage.importLibraryAudio([
      fixture.audioFilePath,
      fixture.unusedAudioFilePath,
    ]);

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    await asset.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: "Imported audio never appeared in the library",
    });
    await (
      await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME)
    ).waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: "Unused imported audio never appeared in the library",
    });
    expect((await AppPage.songView())?.clips.length ?? 0).toBe(clipsBefore);
  });

  it("places library audio on the timeline and deletes the clip", async () => {
    const songBefore = await AppPage.songView();
    const track = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!track) {
      throw new Error("E2E Audio Track is missing before the timeline flow");
    }

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    const lane = await AppPage.trackLane(track.id);
    await asset.dragAndDrop(lane);

    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return (song?.clips.length ?? 0) === 1;
      },
      {
        timeout: 60_000,
        timeoutMsg: "Dragging the library asset did not create a timeline clip",
      },
    );

    const songWithClip = await AppPage.songView();
    const clip = songWithClip?.clips[0];
    if (!songWithClip || !clip) {
      throw new Error("Timeline clip disappeared before duplication");
    }
    const clipMenu = await openClipContextMenu(clip);
    expect(await clipMenu.getText()).toContain("Borrar");
    const deleteButton = await clipMenu.$("button*=Borrar");
    await deleteButton.waitForClickable();
    await deleteButton.click();

    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return (song?.clips.length ?? 0) === 0;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the clip did not update the backend song model",
      },
    );
  });

  it("mutes the real rendered track signal in the native engine", async () => {
    const songBefore = await AppPage.songView();
    const track = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!track) {
      throw new Error("E2E Audio Track is missing before the audio-meter flow");
    }

    const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
    const lane = await AppPage.trackLane(track.id);
    await asset.dragAndDrop(lane);
    await browser.waitUntil(
      async () => (await AppPage.songView())?.clips.length === 1,
      {
        timeout: 60_000,
        timeoutMsg: "The persisted clip was never created",
      },
    );

    const clip = (await AppPage.songView())?.clips[0];
    if (!clip) {
      throw new Error("The audio clip disappeared before playback");
    }

    const timelineView = await AppPage.timelineView();
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const pixelsPerSecond = timelineView.zoomLevel * 18;
    const seekSeconds =
      clip.timelineStartSeconds + Math.min(clip.durationSeconds / 2, 0.5);
    const seekFromLeft =
      seekSeconds * pixelsPerSecond - timelineView.cameraX;
    await ruler.click({
      x: Math.round(seekFromLeft - rulerSize.width / 2),
      y: 0,
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await AppPage.transportSnapshot()).positionSeconds - seekSeconds,
        ) < 0.2,
      {
        timeout: 30_000,
        timeoutMsg: "Timeline seek did not reach the imported audio clip",
      },
    );

    await (await AppPage.playButton).click();
    await AppPage.waitForTrackSignal(track.id);

    const trackHeader = await $(
      `.lt-track-header-row[data-track-id="${track.id}"]`,
    );
    const muteButton = await trackHeader.$("button=M");
    await muteButton.waitForClickable();
    await muteButton.click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === track.id,
        )?.muted === true,
      {
        timeout: 30_000,
        timeoutMsg: "The mute edit never reached the backend song model",
      },
    );

    await AppPage.waitForTrackSilence(track.id);

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "The engine did not stop after the audio-meter flow" },
    );
  });
}
