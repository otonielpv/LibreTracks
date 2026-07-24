import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { writeToneWav } from "./session/support.js";

/**
 * Full-model persistence, in its own clean session. The shared
 * session.e2e.ts persistence flow proves track + mute + clip survive a
 * save/switch/reopen; this widens that to the parts most at risk of a silent
 * serialization bug losing the user's work: a region's transpose / key / warp /
 * master gain, the base tempo + a tempo marker, the base time signature, a
 * section marker's kind/variant/colour/digit, a track colour, a clip colour,
 * and a folder-track hierarchy (parent + depth).
 *
 * Everything is built through the __ltE2E seam (deterministic), saved with
 * Ctrl+S, replaced by a scratch session, then reopened — and every field is
 * re-read from the reopened backend song model and asserted to match.
 */
describe("Full-model persistence (isolated session)", () => {
  let workDir = "";
  let audioFilePath = "";
  let sessionFilePath = "";

  // The exact rich state we write, captured so we can assert it round-trips.
  const expected = {
    regionTranspose: 5,
    regionKey: "Am",
    warpSourceBpm: 90,
    regionMasterGain: 0.5,
    baseBpm: 132,
    tempoMarkerAt: 20,
    tempoMarkerBpm: 150,
    timeSignature: "6/8",
    markerKind: "chorus",
    markerVariant: 3,
    markerColor: "#AA5522",
    markerDigit: 4,
    trackColor: "#123456",
    clipColor: "#654321",
  };

  const REGION_TRACK = "E2E Persist Track";
  const FOLDER_NAME = "E2E Persist Folder";
  const CHILD_NAME = "E2E Persist Child";

  let clipId = "";
  let markerId = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-persist-"));
    audioFilePath = path.join(workDir, "e2e-tone.wav");
    writeToneWav(audioFilePath);

    await AppPage.createSession("E2E Persist Source", workDir);
    const created = await AppPage.transportSnapshot();
    sessionFilePath = created.songFilePath ?? "";
    if (!sessionFilePath) {
      throw new Error("The persist source session did not open cleanly");
    }
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before persist teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("round-trips a rich song model through save, switch and reopen", async () => {
    // --- Build the rich state -------------------------------------------
    // A clip auto-creates a region we can decorate.
    const created = await AppPage.createAudioTracksWithClips([
      { trackName: REGION_TRACK, filePath: audioFilePath, timelineStartSeconds: 5 },
    ]);
    clipId = created[0] ?? "";
    let regionId = "";
    await browser.waitUntil(
      async () => {
        regionId = (await AppPage.songView())?.regions[0]?.id ?? "";
        return regionId !== "" && clipId !== "";
      },
      { timeout: 30_000, timeoutMsg: "The base clip/region were not created" },
    );

    // Region: transpose, key, warp, master gain.
    await AppPage.updateSongRegionTranspose(regionId, expected.regionTranspose);
    await AppPage.updateSongRegionKey(regionId, expected.regionKey);
    await AppPage.updateSongRegionWarp(regionId, true, expected.warpSourceBpm);
    await AppPage.updateSongRegionMasterGain(regionId, expected.regionMasterGain);

    // Markers (tempo + section) MUST land inside a region or LoadSession's
    // strict validator rejects the reopen with "Marker is outside its song"
    // (create is tolerant, load is strict). Read the region's live bounds after
    // warp and place both markers well inside it.
    const regionNow = (await AppPage.songView())?.regions.find(
      (r) => r.id === regionId,
    );
    const insideA =
      (regionNow?.startSeconds ?? 0) +
      ((regionNow?.endSeconds ?? 2) - (regionNow?.startSeconds ?? 0)) * 0.3;
    const insideB =
      (regionNow?.startSeconds ?? 0) +
      ((regionNow?.endSeconds ?? 2) - (regionNow?.startSeconds ?? 0)) * 0.6;
    expected.tempoMarkerAt = insideA;

    // Tempo + time signature (base + a positional tempo marker inside the song).
    await AppPage.updateSongTempo(expected.baseBpm);
    await AppPage.updateSongTimeSignature(expected.timeSignature);
    await AppPage.upsertSongTempoMarker(insideA, expected.tempoMarkerBpm);

    // A decorated section marker, also inside the region.
    markerId = await AppPage.createSectionMarker(insideB);
    await AppPage.setSectionMarkerKind(
      markerId,
      expected.markerKind,
      expected.markerVariant,
    );
    await AppPage.setSectionMarkerColor(markerId, expected.markerColor);
    await AppPage.assignSectionMarkerDigit(markerId, expected.markerDigit);

    // Colours.
    const regionTrackId =
      (await AppPage.songView())?.tracks.find((t) => t.name === REGION_TRACK)
        ?.id ?? "";
    await AppPage.updateTrackColor(regionTrackId, expected.trackColor);
    await AppPage.updateClipColor(clipId, expected.clipColor);

    // Folder hierarchy.
    await AppPage.createTrack({ name: FOLDER_NAME, kind: "folder" });
    await AppPage.createTrack({ name: CHILD_NAME, kind: "audio" });
    await browser.waitUntil(
      async () => {
        const tracks = (await AppPage.songView())?.tracks ?? [];
        return (
          tracks.some((t) => t.name === FOLDER_NAME) &&
          tracks.some((t) => t.name === CHILD_NAME)
        );
      },
      { timeout: 30_000, timeoutMsg: "The folder/child tracks were not created" },
    );
    const folderId =
      (await AppPage.songView())?.tracks.find((t) => t.name === FOLDER_NAME)
        ?.id ?? "";
    const childId =
      (await AppPage.songView())?.tracks.find((t) => t.name === CHILD_NAME)?.id ??
      "";
    await AppPage.moveTrack({ trackId: childId, parentTrackId: folderId });
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find((t) => t.id === childId)
          ?.parentTrackId === folderId,
      { timeout: 30_000, timeoutMsg: "The child was not nested before save" },
    );

    // Sanity: the state is really in the live model before we persist.
    const live = await AppPage.songView();
    const liveRegion = live?.regions.find((r) => r.id === regionId);
    expect(liveRegion?.transposeSemitones).toBe(expected.regionTranspose);

    // --- Save, switch away, reopen --------------------------------------
    await browser.keys(["Control", "s"]);
    await browser.waitUntil(async () => existsSync(sessionFilePath), {
      timeout: 30_000,
      timeoutMsg: "Ctrl+S did not write the session file",
    });
    // Sanity: the save wrote the region track to disk.
    await browser.waitUntil(
      async () => {
        try {
          const onDisk = JSON.parse(readFileSync(sessionFilePath, "utf8")) as {
            tracks?: Array<{ name: string }>;
          };
          return onDisk.tracks?.some((t) => t.name === REGION_TRACK) === true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: "The saved session file is missing the rich state" },
    );

    // Replace the session with a scratch one so nothing is served from memory.
    const sourceId = (await AppPage.songView())?.id ?? "";
    await AppPage.createSession("E2E Persist Scratch", workDir);
    await browser.waitUntil(
      async () => {
        const song = await AppPage.songView();
        return song !== null && song.id !== sourceId && song.tracks.length === 0;
      },
      { timeout: 60_000, timeoutMsg: "The scratch session never replaced the source" },
    );

    // Reopen the saved session, waiting on stable content (the reopened song id
    // isn't necessarily the same value we started with).
    await AppPage.reopenSessionUntil(sessionFilePath, (song) =>
      song.tracks.some((t) => t.name === REGION_TRACK),
    );

    // --- Assert the whole model survived --------------------------------
    const song = await AppPage.songView();
    if (!song) {
      throw new Error("The reopened session has no song model");
    }

    // Region attributes.
    const region = song.regions.find(
      (r) => r.transposeSemitones === expected.regionTranspose,
    );
    expect(region).toBeDefined();
    expect(region?.key).toBe(expected.regionKey);
    expect(region?.warpEnabled).toBe(true);
    expect(region?.warpSourceBpm ?? 0).toBeCloseTo(expected.warpSourceBpm, 1);
    expect(region?.master?.gain ?? -1).toBeCloseTo(expected.regionMasterGain, 3);

    // Tempo + time signature.
    expect(song.bpm).toBeCloseTo(expected.baseBpm, 2);
    expect(song.timeSignature).toBe(expected.timeSignature);
    // Locate the tempo marker by its distinctive bpm (warp can nudge the
    // stored position on the seconds<->frames round trip).
    const tempoMarker = song.tempoMarkers.find(
      (m) => Math.abs(m.bpm - expected.tempoMarkerBpm) < 0.5,
    );
    expect(tempoMarker).toBeDefined();

    // Section marker attributes. Marker ids may be regenerated on load, so
    // locate it by its distinctive kind/variant rather than its id.
    const marker = song.sectionMarkers.find(
      (m) => m.kind === expected.markerKind && m.variant === expected.markerVariant,
    );
    expect(marker).toBeDefined();
    expect(marker?.color).toBe(expected.markerColor);
    expect(marker?.digit ?? null).toBe(expected.markerDigit);

    // Colours. Track ids are preserved across reopen (see session.e2e.ts's
    // persistence flow); locate the clip by its (preserved) track instead of a
    // possibly-regenerated clip id.
    const persistedTrack = song.tracks.find((t) => t.name === REGION_TRACK);
    expect(persistedTrack?.color).toBe(expected.trackColor);
    const persistedClip = song.clips.find(
      (c) => c.trackId === persistedTrack?.id,
    );
    expect(persistedClip?.color).toBe(expected.clipColor);

    // Folder hierarchy.
    const folder = song.tracks.find((t) => t.name === FOLDER_NAME);
    const child = song.tracks.find((t) => t.name === CHILD_NAME);
    expect(folder?.kind).toBe("folder");
    expect(child?.parentTrackId).toBe(folder?.id);
    expect(child?.depth ?? 0).toBeGreaterThan(folder?.depth ?? 0);
  });
});
