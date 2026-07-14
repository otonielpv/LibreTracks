import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Minimum draggable width for the scrollbar thumb. The native webkit thumb
 * shrinks proportionally with the content width, so at high zoom it collapses
 * to a few pixels and becomes impossible to grab. A custom thumb lets us floor
 * its width here so it always stays grabbable, while still mapping its travel
 * back to the full camera range.
 */
const MIN_THUMB_WIDTH_PX = 40;

type HorizontalScrollbarProps = {
  className?: string;
  ariaLabel: string;
  /** Live camera offset in px. Read every frame so the thumb tracks wheel
   * scroll, follow-playhead, and edge auto-scroll without re-rendering. */
  cameraXRef: MutableRefObject<number>;
  /** Maximum camera offset (content width − viewport width). */
  maxCameraX: number;
  /** Seek the camera to an absolute offset; the parent clamps + commits. */
  onScrollTo: (cameraX: number) => void;
};

/**
 * Custom horizontal scrollbar for the timeline. Replaces the native webkit
 * scrollbar so the thumb can keep a usable minimum width at extreme zoom.
 */
export function HorizontalScrollbar({
  className,
  ariaLabel,
  cameraXRef,
  maxCameraX,
  onScrollTo,
}: HorizontalScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  // Latest geometry, read inside the rAF loop and the drag handler without
  // re-subscribing them on every render.
  const geometryRef = useRef({ trackWidth, maxCameraX });
  geometryRef.current = { trackWidth, maxCameraX };

  // Measure the track width and keep it current across panel/splitter resizes.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const next = track.clientWidth;
      if (next > 0) {
        setTrackWidth((prev) => (prev === next ? prev : next));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const computeThumb = useCallback((cameraX: number) => {
    const { trackWidth: width, maxCameraX: max } = geometryRef.current;
    const contentWidth = width + max;
    if (width <= 0 || contentWidth <= 0) {
      return { width: width, left: 0 };
    }
    const rawWidth = (width * width) / contentWidth;
    const thumbWidth = Math.min(width, Math.max(MIN_THUMB_WIDTH_PX, rawWidth));
    const travel = width - thumbWidth;
    const left = max > 0 ? (cameraX / max) * travel : 0;
    return { width: thumbWidth, left };
  }, []);

  // Drive the thumb from the live camera ref every frame so it follows scroll
  // sources that don't re-render this component (wheel, follow-playhead, edge
  // auto-scroll, debounced store commits).
  useEffect(() => {
    let frameId = 0;
    let lastWidth = -1;
    let lastLeft = -1;
    const render = () => {
      const thumb = thumbRef.current;
      if (thumb) {
        const { width, left } = computeThumb(cameraXRef.current);
        if (width !== lastWidth) {
          thumb.style.width = `${width}px`;
          lastWidth = width;
        }
        if (left !== lastLeft) {
          thumb.style.transform = `translate3d(${left}px, 0, 0)`;
          lastLeft = left;
        }
      }
      frameId = window.requestAnimationFrame(render);
    };
    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, [cameraXRef, computeThumb]);

  // Map a track-relative pointer X to a camera offset, centring the thumb on
  // the pointer (used both for thumb drag and track click-to-page).
  const cameraXForPointer = useCallback(
    (pointerTrackX: number) => {
      const { trackWidth: width, maxCameraX: max } = geometryRef.current;
      if (max <= 0) return 0;
      const { width: thumbWidth } = computeThumb(cameraXRef.current);
      const travel = width - thumbWidth;
      if (travel <= 0) return 0;
      const clampedLeft = Math.max(
        0,
        Math.min(pointerTrackX - thumbWidth / 2, travel),
      );
      return (clampedLeft / travel) * max;
    },
    [cameraXRef, computeThumb],
  );

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const track = trackRef.current;
    if (!track) return;

    const trackBounds = track.getBoundingClientRect();
    const { width: thumbWidth, left: thumbLeft } = computeThumb(
      cameraXRef.current,
    );
    // Offset of the pointer within the thumb, so the thumb doesn't jump under
    // the cursor when the drag starts.
    const grabOffset = event.clientX - (trackBounds.left + thumbLeft);

    const onMove = (moveEvent: PointerEvent) => {
      const pointerTrackX =
        moveEvent.clientX - trackBounds.left - grabOffset + thumbWidth / 2;
      onScrollTo(cameraXForPointer(pointerTrackX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Ignore presses that land on the thumb — its own handler runs first.
    if (event.target === thumbRef.current) return;
    const track = trackRef.current;
    if (!track) return;
    const trackBounds = track.getBoundingClientRect();
    onScrollTo(cameraXForPointer(event.clientX - trackBounds.left));
  };

  const interactive = maxCameraX > 0;

  return (
    <div
      ref={trackRef}
      className={`lt-horizontal-scrollbar-track ${className ?? ""}`}
      role="scrollbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-hidden={!interactive}
      onPointerDown={interactive ? handleTrackPointerDown : undefined}
    >
      <div
        ref={thumbRef}
        className="lt-horizontal-scrollbar-thumb"
        style={{ visibility: interactive ? "visible" : "hidden" }}
        onPointerDown={interactive ? handleThumbPointerDown : undefined}
      />
    </div>
  );
}
