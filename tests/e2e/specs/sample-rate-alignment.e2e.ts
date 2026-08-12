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
 * NOTE ON HARDWARE DEPENDENCE — read before trusting a green run. What this can
 * assert depends on the machine's audio device. If the device cannot do the
 * session's rate, aligning is impossible and converting is correct, so the
 * strict assertion is guarded by the device's REAL advertised capability (read
 * from the engine via `supportedSampleRates()`), never by "the rates came out
 * different" — that guard would be false precisely when the feature is broken,
 * which is how an earlier version of this spec passed against a build where
 * alignment never fired at all.
 *
 * On the dev machine this was written on the device advertises 44100 ONLY, so
 * the switch path was NOT exercised end to end here; the run confirmed rates
 * now reach the snapshot and that the engine behaves correctly when a switch is
 * impossible. The switch decision itself is covered by unit tests in
 * `session_sample_rate.rs`. A machine with a multi-rate interface will exercise
 * the strict branch.
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
    const capture = await AppPage.audioOutputCaptureAfterBriefPlayback();

    const engineRate = capture.sampleRate;
    // Whatever happened, the engine must be at a real, sane audio rate — this
    // catches a bungled switch leaving it at 0 or something nonsensical.
    expect(engineRate).toBeGreaterThanOrEqual(8_000);
    expect(engineRate).toBeLessThanOrEqual(768_000);

    // Always report what happened: whether this run exercised the interesting
    // path depends on the machine's device, and a silent pass would hide that.
    // If the device was ALREADY at 44.1k the alignment had nothing to do, and
    // the run proves less than it looks like it does.
    // eslint-disable-next-line no-console
    console.log(
      `[LT_SR] engine=${engineRate}Hz session=${SESSION_RATE}Hz ` +
        `aligned=${engineRate === SESSION_RATE}`,
    );

    // The invariant that holds on ANY device: the audio still plays and is not
    // silence. A rate switch that broke the stream would show up here.
    const hasSignal = capture.left.some((sample) => Math.abs(sample) > 1e-4);
    expect(hasSignal).toBe(true);

    // And the session model survived the (possible) device reopen intact.
    const song = await AppPage.songView();
    expect(song?.clips.length ?? 0).toBe(1);
    expect(song?.clips[0]?.isMissing).toBe(false);
  });

  it("tracks the session rate when a second session uses a different one", async () => {
    // The first case can pass trivially if the device already sat at 44.1k.
    // This one opens a session at the OTHER common rate, so whatever the
    // device started at, one of the two sessions forces a real change — and
    // the engine must follow the session, not stay where it was.
    const first = await AppPage.audioOutputCaptureAfterBriefPlayback();

    const OTHER_RATE = 48_000;
    const otherAudio = path.join(workDir, "tone-48000.wav");
    writeToneWav(otherAudio, 5, OTHER_RATE);
    await AppPage.createSession("E2E SR Session 48k", workDir);
    await AppPage.createAudioTracksWithClips([
      { trackName: "E2E SR 48k", filePath: otherAudio, timelineStartSeconds: 0 },
    ]);
    await browser.waitUntil(
      async () => ((await AppPage.songView())?.clips.length ?? 0) === 1,
      { timeout: 30_000, timeoutMsg: "The 48k session was not built" },
    );

    const second = await AppPage.audioOutputCaptureAfterBriefPlayback();
    // eslint-disable-next-line no-console
    console.log(
      `[LT_SR] first=${first.sampleRate}Hz second=${second.sampleRate}Hz ` +
        `(sessions were 44100Hz then ${OTHER_RATE}Hz)`,
    );

    // Both must be sane rates and both must produce signal — the invariants
    // that hold regardless of what the device supports.
    for (const capture of [first, second]) {
      expect(capture.sampleRate).toBeGreaterThanOrEqual(8_000);
      expect(capture.left.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
    }

    // The engine must have FOLLOWED each session's rate. This assertion caught
    // a real bug: `supported_sample_rates` reached the FFI device LIST but was
    // never copied into `device_info()`, so the engine snapshot always carried
    // an empty list, the planner read that as "unknown" and refused to switch.
    // Both captures came back 44100 and a conditional assertion had let it pass.
    //
    // Guarded, not skipped, so a device that genuinely supports only one rate
    // does not fail the suite — but the guard is the DEVICE's capability, read
    // from the engine, not "the rates happened to differ" (which is what the
    // bug looked like).
    const supported = await AppPage.supportedSampleRates();
    const deviceDoesBoth =
      supported.includes(44_100) && supported.includes(OTHER_RATE);
    // eslint-disable-next-line no-console
    console.log(`[LT_SR] device supports: ${supported.join(",") || "(unknown)"}`);
    if (deviceDoesBoth) {
      expect(first.sampleRate).toBe(44_100);
      expect(second.sampleRate).toBe(OTHER_RATE);
    }
  });
});
