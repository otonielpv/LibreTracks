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
import { DRAG_THRESHOLD_PX } from "../constants";
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
const PLAYHEAD_EDGE_BUFFER_PX = 48;
const PLAYHEAD_MAX_SCROLL_SPEED_PX = 18;

function resolvePlayheadAutoScrollSpeed(distancePx: number) {
  if (distancePx >= PLAYHEAD_EDGE_BUFFER_PX) return 0;
  const intensity =
    (PLAYHEAD_EDGE_BUFFER_PX - Math.max(0, distancePx)) /
    PLAYHEAD_EDGE_BUFFER_PX;
  return Math.max(1, intensity * intensity * PLAYHEAD_MAX_SCROLL_SPEED_PX);
}

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
 * never re-renders this component. Taps do not seek; dragging the playhead
 * handle (or the waveform where it is exposed) scrubs at most once per frame.
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
  const scrubCleanupRef = useRef<(() => void) | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => () => scrubCleanupRef.current?.(), [region.id, onSeek]);

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

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, fromPlayhead = false) => {
    if (!onSeek || event.button !== 0) return;
    if (scrubCleanupRef.current) return;
    if (!fromPlayhead && layout === "short") return;
    event.preventDefault();
    if (fromPlayhead) event.stopPropagation();
    zoomWindow?.setScrubbing?.(true);
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    let pending: number | null = null;
    let frame = 0;
    let autoScrollFrame: number | null = null;
    let latestClientX = event.clientX;
    let ended = false;
    let dragging = false;
    const flush = () => {
      frame = 0;
      if (pending !== null) onSeek(pending);
      pending = null;
    };
    const stopAutoScroll = () => {
      if (autoScrollFrame !== null) {
        window.cancelAnimationFrame(autoScrollFrame);
        autoScrollFrame = null;
      }
    };
    const tickAutoScroll = () => {
      autoScrollFrame = null;
      if (ended || !zoomWindow?.panBy || zoomWindow.left == null || zoomWindow.width <= 0) return;
      const distanceToLeft = latestClientX - zoomWindow.left;
      const distanceToRight = zoomWindow.left + zoomWindow.width - latestClientX;
      const velocity =
        distanceToLeft < PLAYHEAD_EDGE_BUFFER_PX
          ? -resolvePlayheadAutoScrollSpeed(distanceToLeft)
          : distanceToRight < PLAYHEAD_EDGE_BUFFER_PX
            ? resolvePlayheadAutoScrollSpeed(distanceToRight)
            : 0;
      if (!velocity) return;

      const beforeOffset = zoomWindow.offset;
      const afterOffset = zoomWindow.panBy(velocity);
      if (Math.abs(afterOffset - beforeOffset) < 0.5) return;
      pending = secondsAt(latestClientX);
      if (!frame) frame = window.requestAnimationFrame(flush);
      autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
    };
    const maybeStartAutoScroll = () => {
      if (!zoomWindow?.panBy || zoomWindow.left == null || zoomWindow.width <= 0) return;
      const nearEdge =
        latestClientX - zoomWindow.left < PLAYHEAD_EDGE_BUFFER_PX ||
        zoomWindow.left + zoomWindow.width - latestClientX < PLAYHEAD_EDGE_BUFFER_PX;
      if (nearEdge && autoScrollFrame === null) {
        autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
      } else if (!nearEdge) {
        stopAutoScroll();
      }
    };
    const startScrubbing = () => {
      dragging = true;
      zoomWindow?.setScrubbing?.(true);
      playheadRef.current?.classList.add("is-dragging");
      pending = secondsAt(latestClientX);
      if (!frame) frame = window.requestAnimationFrame(flush);
      maybeStartAutoScroll();
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestClientX = moveEvent.clientX;
      if (!dragging) {
        if (Math.abs(latestClientX - startClientX) < DRAG_THRESHOLD_PX) return;
        startScrubbing();
        return;
      }
      pending = secondsAt(latestClientX);
      if (!frame) frame = window.requestAnimationFrame(flush);
      maybeStartAutoScroll();
    };
    const cleanup = () => {
      ended = true;
      stopAutoScroll();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame) window.cancelAnimationFrame(frame);
      pending = null;
      zoomWindow?.setScrubbing?.(false);
      if (dragging) {
        playheadRef.current?.classList.remove("is-dragging");
      }
      scrubCleanupRef.current = null;
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (frame) window.cancelAnimationFrame(frame);
      if (upEvent.type === "pointerup" && dragging) flush();
      cleanup();
    };
    scrubCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={rootRef}
      className={`lt-setlist-overview is-${layout}${onSeek ? " is-seekable" : ""}`}
      role={onSeek ? "group" : "img"}
      aria-label={t("setlistView.overview.label", { name: region.name })}
      onPointerDown={(event) => handlePointerDown(event)}
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
      <div ref={playheadRef} className="lt-setlist-overview-playhead">
        {onSeek ? (
          <button
            type="button"
            className="lt-setlist-playhead-handle"
            aria-label={t("setlistView.overview.movePlayhead")}
            title={t("setlistView.overview.movePlayhead")}
            onPointerDown={(event) => handlePointerDown(event, true)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              event.stopPropagation();
              const seconds = event.key === "Home" ? region.startSeconds
                : event.key === "End" ? region.endSeconds
                : positionSecondsRef.current + (event.key === "ArrowLeft" ? -1 : 1);
              onSeek(Math.max(region.startSeconds, Math.min(region.endSeconds, seconds)));
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">drag_indicator</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const SongOverviewStrip = memo(SongOverviewStripComponent);
