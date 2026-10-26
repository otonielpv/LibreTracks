import {
  createContext,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { DRAG_THRESHOLD_PX } from "../constants";
import { cancelGatedFrame, markFrameActivity, requestGatedFrame, useFrameGateWake } from "../frameGate";
import { useSetlistStore } from "./setlistStore";

export const OVERVIEW_MAX_ZOOM = 32;

/** Which part of the zoomed layer is on screen, in px of the layer. Mutated
 * in place (no renders): the waveform reads it per frame and redraws only
 * the stretch around it, so a 32× zoom keeps full detail without a canvas
 * 32 screens wide. */
export type ZoomWindow = { offset: number; width: number };
export const ZoomWindowContext = createContext<ZoomWindow | null>(null);
const WHEEL_ZOOM_FACTOR = 1.25;

/** How far to slide a `zoom`× wide layer so `fraction` of it sits in the
 * middle of a `viewportWidth` window, never past its edges. */
export function followOffset(fraction: number, viewportWidth: number, zoom: number): number {
  if (zoom <= 1 || viewportWidth <= 0) return 0;
  const layerWidth = viewportWidth * zoom;
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
): number {
  if (viewportWidth <= 0) return 0;
  const fraction = (offset + anchorX) / (viewportWidth * fromZoom);
  const next = fraction * viewportWidth * toZoom - anchorX;
  return Math.max(0, Math.min(viewportWidth * toZoom - viewportWidth, next));
}

type OverviewZoomProps = {
  startSeconds: number;
  endSeconds: number;
  positionSecondsRef: { readonly current: number };
  /** Touch: a tap seeks here (the waveform's own seek is for the mouse). */
  onSeek?: (seconds: number) => void;
  /** Inside the zoomed layer: the waveform, the section blocks, the edit
   * handles. They place things in % of the song, so they stay aligned. */
  children: ReactNode;
  /** Outside the layer (they must not slide): loop / next. */
  overlay?: ReactNode;
};

const isControl = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest("button, [role='button'], .lt-setlist-section-handle"));

/**
 * The band's zoom, with the DAW's gestures on a phone (the iPhone reports):
 * pinch zooms around the fingers, one finger drags the zoomed song, a tap
 * seeks. Zoomed in, the band follows the playhead (centred) whenever it
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
  children,
  overlay,
}: OverviewZoomProps) {
  useFrameGateWake();
  const zoom = useSetlistStore((state) => state.overviewZoom);
  const setZoom = useSetlistStore((state) => state.setOverviewZoom);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Where the layer is, and whether a hand put it there.
  const offsetRef = useRef(0);
  const manualRef = useRef<{ position: number } | null>(null);
  const gestureRef = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingZoomRef = useRef<number | null>(null);
  const windowRef = useRef<ZoomWindow>({ offset: 0, width: 0 });

  const applyOffset = (offset: number) => {
    const layer = layerRef.current;
    offsetRef.current = offset;
    windowRef.current.offset = offset;
    layer?.style.setProperty("transform", offset ? `translate3d(${-offset}px, 0, 0)` : "none");
  };

  useEffect(() => {
    let frameId = 0;
    let last = Number.NaN;
    const frame = () => {
      const viewport = viewportRef.current;
      const position = positionSecondsRef.current;
      if (viewport) windowRef.current.width = viewport.clientWidth;
      if (pendingZoomRef.current !== null) {
        setZoom(pendingZoomRef.current);
        pendingZoomRef.current = null;
      }
      if (manualRef.current && manualRef.current.position !== position) manualRef.current = null;
      if (viewport && !gestureRef.current && !manualRef.current) {
        const duration = Math.max(0.001, endSeconds - startSeconds);
        const fraction = Math.max(0, Math.min(1, (position - startSeconds) / duration));
        // Fractional on purpose: the layer is composited (will-change), so the
        // GPU slides it sub-pixel. Rounding made it step a whole pixel a few
        // times a second when zoomed in, which read as low FPS (the iPhone).
        const offset = followOffset(fraction, viewport.clientWidth, zoomRef.current);
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
  }, [endSeconds, positionSecondsRef, startSeconds, zoom]);

  /** A zoom kept around `anchorX` (px in the viewport). */
  const zoomAround = (nextZoom: number, anchorX: number) => {
    const viewport = viewportRef.current;
    const clamped = Math.max(1, Math.min(OVERVIEW_MAX_ZOOM, nextZoom));
    if (!viewport) return;
    const width = viewport.clientWidth;
    const offset = anchoredOffset(offsetRef.current, anchorX, width, zoomRef.current, clamped);
    zoomRef.current = clamped;
    pendingZoomRef.current = clamped;
    const layer = layerRef.current;
    layer?.style.setProperty("width", `${clamped * 100}%`);
    applyOffset(clamped <= 1 ? 0 : offset);
    manualRef.current = { position: positionSecondsRef.current };
    markFrameActivity();
  };

  // Touch gestures, before the waveform's own pointer handling.
  const pointersRef = useRef(new Map<number, number>());
  // A pinch scales the layer with a transform (no relayout per frame: laying
  // the blocks out again at every step made every section label and edge
  // shiver). The real width is set once, when the fingers lift.
  const pinchRef = useRef<{
    distance: number;
    zoom: number;
    offset: number;
    anchor0: number;
    target: number;
    visualOffset: number;
  } | null>(null);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || isControl(event.target)) return;
    event.stopPropagation();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, event.clientX);
    if (pointers.size === 2) {
      // The second finger: the first one's listeners run the pinch.
      const [a, b] = [...pointers.values()];
      pinchRef.current = {
        distance: Math.abs(a - b),
        zoom: zoomRef.current,
        offset: offsetRef.current,
        anchor0: (a + b) / 2 - viewport.getBoundingClientRect().left,
        target: zoomRef.current,
        visualOffset: offsetRef.current,
      };
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
          const content = (pinch.offset + pinch.anchor0) / (width * pinch.zoom);
          const offset = Math.max(0, Math.min(width * target - width, content * width * target - anchorX));
          pinch.target = target;
          pinch.visualOffset = offset;
          layerRef.current?.style.setProperty(
            "transform",
            `translate3d(${-offset}px, 0, 0) scaleX(${target / pinch.zoom})`,
          );
          manualRef.current = { position: positionSecondsRef.current };
          markFrameActivity();
        }
        return;
      }
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const width = viewport.clientWidth;
      const max = Math.max(0, width * zoomRef.current - width);
      applyOffset(Math.max(0, Math.min(max, startOffset - dx)));
      manualRef.current = { position: positionSecondsRef.current };
      markFrameActivity();
    };
    const onUp = (upEvent: PointerEvent) => {
      if (!pointers.has(upEvent.pointerId)) return;
      pointers.delete(upEvent.pointerId);
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
        layerRef.current?.style.setProperty("width", `${pinch.target * 100}%`);
        applyOffset(pinch.target <= 1 ? 0 : pinch.visualOffset);
        markFrameActivity();
      }
      if (!moved && upEvent.type === "pointerup" && onSeek) {
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
      zoomAround(
        zoomRef.current * (event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR),
        event.clientX - rect.left,
      );
      return;
    }
    if (zoomRef.current <= 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    const width = viewport.clientWidth;
    const max = Math.max(0, width * zoomRef.current - width);
    applyOffset(Math.max(0, Math.min(max, offsetRef.current + delta)));
    manualRef.current = { position: positionSecondsRef.current };
    markFrameActivity();
  };
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    viewport.addEventListener("wheel", listener, { passive: false });
    return () => viewport.removeEventListener("wheel", listener);
  }, []);

  return (
    <>
      <div
        ref={viewportRef}
        className="lt-setlist-zoom-viewport"
        onPointerDownCapture={handlePointerDown}
      >
        <div
          ref={layerRef}
          className="lt-setlist-zoom-layer"
          style={{ width: `${zoom * 100}%` }}
          data-zoom={zoom}
        >
          <ZoomWindowContext.Provider value={windowRef.current}>{children}</ZoomWindowContext.Provider>
        </div>
      </div>
      {overlay}
    </>
  );
}
