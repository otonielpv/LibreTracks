import {
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  buildSongTempoRegions,
  markerCategory,
  type MarkerCategory,
} from "@libretracks/shared/models";
import { LANE_CUES, LANE_SECTIONS } from "../Renderer/drawBackground";
import {
  getElementScaleX,
  screenXToSeconds,
  secondsToScreenX,
  snapToTimelineGrid,
} from "./timelineMath";
import type { SongView } from "../desktopApi";

const MARKER_DRAG_THRESHOLD_PX = 4;

/**
 * Which ruler lane a pointer at `offsetY` (relative to the ruler top) is over.
 *
 * The boundary is the midpoint between the two lanes rather than either lane's
 * own edge, so the whole ruler maps to a lane and there is no dead band where a
 * drag would silently keep the old category. Above the midpoint is the cue lane
 * (it is drawn above the section lane); below it, sections.
 */
export function laneCategoryAtY(offsetY: number): MarkerCategory {
  const boundary = (LANE_CUES.top + LANE_CUES.height + LANE_SECTIONS.top) / 2;
  return offsetY < boundary ? "cue" : "section";
}

/** Vertical middle of a ruler lane, in ruler-relative pixels. */
function laneCentre(lane: { top: number; height: number }): number {
  return lane.top + lane.height / 2;
}

export type MarkerMoveKind = "marker" | "cue";

type MarkerMoveDrag = {
  markerId: string;
  // Section flags and automation-cue diamonds share this drag machinery; only
  // the commit target differs (onMarkerMoveCommit vs onAutomationCueMoveCommit).
  kind: MarkerMoveKind;
  pointerId: number;
  pointerStartClientX: number;
  pointerStartClientY: number;
  /**
   * Where the marker sat, in absolute lane screen space, when the drag began.
   * Only used for cues: they are positioned in raw screen coordinates rather
   * than inside a camera-transformed wrapper, so the drag re-derives seconds
   * from the live cameraX instead of accumulating a delta.
   */
  pointerStartLocalX: number;
  pointerScaleX: number;
  initialStartSeconds: number;
  previewStartSeconds: number;
  /** Category the marker had at grab time, and the one under the pointer now. */
  initialCategory: MarkerCategory;
  previewCategory: MarkerCategory;
  moved: boolean;
};

export type MarkerMovePreview = {
  markerId: string;
  startSeconds: number;
  /** Lane the flag should preview in — it follows the pointer across lanes. */
  category: MarkerCategory;
} | null;

export type MarkerMoveDragDeps = {
  song: SongView | null | undefined;
  snapEnabled: boolean | undefined;
  cameraXRef: MutableRefObject<number>;
  /**
   * The ruler element, used as the fixed frame of reference for which lane the
   * pointer is over. Must be the ruler itself (not a flag hotspot), since the
   * hotspots move with the drag preview.
   */
  rulerRef?: RefObject<HTMLElement | null>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  /** `category` is passed only when the drag actually changed lanes, so a plain
   * horizontal nudge never writes a category override the user didn't ask for. */
  onMarkerMoveCommit?: (
    markerId: string,
    startSeconds: number,
    category?: MarkerCategory,
  ) => void;
  onAutomationCueMoveCommit?: (cueId: string, atSeconds: number) => void;
};

/**
 * Drag a section flag or automation-cue diamond to reposition it.
 *
 * Optimistic: the hotspot follows the pointer during the drag and the backend
 * is touched once on release. Pointer events cover both mouse (desktop) and
 * touch (Android). A press that doesn't clear MARKER_DRAG_THRESHOLD_PX is left
 * to the element's own onClick, so tapping a marker still works.
 *
 * The two marker kinds live in different coordinate spaces, which is the whole
 * subtlety here. Ruler flags sit inside the ruler overlay, which CanvasTimeline
 * transforms with `translateX(-cameraX)`, so a plain pointer delta is already
 * in the right space. Cue diamonds sit in the track-lane area, which has no
 * such wrapper — the canvas paints them at an absolute screen X computed from
 * the live cameraX — so their drag has to work in that same absolute space, or
 * it desyncs from the diamond as soon as the timeline is scrolled or zoomed.
 */
export function useMarkerMoveDrag({
  song,
  snapEnabled,
  cameraXRef,
  rulerRef,
  livePixelsPerSecondRef,
  pixelsPerSecond,
  onMarkerMoveCommit,
  onAutomationCueMoveCommit,
}: MarkerMoveDragDeps) {
  const dragRef = useRef<MarkerMoveDrag | null>(null);
  // Set true the instant a drag actually moves; consumed by the marker's
  // onClick to swallow the synthetic click that follows pointer-up (the drag
  // ref is already nulled by then). Reset on the next pointerdown.
  const didDragRef = useRef(false);
  /**
   * Posición en vuelo del arrastre. Vive en un ref, no en estado, porque se
   * escribe en cada `pointermove`: medido antes del cambio, eso costaba un
   * render completo de `TimelineCanvasPane` por frame — 144/s en una pantalla
   * de 144 Hz (docs/plans/ui-performance/state/01.md).
   *
   * Lo leen, fuera de React: el bucle rAF que coloca los hotspots, el que
   * dibuja el ruler (a través del snapshot, igual que ya hacía el arrastre del
   * playhead) y las dos guías de caída.
   */
  const previewRef = useRef<MarkerMovePreview>(null);
  /**
   * Y esto SÍ es estado, a propósito: sólo cambia cuando el arrastre cruza de
   * carril, que ocurre una o dos veces por gesto, no por píxel. Es lo que
   * enciende las bandas de "Secciones / Avisos" y marca cuál recibiría la
   * marca. Separar lo continuo de lo discreto es lo que permite que lo primero
   * salga de React sin perder lo segundo.
   */
  const [previewLane, setPreviewLane] = useState<{
    markerId: string;
    category: MarkerCategory;
  } | null>(null);

  /** Escribe la posición en el ref y sincroniza el carril sólo si cambió. */
  function publishPreview(next: MarkerMovePreview) {
    previewRef.current = next;
    setPreviewLane((current) => {
      if (!next) return current === null ? current : null;
      if (
        current &&
        current.markerId === next.markerId &&
        current.category === next.category
      ) {
        return current;
      }
      return { markerId: next.markerId, category: next.category };
    });
  }

  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    markerId: string,
    startSeconds: number,
    kind: MarkerMoveKind = "marker",
  ) {
    if (event.button !== 0) return;
    didDragRef.current = false;
    const marker = song?.sectionMarkers.find(
      (candidate) => candidate.id === markerId,
    );
    const initialCategory: MarkerCategory = marker
      ? markerCategory(marker)
      : "section";
    // Derive the grab anchor from the marker's own position rather than the
    // cursor's, so the pointer may land anywhere inside the hotspot without
    // shifting the marker on the first move.
    const pointerStartLocalX = secondsToScreenX(
      startSeconds,
      cameraXRef.current,
      livePixelsPerSecondRef.current ?? pixelsPerSecond,
    );
    dragRef.current = {
      markerId,
      kind,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerStartClientY: event.clientY,
      pointerStartLocalX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: startSeconds,
      previewStartSeconds: startSeconds,
      initialCategory,
      previewCategory: initialCategory,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some engines refuse capture on a not-yet-hovered element; ignore.
    }
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const pointerDeltaPx =
      (event.clientX - drag.pointerStartClientX) / drag.pointerScaleX;

    // Cues resolve against the live camera (so they keep tracking the pointer
    // even if the timeline pans mid-drag); ruler flags use the plain delta.
    const rawDelta =
      drag.kind === "cue"
        ? screenXToSeconds(
            drag.pointerStartLocalX + pointerDeltaPx,
            cameraXRef.current,
            effectivePixelsPerSecond,
          ) - drag.initialStartSeconds
        : pointerDeltaPx / effectivePixelsPerSecond;

    // Ruler flags can also be dragged across lanes to change category. Resolve
    // the pointer's Y against the RULER, which stays put, rather than against
    // the hotspot: the hotspot is a React element whose `top` follows the
    // preview, so it shifts under the pointer as soon as the drag moves, and
    // anchoring to its grab-time rect desynced the moment a drag went
    // horizontal before going vertical.
    const pointerDeltaY = event.clientY - drag.pointerStartClientY;
    const rulerTop = rulerRef?.current?.getBoundingClientRect().top;
    const nextCategory: MarkerCategory =
      drag.kind === "cue"
        ? drag.initialCategory
        : laneCategoryAtY(
            rulerTop != null
              ? event.clientY - rulerTop
              : // No ruler to measure against (tests, or a detached node):
                // fall back to the lane the marker started in, offset by how
                // far the pointer has travelled.
                (drag.initialCategory === "cue"
                  ? laneCentre(LANE_CUES)
                  : laneCentre(LANE_SECTIONS)) + pointerDeltaY,
          );

    // Only start treating this as a drag once the pointer clears the threshold,
    // so a stationary tap/click still fires the primary action. Vertical travel
    // counts too, or dragging straight down to the other lane would never arm
    // the drag.
    if (
      !drag.moved &&
      Math.abs(event.clientX - drag.pointerStartClientX) <
        MARKER_DRAG_THRESHOLD_PX &&
      Math.abs(pointerDeltaY) < MARKER_DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    didDragRef.current = true;

    let nextStart = drag.initialStartSeconds + rawDelta;

    // Snap to the song grid (same grid the user sees). Holding Shift bypasses.
    const shouldSnap = Boolean(snapEnabled) && !event.shiftKey;
    if (shouldSnap) {
      nextStart = snapToTimelineGrid(
        nextStart,
        song.bpm,
        song.timeSignature,
        1,
        effectivePixelsPerSecond,
        buildSongTempoRegions(song),
      );
    }

    // A marker can't sit before the timeline start.
    nextStart = Math.max(0, nextStart);

    drag.previewStartSeconds = nextStart;
    drag.previewCategory = nextCategory;
    publishPreview({
      markerId: drag.markerId,
      startSeconds: nextStart,
      category: nextCategory,
    });
  }

  function end(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released — ignore.
    }

    const finalStart = drag.previewStartSeconds;
    const laneChanged =
      drag.kind !== "cue" && drag.previewCategory !== drag.initialCategory;
    // A lane change alone is worth committing even if the flag didn't move in
    // time — dropping a Chorus straight down into the cue lane is a real edit.
    const moved =
      drag.moved &&
      (Math.abs(finalStart - drag.initialStartSeconds) > 1e-6 || laneChanged);

    dragRef.current = null;
    publishPreview(null);

    if (!moved) {
      return;
    }
    if (drag.kind === "cue") {
      onAutomationCueMoveCommit?.(drag.markerId, finalStart);
    } else {
      onMarkerMoveCommit?.(
        drag.markerId,
        finalStart,
        laneChanged ? drag.previewCategory : undefined,
      );
    }
  }

  return {
    /** Carril previsualizado (discreto). La POSICIÓN no está aquí: va por
     *  `markerMovePreviewRef`, para no re-renderizar por píxel. */
    markerMovePreviewLane: previewLane,
    markerMovePreviewRef: previewRef,
    markerDidDragRef: didDragRef,
    beginMarkerMove: begin,
    updateMarkerMove: update,
    endMarkerMove: end,
  };
}
