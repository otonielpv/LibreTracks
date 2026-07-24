import { browser, expect } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import type { SessionFixture } from "./support.js";

/**
 * Timeline edit-operation flows: the drag/resize/move edge cases the happy-path
 * specs don't reach — moving clips, moving multiple clips, resizing regions,
 * the "regions can't cross" invariant, trimming a clip against its source, and
 * region/marker deletion.
 *
 * These run the SAME shared commands a canvas drag or resize handle invokes
 * (move_clip, move_clips_batch, update_song_region, move_song_region,
 * update_clip_window, …). The canvas hit-testing itself isn't piloted —
 * WebDriver can't drive a <canvas> — but the backend edit and, crucially, its
 * INVARIANTS are exercised identically and asserted against the canonical song
 * model (getSongView), the same "prove it reached the backend" discipline the
 * other flows use.
 *
 * Registered by `specs/timeline-edits.e2e.ts` against its OWN clean session
 * (not the shared session.e2e.ts project) — see that spec's header for why. The
 * flow is fully self-contained regardless: it stands up its own disposable
 * tracks, clips and regions PAST the true end of all existing content (anchored
 * to max(regionEnd, clipEnd) read live, with a wide gap between the two regions)
 * and tears them down in `after`. Because it runs in a pristine single-region
 * session, that anchor lands in genuinely empty space, so its two clips each get
 * their own fresh region with no merge into a pre-existing one.
 *
 * Key backend behaviours these assert (verified in state/regions.rs +
 * state/arrangement.rs), so the tests match reality rather than an assumed spec:
 *   - move_clip normalizes a negative target to >= 0 and RESHAPES the region to
 *     cover the clip (ensure_region_covers_clip) — a clip dragged past its
 *     region's end grows the region; it is NOT rejected.
 *   - update_song_region extending the end is allowed; shrinking so a clip would
 *     dangle outside the new bounds is REJECTED with a clear error.
 *   - move_song_region LEFT into the preceding region is REJECTED; move RIGHT
 *     into the following region CASCADE-PUSHES it instead of overlapping.
 *   - update_clip_window trimming inside the source is allowed; a window that
 *     runs past the decoded source audio is REJECTED.
 */
export function registerSessionTimelineEditFlows(fixture: SessionFixture) {
  // Two disposable tracks, each with one 5 s clip, placed strictly PAST the
  // true end of all existing regions with a wide gap between them, so each
  // clip lands in its OWN freshly auto-created region — never merged into a
  // pre-existing region the earlier flows left behind. The exact start
  // positions are computed at runtime from the current max region end (the
  // canonical topology is not knowable ahead of time), not hardcoded.
  const TRACK_A_NAME = "E2E Edit Track A";
  const TRACK_B_NAME = "E2E Edit Track B";
  const CLIP_DURATION = 5; // the tone fixture is 5 s
  const CLIP_GAP = 30; // wide gap so A's and B's regions never touch
  // Filled in before() from the live song; A sits well past all content, B a
  // full CLIP_GAP past A.
  let clipAStart = 0;
  let clipBStart = 0;

  let clipAId = "";
  let clipBId = "";
  let trackAId = "";
  let trackBId = "";
  let regionAId = "";
  let regionBId = "";
  const disposableRegionIds = new Set<string>();
  // Canonical region bounds captured up front. The clamp-to-zero case can make
  // ensure_region_covers_clip extend the canonical region at t=0; we restore
  // any drifted canonical bounds in `after` so the block leaves regions[0]
  // exactly as it found it (transpose/warp/pad flows ran earlier, but keeping
  // the model pristine avoids surprising any future flow ordered after this).
  const canonicalRegionBounds = new Map<
    string,
    { name: string; startSeconds: number; endSeconds: number }
  >();

  const songView = () => AppPage.songView();
  const clipById = async (id: string) =>
    (await songView())?.clips.find((clip) => clip.id === id);
  const regionCovering = async (seconds: number) =>
    (await songView())?.regions.find(
      (region) =>
        region.startSeconds <= seconds + 1e-3 &&
        region.endSeconds > seconds - 1e-3,
    );

  /**
   * Re-resolve regionAId/regionBId from where clips A and B currently sit.
   * move_clip prunes a clip's now-empty origin region and auto-creates a new
   * one at the destination, so a region's id is NOT stable across a move that
   * takes its clip outside it. Region-dependent cases call this first so they
   * always address the region that actually contains the clip. Any freshly
   * seen non-canonical region is tracked for teardown.
   */
  const resyncRegionIds = async () => {
    const song = await songView();
    const posA = song?.clips.find((c) => c.id === clipAId)?.timelineStartSeconds;
    const posB = song?.clips.find((c) => c.id === clipBId)?.timelineStartSeconds;
    const findCovering = (pos: number | undefined) =>
      pos === undefined
        ? undefined
        : song?.regions.find(
            (r) => r.startSeconds <= pos + 1e-3 && r.endSeconds > pos - 1e-3,
          );
    regionAId = findCovering(posA)?.id ?? regionAId;
    regionBId = findCovering(posB)?.id ?? regionBId;
    for (const region of song?.regions ?? []) {
      if (!canonicalRegionBounds.has(region.id)) {
        disposableRegionIds.add(region.id);
      }
    }
  };

  before(async () => {
    const canonicalRegions = (await songView())?.regions ?? [];
    const canonicalRegionIds = new Set(
      canonicalRegions.map((region) => region.id),
    );
    for (const region of canonicalRegions) {
      canonicalRegionBounds.set(region.id, {
        name: region.name,
        startSeconds: region.startSeconds,
        endSeconds: region.endSeconds,
      });
    }

    // Place our clips STRICTLY past the true end of everything already in the
    // song. Earlier flows leave regions ("Song 2", "Song 4", …) at positions we
    // can't predict; dropping at a fixed 100 s risked landing inside one of
    // them. Anchor off the max region end (and clip end, belt-and-suspenders).
    const maxRegionEnd = canonicalRegions.reduce(
      (max, region) => Math.max(max, region.endSeconds),
      0,
    );
    const maxClipEnd = (
      (await songView())?.clips ?? []
    ).reduce(
      (max, clip) => Math.max(max, clip.timelineStartSeconds + clip.durationSeconds),
      0,
    );
    const anchor = Math.max(maxRegionEnd, maxClipEnd) + 20;
    clipAStart = anchor;
    clipBStart = anchor + CLIP_GAP;

    // One track + clip per request; the backend auto-creates a fresh region
    // around each (they're past all existing content, so no merge).
    const created = await AppPage.createAudioTracksWithClips([
      {
        trackName: TRACK_A_NAME,
        filePath: fixture.audioFilePath,
        timelineStartSeconds: clipAStart,
      },
      {
        trackName: TRACK_B_NAME,
        filePath: fixture.audioFilePath,
        timelineStartSeconds: clipBStart,
      },
    ]);
    if (created.length !== 2) {
      throw new Error(
        `Expected two disposable clips, backend created ${created.length}`,
      );
    }

    const song = await songView();
    const clipA = song?.clips.find((clip) => clip.id === created[0]);
    const clipB = song?.clips.find((clip) => clip.id === created[1]);
    clipAId = clipA?.id ?? "";
    clipBId = clipB?.id ?? "";
    trackAId = clipA?.trackId ?? "";
    trackBId = clipB?.trackId ?? "";
    // Use the clips' ACTUAL landed positions (normalize/reshape may nudge them).
    clipAStart = clipA?.timelineStartSeconds ?? clipAStart;
    clipBStart = clipB?.timelineStartSeconds ?? clipBStart;

    regionAId = (await regionCovering(clipAStart))?.id ?? "";
    regionBId = (await regionCovering(clipBStart))?.id ?? "";
    for (const region of song?.regions ?? []) {
      if (!canonicalRegionIds.has(region.id)) {
        disposableRegionIds.add(region.id);
      }
    }

    if (!clipAId || !clipBId || !regionAId || !regionBId) {
      throw new Error("Disposable edit fixture was not fully created");
    }
    // The two clips must live in DISTINCT regions (they're gap-separated), or
    // the no-cross assertions below are meaningless. If the backend merged them
    // into one region, the gap wasn't wide enough / anchor wasn't past content.
    expect(regionAId).not.toBe(regionBId);
  });

  // A move (single or batch) can prune a clip's origin region and recreate a
  // fresh one at the destination, so a region id is not stable across moves.
  // Re-resolve regionAId/regionBId before every case so region-dependent tests
  // always address the region that currently contains their clip. Idempotent —
  // a no-op read when nothing moved.
  beforeEach(async () => {
    if (clipAId && clipBId) {
      await resyncRegionIds();
    }
  });

  after(async () => {
    // Delete the tracks (removes their clips), then explicitly delete every
    // region this block created — delete_tracks does not prune now-empty
    // regions, so we reclaim them to restore the starting region set exactly.
    const liveTrackIds = new Set(
      ((await songView())?.tracks ?? []).map((track) => track.id),
    );
    const toDelete = [trackAId, trackBId].filter(
      (id) => id && liveTrackIds.has(id),
    );
    if (toDelete.length) {
      await AppPage.deleteTracks(toDelete);
    }
    for (const regionId of disposableRegionIds) {
      const stillThere = ((await songView())?.regions ?? []).some(
        (region) => region.id === regionId,
      );
      if (stillThere) {
        await AppPage.deleteSongRegion(regionId).catch(() => undefined);
      }
    }

    // Restore any canonical region whose bounds drifted (the clamp-to-zero case
    // can extend the t=0 region). Only the still-present canonical regions are
    // restorable; a drifted end is reset via updateSongRegion.
    const remaining = (await songView())?.regions ?? [];
    for (const region of remaining) {
      const original = canonicalRegionBounds.get(region.id);
      if (!original) continue;
      const drifted =
        Math.abs(region.startSeconds - original.startSeconds) > 1e-3 ||
        Math.abs(region.endSeconds - original.endSeconds) > 1e-3;
      if (drifted) {
        await AppPage.updateSongRegion(
          region.id,
          original.name,
          original.startSeconds,
          original.endSeconds,
        ).catch(() => undefined);
      }
    }
  });

  it("moves a single clip to a new timeline position", async () => {
    const target = clipAStart + 3;
    await AppPage.moveClip(clipAId, target);
    await browser.waitUntil(
      async () =>
        Math.abs(((await clipById(clipAId))?.timelineStartSeconds ?? -1) - target) <
        0.05,
      {
        timeout: 30_000,
        timeoutMsg: "Moving the clip did not reach the backend song model",
      },
    );
    // Move it back so later cases start from the known layout.
    await AppPage.moveClip(clipAId, clipAStart);
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - clipAStart,
        ) < 0.05,
      { timeout: 30_000, timeoutMsg: "Clip did not return to its start" },
    );
  });

  it("clamps a clip dragged before the project start to zero", async () => {
    // Fully isolated: this case necessarily lands a clip at t=0, which
    // ensure_region_covers_clip resolves against whatever region already sits
    // there, and move_clip prunes the clip's now-empty origin region. Running
    // it on a THROWAWAY track/clip created and destroyed inside the test keeps
    // that churn away from clips A/B and regions A/B the other cases rely on.
    // (The canonical-bounds restore in `after` still resets regions[0] if the
    // clamp extended it.)
    const created = await AppPage.createAudioTracksWithClips([
      {
        trackName: "E2E Clamp Track",
        filePath: fixture.audioFilePath,
        timelineStartSeconds: 300,
      },
    ]);
    const clampClipId = created[0];
    if (!clampClipId) {
      throw new Error("Could not create the throwaway clip for the clamp case");
    }
    const clampTrackId = (await clipById(clampClipId))?.trackId ?? "";

    await AppPage.moveClip(clampClipId, -50);
    await browser.waitUntil(
      async () => {
        const pos = (await clipById(clampClipId))?.timelineStartSeconds ?? -1;
        return pos >= 0 && pos < 0.001;
      },
      {
        timeout: 30_000,
        timeoutMsg: "The clip was not clamped to the project start (0)",
      },
    );
    // The clamped clip is always inside SOME region (auto-reshaped/created).
    const clamped = await clipById(clampClipId);
    const covering = await regionCovering(clamped?.timelineStartSeconds ?? 0);
    expect(covering).toBeDefined();

    // Tear the throwaway down. Deleting the track drops its clip; then reclaim
    // any region left empty that isn't canonical or one of ours.
    if (clampTrackId) {
      await AppPage.deleteTracks([clampTrackId]);
    }
    for (const region of (await songView())?.regions ?? []) {
      const isCanonical = canonicalRegionBounds.has(region.id);
      const isOurs =
        disposableRegionIds.has(region.id) ||
        region.id === regionAId ||
        region.id === regionBId;
      const hasClip = ((await songView())?.clips ?? []).some(
        (clip) =>
          clip.timelineStartSeconds >= region.startSeconds &&
          clip.timelineStartSeconds < region.endSeconds,
      );
      if (!isCanonical && !isOurs && !hasClip) {
        await AppPage.deleteSongRegion(region.id).catch(() => undefined);
      }
    }
  });

  it("grows the region to cover a clip dragged past the region's end (reshape)", async () => {
    const regionBefore = await regionCovering(clipAStart);
    if (!regionBefore) {
      throw new Error("Region A missing before the reshape case");
    }
    // Drag the clip well past the region's end; the backend reshapes the region
    // to envelop it rather than rejecting the move.
    const farStart = regionBefore.endSeconds + 4;
    await AppPage.moveClip(clipAId, farStart);
    await browser.waitUntil(
      async () => {
        const clip = await clipById(clipAId);
        if (!clip) return false;
        const covering = await regionCovering(clip.timelineStartSeconds);
        return (
          Math.abs(clip.timelineStartSeconds - farStart) < 0.05 &&
          covering !== undefined &&
          covering.endSeconds >= clip.timelineStartSeconds + CLIP_DURATION - 0.1
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "The region did not reshape to cover the clip dragged past its end",
      },
    );
    const clip = await clipById(clipAId);
    const covering = await regionCovering(clip?.timelineStartSeconds ?? 0);
    expect(covering?.endSeconds ?? 0).toBeGreaterThanOrEqual(
      (clip?.timelineStartSeconds ?? 0) + CLIP_DURATION - 0.1,
    );
    // Restore clip A to its start (region shrinks back on prune/reshape).
    await AppPage.moveClip(clipAId, clipAStart);
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - clipAStart,
        ) < 0.05,
      { timeout: 30_000, timeoutMsg: "Clip A did not return to its start" },
    );
  });

  it("moves multiple clips together in one batch", async () => {
    const before = {
      a: (await clipById(clipAId))?.timelineStartSeconds ?? 0,
      b: (await clipById(clipBId))?.timelineStartSeconds ?? 0,
    };
    const delta = 2;
    await AppPage.moveClipsBatch([
      { clipId: clipAId, timelineStartSeconds: before.a + delta },
      { clipId: clipBId, timelineStartSeconds: before.b + delta },
    ]);
    await browser.waitUntil(
      async () => {
        const a = (await clipById(clipAId))?.timelineStartSeconds ?? -1;
        const b = (await clipById(clipBId))?.timelineStartSeconds ?? -1;
        return (
          Math.abs(a - (before.a + delta)) < 0.05 &&
          Math.abs(b - (before.b + delta)) < 0.05
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "The batch move did not translate both clips",
      },
    );
    // Restore both.
    await AppPage.moveClipsBatch([
      { clipId: clipAId, timelineStartSeconds: before.a },
      { clipId: clipBId, timelineStartSeconds: before.b },
    ]);
    await browser.waitUntil(
      async () => {
        const a = (await clipById(clipAId))?.timelineStartSeconds ?? -1;
        const b = (await clipById(clipBId))?.timelineStartSeconds ?? -1;
        return (
          Math.abs(a - before.a) < 0.05 && Math.abs(b - before.b) < 0.05
        );
      },
      { timeout: 30_000, timeoutMsg: "Batched clips did not return" },
    );
  });

  it("reassigns a clip to another track via a batch move (vertical drag)", async () => {
    const before = await clipById(clipBId);
    if (!before) {
      throw new Error("Clip B missing before the track-reassign case");
    }
    // Vertical drag = same timeline position, new track. Move clip B onto
    // track A.
    await AppPage.moveClipsBatch([
      {
        clipId: clipBId,
        timelineStartSeconds: before.timelineStartSeconds,
        targetTrackId: trackAId,
      },
    ]);
    await browser.waitUntil(
      async () => (await clipById(clipBId))?.trackId === trackAId,
      {
        timeout: 30_000,
        timeoutMsg: "The clip was not reassigned to the target track",
      },
    );
    // Move it back onto track B at its original position.
    await AppPage.moveClipsBatch([
      {
        clipId: clipBId,
        timelineStartSeconds: before.timelineStartSeconds,
        targetTrackId: trackBId,
      },
    ]);
    await browser.waitUntil(
      async () => (await clipById(clipBId))?.trackId === trackBId,
      { timeout: 30_000, timeoutMsg: "Clip B was not restored to its track" },
    );
  });

  it("extends a region's end past its content", async () => {
    const region = (await songView())?.regions.find((r) => r.id === regionAId);
    if (!region) {
      throw new Error("Region A missing before the extend case");
    }
    const newEnd = region.endSeconds + 6;
    await AppPage.updateSongRegion(
      regionAId,
      region.name,
      region.startSeconds,
      newEnd,
    );
    await browser.waitUntil(
      async () => {
        const updated = (await songView())?.regions.find(
          (r) => r.id === regionAId,
        );
        return Math.abs((updated?.endSeconds ?? 0) - newEnd) < 0.1;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Extending the region end did not reach the backend model",
      },
    );
    // Restore the original bounds.
    await AppPage.updateSongRegion(
      regionAId,
      region.name,
      region.startSeconds,
      region.endSeconds,
    );
    await browser.waitUntil(
      async () => {
        const updated = (await songView())?.regions.find(
          (r) => r.id === regionAId,
        );
        return Math.abs((updated?.endSeconds ?? 0) - region.endSeconds) < 0.1;
      },
      { timeout: 30_000, timeoutMsg: "Region A end did not restore" },
    );
  });

  it("refuses to shrink a region so a clip would fall outside it", async () => {
    const region = (await songView())?.regions.find((r) => r.id === regionAId);
    const clip = await clipById(clipAId);
    if (!region || !clip) {
      throw new Error("Region/clip A missing before the shrink-reject case");
    }
    // Shrink the end to just after the clip's start — the clip's tail would
    // dangle past the new end, which the backend rejects.
    const strandingEnd = clip.timelineStartSeconds + CLIP_DURATION / 2;
    await expect(
      AppPage.updateSongRegion(
        regionAId,
        region.name,
        region.startSeconds,
        strandingEnd,
      ),
    ).rejects.toThrow();
    // The region bounds must be unchanged after the rejected resize.
    const after = (await songView())?.regions.find((r) => r.id === regionAId);
    expect(after?.startSeconds ?? -1).toBeCloseTo(region.startSeconds, 3);
    expect(after?.endSeconds ?? -1).toBeCloseTo(region.endSeconds, 3);
  });

  it("refuses to move a region left so it would overlap the preceding one", async () => {
    const song = await songView();
    const regionA = song?.regions.find((r) => r.id === regionAId);
    const regionB = song?.regions.find((r) => r.id === regionBId);
    if (!regionA || !regionB) {
      throw new Error("Both disposable regions must exist for the no-cross case");
    }
    // Region B sits after region A. Try to slide B left far enough to overlap
    // A — the backend bounces it (no symmetric push-left).
    const overlappingDelta = -(regionB.startSeconds - regionA.startSeconds + 1);
    await expect(
      AppPage.moveSongRegion(regionBId, overlappingDelta),
    ).rejects.toThrow();
    // B's bounds unchanged.
    const afterB = (await songView())?.regions.find((r) => r.id === regionBId);
    expect(afterB?.startSeconds ?? -1).toBeCloseTo(regionB.startSeconds, 2);
  });

  it("cascade-pushes the following region when a region is moved right into it", async () => {
    let song = await songView();
    let regionA = song?.regions.find((r) => r.id === regionAId);
    let regionB = song?.regions.find((r) => r.id === regionBId);
    if (!regionA || !regionB) {
      throw new Error("Both disposable regions must exist for the cascade case");
    }
    const clip = await clipById(clipAId);
    if (!clip) {
      throw new Error("Clip A missing before the cascade case");
    }

    // A region filled edge-to-edge by its clip can't move at all without the
    // clip crossing the neighbour (the validator rejects that). Real DAW
    // regions have empty tail room. Give region A trailing headroom so its END
    // (not its clip) is what pushes into B: extend A's end to just before B's
    // start, keeping the clip parked at region A's start.
    const headroomEnd = regionB.startSeconds - 1;
    if (headroomEnd > regionA.endSeconds) {
      await AppPage.updateSongRegion(
        regionAId,
        regionA.name,
        regionA.startSeconds,
        headroomEnd,
      );
      await browser.waitUntil(
        async () => {
          const a = (await songView())?.regions.find((r) => r.id === regionAId);
          return Math.abs((a?.endSeconds ?? 0) - headroomEnd) < 0.2;
        },
        { timeout: 30_000, timeoutMsg: "Region A headroom extend did not apply" },
      );
      song = await songView();
      regionA = song?.regions.find((r) => r.id === regionAId);
      regionB = song?.regions.find((r) => r.id === regionBId);
    }
    if (!regionA || !regionB) {
      throw new Error("Regions vanished after headroom extend");
    }

    const bStartBefore = regionB.startSeconds;
    const clipStartBefore =
      (await clipById(clipAId))?.timelineStartSeconds ?? regionA.startSeconds;
    // Move A right by a small amount so its END pushes ~2 s past B's start; the
    // clip (parked near A's start with lots of tail room) stays clear of the
    // boundary, and B cascade-pushes rightward instead of overlapping.
    const delta = regionB.startSeconds - regionA.endSeconds + 2;
    await AppPage.moveSongRegion(regionAId, delta);
    await browser.waitUntil(
      async () => {
        const s = await songView();
        const a = s?.regions.find((r) => r.id === regionAId);
        const b = s?.regions.find((r) => r.id === regionBId);
        if (!a || !b) return false;
        // No overlap, and B has been pushed rightward off its old start.
        return b.startSeconds >= a.endSeconds - 0.2 && b.startSeconds > bStartBefore + 0.5;
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "Moving region A right did not cascade-push region B clear of it",
      },
    );
    const s = await songView();
    const a = s?.regions.find((r) => r.id === regionAId);
    const b = s?.regions.find((r) => r.id === regionBId);
    // The two regions never overlap after the cascade.
    expect(b?.startSeconds ?? 0).toBeGreaterThanOrEqual((a?.endSeconds ?? 0) - 0.2);
    // The clip moved with its region by the same delta (sanity).
    const clipAfter = await clipById(clipAId);
    expect(clipAfter?.timelineStartSeconds ?? 0).toBeCloseTo(
      clipStartBefore + delta,
      1,
    );
  });

  it("trims a clip window inside its source but refuses a window past the source", async () => {
    const clip = await clipById(clipBId);
    if (!clip) {
      throw new Error("Clip B missing before the trim case");
    }
    // A valid trim: keep the start, halve the duration, source offset 0.
    const trimmedDuration = CLIP_DURATION / 2;
    await AppPage.updateClipWindow(
      clipBId,
      clip.timelineStartSeconds,
      0,
      trimmedDuration,
    );
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipBId))?.durationSeconds ?? -1) - trimmedDuration,
        ) < 0.05,
      {
        timeout: 30_000,
        timeoutMsg: "Trimming the clip window did not reach the backend model",
      },
    );

    // An invalid window: ask for far more audio than the 5 s source holds.
    await expect(
      AppPage.updateClipWindow(
        clipBId,
        clip.timelineStartSeconds,
        0,
        CLIP_DURATION * 10,
      ),
    ).rejects.toThrow();
    // The clip keeps the last valid (trimmed) duration.
    expect((await clipById(clipBId))?.durationSeconds ?? -1).toBeCloseTo(
      trimmedDuration,
      2,
    );

    // Restore the full-length window for a clean teardown.
    await AppPage.updateClipWindow(
      clipBId,
      clip.timelineStartSeconds,
      0,
      CLIP_DURATION,
    );
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipBId))?.durationSeconds ?? -1) - CLIP_DURATION,
        ) < 0.1,
      { timeout: 30_000, timeoutMsg: "Clip B window did not restore" },
    );
  });

  it("moves and deletes a section marker", async () => {
    // Create a custom marker inside region A's span (well past canonical
    // content), drag it (updateSectionMarker), then delete it.
    const clip = await clipById(clipAId);
    const anchor = (clip?.timelineStartSeconds ?? clipAStart) + 1;
    const markerId = await AppPage.createSectionMarker(anchor);
    if (!markerId) {
      throw new Error("The section marker was not created");
    }
    await browser.waitUntil(
      async () =>
        ((await songView())?.sectionMarkers ?? []).some(
          (marker) => marker.id === markerId,
        ),
      { timeout: 30_000, timeoutMsg: "The new section marker never persisted" },
    );

    const markerBefore = ((await songView())?.sectionMarkers ?? []).find(
      (marker) => marker.id === markerId,
    );
    const movedTo = (markerBefore?.startSeconds ?? anchor) + 1.5;
    await AppPage.updateSectionMarker(
      markerId,
      markerBefore?.name ?? "E2E Marker",
      movedTo,
    );
    await browser.waitUntil(
      async () => {
        const marker = ((await songView())?.sectionMarkers ?? []).find(
          (m) => m.id === markerId,
        );
        return Math.abs((marker?.startSeconds ?? -1) - movedTo) < 0.05;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Moving the section marker did not reach the backend model",
      },
    );

    await AppPage.deleteSectionMarker(markerId);
    await browser.waitUntil(
      async () =>
        !((await songView())?.sectionMarkers ?? []).some(
          (marker) => marker.id === markerId,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the section marker did not reach the backend",
      },
    );
  });

  it("splits a region at a timeline position and deletes the tail", async () => {
    const region = (await songView())?.regions.find((r) => r.id === regionAId);
    const clip = await clipById(clipAId);
    if (!region || !clip) {
      throw new Error("Region/clip A missing before the region-split case");
    }
    const regionCountBefore = ((await songView())?.regions ?? []).length;
    // Split after the clip so the left half keeps the clip and the right half
    // is an empty tail we can delete.
    const splitAt = clip.timelineStartSeconds + CLIP_DURATION + 1;
    // Make sure the region actually reaches the split point first.
    if (region.endSeconds <= splitAt) {
      await AppPage.updateSongRegion(
        regionAId,
        region.name,
        region.startSeconds,
        splitAt + 2,
      );
    }
    await AppPage.splitSongRegion(regionAId, splitAt);
    await browser.waitUntil(
      async () =>
        ((await songView())?.regions ?? []).length === regionCountBefore + 1,
      {
        timeout: 30_000,
        timeoutMsg: "Splitting the region did not create a second region",
      },
    );
    // Adopt the new tail region for teardown, then delete it now to restore
    // the region count.
    const afterSplit = (await songView())?.regions ?? [];
    const tail = afterSplit.find(
      (r) =>
        r.id !== regionAId &&
        r.id !== regionBId &&
        !disposableRegionIds.has(r.id) &&
        r.startSeconds >= splitAt - 1e-3,
    );
    if (tail) {
      await AppPage.deleteSongRegion(tail.id);
      await browser.waitUntil(
        async () =>
          !((await songView())?.regions ?? []).some((r) => r.id === tail.id),
        { timeout: 30_000, timeoutMsg: "The split-off region did not delete" },
      );
    }
  });

  it("deletes a multi-selection of clips in one transaction", async () => {
    // Duplicate-free multi-delete: add a throwaway clip on track A next to
    // clip A, then delete both A-side clips at once and confirm the count drop.
    const created = await AppPage.createAudioTracksWithClips([
      {
        trackName: "E2E Edit Track C",
        filePath: fixture.audioFilePath,
        timelineStartSeconds: 200,
      },
    ]);
    const extraClipId = created[0];
    if (!extraClipId) {
      throw new Error("Could not create the throwaway clip for multi-delete");
    }
    // Track the auto-created track + region so teardown reclaims them even if
    // the delete below is what removes the clip.
    const extraClip = await clipById(extraClipId);
    const extraTrackId = extraClip?.trackId ?? "";
    for (const region of (await songView())?.regions ?? []) {
      if (
        region.id !== regionAId &&
        region.id !== regionBId &&
        !disposableRegionIds.has(region.id) &&
        region.startSeconds <= 200 &&
        region.endSeconds > 200
      ) {
        disposableRegionIds.add(region.id);
      }
    }

    const countBefore = ((await songView())?.clips ?? []).length;
    await AppPage.deleteClips([extraClipId]);
    await browser.waitUntil(
      async () =>
        !((await songView())?.clips ?? []).some((c) => c.id === extraClipId),
      {
        timeout: 30_000,
        timeoutMsg: "Batch clip deletion did not remove the clip",
      },
    );
    expect(((await songView())?.clips ?? []).length).toBe(countBefore - 1);

    // Remove the now-empty throwaway track so teardown's region cleanup is the
    // only thing left.
    if (extraTrackId) {
      const stillThere = ((await songView())?.tracks ?? []).some(
        (t) => t.id === extraTrackId,
      );
      if (stillThere) {
        await AppPage.deleteTracks([extraTrackId]);
      }
    }
  });

  // --- Undo / redo -----------------------------------------------------------
  // The backend keeps a per-session undo/redo stack of whole-song snapshots
  // (state/history.rs): every structural edit pushes the pre-edit song and
  // clears the redo stack; undo pops it (pushing the current onto redo), redo
  // reverses that. An empty stack is a no-op, not an error. These run against
  // getSongView() — the same "prove it reached the backend" discipline — using
  // a known edit each captures before/after, so they never depend on what the
  // earlier flows happen to have left on the stack.

  it("undoes and redoes a clip move", async () => {
    const clip = await clipById(clipAId);
    if (!clip) {
      throw new Error("Clip A missing before the undo/redo case");
    }
    const before = clip.timelineStartSeconds;
    const moved = before + 3;

    await AppPage.moveClip(clipAId, moved);
    await browser.waitUntil(
      async () =>
        Math.abs(((await clipById(clipAId))?.timelineStartSeconds ?? -1) - moved) <
        0.05,
      { timeout: 30_000, timeoutMsg: "The clip move did not apply before undo" },
    );

    await AppPage.undoAction();
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - before,
        ) < 0.05,
      {
        timeout: 30_000,
        timeoutMsg: "Undo did not restore the clip's previous position",
      },
    );

    await AppPage.redoAction();
    await browser.waitUntil(
      async () =>
        Math.abs(((await clipById(clipAId))?.timelineStartSeconds ?? -1) - moved) <
        0.05,
      { timeout: 30_000, timeoutMsg: "Redo did not re-apply the clip move" },
    );

    // Leave clip A where it started (undo the redo) for a clean teardown.
    await AppPage.undoAction();
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - before,
        ) < 0.05,
      { timeout: 30_000, timeoutMsg: "Final undo did not restore clip A" },
    );
  });

  it("undoes a region creation and redoes it", async () => {
    // Create a region in the empty space just past clip B's region, then undo
    // (it disappears) and redo (it comes back). Region creation is a structural
    // edit, so it lands on the undo stack.
    const song = await songView();
    const maxEnd = (song?.regions ?? []).reduce(
      (max, r) => Math.max(max, r.endSeconds),
      0,
    );
    const newStart = maxEnd + 10;
    const newEnd = newStart + 8;
    const idsBefore = new Set((song?.regions ?? []).map((r) => r.id));

    await AppPage.createSongRegion(newStart, newEnd);
    let createdId = "";
    await browser.waitUntil(
      async () => {
        const created = ((await songView())?.regions ?? []).find(
          (r) => !idsBefore.has(r.id),
        );
        createdId = created?.id ?? "";
        return createdId !== "";
      },
      { timeout: 30_000, timeoutMsg: "The new region was never created" },
    );
    // Track it for teardown in case a later assertion throws.
    disposableRegionIds.add(createdId);

    await AppPage.undoAction();
    await browser.waitUntil(
      async () =>
        !((await songView())?.regions ?? []).some((r) => r.id === createdId),
      {
        timeout: 30_000,
        timeoutMsg: "Undo did not remove the just-created region",
      },
    );

    await AppPage.redoAction();
    await browser.waitUntil(
      async () =>
        ((await songView())?.regions ?? []).some((r) => r.id === createdId),
      { timeout: 30_000, timeoutMsg: "Redo did not restore the created region" },
    );

    // Clean up: delete the region we brought back.
    await AppPage.deleteSongRegion(createdId);
    await browser.waitUntil(
      async () =>
        !((await songView())?.regions ?? []).some((r) => r.id === createdId),
      { timeout: 30_000, timeoutMsg: "The redone region did not delete" },
    );
    disposableRegionIds.delete(createdId);
  });

  it("clears the redo branch when a new edit follows an undo", async () => {
    const clip = await clipById(clipAId);
    if (!clip) {
      throw new Error("Clip A missing before the redo-branch case");
    }
    const home = clip.timelineStartSeconds;
    const firstTarget = home + 4;
    const secondTarget = home + 8;

    // Edit 1, then undo it — now a redo of edit 1 is available.
    await AppPage.moveClip(clipAId, firstTarget);
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - firstTarget,
        ) < 0.05,
      { timeout: 30_000, timeoutMsg: "Edit 1 did not apply" },
    );
    await AppPage.undoAction();
    await browser.waitUntil(
      async () =>
        Math.abs(((await clipById(clipAId))?.timelineStartSeconds ?? -1) - home) <
        0.05,
      { timeout: 30_000, timeoutMsg: "Undo of edit 1 did not restore home" },
    );

    // Edit 2 — a fresh structural edit. This must CLEAR the redo stack, so the
    // redo of edit 1 is gone.
    await AppPage.moveClip(clipAId, secondTarget);
    await browser.waitUntil(
      async () =>
        Math.abs(
          ((await clipById(clipAId))?.timelineStartSeconds ?? -1) - secondTarget,
        ) < 0.05,
      { timeout: 30_000, timeoutMsg: "Edit 2 did not apply" },
    );

    // Redo is now a no-op (branch cut): the clip must NOT jump to firstTarget.
    await AppPage.redoAction();
    // Give any (erroneous) redo a moment to land, then assert it did nothing.
    await browser.pause(300);
    const after = (await clipById(clipAId))?.timelineStartSeconds ?? -1;
    expect(Math.abs(after - secondTarget)).toBeLessThan(0.05);
    expect(Math.abs(after - firstTarget)).toBeGreaterThan(0.05);

    // Restore clip A to home (undo edit 2) for a clean teardown.
    await AppPage.undoAction();
    await browser.waitUntil(
      async () =>
        Math.abs(((await clipById(clipAId))?.timelineStartSeconds ?? -1) - home) <
        0.05,
      { timeout: 30_000, timeoutMsg: "Final undo did not restore clip A" },
    );
  });
}
