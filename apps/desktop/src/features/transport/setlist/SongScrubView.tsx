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
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView, WaveformSummaryDto } from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../constants";
import { cancelGatedFrame, markFrameActivity, requestGatedFrame, useFrameGateWake } from "../frameGate";
import type { ShortcutActionId } from "../keyboard/actions";
import { useTransportStore } from "../store";
import { barStartsInSong, nearestBarIndex, stepBar } from "./sectionScrubModel";
import { buildSongOverviewPeaks, songOverviewClipsKey, songOverviewSummariesKey } from "./songOverviewPeaks";

/** Bars across the view at the default zoom (Playback shows a few bars). */
const DEFAULT_VISIBLE_BARS = 8;
const MIN_VISIBLE_BARS = 2;
const MAX_VISIBLE_BARS = 64;
/** Widest canvas we draw; wider content is stretched (iOS canvas limits). */
const MAX_CANVAS_PX = 8192;

/** What the overlay needs to place things on the waveform. */
export type ScrubGeometry = {
  /** x in the layer of a moment of the song. */
  xOf: (seconds: number) => number;
  pxPerSecond: number;
};

/** What a mode's buttons can do with the line. */
export type ScrubControls = {
  /** The moment under the centre line (on a bar after a swipe). */
  cursorSeconds: () => number;
};

type SongScrubViewProps = {
  song: SongView;
  region: SongRegionSummary;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  /** The DAW's shortcut dispatcher: play/pause is its action. */
  runShortcutAction: (action: ShortcutActionId) => void;
  /** Drawn on the waveform, scrolling with it (sections, cues, clips…). */
  overlay?: (geometry: ScrubGeometry) => ReactNode;
  /** The mode's own buttons, after the shared ones. */
  actions?: (controls: ScrubControls) => ReactNode;
  className?: string;
};

/**
 * The song's waveform the way Playback edits it on a phone: zoomed to a few
 * bars and swiped under a fixed centre line. Releasing the swipe puts the
 * line on the nearest bar and the playhead there; while the song plays the
 * view follows the playhead; play/pause plays from the line. Sections,
 * cues, automation and MIDI each draw their own marks on it and bring their
 * own buttons (`overlay`, `actions`).
 *
 * Panning only moves one layer with a transform (no React render per frame).
 */
function SongScrubViewComponent({
  song,
  region,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  runShortcutAction,
  overlay,
  actions,
  className,
}: SongScrubViewProps) {
  const { t } = useTranslation();
  useFrameGateWake();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barLabelRef = useRef<HTMLOutputElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  const [visibleBars, setVisibleBars] = useState(DEFAULT_VISIBLE_BARS);
  const playing = useTransportStore((state) => state.playback?.playbackState === "playing");

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

  const commitCursor = (seconds: number) => {
    cursorRef.current = clampToSong(bars[nearestBarIndex(bars, seconds)] ?? seconds);
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

  const stepCursor = (direction: -1 | 1) => {
    const target = stepBar(bars, cursorRef.current, direction);
    if (target !== null) commitCursor(target);
  };

  const geometry: ScrubGeometry = {
    xOf: (seconds) => (seconds - region.startSeconds) * pxPerSecond,
    pxPerSecond,
  };
  const labelEvery = Math.max(1, Math.ceil(44 / Math.max(1, firstBarSeconds * pxPerSecond)));

  return (
    <div className={`lt-setlist-scrub${className ? ` ${className}` : ""}`}>
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
            {bars.map((seconds, index) => (
              <span
                key={seconds}
                className="lt-setlist-scrub-tick"
                style={{ left: `${geometry.xOf(seconds)}px` }}
              >
                {index % labelEvery === 0 ? index + 1 : null}
              </span>
            ))}
          </div>
          <canvas ref={canvasRef} className="lt-setlist-scrub-canvas" aria-hidden="true" />
          {overlay?.(geometry)}
        </div>
        <div className="lt-setlist-scrub-cursor" aria-hidden="true" />
        <output ref={barLabelRef} className="lt-setlist-scrub-bar" aria-live="polite" />
      </div>
      <div className="lt-setlist-scrub-bar-row" role="toolbar" aria-label={t("setlistView.sections.actions")}>
        <button
          type="button"
          className={`lt-setlist-settings-button${playing ? " is-active" : ""}`}
          aria-label={t(playing ? "setlistView.scrub.pause" : "setlistView.scrub.play")}
          title={t(playing ? "setlistView.scrub.pause" : "setlistView.scrub.play")}
          onClick={() => runShortcutAction("transport.playPause")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">{playing ? "pause" : "play_arrow"}</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.sections.prevBar")} title={t("setlistView.sections.prevBar")} onClick={() => stepCursor(-1)}>
          <span className="material-symbols-outlined" aria-hidden="true">first_page</span>
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.sections.nextBar")} title={t("setlistView.sections.nextBar")} onClick={() => stepCursor(1)}>
          <span className="material-symbols-outlined" aria-hidden="true">last_page</span>
        </button>
        {actions?.({ cursorSeconds: () => cursorRef.current })}
        <span className="lt-setlist-lanes-toolbar-gap" />
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomOut")} title={t("setlistView.lanes.zoomOut")} disabled={visibleBars >= MAX_VISIBLE_BARS} onClick={() => setVisibleBars((value) => Math.min(MAX_VISIBLE_BARS, value * 2))}>
          −
        </button>
        <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomIn")} title={t("setlistView.lanes.zoomIn")} disabled={visibleBars <= MIN_VISIBLE_BARS} onClick={() => setVisibleBars((value) => Math.max(MIN_VISIBLE_BARS, value / 2))}>
          +
        </button>
      </div>
    </div>
  );
}

export const SongScrubView = memo(SongScrubViewComponent);
