/**
 * Tap-to-seek helpers for the remote cinta (SharedTimeline).
 *
 * The cinta already owns a pointer-drag scrub, so a release can mean two very
 * different things: the end of a scrub (must NOT move playback) or a deliberate
 * tap on a position (should seek, when the user has enabled the toggle). These
 * pure helpers hold that decision and the screen-X → seconds conversion so the
 * rules stay testable outside the rAF/pointer machinery in App.tsx.
 */

/** A pointer that travels further than this is a scrub, not a tap. */
export const TIMELINE_TAP_SLOP_PX = 8;
/** A pointer held longer than this is a scrub/long-press, not a tap. */
export const TIMELINE_TAP_MAX_MS = 600;

export type TimelineTapGesture = {
  /** Client X where the pointer went down. */
  startClientX: number;
  /** Client X where the pointer was released. */
  endClientX: number;
  /** Milliseconds between pointer down and release. */
  durationMs: number;
};

/**
 * True when the gesture stayed within the slop radius and finished quickly
 * enough to read as a tap rather than a scrub.
 */
export function isTimelineTap(gesture: TimelineTapGesture): boolean {
  if (!Number.isFinite(gesture.startClientX) || !Number.isFinite(gesture.endClientX)) {
    return false;
  }
  if (!Number.isFinite(gesture.durationMs) || gesture.durationMs < 0) {
    return false;
  }
  return (
    Math.abs(gesture.endClientX - gesture.startClientX) <= TIMELINE_TAP_SLOP_PX &&
    gesture.durationMs <= TIMELINE_TAP_MAX_MS
  );
}

/**
 * Convert a tap's client X into a timeline position.
 *
 * The ruler is translated by the rAF loop (`translateX`, which folds in both
 * auto-follow and the manual scrub offset), so the content X under the finger
 * is the shell-relative X minus that translate. Negative results clamp to 0 —
 * tapping before the start of the cinta seeks to the beginning.
 */
export function timelineTapPositionSeconds(options: {
  clientX: number;
  shellLeft: number;
  translateX: number;
  pixelsPerSecond: number;
}): number | null {
  const { clientX, shellLeft, translateX, pixelsPerSecond } = options;
  if (!Number.isFinite(clientX) || !Number.isFinite(shellLeft) || !Number.isFinite(translateX)) {
    return null;
  }
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    return null;
  }

  const contentX = clientX - shellLeft - translateX;
  const positionSeconds = contentX / pixelsPerSecond;
  if (!Number.isFinite(positionSeconds)) {
    return null;
  }

  return Math.max(0, positionSeconds);
}

/**
 * How long an optimistic tap-to-seek pins the playhead before deferring to the
 * live snapshot again. Long enough for the WebSocket round-trip on a congested
 * stage network, short enough that a dropped command doesn't strand the cinta.
 */
export const TIMELINE_PENDING_SEEK_TIMEOUT_MS = 1200;

export type PendingSeek = {
  positionSeconds: number;
  expiresAtMs: number;
};

/**
 * Decide whether an in-flight tap-to-seek still owns the playhead.
 *
 * The desktop confirms a seek by changing its reposition token (which carries
 * `lastSeekPositionSeconds`). Until that arrives the rAF loop must not run its
 * follow/correction maths, or it animates from the pre-seek position and the
 * jump looks like it never happened. The timeout is the safety valve for a
 * command that never lands.
 */
export function resolvePendingSeek(
  pending: PendingSeek | null,
  options: { transportRepositioned: boolean; frameAtMs: number },
): PendingSeek | null {
  if (!pending) {
    return null;
  }
  if (options.transportRepositioned) {
    return null;
  }
  if (options.frameAtMs >= pending.expiresAtMs) {
    return null;
  }
  return pending;
}
