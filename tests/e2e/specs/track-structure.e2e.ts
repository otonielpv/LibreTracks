import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Track structure flows (reorder, folder hierarchy, track/clip colour), in
 * their own clean session. All are pure song-model edits, asserted against
 * song.tracks / song.clips (order = array position; hierarchy = parentTrackId
 * + depth; colour = the color field).
 *
 * Backend commands exercised: create_track (audio/folder, with parent/after),
 * move_track (insertBefore/insertAfter/parentTrackId), update_track_color,
 * update_clip_color. All pre-existing — this block only wires them into the
 * seam. Runs in a fresh session so the track list starts empty and order is
 * fully controlled.
 */
describe("Track structure (isolated session)", () => {
  let workDir = "";
  let audioFilePath = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-track-"));
    audioFilePath = path.join(workDir, "e2e-tone.wav");
    writeToneWav(audioFilePath);

    await AppPage.createSession("E2E Track Session", workDir);
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
        { timeoutMsg: "Engine did not stop before track-structure teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  const tracks = async () => (await AppPage.songView())?.tracks ?? [];
  const trackByName = async (name: string) =>
    (await tracks()).find((t) => t.name === name);
  const orderOf = async (name: string) =>
    (await tracks()).findIndex((t) => t.name === name);

  it("reorders tracks by moving one before another", async () => {
    // Three audio tracks in a known creation order: A, B, C.
    await AppPage.createTrack({ name: "E2E Order A", kind: "audio" });
    await AppPage.createTrack({ name: "E2E Order B", kind: "audio" });
    await AppPage.createTrack({ name: "E2E Order C", kind: "audio" });
    await browser.waitUntil(
      async () =>
        (await trackByName("E2E Order A")) !== undefined &&
        (await trackByName("E2E Order B")) !== undefined &&
        (await trackByName("E2E Order C")) !== undefined,
      { timeout: 30_000, timeoutMsg: "The three ordering tracks were not created" },
    );
    expect(await orderOf("E2E Order A")).toBeLessThan(await orderOf("E2E Order C"));

    // Move C to just before A -> C should now precede A.
    const trackC = await trackByName("E2E Order C");
    const trackA = await trackByName("E2E Order A");
    await AppPage.moveTrack({
      trackId: trackC!.id,
      insertBeforeTrackId: trackA!.id,
    });
    await browser.waitUntil(
      async () => (await orderOf("E2E Order C")) < (await orderOf("E2E Order A")),
      {
        timeout: 30_000,
        timeoutMsg: "Moving track C before A did not reorder the backend model",
      },
    );
    expect(await orderOf("E2E Order C")).toBeLessThan(await orderOf("E2E Order B"));
  });

  it("nests an audio track inside a folder track", async () => {
    await AppPage.createTrack({ name: "E2E Folder", kind: "folder" });
    await AppPage.createTrack({ name: "E2E Child", kind: "audio" });
    await browser.waitUntil(
      async () =>
        (await trackByName("E2E Folder")) !== undefined &&
        (await trackByName("E2E Child")) !== undefined,
      { timeout: 30_000, timeoutMsg: "The folder/child tracks were not created" },
    );
    const folder = await trackByName("E2E Folder");
    const child = await trackByName("E2E Child");
    expect(folder?.kind).toBe("folder");
    expect(child?.parentTrackId ?? null).toBe(null);

    // Reparent the child under the folder.
    await AppPage.moveTrack({
      trackId: child!.id,
      parentTrackId: folder!.id,
    });
    await browser.waitUntil(
      async () => (await trackByName("E2E Child"))?.parentTrackId === folder!.id,
      {
        timeout: 30_000,
        timeoutMsg: "Nesting the child under the folder did not persist",
      },
    );
    // A nested track sits one level deeper than the folder.
    const nested = await trackByName("E2E Child");
    const folderAfter = await trackByName("E2E Folder");
    expect(nested?.depth ?? 0).toBeGreaterThan(folderAfter?.depth ?? 0);
  });

  it("sets and clears a track's colour", async () => {
    await AppPage.createTrack({ name: "E2E Coloured Track", kind: "audio" });
    let track: Awaited<ReturnType<typeof trackByName>>;
    await browser.waitUntil(async () => {
      track = await trackByName("E2E Coloured Track");
      return track !== undefined;
    }, { timeout: 30_000, timeoutMsg: "The colour track was not created" });

    await AppPage.updateTrackColor(track!.id, "#33AA77");
    await browser.waitUntil(
      async () => (await trackByName("E2E Coloured Track"))?.color === "#33AA77",
      { timeout: 30_000, timeoutMsg: "The track colour did not persist" },
    );

    await AppPage.updateTrackColor(track!.id, null);
    await browser.waitUntil(
      async () =>
        ((await trackByName("E2E Coloured Track"))?.color ?? null) === null,
      { timeout: 30_000, timeoutMsg: "The track colour was not cleared" },
    );
  });

  it("sets and clears a clip's colour", async () => {
    // A clip needs audio; create one via the batch helper.
    const created = await AppPage.createAudioTracksWithClips([
      {
        trackName: "E2E Clip Colour Track",
        filePath: audioFilePath,
        timelineStartSeconds: 5,
      },
    ]);
    const clipId = created[0];
    expect(clipId).toBeTruthy();

    await AppPage.updateClipColor(clipId, "#8844CC");
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.clips.find((c) => c.id === clipId)?.color ===
        "#8844CC",
      { timeout: 30_000, timeoutMsg: "The clip colour did not persist" },
    );

    await AppPage.updateClipColor(clipId, null);
    await browser.waitUntil(
      async () =>
        ((await AppPage.songView())?.clips.find((c) => c.id === clipId)?.color ??
          null) === null,
      { timeout: 30_000, timeoutMsg: "The clip colour was not cleared" },
    );
  });
});
