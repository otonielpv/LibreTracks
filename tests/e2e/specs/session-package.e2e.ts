import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Whole-session .ltset export → import round trip, in its own clean session.
 * The "build it at home, open it at the venue" flow: export the current
 * session as a single portable package, then import it as a brand-new session
 * and assert the structure/content survived.
 *
 * Both native dialogs (export save, import pick + destination) are unpilotable,
 * so this uses two test-only backend commands that take explicit paths:
 * `export_session_package_at(writePath, includeAudio)` and
 * `import_session_package_at(packagePath, targetSongDir)`. Both run the same
 * production code (`export_session_as_package` / `import_session_package_as_new`)
 * underneath; the import ends with the same `project:load-complete` event, so
 * the frontend load flow is identical to a real import.
 */
describe("Session package .ltset round trip (isolated session)", () => {
  let workDir = "";
  let audioFilePath = "";
  const TRACK_NAME = "E2E Set Track";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-ltset-"));
    audioFilePath = path.join(workDir, "e2e-tone.wav");
    writeToneWav(audioFilePath);

    await AppPage.createSession("E2E Set Source", workDir);
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
        { timeoutMsg: "Engine did not stop before .ltset teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("exports the session to a .ltset and imports it as a new session", async () => {
    // Build a known one-track/one-clip/one-region session.
    await AppPage.createAudioTracksWithClips([
      { trackName: TRACK_NAME, filePath: audioFilePath, timelineStartSeconds: 5 },
    ]);
    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return (
          (song?.tracks.some((t) => t.name === TRACK_NAME) ?? false) &&
          (song?.clips.length ?? 0) === 1 &&
          (song?.regions.length ?? 0) >= 1
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "The source session structure was not created",
      },
    );
    const sourceSessionPath = (await AppPage.transportSnapshot()).songFilePath;

    // Export the whole session (with audio) to an explicit .ltset path.
    const setPath = path.join(workDir, "venue.ltset");
    const ok = await AppPage.exportSessionPackageAt(
      setPath.replace(/\\/g, "/"),
      true,
    );
    expect(ok).toBe(true);
    expect(existsSync(setPath)).toBe(true);
    expect(statSync(setPath).size).toBeGreaterThan(0);

    // Import it into a brand-new folder (must NOT exist — the import creates it).
    const importedName = "E2E Set Imported";
    const targetSongDir = path.join(workDir, importedName);
    await AppPage.importSessionPackageAt(
      setPath.replace(/\\/g, "/"),
      targetSongDir.replace(/\\/g, "/"),
      importedName,
    );

    // It opened as a genuinely new session (different .ltsession path) that
    // carries the source structure: the track by name, one clip, one region.
    const imported = await AppPage.songView();
    const importedPath = (await AppPage.transportSnapshot()).songFilePath;
    expect(importedPath).not.toBe(sourceSessionPath);
    expect(imported?.tracks.filter((t) => t.name === TRACK_NAME).length).toBe(1);
    expect(imported?.clips.length ?? 0).toBe(1);
    expect(imported?.regions.length ?? 0).toBeGreaterThanOrEqual(1);
    // The imported clip's audio resolves inside the new session (not missing).
    expect(imported?.clips[0]?.isMissing).toBe(false);
  });
});
