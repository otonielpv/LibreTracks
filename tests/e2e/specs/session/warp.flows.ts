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

  /**
   * The bug this exists for: turning warp on mid-playback used to desync the
   * click and the guide voice from the tracks, and sound like a rewind.
   *
   * Neither symptom is recoverable from the rendered signal — once the grains
   * have smeared it, a feed that skipped or repeated source frames sounds much
   * like one that did not. So this asserts the two invariants the renderer owes
   * Bungee, read out of the engine's own counters with a real audio device in
   * the loop:
   *
   *   CONTIGUITY  consecutive feeds abut exactly. Any gap is a splice.
   *   RATE        the delivered stretch matches the one the region asked for.
   *               Per-block rounding that leans one way integrates into a track
   *               drifting away from the click over the length of a song.
   *
   * The ratio is established with a TEMPO MARKER at the region start, not by
   * setting the song tempo. Two things make that necessary: the engine reads
   * the effective tempo AT THE REGION START (latest marker at or before it,
   * song BPM otherwise), and disabling warp writes a marker there carrying the
   * region's source BPM. After the flow above, that marker and the source BPM
   * are equal — so any ratio derived from the song's base tempo is a fiction,
   * and the engine correctly renders at 1.0.
   */
  it("keeps the warp feed contiguous and on-ratio when toggled during playback", async () => {
    const song = await AppPage.songView();
    const track = song?.tracks.find((t) => t.name === "E2E Audio Track");
    const clip = song?.clips.find((c) => c.trackId === track?.id);
    if (!track || !clip) {
      throw new Error(
        "E2E Audio Track with a clip is required for the warp timing flow",
      );
    }
    const regionIndex = (song?.regions ?? []).findIndex(
      (region) =>
        clip.timelineStartSeconds >= region.startSeconds &&
        clip.timelineStartSeconds < region.endSeconds,
    );
    if (regionIndex < 0) {
      throw new Error("No region contains the warped track's clip");
    }
    const regionId = song!.regions[regionIndex]!.id;
    const indexOfRegion = async () =>
      ((await AppPage.songView())?.regions ?? []).findIndex(
        (r) => r.id === regionId,
      );
    const regionNow = async () =>
      (await AppPage.songView())?.regions.find((r) => r.id === regionId);

    await setRegionTranspose(0, regionIndex);
    await setRegionWarp(false, regionIndex);

    const region = await regionNow();
    const sourceBpm = region?.warpSourceBpm ?? 120;
    const regionStart = region?.startSeconds ?? 0;
    // A tempo that does NOT divide the source BPM evenly. A ratio like 2
    // divides every common block size exactly, so ceil(block * ratio) equals
    // block * ratio and any rounding bug reports zero error — which is how this
    // class of defect stayed invisible for so long.
    const timelineBpm = Math.round(sourceBpm * 1.2) + 1;
    await AppPage.upsertSongTempoMarker(regionStart, timelineBpm);
    const requested = timelineBpm / sourceBpm;

    // Park the playhead just inside the region. Warping shrinks the region's
    // timeline length by the ratio, so starting at its head is what leaves room
    // for the sampling window below.
    const timelineView = await AppPage.timelineView();
    const ruler = await AppPage.timelineRuler;
    const rulerSize = await ruler.getSize();
    const pixelsPerSecond = timelineView.zoomLevel * 18;
    const seekFromLeft =
      (regionStart + 0.2) * pixelsPerSecond - timelineView.cameraX;
    await ruler.click({
      x: Math.round(seekFromLeft - rulerSize.width / 2),
      y: 0,
    });

    // Start playing BEFORE warp goes on. That ordering is the whole point: the
    // engine has to move a live, warm voice onto the warped geometry while the
    // transport keeps running.
    await (await AppPage.playButton).click();
    await AppPage.waitForTrackSignal(track.id);

    await setRegionWarp(true, await indexOfRegion());
    expect((await regionNow())?.warpEnabled).toBe(true);

    // Counters are cumulative since engine start, so bracket the window. Take
    // the baseline AFTER the toggle has settled: the one-off re-anchor as the
    // voice lands on the new geometry is the design working, not a defect.
    // The window stays short because the region is only a few seconds long once
    // the ratio has compressed it.
    await browser.pause(400);
    const before = await AppPage.engineDiagnostics();
    await browser.pause(1200);
    const after = await AppPage.engineDiagnostics();

    await (await AppPage.stopButton).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.transportSnapshot()).playbackState === "stopped",
      { timeoutMsg: "Engine did not stop after the warp timing flow" },
    );

    const delta = (key: string) =>
      Number(after[key] ?? 0) - Number(before[key] ?? 0);
    const fed = delta("warpSourceFramesFed");
    const made = delta("warpOutputFramesMade");
    const gapFrames = delta("warpFeedGapFrames");

    // Guard: if the warp path never ran, everything below would pass vacuously.
    expect(made).toBeGreaterThan(0);
    expect(fed).toBeGreaterThan(0);

    // Every gap is a splice. There is no acceptable non-zero value.
    if (gapFrames !== 0) {
      throw new Error(
        `warp feed was spliced: gapFrames=${gapFrames} over ` +
          `${delta("warpFeedGapEvents")} blocks (fed=${fed} made=${made})`,
      );
    }

    // Delivered vs requested stretch. 0.5% is loose enough to survive a block
    // boundary landing inside the sampled window, and tight enough that the
    // per-block rounding this replaced (0.078% at a 512-frame block, 0.31% at
    // 256) would fail it. The unit tests hold the same ratio to 0.01%.
    const delivered = fed / made;
    const relError = Math.abs(delivered - requested) / requested;
    if (relError >= 0.005) {
      const view = await AppPage.songView();
      const r = view?.regions.find((x) => x.id === regionId);
      throw new Error(
        `warp ratio off: requested=${requested} delivered=${delivered} ` +
          `relError=${(relError * 100).toFixed(4)}% fed=${fed} made=${made} ` +
          `| songBpm=${view?.bpm} regionStart=${r?.startSeconds} ` +
          `warpEnabled=${r?.warpEnabled} warpSourceBpm=${r?.warpSourceBpm} ` +
          `tempoMarkers=${JSON.stringify(
            (view?.tempoMarkers ?? []).map((m) => [m.startSeconds, m.bpm]),
          )}`,
      );
    }

    // Leave the region neutral for whatever runs next.
    const resetIndex = await indexOfRegion();
    await setRegionWarp(false, resetIndex >= 0 ? resetIndex : 0);
  });
}
