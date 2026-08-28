/**
 * The remote's visual playback clock.
 *
 * The math lives in `@libretracks/shared/playbackClock` and is shared with the
 * desktop timeline — both draw the same playhead from the same snapshots, so
 * both must extrapolate identically. What lives HERE is the remote's anchor
 * policy: when to re-anchor outright, and to what.
 *
 * This replaces two byte-identical copies of a private extrapolator (App.tsx
 * and liveWidgets.tsx) that had no drift correction at all: every snapshot
 * landed as a hard re-anchor, so the playhead twitched a few times a second on
 * a phone. Routing them through `resolveVisualClockResync` means a snapshot
 * that merely confirms the extrapolation is left alone, and a small drift is
 * eased out over ~250 ms instead of jumping.
 */

import type { TransportSnapshot } from "@libretracks/shared/models";
import {
  type PlaybackVisualAnchor,
  resolveVisualClockResync,
  resolveVisualPlaybackPosition,
} from "@libretracks/shared/playbackClock";

export type { PlaybackVisualAnchor };

/** A parked clock: nothing loaded, or transport not running. */
export function idleRemoteAnchor(nowMs: number): PlaybackVisualAnchor {
  return {
    anchorPositionSeconds: 0,
    anchorReceivedAtMs: nowMs,
    durationSeconds: 0,
    running: false,
    playbackRate: 1,
    correctionSeconds: 0,
  };
}

/**
 * A hard re-anchor onto `snapshot`: land on the truth now, no correction.
 *
 * Two remote-specific details, both preserved from the code this replaces:
 *
 * - `running` follows `playbackState`, NOT `transportClock.running`. Over a
 *   remote connection the state label and the native clock can arrive in
 *   different snapshots; gating on the clock froze the timeline on phones
 *   whenever the clock was missing or a beat stale.
 * - the position comes from the clock anchor only while genuinely playing with
 *   a live clock. Otherwise it comes from `positionSeconds`, which stays fresh
 *   either way: in the backend's fallback snapshot flavour the clock anchor is
 *   only refreshed at its 250 ms sync cadence, and on pause it is not refreshed
 *   at all. This mirrors `applyTransportVisualAnchor` on the desktop.
 */
export function reanchorRemoteClock(
  snapshot: TransportSnapshot | null,
  nowMs: number,
): PlaybackVisualAnchor {
  if (!snapshot) {
    return idleRemoteAnchor(nowMs);
  }

  const transportClock = snapshot.transportClock;
  const running = snapshot.playbackState === "playing";
  const anchorPositionSeconds = Math.max(
    0,
    running && transportClock?.running
      ? transportClock.anchorPositionSeconds
      : snapshot.positionSeconds,
  );

  return {
    anchorPositionSeconds,
    anchorReceivedAtMs: nowMs,
    durationSeconds: 0,
    running,
    playbackRate: transportClock?.playbackRate ?? 1,
    correctionSeconds: 0,
  };
}

/**
 * Folds an arriving snapshot into the current anchor.
 *
 * Delegates the decision to the shared resync rule, so the remote behaves like
 * the desktop: keep a true extrapolation, ease a small drift, snap a large one,
 * re-anchor on a real transport change.
 */
export function advanceRemoteClock(params: {
  anchor: PlaybackVisualAnchor;
  previousSnapshot: TransportSnapshot | null;
  nextSnapshot: TransportSnapshot;
  nowMs: number;
}): PlaybackVisualAnchor {
  const { anchor, previousSnapshot, nextSnapshot, nowMs } = params;

  const decision = resolveVisualClockResync({
    anchor,
    previousSnapshot,
    nextSnapshot,
    visualNowSeconds: resolveVisualPlaybackPosition(anchor, nowMs),
    nowMs,
    // The remote has no authoritative timeline length to clamp against; the
    // desktop passes its workspace duration. Leaving it open means a corrected
    // anchor is never dragged short.
    maxDurationSeconds: Number.MAX_SAFE_INTEGER,
    anchorDurationSeconds: 0,
  });

  switch (decision.kind) {
    case "keep":
      return anchor;
    case "correct":
      return decision.anchor;
    case "snap":
    case "reanchor":
      return reanchorRemoteClock(nextSnapshot, nowMs);
  }
}

/** Where the playhead is right now, for drawing. Never negative. */
export function resolveLivePosition(
  anchor: PlaybackVisualAnchor,
  nowMs: number = performance.now(),
): number {
  return Math.max(0, resolveVisualPlaybackPosition(anchor, nowMs));
}
