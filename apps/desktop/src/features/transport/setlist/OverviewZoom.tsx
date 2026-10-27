import {
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { DRAG_THRESHOLD_PX } from "../constants";
import { cancelGatedFrame, markFrameActivity, requestGatedFrame, useFrameGateWake } from "../frameGate";
import {
  FOLLOW_CAMERA_MANUAL_PAUSE_MS,
  shouldPauseFollowCamera,
} from "../followCamera";
import { useTransportStore } from "../store";
import { useSetlistStore } from "./setlistStore";

export const OVERVIEW_MAX_ZOOM = 32;

/** Which part of the zoomed layer is on screen, in px of the layer. Mutated
 * in place (no renders): the waveform reads it per frame and redraws only
 * the stretch around it, so a 32× zoom keeps full detail without a canvas
 * 32 screens wide. */
export type ZoomWindow = {
  offset: number;
  width: number;
  left?: number;
  setScrubbing?: (active: boolean) => void;
  panBy?: (deltaPx: number) => number;
};
export const ZoomWindowContext = createContext<ZoomWindow | null>(null);
const WHEEL_ZOOM_FACTOR = 1.25;

/** How far to slide a `zoom`× wide layer so `fraction` of it sits in the
 * middle of a `viewportWidth` window, never past its edges. */
export function followOffset(
  fraction: number,
  viewportWidth: number,
  zoom: number,
  baseLayerWidth = viewportWidth,
): number {
  const layerWidth = baseLayerWidth * zoom;
  if (zoom <= 1 || layerWidth <= viewportWidth || viewportWidth <= 0) return 0;
  const centred = fraction * layerWidth - viewportWidth / 2;
  return Math.max(0, Math.min(layerWidth - viewportWidth, centred));
}

/** The offset that keeps the moment under `anchorX` (px in the viewport)
 * there when the zoom goes from `fromZoom` to `toZoom` (pinch, Ctrl+wheel). */
export function anchoredOffset(
  offset: number,
  anchorX: number,
  viewportWidth: number,
  fromZoom: number,
  toZoom: number,
  baseLayerWidth = viewportWidth,
): number {
  if (viewportWidth <= 0) return 0;
  const fraction = (offset + anchorX) / (baseLayerWidth * fromZoom);
  const next = fraction * baseLayerWidth * toZoom - anchorX;
  return Math.max(0, Math.min(baseLayerWidth * toZoom - viewportWidth, next));
}

type OverviewZoomProps = {
  startSeconds: number;
  endSeconds: number;
  positionSecondsRef: { readonly current: number };
  /** Touch taps seek here unless `tapToSeek` is disabled. */
  onSeek?: (seconds: number) => void;
  /** Keep section-oriented bands from treating a tap as an arbitrary seek. */
  tapToSeek?: boolean;
  /** Inside the zoomed layer: the waveform, the section blocks, the edit
   * handles. They place things in % of the song, so they stay aligned. */
  children: ReactNode;
  /** Outside the layer (they must not slide): loop / next. */
  overlay?: ReactNode;
  /** Extra layer width at 1×, in rem, for content that must not shrink below its natural width. */
  minLayerWidthRem?: number;
  /** Additional class for a specialized viewport. */
  viewportClassName?: string;
};

const isControl = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest("button:not(.lt-setlist-map-block), [role='button']:not(.lt-setlist-map-block), .lt-setlist-section-handle"));

/**
 * The band's zoom, with the DAW's gestures on a phone (the iPhone reports):
 * pinch zooms around the fingers, one finger drags the zoomed song, and a tap
 * seeks when enabled. Zoomed in, the band follows the playhead (centred) whenever it
 * moves; after a drag by hand it stays where it was left until the playhead
 * moves again. Everything slides by rAF on one layer, with no React render;
 * a pinch writes the zoom at most once per frame. With a mouse: the
 * waveform's click/scrub as before, the wheel slides and Ctrl+wheel (or a
 * trackpad pinch) zooms. No zoom buttons: the gestures replace them.
 */
export function OverviewZoom({
  startSeconds,
  endSeconds,
  positionSecondsRef,
  onSeek,
  tapToSeek = true,
  children,
  overlay,
  minLayerWidthRem = 0,
  viewportClassName,
}: OverviewZoomProps) {
  useFrameGateWake();
  const zoom = useSetlistStore((state) => state.overviewZoom);
  const setZoom = useSetlistStore((state) => state.setOverviewZoom);
  const isPlaying = useTransportStore((state) => state.playback?.playbackState === "playing");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Where the layer is, and whether a hand put it there.
  const offsetRef = useRef(0);
  const manualFollowPauseUntilMsRef = useRef(0);
  const gestureRef = useRef(false);
  const scrubbingRef = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingZoomRef = useRef<number | null>(null);
  const wheelZoomPreviewRef = useRef<{
    baseZoom: number;
    targetZoom: number;
    offset: number;
  } | null>(null);
  const wheelZoomTimerRef = useRef<number | null>(null);
  const windowRef = useRef<ZoomWindow>({ offset: 0, width: 0 });
  const pauseFollowAfterManualNavigation = () => {
    manualFollowPauseUntilMsRef.current =
      performance.now() + FOLLOW_CAMERA_MANUAL_PAUSE_MS;
  };
  windowRef.current.setScrubbing = (active) => {
    scrubbingRef.current = active;
    if (!active) pauseFollowAfterManualNavigation();
  };

  const applyOffset = (offset: number) => {
    const layer = layerRef.current;
    offsetRef.current = offset;
    windowRef.current.offset = offset;
    layer?.style.setProperty("transform", offset ? `translate3d(${-offset}px, 0, 0)` : "none");
  };
  const applyZoomSizing = (scale: number) => {
    const layer = layerRef.current;
    // Keep intrinsic arrangement widths proportional when the pinch commits.
    layer?.style.setProperty("--lt-setlist-arrangement-block-min-width", `${9 * scale}rem`);
    layer?.style.setProperty("--lt-setlist-arrangement-end-width", `${44 * scale}px`);
  };
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    applyZoomSizing(zoom);
    if (!viewport) return;
    const maxOffset = Math.max(
      0,
      baseLayerWidth(viewport) * zoomRef.current - viewport.clientWidth,
    );
    if (offsetRef.current > maxOffset) applyOffset(maxOffset);
  }, [minLayerWidthRem, zoom]);
  windowRef.current.panBy = (deltaPx) => {
    const viewport = viewportRef.current;
    const viewportWidth = viewport?.clientWidth ?? windowRef.current.width;
    const maxOffset = Math.max(
      0,
      (viewport ? baseLayerWidth(viewport) : viewportWidth) * zoomRef.current - viewportWidth,
    );
    const nextOffset = Math.max(0, Math.min(maxOffset, offsetRef.current + deltaPx));
    if (Math.abs(nextOffset - offsetRef.current) > 0.01) {
      applyOffset(nextOffset);
      pauseFollowAfterManualNavigation();
      markFrameActivity();
    }
    return nextOffset;
  };

  useEffect(() => {
    let frameId = 0;
    let last = Number.NaN;
    const frame = () => {
      const viewport = viewportRef.current;
      const position = positionSecondsRef.current;
      if (viewport) {
        windowRef.current.width = viewport.clientWidth;
        windowRef.current.left = viewport.getBoundingClientRect().left;
      }
      if (pendingZoomRef.current !== null) {
        setZoom(pendingZoomRef.current);
        pendingZoomRef.current = null;
      }
      if (
        viewport &&
        isPlaying &&
        !gestureRef.current &&
        !scrubbingRef.current &&
        !shouldPauseFollowCamera(
          performance.now(),
          manualFollowPauseUntilMsRef.current,
        )
      ) {
        const duration = Math.max(0.001, endSeconds - startSeconds);
        const fraction = Math.max(0, Math.min(1, (position - startSeconds) / duration));
        // Fractional on purpose: the layer is composited (will-change), so the
        // GPU slides it sub-pixel. Rounding made it step a whole pixel a few
        // times a second when zoomed in, which read as low FPS (the iPhone).
        const offset = followOffset(
          fraction,
          viewport.clientWidth,
          zoomRef.current,
          baseLayerWidth(viewport),
        );
        if (!(Math.abs(offset - last) < 0.01)) {
          applyOffset(offset);
          last = offset;
          markFrameActivity();
        }
      } else {
        last = Number.NaN;
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endSeconds, isPlaying, minLayerWidthRem, positionSecondsRef, startSeconds, zoom]);

  const commitWheelZoomPreview = () => {
    const preview = wheelZoomPreviewRef.current;
    if (!preview) return;
    wheelZoomPreviewRef.current = null;
    if (wheelZoomTimerRef.current !== null) {
      window.clearTimeout(wheelZoomTimerRef.current);
      wheelZoomTimerRef.current = null;
    }
    zoomRef.current = preview.targetZoom;
    applyZoomSizing(preview.targetZoom);
    layerRef.current?.style.setProperty("width", layerWidthStyle(preview.targetZoom));
    applyOffset(preview.offset);
    setZoom(preview.targetZoom);
    markFrameActivity();
  };

  /** A zoom kept around `anchorX` (px in the viewport). */
  const zoomAround = (nextZoom: number, anchorX: number) => {
    const viewport = viewportRef.current;
    const clamped = Math.max(1, Math.min(OVERVIEW_MAX_ZOOM, nextZoom));
    if (!viewport) return;
    const width = viewport.clientWidth;
    const preview = wheelZoomPreviewRef.current;
    const baseZoom = preview?.baseZoom ?? zoomRef.current;
    const fromZoom = preview?.targetZoom ?? zoomRef.current;
    const fromOffset = preview?.offset ?? offsetRef.current;
    const offset = anchoredOffset(
      fromOffset,
      anchorX,
      width,
      fromZoom,
      clamped,
      baseLayerWidth(viewport),
    );
    wheelZoomPreviewRef.current = { baseZoom, targetZoom: clamped, offset };
    const layer = layerRef.current;
    layer?.style.setProperty(
      "transform",
      `translate3d(${-offset}px, 0, 0) scaleX(${clamped / baseZoom})`,
    );
    if (wheelZoomTimerRef.current !== null) {
      window.clearTimeout(wheelZoomTimerRef.current);
    }
    wheelZoomTimerRef.current = window.setTimeout(commitWheelZoomPreview, 140);
    pauseFollowAfterManualNavigation();
    markFrameActivity();
  };

  // Touch gestures, before the waveform's own pointer handling.
  const pointersRef = useRef(new Map<number, number>());
  const suppressClickRef = useRef(false);
  // A pinch scales the layer with a transform (no relayout per frame: laying
  // the blocks out again at every step made every section label and edge
  // shiver). The real width is set once, when the fingers lift.
  const pinchRef = useRef<{
    distance: number;
    zoom: number;
    baseWidth: number;
    offset: number;
    anchor0: number;
    target: number;
    visualOffset: number;
  } | null>(null);
  const arrangementHandlePointerRef = useRef<number | null>(null);
  const ignoredCancelPointerRef = useRef<number | null>(null);
  const baseLayerWidth = (viewport: HTMLElement) => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.max(viewport.clientWidth, minLayerWidthRem * rem);
  };
  const layerWidthStyle = (scale: number) =>
    minLayerWidthRem > 0
      ? `max(${scale * 100}%, ${minLayerWidthRem * scale}rem)`
      : `${scale * 100}%`;
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    commitWheelZoomPreview();
    if (pointersRef.current.size === 0) suppressClickRef.current = false;
    if (scrubbingRef.current) return;
    const sectionHandle =
      event.target instanceof Element &&
      Boolean(event.target.closest(".lt-setlist-section-handle"));
    const arrangementHandle =
      event.target instanceof Element &&
      Boolean(event.target.closest(".lt-structure-handle, .lt-setlist-arrangement-insert"));
    if (
      event.pointerType !== "touch" ||
      (isControl(event.target) && !sectionHandle && !arrangementHandle)
    ) {
      return;
    }
    const sectionTap = event.target instanceof Element && Boolean(event.target.closest(".lt-setlist-map-block"));
    if (!sectionTap && !sectionHandle && !arrangementHandle) event.stopPropagation();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const pointers = pointersRef.current;
    if (pointers.size === 0) arrangementHandlePointerRef.current = null;
    if (pointers.size === 0 && arrangementHandle) {
      arrangementHandlePointerRef.current = event.pointerId;
    }
    pointers.set(event.pointerId, event.clientX);
    if (pointers.size === 2) {
      suppressClickRef.current = true;
      // The second finger: the first one's listeners run the pinch.
      const [a, b] = [...pointers.values()];
      pinchRef.current = {
        distance: Math.abs(a - b),
        zoom: zoomRef.current,
        baseWidth: baseLayerWidth(viewport),
        offset: offsetRef.current,
        anchor0: (a + b) / 2 - viewport.getBoundingClientRect().left,
        target: zoomRef.current,
        visualOffset: offsetRef.current,
      };
      if (arrangementHandle || arrangementHandlePointerRef.current !== null) {
        event.preventDefault();
        event.stopPropagation();
        const cancelPointerId = arrangementHandlePointerRef.current;
        if (cancelPointerId !== null) {
          ignoredCancelPointerRef.current = cancelPointerId;
          const cancel = new Event("pointercancel");
          Object.defineProperty(cancel, "pointerId", { value: cancelPointerId });
          window.dispatchEvent(cancel);
          ignoredCancelPointerRef.current = null;
          arrangementHandlePointerRef.current = null;
        }
      }
      return;
    }
    if (pointers.size > 2) return;
    gestureRef.current = true;
    const rect = viewport.getBoundingClientRect();
    const startOffset = offsetRef.current;
    const startX = event.clientX;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!pointers.has(moveEvent.pointerId)) return;
      pointers.set(moveEvent.pointerId, moveEvent.clientX);
      const pinch = pinchRef.current;
      if (pinch) {
        moved = true;
        const xs = [...pointers.values()];
        if (xs.length === 2 && pinch.distance > 0) {
          const distance = Math.abs(xs[0] - xs[1]);
          const anchorX = (xs[0] + xs[1]) / 2 - rect.left;
          const width = viewport.clientWidth;
          const target = Math.max(1, Math.min(OVERVIEW_MAX_ZOOM, pinch.zoom * (distance / pinch.distance)));
          // The song's moment under the fingers when they landed stays under
          // them, wherever they go.
          const content = (pinch.offset + pinch.anchor0) / (pinch.baseWidth * pinch.zoom);
          const offset = Math.max(
            0,
            Math.min(
              pinch.baseWidth * target - width,
              content * pinch.baseWidth * target - anchorX,
            ),
          );
          pinch.target = target;
          pinch.visualOffset = offset;
          layerRef.current?.style.setProperty(
            "transform",
            `translate3d(${-offset}px, 0, 0) scaleX(${target / pinch.zoom})`,
          );
          pauseFollowAfterManualNavigation();
          markFrameActivity();
        }
        return;
      }
      if (sectionHandle || arrangementHandle) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      suppressClickRef.current = true;
      const width = viewport.clientWidth;
      const max = Math.max(0, baseLayerWidth(viewport) * zoomRef.current - width);
      applyOffset(Math.max(0, Math.min(max, startOffset - dx)));
      pauseFollowAfterManualNavigation();
      markFrameActivity();
    };
    const onUp = (upEvent: PointerEvent) => {
      if (
        upEvent.type === "pointercancel" &&
        ignoredCancelPointerRef.current === upEvent.pointerId
      ) {
        ignoredCancelPointerRef.current = null;
        return;
      }
      if (!pointers.has(upEvent.pointerId)) return;
      pointers.delete(upEvent.pointerId);
      if (arrangementHandlePointerRef.current === upEvent.pointerId) {
        arrangementHandlePointerRef.current = null;
      }
      if (pointers.size > 0) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      gestureRef.current = false;
      const pinch = pinchRef.current;
      pinchRef.current = null;
      if (pinch && pinch.target !== pinch.zoom) {
        // Commit: the real width, which lays out exactly where the scaled
        // layer was, so nothing jumps.
        zoomRef.current = pinch.target;
        pendingZoomRef.current = pinch.target;
        applyZoomSizing(pinch.target);
        layerRef.current?.style.setProperty("width", layerWidthStyle(pinch.target));
        applyOffset(
          Math.max(
            0,
            Math.min(baseLayerWidth(viewport) * pinch.target - viewport.clientWidth, pinch.visualOffset),
          ),
        );
        markFrameActivity();
      }
      if (
        !moved &&
        !pinch &&
        !sectionTap &&
        !sectionHandle &&
        !arrangementHandle &&
        upEvent.type === "pointerup" &&
        tapToSeek &&
        onSeek
      ) {
        // A tap: the moment under the finger, through the (moved) layer.
        const layer = layerRef.current;
        const box = layer?.getBoundingClientRect();
        if (box && box.width > 0) {
          const fraction = Math.max(0, Math.min(1, (upEvent.clientX - box.left) / box.width));
          onSeek(startSeconds + fraction * (endSeconds - startSeconds));
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Desktop: the wheel (or a trackpad swipe) slides the zoomed song;
  // Ctrl/⌘ + wheel, which is also what a trackpad pinch sends, zooms around
  // the pointer. Native and non-passive: React's wheel listener cannot stop
  // the webview's own page zoom.
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelRef.current = (event: WheelEvent) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const currentZoom = wheelZoomPreviewRef.current?.targetZoom ?? zoomRef.current;
      zoomAround(
        currentZoom * (event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR),
        event.clientX - rect.left,
      );
      return;
    }
    commitWheelZoomPreview();
    if (zoomRef.current <= 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    const width = viewport.clientWidth;
    const max = Math.max(0, baseLayerWidth(viewport) * zoomRef.current - width);
    applyOffset(Math.max(0, Math.min(max, offsetRef.current + delta)));
    pauseFollowAfterManualNavigation();
    markFrameActivity();
  };
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    viewport.addEventListener("wheel", listener, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", listener);
      if (wheelZoomTimerRef.current !== null) {
        window.clearTimeout(wheelZoomTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      <div
        ref={viewportRef}
        className={`lt-setlist-zoom-viewport${viewportClassName ? ` ${viewportClassName}` : ""}`}
        onPointerDownCapture={handlePointerDown}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          ref={layerRef}
          className="lt-setlist-zoom-layer"
          style={{ width: layerWidthStyle(zoom) }}
          data-zoom={zoom}
        >
          <ZoomWindowContext.Provider value={windowRef.current}>{children}</ZoomWindowContext.Provider>
        </div>
      </div>
      {overlay}
    </>
  );
}
