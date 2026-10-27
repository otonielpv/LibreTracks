import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { barGridTicksInSong, barStartsInSong } from "./sectionScrubModel";

type SongBarRulerProps = {
  song: SongView;
  region: SongRegionSummary;
  variant?: "map" | "arrangement";
};

function SongBarRulerComponent({ song, region, variant = "map" }: SongBarRulerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const bars = useMemo(() => barStartsInSong(song, region), [song, region]);
  const ticks = useMemo(
    () => barGridTicksInSong(song, region, width),
    [song, region, width],
  );
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  const averageBarWidth = width > 0 && bars.length > 0 ? width / bars.length : 0;
  const labelEvery = Math.max(1, Math.ceil(44 / averageBarWidth));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const updateWidth = () => setWidth(root.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className={`lt-setlist-bar-ruler is-${variant}`}
      aria-hidden="true"
    >
      {duration > 0
        ? ticks.map((tick) => (
            <span
              key={`${tick.kind}:${tick.seconds}`}
              className={`lt-setlist-bar-ruler-tick is-${tick.kind}`}
              style={{ left: `${((tick.seconds - region.startSeconds) / duration) * 100}%` }}
            >
              {tick.kind === "bar" && tick.barIndex % labelEvery === 0 ? (
                <span className="lt-setlist-bar-ruler-label">{tick.barIndex + 1}</span>
              ) : null}
            </span>
          ))
        : null}
    </div>
  );
}

export const SongBarRuler = memo(SongBarRulerComponent);
