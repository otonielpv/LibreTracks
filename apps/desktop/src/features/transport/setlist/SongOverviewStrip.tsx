import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  markerCategory,
  type ClipSummary,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";

import {
  cancelGatedFrame,
  markFrameActivity,
  requestGatedFrame,
  useFrameGateWake,
} from "../frameGate";
import { ZoomWindowContext } from "./OverviewZoom";
import {
  buildSongOverviewPeaks,
  songOverviewClipsKey,
  songOverviewLoudest,
  songOverviewSummariesKey,
} from "./songOverviewPeaks";
import { createSongTimeScale } from "./songTimeScale";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SongOverviewStripProps = {
  region: SongRegionSummary;
  clips: readonly ClipSummary[];
  sectionMarkers: readonly SectionMarkerSummary[];
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  layout: SetlistLayoutClass;
  /** Seek to a point of the song; the panel's coalesced seek. Absent (or
   * while editing) the strip is read-only. */
  onSeek?: (seconds: number) => void;
  /** Right click / long press on the waveform at `seconds` (the DAW's ruler
   * menu: create a section or a cue, a tempo or meter change…). */
  onContextMenuAt?: (event: ReactMouseEvent<HTMLElement>, seconds: number) => void;
  /** Double click at `seconds` (edit mode: a new section there). */
  onDoubleClickAt?: (seconds: number) => void;
};

const MAX_PIXEL_RATIO = 2;
const MAX_BUCKETS = 8192;
/** Buckets for the whole-song scale every zoomed window shares. */
const SCALE_BUCKETS = 2048;
const MAX_CANVAS_PX = 16384;
/** Zoomed in, the canvas covers this many screens around the view: redrawn
 * only when the view nears its edge, about once per screen of travel. */
const WINDOW_SCREENS = 3;

/** The stretch of the layer (px) to draw so `view` is well inside it. */
export function drawWindowFor(
  view: { offset: number; width: number },
  layerWidth: number,
): { start: number; width: number } {
  if (view.width <= 0 || layerWidth <= view.width * WINDOW_SCREENS) {
    return { start: 0, width: layerWidth };
  }
  const width = view.width * WINDOW_SCREENS;
  const start = Math.max(0, Math.min(layerWidth - width, view.offset - view.width));
  return { start, width };
}
const WAVE_COLOR = "rgb(186 214 207 / 0.75)";
const SECTION_COLOR = "rgb(233 241 238 / 0.35)";

/** Local x inside `element`, robust to the app's CSS zoom (the rect is in
 * zoomed pixels, offsetWidth in layout pixels). */
function localX(element: HTMLElement, clientX: number) {
  const rect = element.getBoundingClientRect();
  const scale = rect.width > 0 ? element.offsetWidth / rect.width : 1;
  return (clientX - rect.left) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

/**
 * The selected song's waveform with its playhead. The canvas repaints only
 * when the peaks, the size or the sections change; the playhead is a
 * separate element moved by a rAF loop from `positionSecondsRef`, so playing
 * never re-renders this component. Tap = seek; drag = scrub (wide/medium),
 * one seek per frame at most, through the panel's coalesced seek.
 */
function SongOverviewStripComponent({
  region,
  clips,
  sectionMarkers,
  waveformSummaries,
  positionSecondsRef,
  layout,
  onSeek,
  onContextMenuAt,
  onDoubleClickAt,
}: SongOverviewStripProps) {
  const { t } = useTranslation();
  useFrameGateWake();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const apply = (width: number, height: number) =>
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    apply(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) apply(Math.round(rect.width), Math.round(rect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pixelRatio = Math.min(
    MAX_PIXEL_RATIO,
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  );
  // Inside the band's zoom: only the stretch around what is on screen is
  // drawn, at full detail (the iPhone asked for more zoom with detail; one
  // canvas for the whole zoomed song blew past canvas limits and had to be
  // stretched). Re-rendered when the view nears the stretch's edge.
  const zoomWindow = useContext(ZoomWindowContext);
  const [drawRange, setDrawRange] = useState<{ start: number; width: number } | null>(null);
  const range =
    drawRange && drawRange.start + drawRange.width <= size.width + 0.5
      ? drawRange
      : zoomWindow
        ? drawWindowFor(zoomWindow, size.width)
        : { start: 0, width: size.width };
  const buckets = Math.min(MAX_BUCKETS, Math.max(1, Math.round(range.width * pixelRatio)));
  const clipsKey = songOverviewClipsKey(clips, region);
  const summariesKey = songOverviewSummariesKey(clips, waveformSummaries);
  // Keyed on what the waveform depends on, never on the playhead or on mix
  // changes: one computation per clip edit, arriving summary or new stretch.
  const loudest = useMemo(
    () => songOverviewLoudest(clips, waveformSummaries, region, SCALE_BUCKETS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clipsKey, summariesKey, region.startSeconds, region.endSeconds],
  );
  const songSeconds = region.endSeconds - region.startSeconds;
  const windowStartSeconds = size.width > 0 ? region.startSeconds + (range.start / size.width) * songSeconds : region.startSeconds;
  const windowEndSeconds =
    size.width > 0 ? region.startSeconds + ((range.start + range.width) / size.width) * songSeconds : region.endSeconds;
  const peaks = useMemo(
    () =>
      buildSongOverviewPeaks(
        clips,
        waveformSummaries,
        { startSeconds: windowStartSeconds, endSeconds: windowEndSeconds },
        buckets,
        loudest,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clipsKey, summariesKey, windowStartSeconds, windowEndSeconds, buckets, loudest],
  );
  const sectionStarts = useMemo(
    () =>
      sectionMarkers
        .filter(
          (marker) =>
            markerCategory(marker) === "section" &&
            marker.startSeconds > region.startSeconds &&
            marker.startSeconds < region.endSeconds,
        )
        .map((marker) => marker.startSeconds),
    [region.endSeconds, region.startSeconds, sectionMarkers],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    // Before the zoom has measured its window the stretch can be the whole
    // zoomed song: skip that frame rather than allocate a giant canvas.
    if (range.width * pixelRatio > MAX_CANVAS_PX) return;
    canvas.width = Math.round(range.width * pixelRatio);
    canvas.height = Math.round(size.height * pixelRatio);
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    if (!context) return;
    const scale = createSongTimeScale({
      startSeconds: windowStartSeconds,
      endSeconds: windowEndSeconds,
      widthPx: canvas.width,
    });
    const mid = canvas.height / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = WAVE_COLOR;
    const barWidth = canvas.width / Math.max(1, peaks.length);
    for (let index = 0; index < peaks.length; index += 1) {
      const half = Math.max(0.5, peaks[index] * mid * 0.92);
      context.fillRect(index * barWidth, mid - half, Math.max(1, barWidth), half * 2);
    }
    context.fillStyle = SECTION_COLOR;
    for (const start of sectionStarts) {
      context.fillRect(Math.round(scale.secondsToPx(start)), 0, Math.max(1, pixelRatio), canvas.height);
    }
  }, [peaks, pixelRatio, windowStartSeconds, windowEndSeconds, range.width, sectionStarts, size]);

  // The playhead, by rAF. Hidden outside the song.
  const sourcesRef = useRef({ region, width: size.width, positionSecondsRef, zoomWindow, range });
  sourcesRef.current = { region, width: size.width, positionSecondsRef, zoomWindow, range };
  useEffect(() => {
    let frameId = 0;
    let lastX = Number.NaN;
    let lastVisible: boolean | null = null;
    const frame = () => {
      const { region: current, width, positionSecondsRef: ref, zoomWindow: view, range: drawn } = sourcesRef.current;
      // The view left the drawn stretch (or the zoom changed it): a new one.
      if (view && width > 0) {
        const wanted = drawWindowFor(view, width);
        const outside =
          view.offset < drawn.start - 0.5 ||
          view.offset + view.width > drawn.start + drawn.width + 0.5 ||
          (wanted.width === width && drawn.width !== width) ||
          (wanted.width !== width && drawn.width === width);
        if (outside) {
          setDrawRange(wanted);
          markFrameActivity();
        }
      }
      const element = playheadRef.current;
      const position = ref.current;
      const visible = position >= current.startSeconds && position < current.endSeconds;
      if (element) {
        if (visible !== lastVisible) {
          element.style.setProperty("visibility", visible ? "visible" : "hidden");
          lastVisible = visible;
          markFrameActivity();
        }
        if (visible) {
          const x = createSongTimeScale({
            startSeconds: current.startSeconds,
            endSeconds: current.endSeconds,
            widthPx: width,
          }).secondsToPx(position);
          if (x !== lastX) {
            element.style.setProperty("transform", `translate3d(${x}px, 0, 0)`);
            lastX = x;
            markFrameActivity();
          }
        }
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, []);

  const secondsAt = (clientX: number) => {
    const element = rootRef.current;
    if (!element) return region.startSeconds;
    const scale = createSongTimeScale({
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
      widthPx: element.offsetWidth || size.width,
    });
    return scale.clampSeconds(scale.pxToSeconds(localX(element, clientX)));
  };

  const scrubEnabled = layout !== "short";
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSeek || event.button !== 0) return;
    event.preventDefault();
    onSeek(secondsAt(event.clientX));
    if (!scrubEnabled) return;
    const pointerId = event.pointerId;
    let pending: number | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (pending !== null) onSeek(pending);
      pending = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      // One seek per frame at most; the panel's coalescer keeps the last.
      pending = secondsAt(moveEvent.clientX);
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame) window.cancelAnimationFrame(frame);
      flush();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={rootRef}
      className={`lt-setlist-overview is-${layout}${onSeek ? " is-seekable" : ""}`}
      role="img"
      aria-label={t("setlistView.overview.label", { name: region.name })}
      onPointerDown={handlePointerDown}
      onContextMenu={
        onContextMenuAt
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenuAt(event, secondsAt(event.clientX));
            }
          : undefined
      }
      onDoubleClick={onDoubleClickAt ? (event) => onDoubleClickAt(secondsAt(event.clientX)) : undefined}
    >
      <canvas
        ref={canvasRef}
        className="lt-setlist-overview-canvas"
        aria-hidden="true"
        style={range.width < size.width ? { left: `${range.start}px`, width: `${range.width}px` } : undefined}
      />
      <div ref={playheadRef} className="lt-setlist-overview-playhead" aria-hidden="true" />
    </div>
  );
}

export const SongOverviewStrip = memo(SongOverviewStripComponent);
