import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Region ids of the compact song columns within one strip width of the
 * visible band, or `null` for "every column" (before the first report, or
 * where IntersectionObserver does not exist, like jsdom).
 *
 * Why: each column's clip stack is its own vertical scroller. On iOS every
 * overflowing one becomes a native scroll view with its own backing store,
 * mounted inside the horizontal strip whether it is on screen or not, so the
 * strip's scrolling slowed down with the song count (fine with 2 songs, heavy
 * with 10+) while every other view stayed fluid. A column far from the band
 * renders its stack empty: it no longer overflows, so it is no scroller.
 * Columns themselves stay mounted (widths, headers, reorder, drop targets).
 *
 * The observer reports only when a column crosses the margin, never per
 * scroll event, and the state changes only when the set does.
 */
export function useNearbySongColumns(
  stripRef: RefObject<HTMLElement | null>,
  regionIds: readonly string[],
): ReadonlySet<string> | null {
  const [nearby, setNearby] = useState<ReadonlySet<string> | null>(null);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof IntersectionObserver === "undefined") {
      return;
    }
    const intersecting = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.regionId;
          if (!id) continue;
          if (entry.isIntersecting) intersecting.add(id);
          else intersecting.delete(id);
        }
        setNearby((previous) =>
          previous &&
          previous.size === intersecting.size &&
          [...intersecting].every((id) => previous.has(id))
            ? previous
            : new Set(intersecting),
        );
      },
      // Half a strip width of slack on each side: a column is filled in
      // before it scrolls into view. A whole width left ~9 of 10 stacks
      // filled on a phone, which is what this hook exists to avoid.
      { root: strip, rootMargin: "0px 50% 0px 50%" },
    );
    strip
      .querySelectorAll<HTMLElement>(".lt-compact-song-column[data-region-id]")
      .forEach((column) => observer.observe(column));
    return () => observer.disconnect();
  }, [stripRef, regionIds]);

  return nearby;
}
