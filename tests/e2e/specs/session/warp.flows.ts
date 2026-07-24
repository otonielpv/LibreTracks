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

    // Select the region and make sure transpose is neutral: this test is about
    // warp's time/pitch decoupling, not pitch shifting.
    const hotspots = await $$(".lt-region-hotspot").getElements();
    expect(hotspots.length).toBeGreaterThan(0);
    await hotspots[0].click();
    await setRegionTranspose(0);

    // Enable warp and force a 2× stretch (source 60 vs timeline 120).
    await setRegionWarp(true);
    await setRegionWarpSourceBpm(60);
    expect(
      (await AppPage.songView())?.regions[0]?.warpEnabled,
    ).toBe(true);

    // The pitch must stay at the fixture's ~440 Hz despite the 2× time stretch —
    // vari-speed would have dropped it toward ~220 Hz. Comfortably above 320 Hz
    // separates "preserved" from "octave down".
    const warpedHz = await measureRenderedPitch(track.id);
    expect(Math.abs(warpedHz - TONE_FREQUENCY_HZ)).toBeLessThan(60);
    expect(warpedHz).toBeGreaterThan(320);

    // Restore neutral warp for later flows.
    await setRegionWarp(false);
  });
}
