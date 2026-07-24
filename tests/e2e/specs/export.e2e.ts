import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Region (song) export to a `.ltpkg`, in its own clean session.
 *
 * Placing a clip auto-creates a region; the flow then exports that region as a
 * portable package and asserts a non-empty `.ltpkg` was written to disk. The
 * native save dialog can't be piloted, so this uses a test-only backend command
 * `export_region_as_package_at(regionId, writePath, includeAudio)` that mirrors
 * `export_region_as_package` but writes straight to an explicit path — the same
 * libretracks_project::export_region_as_package code runs underneath.
 *
 * Both `includeAudio` modes are exercised: the audio-bundled package must be at
 * least as large as the metadata-only one.
 */
describe("Region package export (isolated session)", () => {
  let workDir = "";
  let audioFilePath = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-export-"));
    audioFilePath = path.join(workDir, "e2e-tone.wav");
    writeToneWav(audioFilePath);

    await AppPage.createSession("E2E Export Session", workDir);
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
        { timeoutMsg: "Engine did not stop before export teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("exports a region as a .ltpkg, with and without bundled audio", async () => {
    // A clip auto-creates a region we can export.
    await AppPage.createAudioTracksWithClips([
      { trackName: "E2E Export Track", filePath: audioFilePath, timelineStartSeconds: 5 },
    ]);
    let regionId = "";
    await browser.waitUntil(
      async () => {
        regionId = (await AppPage.songView())?.regions[0]?.id ?? "";
        return regionId !== "";
      },
      {
        timeout: 30_000,
        timeoutMsg: "No region was auto-created for the export",
      },
    );

    // Metadata-only export.
    const metaPath = path.join(workDir, "song-meta.ltpkg");
    const okMeta = await AppPage.exportRegionAsPackageAt(
      regionId,
      metaPath.replace(/\\/g, "/"),
      false,
    );
    expect(okMeta).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    const metaSize = statSync(metaPath).size;
    expect(metaSize).toBeGreaterThan(0);

    // Audio-bundled export must exist and be at least as large.
    const audioPath = path.join(workDir, "song-audio.ltpkg");
    const okAudio = await AppPage.exportRegionAsPackageAt(
      regionId,
      audioPath.replace(/\\/g, "/"),
      true,
    );
    expect(okAudio).toBe(true);
    expect(existsSync(audioPath)).toBe(true);
    expect(statSync(audioPath).size).toBeGreaterThanOrEqual(metaSize);
  });

  it("re-imports an exported .ltpkg as a new song in the open session", async () => {
    // The previous case wrote song-audio.ltpkg (bundled audio). Import it back
    // into THIS session as a new song, closing the export -> import round trip.
    const audioPath = path.join(workDir, "song-audio.ltpkg");
    if (!existsSync(audioPath)) {
      throw new Error("The exported .ltpkg is missing before re-import");
    }

    const before = await AppPage.songView();
    const regionsBefore = before?.regions.length ?? 0;
    const clipsBefore = before?.clips.length ?? 0;

    // Import as a new song well past the existing content.
    await AppPage.importSongPackageFromPath(audioPath.replace(/\\/g, "/"), 100);

    // A new region (and its clip) must appear.
    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return (
          (song?.regions.length ?? 0) > regionsBefore &&
          (song?.clips.length ?? 0) > clipsBefore
        );
      },
      {
        timeout: 60_000,
        timeoutMsg: "Re-importing the .ltpkg did not add a new song to the session",
      },
    );

    // The imported clip's audio travelled inside the package, so it resolves
    // (not missing) in the open session.
    const after = await AppPage.songView();
    const newClip = after?.clips.find(
      (clip) => clip.timelineStartSeconds >= 90,
    );
    expect(newClip).toBeDefined();
    expect(newClip?.isMissing).toBe(false);
  });
});
