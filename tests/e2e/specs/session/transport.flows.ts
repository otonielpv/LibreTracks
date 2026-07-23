import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import type { SessionFixture } from "./support.js";

export function registerSessionTransportFlows(fixture: SessionFixture) {
  it("round-trips transport controls and the metronome toggle to the engine", async () => {
    await (await AppPage.playButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "playing",
      { timeoutMsg: "The engine never entered playing state" },
    );

    await (await AppPage.pauseButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "paused",
      { timeoutMsg: "The engine never entered paused state" },
    );

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "The engine never entered stopped state" },
    );

    const expectedMetronome = !fixture.initialMetronomeEnabled;
    await (await AppPage.metronomeButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.settings()).metronomeEnabled === expectedMetronome,
      {
        timeout: 30_000,
        timeoutMsg:
          "The realtime metronome command did not complete and persist",
      },
    );
    const metronomeClass = await (
      await AppPage.metronomeButton
    ).getAttribute("class");
    if (expectedMetronome) {
      expect(metronomeClass).toContain("is-active");
    } else {
      expect(metronomeClass).not.toContain("is-active");
    }
  });
}
