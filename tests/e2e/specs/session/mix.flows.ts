import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  clickRangeEdge,
  prepareMixerScenario,
  waitForOutputSignal,
  waitForOutputSilence,
  waitForStereoDirection,
} from "./mix.support.js";
import type { SessionFixture } from "./support.js";

export function registerSessionMixFlows(fixture: SessionFixture) {
  it("applies solo, volume and pan to the real post-mix signal", async () => {
    if ((await AppPage.settings()).metronomeEnabled) {
      await (await AppPage.metronomeButton).click();
      await browser.waitUntil(
        async () => !(await AppPage.settings()).metronomeEnabled,
      );
    }

    const songBefore = await AppPage.songView();
    const anchorTrack = songBefore?.tracks.find(
      (candidate) => candidate.name === "E2E Audio Track",
    );
    if (!songBefore || !anchorTrack) {
      throw new Error("The anchor audio track is missing before mixer validation");
    }

    const { anchorHeader, peerTrackId, restartMixPlayback } =
      await prepareMixerScenario(songBefore, anchorTrack);

    await restartMixPlayback();
    await AppPage.waitForTrackSignal(anchorTrack.id);
    await AppPage.waitForTrackSignal(peerTrackId);

    const soloButton = await anchorHeader.$("button=S");
    await soloButton.click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.solo === true,
      {
        timeout: 30_000,
        timeoutMsg: "Solo never reached the backend song model",
      },
    );
    await AppPage.waitForTrackSignal(anchorTrack.id);
    await AppPage.waitForTrackSilence(peerTrackId);

    await restartMixPlayback();
    await AppPage.waitForTrackSignal(anchorTrack.id);
    const volume = await anchorHeader.$(".lt-track-volume input");
    await clickRangeEdge(volume, "start");
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.volume === 0,
      {
        timeout: 30_000,
        timeoutMsg: "The zero-volume fader value did not persist",
      },
    );
    await waitForOutputSilence();

    await volume.doubleClick();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.volume === 1,
      {
        timeout: 30_000,
        timeoutMsg: "The volume fader did not reset to unity",
      },
    );
    await restartMixPlayback();
    await waitForOutputSignal();

    await restartMixPlayback();
    const pan = await anchorHeader.$(".lt-track-pan input");
    await clickRangeEdge(pan, "start");
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.pan === -1,
      {
        timeout: 30_000,
        timeoutMsg: "Full-left pan did not persist",
      },
    );
    await waitForStereoDirection("leftPeak", "rightPeak");

    await restartMixPlayback();
    await clickRangeEdge(pan, "end");
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.pan === 1,
      {
        timeout: 30_000,
        timeoutMsg: "Full-right pan did not persist",
      },
    );
    await waitForStereoDirection("rightPeak", "leftPeak");

    await pan.doubleClick();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.pan === 0,
      {
        timeout: 30_000,
        timeoutMsg: "The pan control did not reset to centre",
      },
    );

    await restartMixPlayback();
    await soloButton.click();
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find(
          (candidate) => candidate.id === anchorTrack.id,
        )?.solo === false,
      {
        timeout: 30_000,
        timeoutMsg: "Solo did not clear in the backend song model",
      },
    );
    await AppPage.waitForTrackSignal(peerTrackId);

    await browser.keys(["Shift", " "]);
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "The engine did not stop after mixer validation" },
    );

    expect((await AppPage.songView())?.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: anchorTrack.id,
          volume: 1,
          pan: 0,
          solo: false,
        }),
      ]),
    );

    if (fixture.initialMetronomeEnabled) {
      await (await AppPage.metronomeButton).click();
      await browser.waitUntil(
        async () => (await AppPage.settings()).metronomeEnabled,
      );
    }
  });
}
