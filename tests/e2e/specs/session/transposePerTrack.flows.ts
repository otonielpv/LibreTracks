import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  TONE_FREQUENCY_HZ,
  measureRenderedPitch,
  setRegionTranspose,
  setRegionWarp,
  setRegionWarpSourceBpm,
  toggleTrackSolo,
  toggleTrackTranspose,
} from "./support.js";

/**
 * The per-track transpose enable ("T" in each track header) only has meaning
 * WITH warp on: without warp a pitch change is global vari-speed that shifts
 * every track, so there's nothing to opt out of. With warp on, "T" decides per
 * track whether the region transpose applies. This proves both sides on the real
 * rendered signal: region transposed +12 under warp, a track with T on comes out
 * ~880 Hz, a track with T off stays ~440 Hz.
 *
 * Both measurements isolate their track with solo (getAudioOutputCapture reads
 * the whole bus). Runs after mix.flows.ts (second tone track "E2E Solo Peer")
 * and warp.flows.ts. Tracks default to T on; resets state afterwards.
 */
export function registerSessionTransposePerTrackFlows() {
  it("honors per-track transpose enable under warp", async () => {
    const song = await AppPage.songView();
    const obeying = song?.tracks.find((t) => t.name === "E2E Audio Track");
    const ignoring = song?.tracks.find((t) => t.name === "E2E Solo Peer");
    if (!obeying || !ignoring) {
      throw new Error(
        "Both E2E Audio Track and E2E Solo Peer are required — mix.flows.ts must run first",
      );
    }
    for (const track of [obeying, ignoring]) {
      if (!(song?.clips ?? []).some((c) => c.trackId === track.id)) {
        throw new Error(`Track ${track.name} has no clip to measure`);
      }
    }

    // Both clips must sit in the SAME region for the comparison to mean
    // anything — the region is what carries the transpose, and addressing it
    // positionally targets the wrong one once earlier flows have left several
    // behind (see setRegionTranspose's note).
    const obeyingClip = song?.clips.find((c) => c.trackId === obeying.id);
    const regionIndex = (song?.regions ?? []).findIndex(
      (region) =>
        obeyingClip !== undefined &&
        obeyingClip.timelineStartSeconds >= region.startSeconds &&
        obeyingClip.timelineStartSeconds < region.endSeconds,
    );
    if (regionIndex < 0) {
      throw new Error("No region contains the measured track's clip");
    }
    const regionId = song!.regions[regionIndex]!.id;
    const ignoringClip = song?.clips.find((c) => c.trackId === ignoring.id);
    const sameRegion =
      ignoringClip !== undefined &&
      ignoringClip.timelineStartSeconds >=
        song!.regions[regionIndex]!.startSeconds &&
      ignoringClip.timelineStartSeconds < song!.regions[regionIndex]!.endSeconds;
    if (!sameRegion) {
      throw new Error(
        "The two tracks' clips are in different regions — the per-track " +
          "transpose comparison requires them to share one",
      );
    }

    // Warp on is the precondition for per-track transpose to mean anything —
    // but enabling the flag is NOT enough. The engine only lets a track opt out
    // of the region transpose when warp is genuinely active, which it checks as
    // `warp_enabled && warp_source_bpm > 0` (pitch_resolution.cpp). A region
    // with warp on and no source BPM has nothing to stretch against, so every
    // track transposes and the "ignoring" track comes out at 880 Hz like the
    // other one. Set the source BPM as warp.flows.ts does.
    await setRegionWarp(true, regionIndex);
    await setRegionWarpSourceBpm(60, regionIndex);
    await browser.waitUntil(
      async () => {
        const region = (await AppPage.songView())?.regions.find(
          (r) => r.id === regionId,
        );
        return region?.warpEnabled === true && (region?.warpSourceBpm ?? 0) > 0;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Warp never became active (needs both flag and source BPM)",
      },
    );

    // Disable transpose on the "ignoring" track (default on → one click), then
    // transpose the region up an octave.
    await toggleTrackTranspose(ignoring.id);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.tracks.find((t) => t.id === ignoring.id)
          ?.transposeEnabled === false,
      {
        timeout: 30_000,
        timeoutMsg: "Disabling per-track transpose never reached the model",
      },
    );
    await setRegionTranspose(12, regionIndex);
    await browser.waitUntil(
      async () =>
        (await AppPage.songView())?.regions.find((r) => r.id === regionId)
          ?.transposeSemitones === 12,
      {
        timeout: 30_000,
        timeoutMsg: "Transpose +12 never reached the clips' region",
      },
    );
    // Sanity: the obeying track still follows the region transpose.
    expect(
      (await AppPage.songView())?.tracks.find((t) => t.id === obeying.id)
        ?.transposeEnabled,
    ).toBe(true);

    // Measure each track isolated by solo.
    await toggleTrackSolo(obeying.id);
    const obeyingHz = await measureRenderedPitch(obeying.id);
    await toggleTrackSolo(obeying.id);

    await toggleTrackSolo(ignoring.id);
    const ignoringHz = await measureRenderedPitch(ignoring.id);
    await toggleTrackSolo(ignoring.id);

    // Obeying track shifted up an octave (~880 Hz); ignoring track kept the
    // fixture's ~440 Hz. The octave gap between them is the real assertion.
    expect(obeyingHz).toBeGreaterThan(700);
    expect(obeyingHz).toBeLessThan(1050);
    expect(Math.abs(ignoringHz - TONE_FREQUENCY_HZ)).toBeLessThan(60);
    expect(obeyingHz).toBeGreaterThan(ignoringHz * 1.5);

    // Restore neutral state. Re-resolve the index: the transpose resized the
    // region, which can reorder `song.regions`.
    await toggleTrackTranspose(ignoring.id);
    const regionsAfter = (await AppPage.songView())?.regions ?? [];
    const resetIndex = regionsAfter.findIndex((r) => r.id === regionId);
    const safeIndex = resetIndex >= 0 ? resetIndex : 0;
    await setRegionTranspose(0, safeIndex);
    await setRegionWarp(false, safeIndex);
  });
}
