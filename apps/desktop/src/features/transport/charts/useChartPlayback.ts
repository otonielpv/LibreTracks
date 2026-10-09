import { useEffect, useRef, useState } from "react";

import {
  getEffectiveBpmAt,
  type ChartLink,
  type SectionMarkerSummary,
  type SongView,
} from "@libretracks/shared/models";

import type { ChartDoc } from "./chordChart";
import { NO_CHART_PLAYBACK, resolveChartPlayback, type ChartPlayback } from "./chartSync";

const POLL_MS = 100;

function samePlayback(left: ChartPlayback, right: ChartPlayback): boolean {
  return (
    left.markerId === right.markerId &&
    left.section === right.section &&
    left.line === right.line &&
    left.nextSection === right.nextSection
  );
}

/**
 * The section and line playing, read from the parent's mutable playhead. Like
 * `useLiveMarkerPlayback`, it never subscribes React to 60 fps: it publishes
 * only when the section or the line changes, a few times per song section.
 */
export function useChartPlayback(
  song: SongView,
  doc: ChartDoc | null,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
  regionEndSeconds: number,
  positionSecondsRef: { readonly current: number },
): { playback: ChartPlayback; positionSecondsRef: { readonly current: number } } {
  const sources = useRef({ song, doc, links, markers, regionEndSeconds });
  sources.current = { song, doc, links, markers, regionEndSeconds };
  const resolve = (): ChartPlayback => {
    const current = sources.current;
    if (!current.doc) return NO_CHART_PLAYBACK;
    return resolveChartPlayback(
      current.doc,
      current.links,
      current.markers,
      current.regionEndSeconds,
      positionSecondsRef.current,
      (seconds) => 60 / Math.max(1, getEffectiveBpmAt(current.song, seconds)),
    );
  };
  const [playback, setPlayback] = useState<ChartPlayback>(resolve);

  useEffect(() => {
    const tick = () => {
      const next = resolve();
      setPlayback((current) => (samePlayback(current, next) ? current : next));
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
    // The sources are read through the ref; the timer lives as long as the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new chart, new links or another song must show at once, not at the
  // next tick.
  useEffect(() => {
    const next = resolve();
    setPlayback((current) => (samePlayback(current, next) ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, links, markers, regionEndSeconds]);

  return { playback, positionSecondsRef };
}
