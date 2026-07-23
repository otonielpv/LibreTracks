import { browser, $ } from "@wdio/globals";
import AppPage, {
  type E2ESongView,
} from "../../pageobjects/app.page.js";
import { AUDIO_FILE_NAME } from "./support.js";

export async function clickRangeEdge(
  range: ReturnType<typeof $>,
  edge: "start" | "end",
) {
  const size = await range.getSize();
  const inset = 3;
  await range.click({
    x:
      edge === "start"
        ? Math.round(-size.width / 2 + inset)
        : Math.round(size.width / 2 - inset),
    y: 0,
  });
}

export async function waitForStereoDirection(
  activeChannel: "leftPeak" | "rightPeak",
  silentChannel: "leftPeak" | "rightPeak",
) {
  let consecutiveSamples = 0;
  await browser.waitUntil(
    async () => {
      const meter = await AppPage.audioOutputMeter();
      if (
        meter[activeChannel] > 0.01 &&
        meter[silentChannel] <= 0.000_001
      ) {
        consecutiveSamples += 1;
      } else {
        consecutiveSamples = 0;
      }
      return consecutiveSamples >= 3;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "The native output never reached the expected stereo direction",
    },
  );
}

export async function waitForOutputSignal() {
  await browser.waitUntil(
    async () => {
      const meter = await AppPage.audioOutputMeter();
      return Math.max(meter.leftPeak, meter.rightPeak) > 0.01;
    },
    {
      timeout: 30_000,
      timeoutMsg: "The native output bus never emitted signal",
    },
  );
}

export async function waitForOutputSilence() {
  let consecutiveSamples = 0;
  await browser.waitUntil(
    async () => {
      const meter = await AppPage.audioOutputMeter();
      if (Math.max(meter.leftPeak, meter.rightPeak) <= 0.000_001) {
        consecutiveSamples += 1;
      } else {
        consecutiveSamples = 0;
      }
      return consecutiveSamples >= 3;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "The native output bus did not reach sustained silence",
    },
  );
}

export async function prepareMixerScenario(
  songBefore: E2ESongView,
  anchorTrack: E2ESongView["tracks"][number],
) {
  const anchorHeader = await $(
    `.lt-track-header-row[data-track-id="${anchorTrack.id}"] .lt-track-header`,
  );
  await anchorHeader.click({ button: "right" });
  const menu = await $(".lt-context-menu");
  await menu.waitForDisplayed();
  await (await menu.$("button=Insertar track")).click();

  const input = await $("#lt-dialog-input");
  await input.waitForDisplayed();
  await input.click();
  await browser.keys(["Control", "a"]);
  await browser.keys("E2E Solo Peer");
  await (await $(".lt-dialog-button--primary")).click();

  let peerTrackId = "";
  await browser.waitUntil(
    async () => {
      const peer = (await AppPage.songView())?.tracks.find(
        (candidate) => candidate.name === "E2E Solo Peer",
      );
      peerTrackId = peer?.id ?? "";
      return peerTrackId !== "";
    },
    {
      timeout: 30_000,
      timeoutMsg: "The peer track was never created for solo validation",
    },
  );

  const anchorClip = songBefore.clips.find(
    (candidate) => candidate.trackId === anchorTrack.id,
  );
  if (!anchorClip) {
    throw new Error("The anchor track has no clip for mixer validation");
  }

  const peerLane = await AppPage.trackLane(peerTrackId);
  const laneSize = await peerLane.getSize();
  const viewBeforeDrop = await AppPage.timelineView();
  const desiredCameraX = Math.max(
    0,
    anchorClip.timelineStartSeconds * viewBeforeDrop.zoomLevel * 18 -
      laneSize.width / 2,
  );
  const cameraDelta = Math.round(desiredCameraX - viewBeforeDrop.cameraX);
  if (cameraDelta !== 0) {
    await browser
      .action("wheel")
      .scroll({
        origin: peerLane,
        deltaX: cameraDelta,
        deltaY: 0,
        duration: 100,
      })
      .perform();
    await browser.waitUntil(
      async () =>
        Math.abs((await AppPage.timelineView()).cameraX - desiredCameraX) < 2,
      {
        timeout: 10_000,
        timeoutMsg: "The camera did not align with the anchor clip",
      },
    );
  }

  const asset = await AppPage.libraryAsset(AUDIO_FILE_NAME);
  await asset.dragAndDrop(peerLane);
  await browser.waitUntil(
    async () =>
      (await AppPage.songView())?.clips.length === songBefore.clips.length + 1,
    {
      timeout: 60_000,
      timeoutMsg: "The peer audio clip was never created",
    },
  );

  const songWithPeer = await AppPage.songView();
  const peerClip = songWithPeer?.clips.find(
    (candidate) => candidate.trackId === peerTrackId,
  );
  const overlap = songWithPeer?.clips
    .filter((candidate) => candidate.trackId === anchorTrack.id)
    .map((candidate) => ({
      start: Math.max(
        candidate.timelineStartSeconds,
        peerClip?.timelineStartSeconds ?? Number.POSITIVE_INFINITY,
      ),
      end: Math.min(
        candidate.timelineStartSeconds + candidate.durationSeconds,
        (peerClip?.timelineStartSeconds ?? 0) +
          (peerClip?.durationSeconds ?? 0),
      ),
    }))
    .find((candidate) => candidate.end - candidate.start > 0.25);
  if (!peerClip || !overlap) {
    throw new Error("The mixer clips do not overlap on the timeline");
  }

  const seekSeconds =
    overlap.start + Math.min((overlap.end - overlap.start) / 2, 0.5);
  const view = await AppPage.timelineView();
  const ruler = await AppPage.timelineRuler;
  const rulerSize = await ruler.getSize();
  const seekFromLeft = seekSeconds * view.zoomLevel * 18 - view.cameraX;
  const restartMixPlayback = async () => {
    if ((await AppPage.transportSnapshot()).playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
      );
    }
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
        timeoutMsg: "The engine never sought into the overlapping mixer clips",
      },
    );
    await browser.keys(" ");
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "playing",
    );
  };

  return { anchorHeader, peerTrackId, restartMixPlayback };
}
