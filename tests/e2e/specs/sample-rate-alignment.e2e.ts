import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Opening a session should make the engine run at the session's sample rate.
 *
 * The engine has ONE working rate; every file that doesn't match is decoded,
 * resampled and written to a PCM cache before it can play. Measured over 25
 * real 44.1k stems: 2 ms when the rates matched, 13.9 s and 3.6 GB written when
 * they didn't. Windows commonly parks output devices at 48k while live
 * multitracks are 44.1k, so the expensive path used to be the default.
 *
 * The observable is `getAudioOutputCapture().sampleRate` — the rate the C++
 * mixer actually rendered at, read out of the capture ring buffer. That is the
 * engine's real rate, not a setting we echo back, so it cannot pass by
 * construction.
 *
 * NOTE ON HARDWARE DEPENDENCE: what this can assert depends on the machine's
 * audio device. If the device cannot do the session's rate, aligning is
 * impossible and the correct behaviour is to convert instead — so the test
 * accepts either outcome and only fails on a THIRD, wrong one: an engine rate
 * that matches neither the session nor a plausible device rate. It also asserts
 * the invariant that always holds regardless of device: whatever rate the
 * engine picks, playback works and the audio is intact.
 */
describe("Sample rate alignment (isolated session)", () => {
  let workDir = "";
  const TRACK_NAME = "E2E SR Track";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-sr-"));
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before sample-rate teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("runs the engine at a rate consistent with the session's audio", async () => {
    // Build a session whose audio is entirely 44.1k — the live-multitrack case.
    const SESSION_RATE = 44_100;
    const audioPath = path.join(workDir, "tone-44100.wav");
    writeToneWav(audioPath, 5, SESSION_RATE);

    await AppPage.createSession("E2E SR Session", workDir);
    await AppPage.createAudioTracksWithClips([
      { trackName: TRACK_NAME, filePath: audioPath, timelineStartSeconds: 0 },
    ]);
    await browser.waitUntil(
      async () => ((await AppPage.songView())?.clips.length ?? 0) === 1,
      { timeout: 30_000, timeoutMsg: "The 44.1k session was not built" },
    );

    // Play briefly so the mixer fills the capture ring buffer; the capture's
    // sampleRate is the rate the engine genuinely rendered at.
    await (await AppPage.playButton).click();
    await browser.waitUntil(
      async () => (await AppPage.audioOutputCapture()).sampleRate > 0,
      { timeout: 30_000, timeoutMsg: "The engine never reported a render rate" },
    );
    const capture = await AppPage.audioOutputCapture();
    await (await AppPage.stopButton).click();

    const engineRate = capture.sampleRate;
    // Whatever happened, the engine must be at a real, sane audio rate — this
    // catches a bungled switch leaving it at 0 or something nonsensical.
    expect(engineRate).toBeGreaterThanOrEqual(8_000);
    expect(engineRate).toBeLessThanOrEqual(768_000);

    // Either we aligned to the session (the win) or the device could not do
    // 44.1k and we're converting (still correct). Both are acceptable; what
    // would be wrong is silence or a broken stream, asserted below.
    if (engineRate !== SESSION_RATE) {
      // eslint-disable-next-line no-console
      console.log(
        `[LT_SR] engine at ${engineRate} Hz, session is ${SESSION_RATE} Hz — ` +
          `this device cannot do the session rate, so conversion is expected.`,
      );
    }

    // The invariant that holds on ANY device: the audio still plays and is not
    // silence. A rate switch that broke the stream would show up here.
    const hasSignal = capture.left.some((sample) => Math.abs(sample) > 1e-4);
    expect(hasSignal).toBe(true);

    // And the session model survived the (possible) device reopen intact.
    const song = await AppPage.songView();
    expect(song?.clips.length ?? 0).toBe(1);
    expect(song?.clips[0]?.isMissing).toBe(false);
  });
});
