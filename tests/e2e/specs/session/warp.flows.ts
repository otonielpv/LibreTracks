import { browser, expect, $$ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import {
  TONE_FREQUENCY_HZ,
  measureRenderedPitch,
  setRegionTranspose,
  setRegionWarp,
  setRegionWarpSourceBpm,
} from "./support.js";

/**
 * Warp is what makes LibreTracks' pitch/tempo independent: it time-stretches a
 * region's audio (aligning its source BPM to the timeline tempo) WITHOUT changing
 * pitch — the defining difference from plain vari-speed, where stretching time
 * also shifts pitch. This proves it on the real rendered signal.
 *
 * With the default 120 BPM timeline, setting the region's warp source BPM to 60
 * asks the engine to stretch the audio 2×. Under vari-speed that 2× stretch would
 * drop the 440 Hz tone an octave to ~220 Hz; under warp the pitch stays ~440 Hz.
 * We measure the captured output's dominant frequency to tell them apart.
 *
 * Runs after transpose.flows.ts (which left the region at transpose 0). Resets
 * warp afterwards so later flows start neutral.
 */
export function registerSessionWarpFlows() {
  it("time-stretches under warp while preserving pitch", async () => {
    const song = await AppPage.songView();
    const track = song?.tracks.find((t) => t.name === "E2E Audio Track");
    if (!track) {
      throw new Error("E2E Audio Track is required for the warp flow");
    }
    if (!(song?.clips ?? []).some((c) => c.trackId === track.id)) {
      throw new Error("E2E Audio Track has no clip to warp");
    }

    // Act on the region that actually CONTAINS this track's clip. Addressing
    // regions positionally (hotspots[0] / regions[0]) only works while there is
    // one region and quietly targets the wrong one afterwards.
    const clip = song?.clips.find((c) => c.trackId === track.id);
    const regionIndex = (song?.regions ?? []).findIndex(
      (region) =>
        clip !== undefined &&
        clip.timelineStartSeconds >= region.startSeconds &&
        clip.timelineStartSeconds < region.endSeconds,
    );
    if (regionIndex < 0) {
      throw new Error("No region contains the warped track's clip");
    }
    const regionId = song!.regions[regionIndex]!.id;

    // Make sure transpose is neutral: this test is about warp's time/pitch
    // decoupling, not pitch shifting.
    await setRegionTranspose(0, regionIndex);

    // Enable warp and force a 2× stretch (source 60 vs timeline 120).
    await setRegionWarp(true, regionIndex);
    await setRegionWarpSourceBpm(60, regionIndex);
    expect(
      (await AppPage.songView())?.regions.find((r) => r.id === regionId)
        ?.warpEnabled,
    ).toBe(true);

    // The pitch must stay at the fixture's ~440 Hz despite the 2× time stretch —
    // vari-speed would have dropped it toward ~220 Hz. Comfortably above 320 Hz
    // separates "preserved" from "octave down".
    const warpedHz = await measureRenderedPitch(track.id);
    expect(Math.abs(warpedHz - TONE_FREQUENCY_HZ)).toBeLessThan(60);
    expect(warpedHz).toBeGreaterThan(320);

    // Restore neutral warp for later flows. Re-resolve the index: warping can
    // resize the region and reorder `song.regions`.
    const regionsAfter = (await AppPage.songView())?.regions ?? [];
    const resetIndex = regionsAfter.findIndex((r) => r.id === regionId);
    await setRegionWarp(false, resetIndex >= 0 ? resetIndex : 0);
  });
}
