import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import { setRegionWarp } from "./support.js";

/**
 * What a jump actually sounds like.
 *
 * The engine has two paths for a marker jump, and they sound nothing alike:
 *
 *   HIT   the prearm cache holds a set of voices already warmed and aligned on
 *         the target. Publish them, move the clock, done — instant.
 *   MISS  the engine publishes an EMPTY voice map and rebuilds asynchronously.
 *         An empty map means `voice_for()` returns null and the stretched path
 *         renders nothing, so every warped or transposed track is SILENT until
 *         the rebuild lands.
 *
 * So "jumps have a bit of silence" is not vague: it is the miss path, and its
 * length is however long rebuilding N Bungee voices takes.
 *
 * This measures both halves — which path was taken, and the longest silent run
 * the listener got — against the real engine with a real device. The captured
 * buffer is the final post-mix output, so a gap here is a gap the user hears.
 */
export function registerSessionJumpSilenceFlows() {
  it("does not drop the output silent when jumping to a marker", async () => {
    const song = await AppPage.songView();
    const track = song?.tracks.find((t) => t.name === "E2E Audio Track");
    const clip = song?.clips.find((c) => c.trackId === track?.id);
    if (!track || !clip) {
      throw new Error("E2E Audio Track with a clip is required for the jump flow");
    }

    // Jump to a marker that sits inside the clip, so the target has audio to
    // render. A marker over empty timeline would be silent for honest reasons
    // and prove nothing.
    const insideClip = (s: number) =>
      s >= clip.timelineStartSeconds &&
      s < clip.timelineStartSeconds + clip.durationSeconds;
    let marker = (song?.sectionMarkers ?? []).find((m) =>
      insideClip(m.startSeconds),
    );
    if (!marker) {
      const at = clip.timelineStartSeconds + clip.durationSeconds / 2;
      const id = await AppPage.createSectionMarker(at);
      marker = ((await AppPage.songView())?.sectionMarkers ?? []).find(
        (m) => m.id === id,
      );
    }
    if (!marker) {
      throw new Error("Could not place a section marker inside the clip");
    }

    // Warp ON. This is the condition that makes the miss path audible: an
    // unwarped, untransposed clip renders through the Direct path and needs no
    // Bungee voice, so publishing an empty voice map costs it nothing. Only a
    // stretched clip goes silent. Measuring without warp reports a clean 0 ms
    // and proves nothing — which is exactly what the first version of this test
    // did.
    const regionIndex = (
      (await AppPage.songView())?.regions ?? []
    ).findIndex(
      (r) =>
        clip.timelineStartSeconds >= r.startSeconds &&
        clip.timelineStartSeconds < r.endSeconds,
    );
    if (regionIndex < 0) {
      throw new Error("No region contains the clip to warp");
    }
    const regionId = (await AppPage.songView())!.regions[regionIndex]!.id;

    await (await AppPage.playButton).click();
    await AppPage.waitForTrackSignal(track.id);

    // Enable warp WHILE PLAYING and jump straight after. Any session edit bumps
    // the prearm revision and throws the whole cache away, so this is the window
    // where a jump misses — and it is not a contrived one: it is exactly what a
    // user does when they turn warp on and then hit a section.
    //
    // A small fixture session refills the cache fast enough to hit if you give
    // it a second, which is why the first version of this test measured a clean
    // 0 ms and proved nothing.
    await setRegionWarp(true, regionIndex);

    const before = await AppPage.engineDiagnostics();

    // Jump twice in quick succession. take_ready() ERASES the set it hands out
    // and the refill is asynchronous, so the second jump is guaranteed to find
    // the cache empty. That is the miss path, forced deterministically instead
    // of waiting for a session big enough to miss on its own — and it is a real
    // gesture: hitting two sections back to back is ordinary live use.
    await AppPage.scheduleMarkerJump(marker.id);
    await browser.pause(120);
    await AppPage.scheduleMarkerJump(marker.id);

    // Long enough to cover a rebuild if one happens: the miss path is a few
    // hundred milliseconds of voice construction.
    await browser.pause(1500);
    const after = await AppPage.engineDiagnostics();
    const capture = await AppPage.audioOutputCapture();

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "Engine did not stop after the jump flow" },
    );

    const delta = (key: string) =>
      Number(after[key] ?? 0) - Number(before[key] ?? 0);
    const hits = delta("prearmTakeHitTotal");
    const misses = delta("prearmTakeMissTotal");

    // Longest run of near-silence in the captured output. The threshold is well
    // under a normal signal but above dither/noise floor.
    const channel =
      capture.left.length >= capture.right.length ? capture.left : capture.right;
    if (channel.length < 4096) {
      throw new Error("Captured output was too short to analyse");
    }
    let longestRun = 0;
    let run = 0;
    for (const sample of channel) {
      if (Math.abs(sample) < 1e-4) {
        run += 1;
        if (run > longestRun) longestRun = run;
      } else {
        run = 0;
      }
    }
    const silentMs = (longestRun / capture.sampleRate) * 1000;

    // Report the shape of the result whether or not it passes — a hit with a
    // gap and a miss with a gap are different bugs.
    const summary =
      `prearm hits=${hits} misses=${misses} | ` +
      `longest silence=${silentMs.toFixed(1)} ms ` +
      `(${longestRun} frames @ ${capture.sampleRate} Hz)`;

    // Always on record, pass or fail: a hit with a gap and a miss with a gap
    // are different bugs, and a run that never exercised the jump is neither.
    // eslint-disable-next-line no-console
    console.log(`[JUMP_SILENCE] ${summary}`);

    expect(hits + misses).toBeGreaterThan(0); // the jump path really ran

    // 60 ms is generous: a clean jump crossfades in a few milliseconds, and the
    // miss path costs hundreds. Anything in between still means the listener
    // heard a hole.
    if (silentMs > 60) {
      throw new Error(`jump left an audible hole: ${summary}`);
    }

    // Leave the region neutral for whatever runs next.
    const resetIndex = ((await AppPage.songView())?.regions ?? []).findIndex(
      (r) => r.id === regionId,
    );
    await setRegionWarp(false, resetIndex >= 0 ? resetIndex : 0);
  });
}
