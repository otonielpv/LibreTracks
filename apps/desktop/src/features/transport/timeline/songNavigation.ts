// Which song (region) the transport's Previous / Next buttons jump to.
//
// Both wrap around: Next from the last song goes to the first, Previous from
// the first goes to the last. The backend MIDI dispatch mirrors these rules
// (`jump_to_next_region` / `jump_to_previous_region` in midi/dispatch.rs), so a
// mapped pedal and the on-screen button always agree.

type RegionLike = { id: string; startSeconds: number };

const byStart = <T extends RegionLike>(regions: readonly T[]) =>
  [...regions].sort((a, b) => a.startSeconds - b.startSeconds);

/** First song that starts after the cursor, or the first song. */
export function findNextSongRegion<T extends RegionLike>(
  regions: readonly T[],
  positionSeconds: number,
): T | null {
  const sorted = byStart(regions);
  return (
    sorted.find((region) => region.startSeconds > positionSeconds + Number.EPSILON) ??
    sorted[0] ??
    null
  );
}

/**
 * The song before the one under the cursor, or the last song when the cursor
 * is in (or before) the first one.
 */
export function findPreviousSongRegion<T extends RegionLike>(
  regions: readonly T[],
  positionSeconds: number,
): T | null {
  const sorted = byStart(regions);
  if (sorted.length === 0) return null;
  let current = -1;
  sorted.forEach((region, index) => {
    if (region.startSeconds <= positionSeconds + Number.EPSILON) current = index;
  });
  return current > 0 ? sorted[current - 1] : sorted[sorted.length - 1];
}
