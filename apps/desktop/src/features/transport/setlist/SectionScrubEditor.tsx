import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  markerCategory,
  markerColor,
  type SongRegionSummary,
  type SongView,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../constants";
import { cancelGatedFrame, markFrameActivity, requestGatedFrame, useFrameGateWake } from "../frameGate";
import { useTimelineUIStore } from "../uiStore";
import type { SectionEditHandlers } from "./sectionEditHandlers";
import { buildSongOverviewPeaks, songOverviewClipsKey, songOverviewSummariesKey } from "./songOverviewPeaks";
import { barStartsInSong, nearestBarIndex, stepBar } from "./sectionScrubModel";

/** Bars across the view at the default zoom (Playback shows a few bars). */
const DEFAULT_VISIBLE_BARS = 8;
const MIN_VISIBLE_BARS = 2;
const MAX_VISIBLE_BARS = 32;
/** Widest canvas we draw; wider content is stretched (iOS canvas limits). */
const MAX_CANVAS_PX = 8192;

type SectionScrubEditorProps = {
  song: SongView;
  region: SongRegionSummary;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  handlers: Pick<
    SectionEditHandlers,
    "createAt" | "commitMove" | "select" | "dragGroup" | "openMenu" | "duplicateSelection" | "deleteSelection"
  >;
};

/**
 * Edit → Sections on a phone, the way Playback does it: the song's waveform
 * zoomed to a few bars, swiped under a fixed centre line. Releasing the
 * swipe puts the line on the nearest bar and the playhead there; «+» adds a
 * section at that bar and the arrows move the selected section one bar at a
 * time (Playback's «Move Song Section»). While the song plays the view
 * follows the playhead.
 *
 * Panning only moves one layer with a transform (no React render per
 * frame); every edit is the DAW's, through the section handlers.
 */
function SectionScrubEditorComponent({
  song,
  region,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  handlers,
}: SectionScrubEditorProps) {
  const { t } = useTranslation();
  useFrameGateWake();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barLabelRef = useRef<HTMLOutputElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  const [visibleBars, setVisibleBars] = useState(DEFAULT_VISIBLE_BARS);
  // Two plain fields: a selector building `[{…}]` would be a new array on
  // every read and re-render forever.
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);

  const bars = useMemo(() => barStartsInSong(song, region), [song, region]);
  const firstBarSeconds = (bars[1] ?? region.endSeconds) - (bars[0] ?? region.startSeconds);
  const duration = Math.max(0.001, region.endSeconds - region.startSeconds);
  const pxPerSecond = widthPx > 0 ? widthPx / Math.max(0.001, visibleBars * firstBarSeconds) : 0;
  const contentWidth = duration * pxPerSecond;

  // Where the centre line is, in song seconds. A ref: panning never renders.
  const cursorRef = useRef(positionSecondsRef.current);
  const panningRef = useRef(false);
  const lastPositionRef = useRef(Number.NaN);
  const geometryRef = useRef({ pxPerSecond, widthPx, bars, region });
  geometryRef.current = { pxPerSecond, widthPx, bars, region };

  const clampToSong = useCallback(
    (seconds: number) => Math.max(region.startSeconds, Math.min(region.endSeconds - 0.001, seconds)),
    [region.endSeconds, region.startSeconds],
  );

  /** Puts the layer so the cursor sits under the centre line. */
  const applyCursor = useCallback(() => {
    const { pxPerSecond: pps, widthPx: width, bars: barList, region: bounds } = geometryRef.current;
    const layer = layerRef.current;
    if (layer) {
      const offset = width / 2 - (cursorRef.current - bounds.startSeconds) * pps;
      layer.style.setProperty("transform", `translate3d(${offset}px, 0, 0)`);
    }
    const label = barLabelRef.current;
    if (label) {
      const index = nearestBarIndex(barList, cursorRef.current, { floor: true });
      label.textContent = t("setlistView.sections.barLabel", { bar: index + 1 });
    }
  }, [t]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    setWidthPx(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) setWidthPx(Math.round(rect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    cursorRef.current = clampToSong(cursorRef.current);
    applyCursor();
  }, [applyCursor, clampToSong, pxPerSecond, widthPx]);

  // Follow the playhead (playing, or a seek from elsewhere) unless the
  // finger is on the waveform.
  useEffect(() => {
    let frameId = 0;
    const frame = () => {
      const position = positionSecondsRef.current;
      if (!panningRef.current && position !== lastPositionRef.current) {
        lastPositionRef.current = position;
        if (position >= region.startSeconds && position < region.endSeconds) {
          cursorRef.current = position;
          applyCursor();
          markFrameActivity();
        }
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, [applyCursor, positionSecondsRef, region.endSeconds, region.startSeconds]);

  // The waveform of the whole song, drawn once per zoom/content change.
  const clipsKey = songOverviewClipsKey(song.clips, region);
  const summariesKey = songOverviewSummariesKey(song.clips, waveformSummaries);
  const canvasWidth = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(contentWidth)));
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || contentWidth <= 0) return;
    const height = Math.max(1, canvas.clientHeight || 120);
    canvas.width = canvasWidth;
    canvas.height = height;
    const context = canvas.getContext?.("2d");
    if (!context) return;
    const peaks = buildSongOverviewPeaks(song.clips, waveformSummaries, region, canvasWidth);
    context.clearRect(0, 0, canvasWidth, height);
    context.fillStyle = "rgb(186 202 197 / 0.62)";
    const mid = height / 2;
    for (let index = 0; index < peaks.length; index += 1) {
      const half = Math.max(0.5, peaks[index] * mid * 0.92);
      context.fillRect(index, mid - half, 1, half * 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasWidth, clipsKey, summariesKey, region.startSeconds, region.endSeconds]);

  const settleOnBar = (seconds: number) => {
    const index = nearestBarIndex(bars, seconds);
    return clampToSong(bars[index] ?? seconds);
  };

  const commitCursor = (seconds: number) => {
    cursorRef.current = settleOnBar(seconds);
    lastPositionRef.current = cursorRef.current;
    applyCursor();
    onSeek(cursorRef.current);
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pxPerSecond <= 0) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startCursor = cursorRef.current;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      panningRef.current = true;
      cursorRef.current = clampToSong(startCursor - dx / pxPerSecond);
      applyCursor();
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      detach();
      panningRef.current = false;
      if (moved) commitCursor(cursorRef.current);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      detach();
      panningRef.current = false;
      cursorRef.current = startCursor;
      applyCursor();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const sections = song.sectionMarkers.filter(
    (marker) =>
      markerCategory(marker) === "section" &&
      marker.startSeconds >= region.startSeconds &&
      marker.startSeconds < region.endSeconds,
  );
  const selectedSectionIds =
    selectedMarkers.length > 0
      ? selectedMarkers.filter((marker) => marker.kind === "section").map((marker) => marker.id)
      : selectedSectionId
        ? [selectedSectionId]
        : [];
  const primarySelected = sections.find((marker) => marker.id === selectedSectionIds[0]) ?? null;

  const nudgeSelected = (direction: -1 | 1) => {
    if (!primarySelected) return;
    const target = stepBar(bars, primarySelected.startSeconds, direction);
    if (target === null || target >= region.endSeconds) return;
    handlers.commitMove(handlers.dragGroup(primarySelected.id), target - primarySelected.startSeconds);
  };

  const stepCursor = (direction: -1 | 1) => {
    const target = stepBar(bars, cursorRef.current, direction);
    if (target !== null) commitCursor(target);
  };

  const ticks = bars.map((seconds, index) => ({ seconds, bar: index + 1 }));
  const labelEvery = Math.max(1, Math.ceil(44 / Math.max(1, firstBarSeconds * pxPerSecond)));

  return (
    <div className="lt-setlist-scrub">
      <div
        ref={viewportRef}
        className="lt-setlist-scrub-viewport"
        aria-label={t("setlistView.sections.scrubHint")}
        title={t("setlistView.sections.scrubHint")}
        onPointerDown={startPan}
      >
        <div
          ref={layerRef}
          className="lt-setlist-scrub-layer"
          style={{ width: `${contentWidth}px` } as CSSProperties}
        >
          <div className="lt-setlist-scrub-ruler" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.seconds}
                className="lt-setlist-scrub-tick"
                style={{ left: `${(tick.seconds - region.startSeconds) * pxPerSecond}px` }}
              >
                {(tick.bar - 1) % labelEvery === 0 ? tick.bar : null}
              </span>
            ))}
          </div>
          <canvas ref={canvasRef} className="lt-setlist-scrub-canvas" aria-hidden="true" />
          {sections.map((marker) => {
            const isSelected = selectedSectionIds.includes(marker.id);
            return (
              <button
                key={marker.id}
                type="button"
                className={`lt-setlist-scrub-section${isSelected ? " is-selected" : ""}`}
                style={
                  {
                    left: `${(marker.startSeconds - region.startSeconds) * pxPerSecond}px`,
                    "--lt-setlist-block-color": markerColor(marker),
                  } as CSSProperties
                }
                aria-pressed={isSelected}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => handlers.select(marker.id, { additive: false, range: false })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  handlers.openMenu(event, marker.id);
                }}
              >
                {marker.name}
              </button>
            );
          })}
        </div>
        <div className="lt-setlist-scrub-cursor" aria-hidden="true" />
        <output ref={barLabelRef} className="lt-setlist-scrub-bar" aria-live="polite" />
      </div>
      <div className="lt-setlist-scrub-bar-row" role="toolbar" aria-label={t("setlistView.sections.actions")}>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.sections.prevBar")} title={t("setlistView.sections.prevBar")} onClick={() => stepCursor(-1)}>
          <span className="material-symbols-outlined" aria-hidden="true">first_page</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.sections.nextBar")} title={t("setlistView.sections.nextBar")} onClick={() => stepCursor(1)}>
          <span className="material-symbols-outlined" aria-hidden="true">last_page</span>
        </button>
        <button type="button" className="lt-setlist-settings-button is-primary" onClick={() => handlers.createAt(cursorRef.current)}>
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
          {t("setlistView.sections.addHere")}
        </button>
        <span className="lt-setlist-lanes-toolbar-gap" />
        <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.moveLeft")} title={t("setlistView.sections.moveLeft")} onClick={() => nudgeSelected(-1)}>
          <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.moveRight")} title={t("setlistView.sections.moveRight")} onClick={() => nudgeSelected(1)}>
          <span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.duplicate")} title={t("setlistView.sections.duplicate")} onClick={handlers.duplicateSelection}>
          <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" disabled={!primarySelected} aria-label={t("setlistView.sections.delete")} title={t("setlistView.sections.delete")} onClick={handlers.deleteSelection}>
          <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomOut")} title={t("setlistView.lanes.zoomOut")} disabled={visibleBars >= MAX_VISIBLE_BARS} onClick={() => setVisibleBars((bars) => Math.min(MAX_VISIBLE_BARS, bars * 2))}>
          −
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomIn")} title={t("setlistView.lanes.zoomIn")} disabled={visibleBars <= MIN_VISIBLE_BARS} onClick={() => setVisibleBars((bars) => Math.max(MIN_VISIBLE_BARS, bars / 2))}>
          +
        </button>
      </div>
    </div>
  );
}

export const SectionScrubEditor = memo(SectionScrubEditorComponent);
