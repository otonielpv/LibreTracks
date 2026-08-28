import {
  createLatestWinsStream,
  type LatestWinsStream,
} from "../latestWinsStream";

/**
 * Serializes timeline seeks and keeps only the last one.
 *
 * A seek is not cheap on the backend: it takes the session lock, rebuilds the
 * pitch/warp voice map and blocks until the destination audio is in RAM. Firing
 * one per click means N of those run back to back, and the user only ever
 * wanted the last position — the intermediate ones just hold the lock and make
 * the fill pool read audio nobody will hear. Clicking around the ruler during
 * playback on a slow disk is where this showed: the transport went quiet, the
 * playhead froze, then everything caught up at once.
 *
 * The visual preview is deliberately NOT handled here. The caller previews every
 * click immediately, so the playhead follows the pointer even for the clicks
 * whose backend seek is dropped.
 *
 * See ../latestWinsStream for the mechanism and for the other controls that
 * stream a value to Rust the same way.
 */
export type SeekRunner = (positionSeconds: number) => Promise<void>;

export type CoalescedSeek = LatestWinsStream<number>;

export function createSeekCoalescer(run: SeekRunner): CoalescedSeek {
  return createLatestWinsStream(run);
}
