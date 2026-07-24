import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import { dominantFrequency, type SessionFixture } from "./support.js";

/**
 * Ambient pads normally need a downloaded pack (not present in E2E), so this
 * creates a USER pad and assigns the 440 Hz tone fixture to it — no external
 * asset needed. Pads are transport-decoupled: they sound as soon as they're
 * enabled, without pressing play. We prove that on the real signal by enabling
 * the pad and confirming the captured output's dominant frequency is ~440 Hz.
 *
 * Uses window.__ltE2E.activatePadWithTone, which runs the production
 * createUserPad → assignPadKey → loadPadKey → setPadConfigRealtime path.
 */
export function registerSessionPadFlows(fixture: SessionFixture) {
  it("renders an enabled user pad's audio without playback", async () => {
    // Make sure the transport is stopped — the pad must sound on its own.
    if ((await AppPage.transportSnapshot()).playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
      );
    }

    const padId = await AppPage.activatePadWithTone(fixture.audioFilePath);
    try {
      // Wait for the pad to reach the output bus (pads have a short fade-in).
      await browser.waitUntil(
        async () => {
          const meter = await AppPage.audioOutputMeter();
          return Math.max(meter.leftPeak, meter.rightPeak) > 0.01;
        },
        {
          timeout: 30_000,
          timeoutMsg: "The enabled pad never produced output signal",
        },
      );
      // Let the capture ring fill with pad audio.
      await browser.pause(400);

      const capture = await AppPage.audioOutputCapture();
      const channel =
        capture.left.length >= capture.right.length
          ? capture.left
          : capture.right;
      expect(channel.length).toBeGreaterThan(2048);
      const hz = dominantFrequency(channel, capture.sampleRate);
      // The pad plays the 440 Hz tone; transport is stopped, so this signal can
      // only be the pad.
      expect(Math.abs(hz - 440)).toBeLessThan(60);
    } finally {
      await AppPage.deactivatePad(padId);
      // Confirm the pad stopped so it doesn't bleed into later flows.
      await browser.waitUntil(
        async () => {
          const meter = await AppPage.audioOutputMeter();
          return Math.max(meter.leftPeak, meter.rightPeak) <= 0.001;
        },
        {
          timeout: 30_000,
          timeoutMsg: "The pad kept sounding after being disabled",
        },
      );
    }
  });
}
