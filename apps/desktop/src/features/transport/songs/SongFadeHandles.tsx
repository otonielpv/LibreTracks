import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { updateSongRegionFades } from "../desktopApi";
import { formatFadeSeconds } from "./songFades";
import "./songFades.css";

type Fades = { fadeIn: number; fadeOut: number };

type DragState = {
  edge: "in" | "out";
  pointerId: number;
  startClientX: number;
  /** Screen px per content px of the band (UI zoom × live timeline zoom). */
  scaleX: number;
  initial: Fades;
};

/**
 * The fade in / fade out a drag on a handle leads to. Each fade stays inside
 * the song and never crosses the other one.
 */
export function fadesAfterDrag(
  initial: Fades,
  edge: "in" | "out",
  deltaSeconds: number,
  songLengthSeconds: number,
): Fades {
  const length = Math.max(0, songLengthSeconds);
  const round = (value: number) => Math.round(value * 100) / 100;
  if (edge === "in") {
    const max = Math.max(0, length - initial.fadeOut);
    return { ...initial, fadeIn: round(Math.min(max, Math.max(0, initial.fadeIn + deltaSeconds))) };
  }
  const max = Math.max(0, length - initial.fadeIn);
  return { ...initial, fadeOut: round(Math.min(max, Math.max(0, initial.fadeOut - deltaSeconds))) };
}

type SongFadeHandlesProps = {
  region: SongRegionSummary;
  /** Committed px per second the band is laid out at (not the live zoom: the
   * ruler applies that with a transform, which `scaleX` picks up). */
  pixelsPerSecond: number;
};

/**
 * Fade handles of a song band in the ruler, like the corners of a clip in
 * Ableton: drag the top-left corner right for a fade in, the top-right corner
 * left for a fade out. The ramps are drawn on the band. The preview lives in
 * this component's own state, so dragging re-renders the handles and nothing
 * else; the value is saved on release (the song menu has the same setting
 * typed in seconds).
 */
export function SongFadeHandles({ region, pixelsPerSecond }: SongFadeHandlesProps) {
  const { t } = useTranslation();
  const saved: Fades = {
    fadeIn: region.master?.fadeInSeconds ?? 0,
    fadeOut: region.master?.fadeOutSeconds ?? 0,
  };
  const [preview, setPreview] = useState<Fades | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // A new saved value (this edit landing, undo, the menu) replaces the preview.
  useEffect(() => {
    if (!dragRef.current) setPreview(null);
  }, [saved.fadeIn, saved.fadeOut]);

  const fades = preview ?? saved;
  const lengthSeconds = region.endSeconds - region.startSeconds;
  const widthPx = lengthSeconds * pixelsPerSecond;
  const fadeInPx = Math.min(widthPx, fades.fadeIn * pixelsPerSecond);
  const fadeOutPx = Math.min(widthPx, fades.fadeOut * pixelsPerSecond);

  const begin = (event: ReactPointerEvent<HTMLDivElement>, edge: "in" | "out") => {
    if (event.button !== 0) return;
    // The band under the handle moves the song on pointerdown: not this time.
    event.preventDefault();
    event.stopPropagation();
    const band = event.currentTarget.closest<HTMLElement>(".lt-region-hotspot");
    const rect = band?.getBoundingClientRect();
    const scaleX = band && rect && band.offsetWidth > 0 ? rect.width / band.offsetWidth : 1;
    dragRef.current = {
      edge,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      scaleX: scaleX || 1,
      initial: fades,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(fades);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || pixelsPerSecond <= 0) return;
    event.stopPropagation();
    const deltaSeconds = (event.clientX - drag.startClientX) / drag.scaleX / pixelsPerSecond;
    setPreview(fadesAfterDrag(drag.initial, drag.edge, deltaSeconds, lengthSeconds));
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
    const next = preview ?? drag.initial;
    if (next.fadeIn === saved.fadeIn && next.fadeOut === saved.fadeOut) {
      setPreview(null);
      return;
    }
    // Keep showing the new value until the song view brings it back saved.
    void updateSongRegionFades(region.id, next.fadeIn, next.fadeOut).catch(() =>
      setPreview(null),
    );
  };

  const hasFade = fades.fadeIn > 0 || fades.fadeOut > 0;
  const handleProps = {
    role: "slider" as const,
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    // A click on a handle must not select the song underneath.
    onClick: (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return (
    <>
      {hasFade ? (
        <svg
          className="lt-song-fade-ramps"
          aria-hidden="true"
          width={Math.max(1, widthPx)}
          height="100%"
          preserveAspectRatio="none"
          viewBox={`0 0 ${Math.max(1, widthPx)} 100`}
        >
          {fadeInPx > 0 ? <polygon points={`0,0 ${fadeInPx},0 0,100`} /> : null}
          {fadeOutPx > 0 ? (
            <polygon points={`${widthPx},0 ${widthPx - fadeOutPx},0 ${widthPx},100`} />
          ) : null}
        </svg>
      ) : null}
      <div
        {...handleProps}
        className={`lt-song-fade-handle is-in${fades.fadeIn > 0 ? " has-fade" : ""}`}
        style={{ left: fadeInPx }}
        aria-label={t("transport.menu.songFadeIn", { seconds: formatFadeSeconds(fades.fadeIn) })}
        aria-valuemin={0}
        aria-valuemax={Math.round(lengthSeconds)}
        aria-valuenow={fades.fadeIn}
        title={t("transport.menu.songFadeIn", { seconds: formatFadeSeconds(fades.fadeIn) })}
        onPointerDown={(event) => begin(event, "in")}
      />
      <div
        {...handleProps}
        className={`lt-song-fade-handle is-out${fades.fadeOut > 0 ? " has-fade" : ""}`}
        style={{ right: fadeOutPx }}
        aria-label={t("transport.menu.songFadeOut", { seconds: formatFadeSeconds(fades.fadeOut) })}
        aria-valuemin={0}
        aria-valuemax={Math.round(lengthSeconds)}
        aria-valuenow={fades.fadeOut}
        title={t("transport.menu.songFadeOut", { seconds: formatFadeSeconds(fades.fadeOut) })}
        onPointerDown={(event) => begin(event, "out")}
      />
    </>
  );
}
