import { getFollowPlayheadCameraX } from "@libretracks/shared/timelineMath";

/**
 * Where the camera goes after a song jump made while the transport is
 * stopped, or `null` to leave it.
 *
 * With follow enabled the camera tracks the playhead from the playback frame
 * loop — which only runs while playing. Previous/next song with the transport
 * stopped moved the playhead off screen and the view stayed put. This applies
 * the same follow rule (same mode, same window) once, at the jump.
 *
 * Only for jumps: a click on the timeline already lands where the user looks,
 * and in "center" mode re-centring under the pointer would yank the view.
 */
export function cameraXAfterStoppedJump(params: {
  followEnabled: boolean;
  viewMode: string;
  playheadSeconds: number;
  cameraX: number;
  pixelsPerSecond: number;
  viewportWidth: number;
  durationSeconds: number;
  contentEndSeconds: number;
  followMode: "ahead" | "center";
}): number | null {
  if (!params.followEnabled || params.viewMode !== "daw") return null;
  return getFollowPlayheadCameraX({
    playheadSeconds: params.playheadSeconds,
    cameraX: params.cameraX,
    pixelsPerSecond: params.pixelsPerSecond,
    viewportWidth: params.viewportWidth,
    durationSeconds: params.durationSeconds,
    contentEndSeconds: params.contentEndSeconds,
    followMode: params.followMode,
  });
}
