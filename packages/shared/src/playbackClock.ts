/**
 * Pure math for the visual playback clock, shared by every UI that draws a
 * playhead (desktop timeline, remote).
 *
 * Why this lives in `shared`: the audio engine's `lt::TransportClock` is the
 * only real clock — it counts frames on the audio thread and nothing else can
 * read it synchronously. Every UI therefore EXTRAPOLATES between the transport
 * snapshots it receives, and every UI that does that must extrapolate the SAME
 * way. There used to be four copies of this math (desktop panel, desktop
 * playhead overlay, remote App, remote liveWidgets) and they had already
 * diverged: two of them ignored `playbackRate`, so their playhead ran at the
 * wrong speed in warped regions, and three of them had no drift correction, so
 * they twitched on every snapshot. One implementation, no divergence.
 *
 * The visual position is an extrapolation from an anchor:
 *
 *   displayed = anchorPositionSeconds
 *             + (now - anchorReceivedAtMs) * playbackRate
 *             + residualCorrection(now)         // eased drift resync
 *
 * When a snapshot poll shows the extrapolation has drifted from the backend
 * clock we re-anchor to the true position but stash the old visual offset as
 * `correctionSeconds`, then decay it to zero over CLOCK_RESYNC_EASE_MS so the
 * resync is spread across many frames instead of snapping (the periodic
 * micro-jump that reads as non-fluid playback). Hard re-anchors (seek/jump)
 * carry correctionSeconds = 0 and so land instantly.
 *
 * Everything here is pure: the caller owns the anchor and passes it in. What
 * differs between apps is the ANCHOR POLICY (when to re-anchor outright and to
 * what), which stays with each app because the desktop has concerns the remote
 * does not (seek previews, vamp wraps, armed jumps).
 */

import type { TransportSnapshot } from "./models";

export type PlaybackVisualAnchor = {
  anchorPositionSeconds: number;
  anchorReceivedAtMs: number;
  durationSeconds: number;
  running: boolean;
  /** Timeline seconds advanced per real second. This differs from 1 in
   * warped/varispeed regions and must match the engine clock. */
  playbackRate: number;
  correctionSeconds: number;
};

export type VisualVampRange = {
  startSeconds: number;
  endSeconds: number;
};

/** Visual/backend gap tolerated before the clock is resynced at all. Below
 * this the extrapolation is considered true and is left alone — which is what
 * makes the playhead glide instead of stepping on every poll. */
export const PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS = 0.08;

/** Window over which a clock-drift correction is eased out (ms). Short enough
 * that a genuine change still resolves quickly; drift is only a few ms so the
 * ease is imperceptible. ~15 frames at 60fps. */
export const CLOCK_RESYNC_EASE_MS = 250;

/** Largest visual/backend drift still treated as clock skew and resynced
 * smoothly (seconds). Beyond this the discrepancy is assumed to be a real
 * discontinuity the preserve-guard didn't catch, and the caller hard-snaps.
 * Comfortably above the ~80 ms tolerance, well below a musical jump. */
export const CLOCK_RESYNC_MAX_SMOOTH_SECONDS = 0.35;

/**
 * Residual drift correction for the frame at `nowMs`: the stashed offset
 * decayed linearly to zero over CLOCK_RESYNC_EASE_MS. Zero once elapsed or when
 * no correction is pending.
 */
export function resolveVisualCorrectionSeconds(
  anchor: PlaybackVisualAnchor,
  nowMs: number,
): number {
  if (!anchor.correctionSeconds) {
    return 0;
  }
  const elapsedMs = nowMs - anchor.anchorReceivedAtMs;
  if (elapsedMs >= CLOCK_RESYNC_EASE_MS) {
    return 0;
  }
  const remaining = 1 - elapsedMs / CLOCK_RESYNC_EASE_MS;
  return anchor.correctionSeconds * remaining;
}

/** Extrapolates the visual timeline position from the same rate published by
 * the engine. Keeping this pure makes warp/varispeed clock behaviour testable
 * without involving the 60fps React-free render path. */
export function resolveVisualPlaybackPosition(
  anchor: PlaybackVisualAnchor,
  nowMs: number,
): number {
  const playbackRate =
    Number.isFinite(anchor.playbackRate) && anchor.playbackRate > 0
      ? anchor.playbackRate
      : 1;
  const elapsedSeconds = anchor.running
    ? Math.max(0, nowMs - anchor.anchorReceivedAtMs) / 1000
    : 0;
  return (
    anchor.anchorPositionSeconds +
    elapsedSeconds * playbackRate +
    resolveVisualCorrectionSeconds(anchor, nowMs)
  );
}

/** Mirrors an active VAMP in the frame-by-frame visual clock. The native
 * engine performs the audio wrap sample-exactly, while transport snapshots
 * arrive less frequently; wrapping here prevents the playhead and Live marker
 * matrix from briefly entering the following section before that confirmation
 * arrives. */
export function resolveVisualPositionAcrossVamp(
  positionSeconds: number,
  activeVamp: VisualVampRange | null | undefined,
): number {
  if (!activeVamp || positionSeconds < activeVamp.endSeconds) {
    return positionSeconds;
  }

  const durationSeconds = activeVamp.endSeconds - activeVamp.startSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return positionSeconds;
  }

  const overshootSeconds = positionSeconds - activeVamp.endSeconds;
  return activeVamp.startSeconds + (overshootSeconds % durationSeconds);
}

/**
 * What a transport snapshot should do to the free-running visual clock.
 *
 * - `reanchor`: the snapshot carries new transport state (a different song
 *   revision, a seek, a jump, a stopped transport). The caller must run its
 *   full re-anchor, which is the only path allowed to change what the playhead
 *   is doing — not just where it is.
 * - `keep`: the extrapolation is still true within tolerance. Do nothing; this
 *   is the common case and the reason the playhead glides.
 * - `correct`: drift worth fixing, small enough to hide. Adopt the returned
 *   anchor, which lands on the engine's position while carrying the current
 *   visual offset as a correction that decays to zero.
 * - `snap`: too far apart to ease away (a stalled engine, a visual clock that
 *   ran off). Land on the truth now.
 */
export type VisualClockResyncDecision =
  | { kind: "reanchor" }
  | { kind: "keep" }
  | { kind: "correct"; anchor: PlaybackVisualAnchor }
  | { kind: "snap" };

/**
 * Decides how a polled snapshot should treat the visual clock.
 *
 * The visual playhead extrapolates from performance.now() while the engine runs
 * on the audio clock: the two drift, and a stalled engine doesn't drift — it
 * stops. Every snapshot carries the truth, so this is what keeps the
 * extrapolation honest between the transport events that re-anchor it outright.
 *
 * Anything other than `reanchor` requires an anchor that is ALREADY RUNNING and
 * a transport whose position bookkeeping is unchanged. That is what makes it
 * safe to run on snapshots nobody published: a parked anchor (a seek preview
 * holding the cursor under the pointer) reports `reanchor` and is left alone by
 * a caller that has no new transport state to apply.
 */
export function resolveVisualClockResync(params: {
  anchor: PlaybackVisualAnchor;
  previousSnapshot: TransportSnapshot | null;
  nextSnapshot: TransportSnapshot;
  /** The visual position right now, vamp wrap already applied. */
  visualNowSeconds: number;
  nowMs: number;
  /** Upper clamp for a corrected anchor (timeline workspace, then song). */
  maxDurationSeconds: number;
  /** Value to store as the anchor's own durationSeconds. */
  anchorDurationSeconds: number;
}): VisualClockResyncDecision {
  const {
    anchor,
    previousSnapshot,
    nextSnapshot,
    visualNowSeconds,
    nowMs,
    maxDurationSeconds,
    anchorDurationSeconds,
  } = params;

  const canPreserveAnchor =
    previousSnapshot?.playbackState === "playing" &&
    nextSnapshot.playbackState === "playing" &&
    previousSnapshot.projectRevision === nextSnapshot.projectRevision &&
    previousSnapshot.transportClock?.lastJumpPositionSeconds ===
      nextSnapshot.transportClock?.lastJumpPositionSeconds &&
    previousSnapshot.transportClock?.lastSeekPositionSeconds ===
      nextSnapshot.transportClock?.lastSeekPositionSeconds &&
    Math.abs(
      anchor.playbackRate - (nextSnapshot.transportClock?.playbackRate ?? 1),
    ) < 0.000001 &&
    anchor.running &&
    Boolean(nextSnapshot.transportClock?.running);

  if (!canPreserveAnchor) {
    return { kind: "reanchor" };
  }

  // Where the engine says the playhead is. In the normal snapshot flavour this
  // is the very same number as transportClock.anchorPositionSeconds — the
  // backend overwrites the anchor with the audio engine's live position
  // (snapshot_with_transport_override). In the fallback flavour, with the
  // native engine not reporting Playing (pending start, or a dead device on the
  // null pump), the anchor is only refreshed at the backend's 250ms sync
  // cadence while positionSeconds stays live; comparing against the anchor
  // there would tug the playhead backwards on every poll that skipped a sync.
  const enginePositionSeconds = nextSnapshot.positionSeconds;
  const driftSeconds = Math.abs(visualNowSeconds - enginePositionSeconds);

  if (driftSeconds <= PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS) {
    return { kind: "keep" };
  }

  if (driftSeconds > CLOCK_RESYNC_MAX_SMOOTH_SECONDS) {
    return { kind: "snap" };
  }

  const clampedTarget = Math.min(
    Math.max(enginePositionSeconds, 0),
    maxDurationSeconds,
  );

  return {
    kind: "correct",
    anchor: {
      anchorPositionSeconds: clampedTarget,
      anchorReceivedAtMs: nowMs,
      durationSeconds: anchorDurationSeconds,
      running: true,
      playbackRate: nextSnapshot.transportClock?.playbackRate ?? 1,
      // Displayed = clampedTarget + correction = visualNow at t0, then the
      // correction eases out -> converges to the true clock with no jump.
      correctionSeconds: visualNowSeconds - clampedTarget,
    },
  };
}
