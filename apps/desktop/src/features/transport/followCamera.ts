/**
 * Pure math for the follow-playhead camera glide.
 *
 * Extracted from TransportPanelContent so the monolith stays under its size
 * budget and the motion is unit-testable in isolation. Holds no state: the
 * caller owns the camera ref and passes it in.
 *
 * The clock math that feeds this (where the playhead IS) lives in
 * `@libretracks/shared/playbackClock` — it is shared with the remote, which
 * draws the same playhead from the same snapshots. This file is desktop-only
 * because only the desktop has a scrolling camera to move.
 */

/**
 * Follow-playhead camera smoothing: fraction of the remaining distance the
 * camera closes per frame at 60fps. Only used to soften a genuine DISCONTINUITY
 * (a leading-edge crossing or a seek), not steady tracking. Frame-rate
 * compensated by the caller. Higher = snappier, lower = smoother.
 */
export const FOLLOW_CAMERA_SMOOTHING = 0.22;
/**
 * Distance (px) below which the camera locks rigidly to the goal instead of
 * easing. During steady playback the goal moves at the playhead's velocity, so
 * a rigid lock makes the camera advance at exactly that velocity — perfectly
 * smooth, like a steady manual scroll. Easing here would instead make the
 * camera *chase* the goal, and any per-frame rAF-delta jitter would ripple the
 * velocity — the low-zoom tremor, where the frame's motion is only a pixel or
 * two so the ripple dominates. Above this distance the gap is a real jump and
 * we ease to soften it.
 */
export const FOLLOW_CAMERA_LOCK_PX = 24;

/** WKWebView repaints every visible timeline canvas whenever follow changes
 * cameraX. Capping only that camera write on iOS halves sustained GPU work;
 * the playhead clock and native audio continue at their normal cadence. */
export const IOS_FOLLOW_CAMERA_FPS = 30;
export const IOS_FOLLOW_CAMERA_FRAME_INTERVAL_MS =
  1000 / IOS_FOLLOW_CAMERA_FPS;

/** Return the elapsed time for the next follow-camera update, or null while a
 * platform-specific frame interval has not elapsed. */
export function resolveFollowFrameDeltaSeconds(params: {
  nowMs: number;
  lastFollowFrameMs: number | null;
  minimumIntervalMs: number;
}): number | null {
  const { nowMs, lastFollowFrameMs, minimumIntervalMs } = params;
  if (lastFollowFrameMs === null) {
    return 1 / 60;
  }
  const elapsedMs = Math.max(0, nowMs - lastFollowFrameMs);
  // rAF timestamps commonly land a fraction below the nominal interval.
  // Half a millisecond of tolerance prevents a 30fps gate becoming 20fps.
  if (minimumIntervalMs > 0 && elapsedMs + 0.5 < minimumIntervalMs) {
    return null;
  }
  return Math.min(0.1, elapsedMs / 1000);
}

/** Stateful frame gate kept outside TransportPanelContent's hot-path
 * monolith. The returned closure owns only its previous accepted timestamp. */
export function createFollowCameraFrameGate(ios: boolean) {
  let lastFollowFrameMs: number | null = null;
  const minimumIntervalMs = ios ? IOS_FOLLOW_CAMERA_FRAME_INTERVAL_MS : 0;
  return (nowMs: number) => {
    const delta = resolveFollowFrameDeltaSeconds({
      nowMs,
      lastFollowFrameMs,
      minimumIntervalMs,
    });
    if (delta !== null) lastFollowFrameMs = nowMs;
    return delta;
  };
}

/**
 * Frame-rate-compensated ease factor for the follow camera. The smoothing
 * constant is tuned for 60fps; scaling by the real frame delta keeps the same
 * feel on slower/faster displays. Clamped to 1 so a long stall can't overshoot.
 */
export function resolveFollowCameraEaseFactor(frameDtSeconds: number): number {
  if (frameDtSeconds <= 0) {
    return FOLLOW_CAMERA_SMOOTHING;
  }
  return Math.min(1, FOLLOW_CAMERA_SMOOTHING * (frameDtSeconds / (1 / 60)));
}

/**
 * Next camera X for a follow frame.
 *
 * Steady tracking (gap ≤ FOLLOW_CAMERA_LOCK_PX): lock RIGIDLY to the goal. The
 * goal advances at the playhead's velocity, so the camera does too — a constant
 * glide, the smoothest possible and the same feel as a steady manual scroll. An
 * exponential ease here would chase the goal instead and let rAF-delta jitter
 * ripple the velocity (the low-zoom tremor).
 *
 * Discontinuity (gap > FOLLOW_CAMERA_LOCK_PX, e.g. crossing the leading edge or
 * after a seek): ease so the jump becomes a short glide rather than a snap.
 *
 * The result is kept FRACTIONAL on purpose: the canvas draws at seconds*pps −
 * cameraX and the ruler overlay pans via translateX, both sub-pixel smooth, so
 * a fractional camera glides cleanly even at low zoom.
 *
 * Returns null when the move is negligible (< 0.01px) so the caller can skip a
 * redundant DOM/scroll write.
 */
export function resolveFollowCameraX(params: {
  currentCameraX: number;
  goalCameraX: number;
  frameDtSeconds: number;
}): number | null {
  const { currentCameraX, goalCameraX, frameDtSeconds } = params;
  const distance = goalCameraX - currentCameraX;
  const nextCameraX =
    Math.abs(distance) <= FOLLOW_CAMERA_LOCK_PX
      ? goalCameraX
      : currentCameraX +
        distance * resolveFollowCameraEaseFactor(frameDtSeconds);

  return Math.abs(nextCameraX - currentCameraX) < 0.01 ? null : nextCameraX;
}
