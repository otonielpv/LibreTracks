import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * "Locate a missing audio file" flow, run against its own clean session.
 *
 * A clip stores the audio's file path verbatim (append_clip_to_song only
 * normalises backslashes to forward slashes — it does not copy the file), and
 * get_song_view recomputes `isMissing` on every read by checking whether that
 * path exists on disk (models/view.rs). So the flow can drive the real
 * production path without reopening the session:
 *
 *   1. create a clip pointing at a real WAV,
 *   2. delete that WAV from disk -> the next getSongView() reports isMissing,
 *   3. write a replacement WAV elsewhere and call resolveMissingFile(old, new)
 *      -> the clip repoints and isMissing clears.
 *
 * Asserted against the backend song model (clip.filePath / clip.isMissing), the
 * same discipline as the other flows.
 */
describe("Missing audio file resolution (isolated session)", () => {
  let sessionParentDir = "";
  const MISSING_WAV = "e2e-missing-src.wav";
  const REPLACEMENT_WAV = "e2e-found-dest.wav";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    sessionParentDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-missing-"));
    await AppPage.createSession("E2E Missing Session", sessionParentDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before missing-file teardown" },
      );
    }
    if (sessionParentDir && existsSync(sessionParentDir)) {
      rmSync(sessionParentDir, { recursive: true, force: true });
    }
  });

  it("flags a clip whose audio is gone, then resolves it to a new path", async () => {
    const missingSrcPath = path.join(sessionParentDir, MISSING_WAV);
    writeToneWav(missingSrcPath);

    const created = await AppPage.createAudioTracksWithClips([
      {
        trackName: "E2E Missing Track",
        filePath: missingSrcPath,
        timelineStartSeconds: 5,
      },
    ]);
    const clipId = created[0];
    if (!clipId) {
      throw new Error("The clip pointing at the soon-missing WAV was not created");
    }

    const clipBefore = (await AppPage.songView())?.clips.find(
      (clip) => clip.id === clipId,
    );
    if (!clipBefore) {
      throw new Error("The created clip is not in the song model");
    }
    // With the WAV still on disk the clip is present and not missing.
    expect(clipBefore.isMissing).toBe(false);
    // The backend stores the path with forward slashes; use exactly what it
    // recorded as the `oldPath` to resolve against.
    const oldPath = clipBefore.filePath;

    // Delete the audio -> getSongView recomputes isMissing = true.
    unlinkSync(missingSrcPath);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.clips.find((clip) => clip.id === clipId)
          ?.isMissing === true,
      {
        timeout: 30_000,
        timeoutMsg: "The clip was not flagged missing after its WAV was deleted",
      },
    );

    // Provide a replacement file at a new path and resolve the missing clip.
    const replacementPath = path.join(sessionParentDir, REPLACEMENT_WAV);
    writeToneWav(replacementPath);
    const newPath = replacementPath.replace(/\\/g, "/");

    await AppPage.resolveMissingFile(oldPath, newPath);
    await browser.waitUntil(
      async () => {
        const clip = (await AppPage.songView())?.clips.find(
          (candidate) => candidate.id === clipId,
        );
        return clip?.isMissing === false && clip?.filePath === newPath;
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "Resolving the missing file did not repoint the clip and clear isMissing",
      },
    );

    const resolved = (await AppPage.songView())?.clips.find(
      (clip) => clip.id === clipId,
    );
    expect(resolved?.isMissing).toBe(false);
    expect(resolved?.filePath).toBe(newPath);
    expect(resolved?.filePath).not.toBe(oldPath);
  });
});
