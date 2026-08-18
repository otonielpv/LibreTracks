import { useEffect, useRef, type RefObject } from "react";

export function calculateLiveProgress(
  positionSeconds: number,
  startSeconds: number | null,
  endSeconds: number | null,
) {
  if (
    startSeconds === null ||
    endSeconds === null ||
    endSeconds <= startSeconds
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(1, (positionSeconds - startSeconds) / (endSeconds - startSeconds)),
  );
}

type LiveProgressBarOptions = {
  positionSecondsRef: { readonly current: number };
  markerStartSeconds: number | null;
  markerEndSeconds: number | null;
  regionStartSeconds: number | null;
  regionEndSeconds: number | null;
  markerFillRef: RefObject<HTMLSpanElement | null>;
  songFillRef: RefObject<HTMLSpanElement | null>;
};

/**
 * Animates only two compositor-friendly transforms from the mutable playhead.
 * React remains on the low-frequency clock used for labels and accessibility.
 */
export function useLiveProgressBars(options: LiveProgressBarOptions) {
  const sourcesRef = useRef(options);
  sourcesRef.current = options;

  useEffect(() => {
    let frameId = 0;
    let previousMarkerScale = -1;
    let previousSongScale = -1;
    let previousMarkerElement: HTMLSpanElement | null = null;
    let previousSongElement: HTMLSpanElement | null = null;

    const frame = () => {
      const sources = sourcesRef.current;
      const position = sources.positionSecondsRef.current;
      const markerScale = calculateLiveProgress(
        position,
        sources.markerStartSeconds,
        sources.markerEndSeconds,
      );
      const songScale = calculateLiveProgress(
        position,
        sources.regionStartSeconds,
        sources.regionEndSeconds,
      );

      const markerElement = sources.markerFillRef.current;
      const songElement = sources.songFillRef.current;
      if (
        markerElement !== previousMarkerElement ||
        markerScale !== previousMarkerScale
      ) {
        markerElement?.style.setProperty(
          "transform",
          `scaleX(${markerScale})`,
        );
        previousMarkerElement = markerElement;
        previousMarkerScale = markerScale;
      }
      if (songElement !== previousSongElement || songScale !== previousSongScale) {
        songElement?.style.setProperty(
          "transform",
          `scaleX(${songScale})`,
        );
        previousSongElement = songElement;
        previousSongScale = songScale;
      }
      frameId = window.requestAnimationFrame(frame);
    };

    frameId = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(frameId);
  }, []);
}
