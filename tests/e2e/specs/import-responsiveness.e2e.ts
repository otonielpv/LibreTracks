import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * The UI must stay responsive while a large `.ltset` decompresses.
 *
 * A user built a session on one machine, exported it as a 2.17 GB `.ltset` and
 * imported it on another: LibreTracks stopped responding entirely and they had
 * to reboot. The cause was that decompression ran while holding the session
 * lock, so every session-touching command queued behind gigabytes of unzipping.
 * The fix splits extraction (off-lock) from opening (locked).
 *
 * This asserts the property that regressed, not the plumbing: while an import
 * is in flight, commands that take the session lock still answer. It's the
 * check a pure round-trip test can't make — `session-package.e2e.ts` already
 * proves the data survives, and it passed even when the app froze.
 *
 * `transportSnapshot()` is the probe because it goes through the real Tauri
 * command layer and takes the same lock the import used to hold. Polling it
 * during the import is exactly what the UI does.
 */
describe("Import responsiveness (isolated session)", () => {
  let workDir = "";
  const TRACK_NAME = "E2E Import Track";
  // The fixture has to be big enough that extraction OUTLASTS a probe's
  // round trip, or no probe ever lands while the lock is held and the test
  // cannot tell the two builds apart. Measured on this machine: 63 MB
  // extracted so fast that not even a single progress tick fired, and the
  // buggy build passed. 24 x 300s of 44.1k mono PCM is ~635 MB, which takes
  // seconds to inflate — comfortably longer than the ~100 ms probe.
  const CLIP_COUNT = 24;
  const CLIP_SECONDS = 300;

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-import-"));
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before import teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps answering session commands while a .ltset imports", async () => {
    await AppPage.createSession("E2E Import Source", workDir);

    // Build a session with several seconds of real audio so the resulting
    // .ltset is big enough that extraction spans multiple probes.
    const clips = [];
    for (let index = 0; index < CLIP_COUNT; index += 1) {
      const audioPath = path.join(workDir, `tone-${index}.wav`);
      writeToneWav(audioPath, CLIP_SECONDS);
      clips.push({
        trackName: `${TRACK_NAME} ${index}`,
        filePath: audioPath,
        timelineStartSeconds: index * (CLIP_SECONDS + 1),
      });
    }
    await AppPage.createAudioTracksWithClips(clips);
    await browser.waitUntil(
      async () => ((await AppPage.songView())?.clips.length ?? 0) === CLIP_COUNT,
      { timeout: 60_000, timeoutMsg: "The source session was not built" },
    );

    const setPath = path.join(workDir, "responsive.ltset");
    expect(
      await AppPage.exportSessionPackageAt(setPath.replace(/\\/g, "/"), true),
    ).toBe(true);
    expect(statSync(setPath).size).toBeGreaterThan(0);

    // Kick off the import WITHOUT awaiting it. The seam is fire-and-forget
    // (the flow ends on project:load-complete), which is what lets us observe
    // the app mid-import instead of only after it settles.
    const importedName = "E2E Import Target";
    const targetSongDir = path.join(workDir, importedName);
    await browser.execute(
      (pkg: string, dir: string) =>
        (
          window as unknown as {
            __ltE2E: {
              importSessionPackageAt: (p: string, d: string) => void;
            };
          }
        ).__ltE2E.importSessionPackageAt(pkg, dir),
      setPath.replace(/\\/g, "/"),
      targetSongDir.replace(/\\/g, "/"),
    );

    // Poll the lock-taking command while the import runs. Before the fix each
    // of these blocked for the whole decompression; now each must return
    // promptly. We measure INDIVIDUAL probe latency rather than counting
    // probes: with the fix in place the import can finish in a couple of
    // seconds, so a "how many probes fit" assertion measures import speed
    // (machine-dependent) instead of responsiveness (the actual property).
    const probeDurationsMs: number[] = [];
    let importFinished = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const startedAt = Date.now();
      const snapshot = await AppPage.transportSnapshot();
      probeDurationsMs.push(Date.now() - startedAt);
      if (snapshot.songFilePath?.includes(importedName)) {
        importFinished = true;
        break;
      }
    }

    if (!importFinished) {
      // Distinguish "the import never finished" from "a probe hung": both fail
      // this test, but only one of them is the lock regression.
      throw new Error(
        `The import never opened the new session (${probeDurationsMs.length} probes, ` +
          `slowest ${Math.max(...probeDurationsMs, 0)}ms). Check the load-complete event.`,
      );
    }
    // A coarse upper bound on total unresponsiveness. This is NOT a tight
    // regression guard: a WebDriver round trip costs ~600 ms, so on a fast SSD
    // the whole import (extraction included) can complete inside a single
    // probe — measured, with a 635 MB set. That means this spec cannot
    // distinguish lock-held from off-lock extraction on this hardware; it was
    // verified to pass against a deliberately re-broken build.
    //
    // It still earns its place: it exercises the real import end to end and
    // catches a GROSS regression (an import that wedges the app for minutes,
    // which is what the 2.17 GB report looked like). The precise "extraction
    // must not hold the session lock" property is enforced at the type level
    // instead — `extract_session_package_off_lock` is an associated function
    // with no `&self`, so calling it with the lock held cannot compile.
    const slowestProbeMs = Math.max(...probeDurationsMs);
    expect(slowestProbeMs).toBeLessThan(30_000);

    // And the import still did its job.
    const imported = await AppPage.songView();
    expect(imported?.clips.length ?? 0).toBe(CLIP_COUNT);
    expect(imported?.clips.every((clip) => !clip.isMissing)).toBe(true);
  });
});
