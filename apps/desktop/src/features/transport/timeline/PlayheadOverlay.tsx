import {
  useEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { TransportSnapshot } from "../desktopApi";
import { useRenderCounter } from "../perf/useRenderCounter";
import { useTransportStore } from "../store";
import {
  clamp,
  clientXToLocalX,
  secondsToAbsoluteX,
  screenXToSeconds,
} from "./timelineMath";

function isSyncDebugAvailable() {
  if (import.meta.env.DEV) return true;
  return Boolean(
    (window as unknown as { __LT_DEBUG_BUILD?: boolean }).__LT_DEBUG_BUILD,
  );
}

type PlayheadDragState = {
  pointerId: number;
  currentSeconds: number;
} | null;

type PlayheadOverlayProps = {
  className: string;
  durationSeconds: number;
  pixelsPerSecond: number;
  livePixelsPerSecondRef?: MutableRefObject<number>;
  cameraXRef?: MutableRefObject<number>;
  dragStateRef: MutableRefObject<PlayheadDragState>;
  /**
   * The panel's visual clock, written every frame by the 60fps playhead loop
   * (see `syncLivePosition`). REQUIRED: this overlay must never extrapolate a
   * position of its own. It used to carry a private fallback extrapolator that
   * ignored `playbackRate`, so a mount without this ref would have run the
   * playhead at wall-clock speed through warped regions — a bug that only
   * appears with warp enabled. Taking the shared clock is the only mode.
   */
  positionSecondsRef: MutableRefObject<number>;
  normalizePositionSeconds?: (
    positionSeconds: number,
    options?: { allowSnap?: boolean },
  ) => number;
  onPreviewPositionChange?: (positionSeconds: number) => void;
  onSeekIntent?: (positionSeconds: number) => void;
  onSeekCommit?: (positionSeconds: number) => void | Promise<void>;
  positionBoundsRef?: MutableRefObject<HTMLDivElement | null>;
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;
  /**
   * Scroll the timeline camera by `deltaPx` while the playhead is dragged into
   * the viewport edge. Wiring this enables edge auto-scroll: dragging the
   * playhead to the left/right border pans the timeline in that direction so
   * the user can seek past the visible range without releasing. The callback
   * returns the actual camera offset after clamping so the overlay knows when
   * scrolling has bottomed out at the content bounds.
   */
  onEdgeAutoScroll?: (deltaPx: number) => number;
};

/** Distance from the viewport edge (px) at which playhead auto-scroll kicks in. */
const PLAYHEAD_EDGE_BUFFER_PX = 48;
/** Peak auto-scroll speed (px per frame) at the very edge of the viewport. */
const PLAYHEAD_MAX_SCROLL_SPEED_PX = 24;

/** Desplazamiento que convierte un toque sobre el asa en un arrastre. Por
 * debajo de esto la pulsacion es de la regla (menu contextual), no del cabezal.
 * Ver el comentario en handlePointerDown. */
const TOUCH_DRAG_THRESHOLD_PX = 6;

/**
 * Eased scroll speed for a pointer `distancePx` from the edge: zero outside the
 * buffer, ramping up quadratically as the pointer nears the border.
 */
function resolvePlayheadAutoScrollSpeed(distancePx: number) {
  if (distancePx >= PLAYHEAD_EDGE_BUFFER_PX) {
    return 0;
  }
  const intensity =
    (PLAYHEAD_EDGE_BUFFER_PX - Math.max(0, distancePx)) /
    PLAYHEAD_EDGE_BUFFER_PX;
  return Math.max(1, intensity * intensity * PLAYHEAD_MAX_SCROLL_SPEED_PX);
}

/**
 * The slice of the transport this overlay tracks. Deliberately carries NO clock
 * anchor: the position comes from `positionSecondsRef`, and holding an anchor
 * here is what let a second, subtly different extrapolator grow in this file.
 */
type PlaybackSnapshotState = {
  playbackState: TransportSnapshot["playbackState"] | "empty";
  /** While an automation jump is armed, the timeline second it fires at. The
   * visual clock must not extrapolate past this, else the playhead overshoots
   * the cue before the jump's reanchor arrives. */
  pendingJumpExecuteSeconds: number | null;
  /** The armed automation jump's destination in seconds, so the playhead can
   * snap there the instant it reaches the cue (no waiting for the reanchor). */
  pendingJumpTargetSeconds: number | null;
};

function clientXToTimelineSecondsFromCamera(
  clientX: number,
  boundsElement: Pick<HTMLElement, "getBoundingClientRect"> &
    Partial<Pick<HTMLElement, "offsetWidth">>,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const bounds = boundsElement.getBoundingClientRect();
  const viewportWidth = boundsElement.offsetWidth ?? bounds.width;
  const viewportX = clamp(
    clientXToLocalX(clientX, bounds, boundsElement.offsetWidth),
    0,
    viewportWidth,
  );
  return screenXToSeconds(viewportX, cameraX, pixelsPerSecond);
}

export function PlayheadOverlay({
  className,
  durationSeconds,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  cameraXRef,
  dragStateRef,
  positionSecondsRef,
  normalizePositionSeconds,
  onPreviewPositionChange,
  onSeekIntent,
  onSeekCommit,
  positionBoundsRef,
  scrollContainerRef,
  onEdgeAutoScroll,
}: PlayheadOverlayProps) {
  useRenderCounter("PlayheadOverlay");
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const playbackRef = useRef<PlaybackSnapshotState>({
    playbackState: "empty",
    pendingJumpExecuteSeconds: null,
    pendingJumpTargetSeconds: null,
  });
  const latestPropsRef = useRef({
    durationSeconds,
    pixelsPerSecond,
    livePixelsPerSecondRef,
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
    onSeekIntent,
    onSeekCommit,
    positionBoundsRef,
    scrollContainerRef,
    onEdgeAutoScroll,
  });
  const dragCleanupRef = useRef<(() => void) | null>(null);

  latestPropsRef.current = {
    durationSeconds,
    pixelsPerSecond,
    livePixelsPerSecondRef,
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
    onSeekIntent,
    onSeekCommit,
    positionBoundsRef,
    scrollContainerRef,
    onEdgeAutoScroll,
  };

  useEffect(() => {
    const syncPlayback = (playback: TransportSnapshot | null) => {
      playbackRef.current = {
        playbackState: playback?.playbackState ?? "empty",
        pendingJumpExecuteSeconds:
          playback?.pendingAutomationCue?.executeAtSeconds ??
          playback?.pendingMarkerJump?.executeAtSeconds ??
          null,
        pendingJumpTargetSeconds:
          playback?.pendingAutomationCue?.targetSeconds ??
          playback?.pendingMarkerJump?.targetSeconds ??
          null,
      };
    };

    syncPlayback(useTransportStore.getState().playback);

    return useTransportStore.subscribe((state) => state.playback, syncPlayback);
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    let lastTransform = "";
    let lastSyncLogMs = 0;

    const render = () => {
      const activeDrag = dragStateRef.current;
      const effectivePixelsPerSecond =
        latestPropsRef.current.livePixelsPerSecondRef?.current ??
        latestPropsRef.current.pixelsPerSecond;
      // One clock only: the panel's shared visual position, already carrying
      // playbackRate, the vamp wrap and the eased drift correction.
      let nextSeconds = activeDrag
        ? activeDrag.currentSeconds
        : clamp(
            latestPropsRef.current.positionSecondsRef.current,
            0,
            Math.max(0, latestPropsRef.current.durationSeconds),
          );

      // When the playhead reaches an armed jump, move it to the destination
      // immediately rather than waiting for the backend reanchor (which can lag
      // 80–250 ms, leaving the playhead visibly frozen at the cue). The audio
      // already jumped sample-exact; this just keeps the visual in step.
      // Both automation cues and marker/song jumps carry the resolved
      // targetSeconds → snap there; if it's missing (no song loaded when the
      // snapshot was built) freeze at the execute point so we don't overshoot.
      const execute = playbackRef.current.pendingJumpExecuteSeconds;
      const target = playbackRef.current.pendingJumpTargetSeconds;
      if (!activeDrag && execute != null && nextSeconds >= execute) {
        nextSeconds =
          target != null
            ? clamp(target, 0, Math.max(0, latestPropsRef.current.durationSeconds))
            : execute;
      }
      const absoluteX = secondsToAbsoluteX(
        nextSeconds,
        effectivePixelsPerSecond,
      );
      const cameraX = latestPropsRef.current.cameraXRef?.current ?? 0;
      const nextTransform = `translate3d(${absoluteX - cameraX}px, 0, 0)`;

      if (playheadRef.current && nextTransform !== lastTransform) {
        playheadRef.current.style.transform = nextTransform;
        lastTransform = nextTransform;
      }

      // Sync instrumentation — log what the playhead is DISPLAYING. Rate-limit
      // to 5/sec so the rAF loop doesn't flood the console.
      if (
        isSyncDebugAvailable() &&
        (window as unknown as { __LT_SYNC_DEBUG?: boolean }).__LT_SYNC_DEBUG &&
        playbackRef.current.playbackState === "playing"
      ) {
        const nowMs = performance.now();
        if (nowMs - lastSyncLogMs >= 200) {
          lastSyncLogMs = nowMs;
          // eslint-disable-next-line no-console
          console.log(
            `[PLAYHEAD_UI] wall_ms=${Date.now()} perf_ms=${nowMs.toFixed(1)} displayed_s=${nextSeconds.toFixed(4)}`,
          );
        }
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [dragStateRef]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onSeekCommit) {
      return;
    }

    const boundsElement = positionBoundsRef?.current;
    if (!boundsElement) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Latest pointer state, shared between the move handler and the
    // edge-autoscroll rAF loop (which re-evaluates the seek as the camera pans
    // even when the pointer is held still at the edge).
    let latestClientX = event.clientX;
    let latestAltKey = event.altKey;
    let autoScrollFrameId: number | null = null;

    // Resolve the current pointer X to a normalized timeline position and push
    // it to the drag state + preview/intent callbacks. Reads the live cameraX
    // each call so it stays correct while the timeline auto-scrolls.
    const applySeekAtClientX = () => {
      const activeDrag = dragStateRef.current;
      if (!activeDrag) return;
      const rawSeconds = clamp(
        clientXToTimelineSecondsFromCamera(
          latestClientX,
          boundsElement,
          latestPropsRef.current.cameraXRef?.current ??
            latestPropsRef.current.scrollContainerRef?.current?.scrollLeft ??
            0,
          latestPropsRef.current.livePixelsPerSecondRef?.current ??
            latestPropsRef.current.pixelsPerSecond,
        ),
        0,
        Math.max(0, latestPropsRef.current.durationSeconds),
      );
      // Alt held while dragging suppresses snap-to-grid for the playhead,
      // matching the convention used by clip-drag and region-resize.
      const normalizedSeconds = latestPropsRef.current.normalizePositionSeconds
        ? latestPropsRef.current.normalizePositionSeconds(rawSeconds, {
            allowSnap: !latestAltKey,
          })
        : rawSeconds;
      dragStateRef.current = {
        ...activeDrag,
        currentSeconds: normalizedSeconds,
      };
      onPreviewPositionChange?.(normalizedSeconds);
      latestPropsRef.current.onSeekIntent?.(normalizedSeconds);
    };

    const stopAutoScroll = () => {
      if (autoScrollFrameId !== null) {
        window.cancelAnimationFrame(autoScrollFrameId);
        autoScrollFrameId = null;
      }
    };

    // Pan the timeline while the pointer sits near a viewport edge, then
    // re-seek so the playhead keeps following the (now off-screen) cursor.
    const tickAutoScroll = () => {
      const edgeScroll = latestPropsRef.current.onEdgeAutoScroll;
      const bounds = boundsElement.getBoundingClientRect();
      const distanceToLeft = latestClientX - bounds.left;
      const distanceToRight = bounds.right - latestClientX;
      let velocity = 0;
      if (distanceToLeft < PLAYHEAD_EDGE_BUFFER_PX) {
        velocity = -resolvePlayheadAutoScrollSpeed(distanceToLeft);
      } else if (distanceToRight < PLAYHEAD_EDGE_BUFFER_PX) {
        velocity = resolvePlayheadAutoScrollSpeed(distanceToRight);
      }

      if (!velocity || !edgeScroll) {
        autoScrollFrameId = null;
        return;
      }

      // edgeScroll clamps to the content bounds and returns the camera offset
      // it actually landed on; an unchanged offset means we've hit the end and
      // there's nothing left to scroll, so stop spinning the loop.
      const beforeX = latestPropsRef.current.cameraXRef?.current ?? 0;
      const afterX = edgeScroll(velocity);
      applySeekAtClientX();
      if (Math.abs(afterX - beforeX) < 0.5) {
        autoScrollFrameId = null;
        return;
      }
      autoScrollFrameId = window.requestAnimationFrame(tickAutoScroll);
    };

    const maybeStartAutoScroll = () => {
      if (!latestPropsRef.current.onEdgeAutoScroll) return;
      const bounds = boundsElement.getBoundingClientRect();
      const nearEdge =
        latestClientX - bounds.left < PLAYHEAD_EDGE_BUFFER_PX ||
        bounds.right - latestClientX < PLAYHEAD_EDGE_BUFFER_PX;
      if (nearEdge) {
        if (autoScrollFrameId === null) {
          autoScrollFrameId = window.requestAnimationFrame(tickAutoScroll);
        }
      } else {
        stopAutoScroll();
      }
    };

    // Con un dedo el arrastre no empieza al tocar, sino al MOVER.
    //
    // El asa del cabezal ocupa 16px de ancho por todo el alto de la regla. Al
    // mantener pulsado ahi para crear una marca pasaba una de dos: o el dedo se
    // movia un pelo y la pulsacion larga se cancelaba (el menu no salia), o el
    // menu salia y al levantar el dedo este arrastre confirmaba su salto, que
    // cierra el menu — el "se abre y se cierra al instante". Armandolo, una
    // pulsacion sin desplazamiento no es un arrastre y la regla se queda con
    // ella. El raton conserva el arranque inmediato: ahi no hay pulsacion larga
    // que estorbe y el salto al pulsar es el gesto esperado.
    const isTouch = event.pointerType === "touch";
    const armOriginX = event.clientX;
    let armed = isTouch;

    const startDrag = () => {
      armed = false;
      dragStateRef.current = {
        pointerId: event.pointerId,
        currentSeconds: 0,
      };
      playheadRef.current?.classList.add("is-dragging");
      applySeekAtClientX();
    };

    const onPointerMove = (pointerEvent: PointerEvent) => {
      if (armed) {
        if (pointerEvent.pointerId !== event.pointerId) {
          return;
        }
        if (
          Math.abs(pointerEvent.clientX - armOriginX) <
          TOUCH_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        latestClientX = pointerEvent.clientX;
        startDrag();
        return;
      }

      const activeDrag = dragStateRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) {
        return;
      }
      latestClientX = pointerEvent.clientX;
      // Re-evaluate Alt on every move so the user can hold/release it
      // mid-drag to toggle snap behaviour live.
      latestAltKey = pointerEvent.altKey;
      applySeekAtClientX();
      maybeStartAutoScroll();
    };

    /** Suelta el gesto SIN confirmar. Es lo que corresponde a un
     * `pointercancel` (el gesto de dos dedos del timeline sintetiza uno para
     * apartar los arrastres de un dedo) y a la pulsacion larga que abre el menu
     * de la regla: ninguno de los dos debe mover el cabezal. */
    const abandonDrag = () => {
      armed = false;
      dragStateRef.current = null;
      playheadRef.current?.classList.remove("is-dragging");
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };

    const finishDrag = (pointerEvent: PointerEvent) => {
      if (armed) {
        if (pointerEvent.pointerId === event.pointerId) {
          abandonDrag();
        }
        return;
      }

      const activeDrag = dragStateRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const commitSeconds = activeDrag.currentSeconds;
      abandonDrag();
      void onSeekCommit(commitSeconds);
    };

    const cancelDrag = (pointerEvent: PointerEvent) => {
      const pointerId = armed ? event.pointerId : dragStateRef.current?.pointerId;
      if (pointerId === undefined || pointerEvent.pointerId !== pointerId) {
        return;
      }
      abandonDrag();
    };

    /** La pulsacion larga sobre la regla sintetiza un `contextmenu`; si ocurre
     * encima del asa, este arrastre debe apartarse del camino. */
    const onContextMenu = () => abandonDrag();

    const cleanup = () => {
      stopAutoScroll();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelDrag);
      window.removeEventListener("contextmenu", onContextMenu);
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("contextmenu", onContextMenu);

    if (!armed) {
      startDrag();
    }
  };

  return (
    <div
      ref={playheadRef}
      className={className}
      aria-hidden="true"
      onPointerDown={onSeekCommit ? handlePointerDown : undefined}
    />
  );
}
