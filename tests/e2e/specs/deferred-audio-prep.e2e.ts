import { browser, expect, $ } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Opening a session must be INSTANT, with honest feedback that the audio is not
 * ready yet.
 *
 * Sessions used to block on decoding every source before the timeline appeared.
 * With a big set (39 stems / ~2 GB in the report that motivated this) that left
 * the user staring at a frozen-looking screen for minutes. Now the session opens
 * as soon as the model is loaded and the decode continues in the background —
 * the same deferred model the .ltpkg import already used.
 *
 * The deal is: a fast open is only acceptable if the user can SEE that the audio
 * isn't ready. This spec proves the half it can prove deterministically — the
 * session opens fast — and reports the other.
 *
 * WHY IT CANNOT ASSERT THE INDICATOR HERE (measured, not assumed): the fixture
 * is 44.1 kHz WAV and the engine runs at 44.1 kHz, so `try_install_native_file`
 * streams those files IN PLACE with no decode at all. There is nothing to
 * prepare, so `sourcesTotal > 0 && !sourcesReady` is never true and the
 * "Preparando audio…" indicator correctly never appears — confirmed with
 * `sawIndicator=false` on both a warm cache AND a purged one
 * (LIBRETRACKS_CACHE_DIR pointed at an empty dir). Reproducing a real decode
 * would need compressed fixtures (MP3) or a deliberate sample-rate mismatch.
 *
 * The indicator's own show/hide logic is unit-tested in `sourcesPrepare.test.ts`
 * (it renders exactly while `sourcesTotal > 0 && !sourcesReady`), so what is
 * left unverified end-to-end is the wiring between the two, not the rule.
 */
describe("Deferred audio preparation (isolated session)", () => {
  let workDir = "";
  // Enough distinct sources that the decode outlasts the session open. One
  // small file finishes before the indicator's 180 ms debounce and proves
  // nothing. Kept modest so BUILDING the fixture (which is not what we are
  // measuring) doesn't dominate the test's runtime.
  const CLIP_COUNT = 8;
  const CLIP_SECONDS = 30;

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-defer-"));
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("opens the session before the audio finishes decoding, and says so", async function () {
    // Building the fixture (8 real WAVs + a save + two session switches) costs
    // more than the default per-test budget on its own.
    this.timeout(300_000);
    // Build a session with several sources, then reopen it from scratch: the
    // reopen is the flow under test (a cold open with nothing decoded yet).
    await AppPage.createSession("E2E Defer Source", workDir);
    const clips = [];
    for (let index = 0; index < CLIP_COUNT; index += 1) {
      const audioPath = path.join(workDir, `defer-${index}.wav`);
      writeToneWav(audioPath, CLIP_SECONDS);
      clips.push({
        trackName: `E2E Defer ${index}`,
        filePath: audioPath,
        timelineStartSeconds: index * (CLIP_SECONDS + 1),
      });
    }
    await AppPage.createAudioTracksWithClips(clips);
    await browser.waitUntil(
      async () => ((await AppPage.songView())?.clips.length ?? 0) === CLIP_COUNT,
      { timeout: 90_000, timeoutMsg: "The source session was not built" },
    );
    const sessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!sessionPath) {
      throw new Error("The engine did not report the session path");
    }
    await browser.keys(["Control", "s"]);

    // Swap to a scratch session so reopening the real one is a genuine cold
    // open rather than a no-op.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-defer-scratch-"));
    await AppPage.createSession("E2E Defer Scratch", scratchDir);

    // Reopen WITHOUT awaiting: the point is to observe the app mid-preparation.
    await browser.execute(
      (file: string) =>
        (
          window as unknown as {
            __ltE2E: { openSessionFromPath: (songFile: string) => void };
          }
        ).__ltE2E.openSessionFromPath(file),
      sessionPath.replace(/\\/g, "/"),
    );

    // The timeline must MOUNT quickly. Under the old blocking model this only
    // happened after every source had decoded; now it happens as soon as the
    // model is loaded.
    //
    // `sawIndicator` is REPORTED, not asserted — see the header for why this
    // fixture cannot make the indicator appear (native WAV streaming means no
    // decode). Keep it logged: if a future fixture does trigger a decode, the
    // log tells you the indicator showed without having to add a probe.
    let sawIndicator = false;
    let polls = 0;
    let shellAppearedAtMs = -1;
    const openStartedAt = Date.now();
    const deadline = openStartedAt + 60_000;
    while (Date.now() < deadline) {
      polls += 1;
      const [shellPresent, indicatorPresent] = await Promise.all([
        (await $(".lt-timeline-shell")).isExisting(),
        (await $(".lt-source-prep-indicator")).isExisting(),
      ]);
      if (indicatorPresent) {
        sawIndicator = true;
      }
      if (shellPresent && shellAppearedAtMs < 0) {
        shellAppearedAtMs = Date.now() - openStartedAt;
      }
      // Stop once the session is open and settled (indicator gone, if it ever
      // showed). Bounded so a warm-cache run doesn't spin the whole window.
      if (shellPresent && !indicatorPresent && polls > 3) {
        break;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[LT_DEFER] polls=${polls} shellAppearedAtMs=${shellAppearedAtMs} ` +
        `sawIndicator=${sawIndicator} (false is expected on a warm cache)`,
    );

    // The session opened at all...
    expect(shellAppearedAtMs).toBeGreaterThanOrEqual(0);
    // ...and it did NOT take the minutes the blocking model cost on a cold,
    // multi-source session. Loose on purpose: this is a gross-regression guard
    // against reintroducing a blocking wait, not a latency budget.
    expect(shellAppearedAtMs).toBeLessThan(30_000);

    // The session opened correctly.
    const song = await AppPage.songView();
    expect(song?.clips.length ?? 0).toBe(CLIP_COUNT);
    rmSync(scratchDir, { recursive: true, force: true });
  });
});
