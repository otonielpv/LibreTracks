import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import type { TimelineRangeSelection } from "../types";

const RANGE_DRAG_THRESHOLD_PX = 4;
const RANGE_AUTO_SCROLL_EDGE_PX = 48;
const ANDROID_CONTEXT_MENU_GRACE_MS = 600;

type TimelineRangeSelectionDeps = {
  enabled: boolean;
  seekLocked: boolean;
  isAndroid: boolean;
  currentRange: TimelineRangeSelection | null;
  rulerTrackRef: RefObject<HTMLDivElement | null>;
  contextMenuOpenedAtRef: RefObject<number>;
  getCameraX: () => number;
  getSnappedSeconds: (clientX: number) => number;
  getPointerScaleX: (element: HTMLElement) => number;
  resolveAutoScrollVelocity: (distanceFromEdge: number) => number;
  previewCameraX: (cameraX: number) => void;
  prewarmPosition: (seconds: number) => void;
  clearTimelineSelection: () => void;
  setRange: (range: TimelineRangeSelection | null) => void;
  seek: (seconds: number) => void;
  announceRange: (range: TimelineRangeSelection) => void;
};

const INTERACTIVE_RULER_SELECTOR = [
  ".lt-region-hotspot",
  ".lt-marker-hotspot",
  ".lt-tempo-hotspot",
  ".lt-automation-hotspot",
  ".lt-playhead",
].join(", ");

/**
 * Owns empty-ruler range selection for both mouse and touch.
 *
 * Dependencies are read through a ref so the returned handler stays stable,
 * while every gesture snapshots the current camera, duration and callbacks.
 * The playhead's 60 fps path is untouched; React state is updated only while
 * the user is actively drawing a range.
 */
export function useTimelineRangeSelection(
  deps: TimelineRangeSelectionDeps,
) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const d = depsRef.current;
    const target = event.target;
    if (
      // Browsers with Pointer Events emit a compatibility mousedown after the
      // pointerdown. Keep onMouseDown only as a WebView/test fallback.
      (event.type === "mousedown" && typeof window.PointerEvent === "function") ||
      !d.enabled ||
      event.button !== 0 ||
      event.isPrimary === false ||
      !d.rulerTrackRef.current ||
      (target instanceof Element && target.closest(INTERACTIVE_RULER_SELECTOR)) ||
      (d.isAndroid &&
        Date.now() - d.contextMenuOpenedAtRef.current <
          ANDROID_CONTEXT_MENU_GRACE_MS)
    ) {
      return;
    }

    event.preventDefault();

    const usesPointerEvents = event.type === "pointerdown";
    const pointerId = event.pointerId;
    const moveEventName = usesPointerEvents ? "pointermove" : "mousemove";
    const upEventName = usesPointerEvents ? "pointerup" : "mouseup";
    const cancelEventName = usesPointerEvents ? "pointercancel" : null;
    const startClientX = event.clientX;
    const pressStartedAt = Date.now();
    const pointerScaleX = d.getPointerScaleX(event.currentTarget);
    const startSeconds = d.getSnappedSeconds(startClientX);
    const pressedInsideCurrentRange = Boolean(
      d.currentRange &&
        startSeconds >= d.currentRange.startSeconds &&
        startSeconds <= d.currentRange.endSeconds,
    );
    let hasMoved = false;
    let autoScrollFrameId: number | null = null;
    let autoScrollVelocity = 0;
    let latestClientX = startClientX;

    d.prewarmPosition(startSeconds);

    const stopAutoScroll = () => {
      autoScrollVelocity = 0;
      if (autoScrollFrameId !== null) {
        window.cancelAnimationFrame(autoScrollFrameId);
        autoScrollFrameId = null;
      }
    };

    const updateRange = (clientX: number) => {
      const currentSeconds = d.getSnappedSeconds(clientX);
      d.setRange({
        startSeconds: Math.min(startSeconds, currentSeconds),
        endSeconds: Math.max(startSeconds, currentSeconds),
      });
    };

    const tickAutoScroll = () => {
      if (!autoScrollVelocity) {
        autoScrollFrameId = null;
        return;
      }

      d.previewCameraX(d.getCameraX() + autoScrollVelocity);
      updateRange(latestClientX);
      autoScrollFrameId = window.requestAnimationFrame(tickAutoScroll);
    };

    const updateAutoScroll = (clientX: number) => {
      const bounds = d.rulerTrackRef.current?.getBoundingClientRect();
      if (!bounds) {
        stopAutoScroll();
        return;
      }

      const distanceToLeft = clientX - bounds.left;
      const distanceToRight = bounds.right - clientX;
      if (distanceToLeft < RANGE_AUTO_SCROLL_EDGE_PX) {
        autoScrollVelocity = -d.resolveAutoScrollVelocity(distanceToLeft);
      } else if (distanceToRight < RANGE_AUTO_SCROLL_EDGE_PX) {
        autoScrollVelocity = d.resolveAutoScrollVelocity(distanceToRight);
      } else {
        autoScrollVelocity = 0;
      }

      if (!autoScrollVelocity) {
        stopAutoScroll();
      } else if (autoScrollFrameId === null) {
        autoScrollFrameId = window.requestAnimationFrame(tickAutoScroll);
      }
    };

    const cleanup = () => {
      window.removeEventListener(moveEventName, onMove as EventListener);
      window.removeEventListener(upEventName, finishGesture as EventListener);
      if (cancelEventName) {
        window.removeEventListener(
          cancelEventName,
          finishGesture as EventListener,
        );
      }
      stopAutoScroll();
    };

    const belongsToGesture = (windowEvent: MouseEvent | PointerEvent) =>
      !usesPointerEvents ||
      (windowEvent as PointerEvent).pointerId === pointerId;

    const onMove = (rawEvent: Event) => {
      const windowEvent = rawEvent as MouseEvent | PointerEvent;
      if (!belongsToGesture(windowEvent)) return;

      const exceededThreshold =
        Math.abs((windowEvent.clientX - startClientX) / pointerScaleX) >
        RANGE_DRAG_THRESHOLD_PX;
      if (!hasMoved && !exceededThreshold) return;

      if (!hasMoved) {
        hasMoved = true;
        d.clearTimelineSelection();
      }
      latestClientX = windowEvent.clientX;
      d.prewarmPosition(d.getSnappedSeconds(windowEvent.clientX));
      updateRange(windowEvent.clientX);
      updateAutoScroll(windowEvent.clientX);
    };

    const finishGesture = (rawEvent: Event) => {
      const windowEvent = rawEvent as MouseEvent | PointerEvent;
      if (!belongsToGesture(windowEvent)) return;
      cleanup();

      if (rawEvent.type === "pointercancel") {
        if (hasMoved) d.setRange(null);
        return;
      }

      // A native Android long-press has already opened the existing context
      // menu. Do not erase the range when the same finger is released.
      if (
        d.isAndroid &&
        d.contextMenuOpenedAtRef.current >= pressStartedAt
      ) {
        return;
      }

      if (!hasMoved) {
        if (pressedInsideCurrentRange) {
          d.rulerTrackRef.current?.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: windowEvent.clientX,
              clientY: windowEvent.clientY,
            }),
          );
          return;
        }

        d.clearTimelineSelection();
        d.setRange(null);
        if (!d.seekLocked) d.seek(startSeconds);
        return;
      }

      const endSeconds = d.getSnappedSeconds(windowEvent.clientX);
      const range = {
        startSeconds: Math.min(startSeconds, endSeconds),
        endSeconds: Math.max(startSeconds, endSeconds),
      };
      d.setRange(range);
      d.announceRange(range);
    };

    window.addEventListener(moveEventName, onMove as EventListener);
    window.addEventListener(upEventName, finishGesture as EventListener);
    if (cancelEventName) {
      window.addEventListener(cancelEventName, finishGesture as EventListener);
    }
  }, []);
}
