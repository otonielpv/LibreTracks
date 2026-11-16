import type { ClipSummary, TransportSnapshot } from "@libretracks/shared/models";
import {
  clientXToLocalX,
  clientYToLocalY,
  getElementScaleX,
  getElementScaleY,
  secondsToScreenX,
} from "@libretracks/shared/timelineMath";

import { updateClipFades } from "../desktopApi";
import {
  applyClipCurveDrag,
  applyClipFadeDrag,
  clipFadesOf,
  clipSourceDuration,
  clipViewScale,
  sameCurve,
  type ClipFades,
  type FadeCurve,
} from "./clipFadeMath";
import {
  markClipFadePreviewCommitted,
  setClipFadePreview,
} from "./clipFadeCanvasState";
import {
  CLIP_FADE_HANDLE_MIN_CLIP_WIDTH,
  clipFadeCurveHandles,
  clipFadeGeometry,
  clipFadeHandleXs,
} from "./drawClipFades";

/**
 * How far from a handle still grabs it, in CSS px: `slopX` either side of a
 * length handle, `bandY` down from the clip's top edge, `curveRadius` around
 * a curve handle. A finger covers ~40 px, so touch gets a much bigger target
 * than the few pixels the mouse aims at.
 */
export type ClipFadeHitSlop = { slopX: number; bandY: number; curveRadius: number };
export const MOUSE_HIT_SLOP: ClipFadeHitSlop = { slopX: 8, bandY: 12, curveRadius: 7 };
export const TOUCH_HIT_SLOP: ClipFadeHitSlop = { slopX: 22, bandY: 34, curveRadius: 22 };
const DRAG_THRESHOLD_PX = 2;
/** A finger wobbles more than a mouse before it means to drag. */
const TOUCH_DRAG_THRESHOLD_PX = 6;

/** `length`: the corner square, dragged sideways. `curve`: the dot on the
 * fade, dragged in any direction to shape it. */
export type ClipFadeHandleKind = "length" | "curve";
export type ClipFadeHandleHit = {
  clip: ClipSummary;
  edge: "in" | "out";
  kind: ClipFadeHandleKind;
};

/** Curve handles are only drawn (and grabbed) on selected clips. */
export type ClipFadeCurveHitOptions = { laneHeight: number; selectedIds: ReadonlySet<string> };

function isTouchPointer(event: unknown): boolean {
  return (event as { pointerType?: string } | null)?.pointerType === "touch";
}

/**
 * The fade handle under a point of a lane, if any. `localX`/`localY` are in
 * the lane's CSS px; the clips are laid out exactly like the canvas paints
 * them (`clipFadeGeometry`), so what you see is what you grab. A curve handle
 * wins over a length handle when both are in reach.
 */
export function hitClipFadeHandle(
  clips: ClipSummary[],
  localX: number,
  localY: number,
  cameraX: number,
  pixelsPerSecond: number,
  slop: ClipFadeHitSlop = MOUSE_HIT_SLOP,
  curves?: ClipFadeCurveHitOptions,
): ClipFadeHandleHit | null {
  if (pixelsPerSecond <= 0) return null;
  let best: (ClipFadeHandleHit & { distance: number }) | null = null;
  for (const clip of clips) {
    const left = secondsToScreenX(clip.timelineStartSeconds, cameraX, pixelsPerSecond);
    const width = clip.durationSeconds * pixelsPerSecond;
    if (width < CLIP_FADE_HANDLE_MIN_CLIP_WIDTH) continue;
    const reach = Math.max(slop.slopX, slop.curveRadius);
    if (localX < left - reach || localX > left + width + reach) continue;
    const geometry = clipFadeGeometry(clip, left, width, pixelsPerSecond);

    if (curves && curves.laneHeight > 0 && curves.selectedIds.has(clip.id)) {
      const points = clipFadeCurveHandles(geometry, 0, curves.laneHeight);
      for (const [edge, point] of [["in", points.in], ["out", points.out]] as const) {
        if (!point) continue;
        const distance = Math.hypot(localX - point.x, localY - point.y);
        if (distance <= slop.curveRadius) {
          // Curve first: its dot sits inside the band the squares reach.
          const score = distance - 1000;
          if (!best || score < best.distance) best = { clip, edge, kind: "curve", distance: score };
        }
      }
    }

    if (localY < 0 || localY > slop.bandY) continue;
    const { inX, outX } = clipFadeHandleXs(geometry);
    for (const [edge, x] of [["in", inX], ["out", outX]] as const) {
      const distance = Math.abs(localX - x);
      if (distance <= slop.slopX && (!best || distance < best.distance)) {
        best = { clip, edge, kind: "length", distance };
      }
    }
  }
  return best ? { clip: best.clip, edge: best.edge, kind: best.kind } : null;
}

export type ClipFadeDragDeps = {
  getCameraX: () => number;
  getPixelsPerSecond: () => number;
  runAction: (action: () => Promise<void>) => Promise<unknown>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  /** A press on a handle that never moved selects the clip, like a click. */
  selectClip: (clipId: string, trackId: string) => void;
  /**
   * The selected clips, from every track. Dragging a handle of one of them
   * gives all of them that fade, like the menu's «Fades ▸» does. With a finger
   * only these handles are grabbed: the touch rule is select first, then drag.
   */
  getSelectedClips: () => ClipSummary[];
  /** Overridable in tests. */
  updateFades?: typeof updateClipFades;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
};

type DragMember = { clip: ClipSummary; base: ClipFades };

type DragState = {
  /** The clip whose handle is under the pointer: the drag measures on it. */
  primary: DragMember;
  /** Every clip the drag edits, `primary` included. */
  members: DragMember[];
  edge: "in" | "out";
  kind: ClipFadeHandleKind;
  /** The dragged fade length in source seconds (length handle). */
  length: number | null;
  /** The dragged control point (curve handle). Both stay null until the
   * pointer moves past the threshold. */
  curve: FadeCurve | null;
  /** Size of the primary clip's fade on screen when the drag began: the
   * curve handle's movement is measured in that box. */
  fadeWidthPx: number;
  laneHeightPx: number;
  startClientX: number;
  startClientY: number;
  scaleX: number;
  scaleY: number;
  threshold: number;
  moved: boolean;
};

/** `member` with the dragged edge's length set to `value` and the other fade
 * pushed back if they would overlap (the backend applies the same rule). */
export function withFadeEdge(member: DragMember, edge: "in" | "out", value: number): ClipFades {
  const duration = clipSourceDuration(member.clip);
  const fade = Math.min(Math.max(0, value), duration);
  return edge === "in"
    ? {
        ...member.base,
        fadeInSeconds: fade,
        fadeOutSeconds: Math.min(member.base.fadeOutSeconds, duration - fade),
      }
    : {
        ...member.base,
        fadeInSeconds: Math.min(member.base.fadeInSeconds, duration - fade),
        fadeOutSeconds: fade,
      };
}

function withCurve(member: DragMember, edge: "in" | "out", curve: FadeCurve): ClipFades {
  return edge === "in"
    ? { ...member.base, fadeInCurve: curve }
    : { ...member.base, fadeOutCurve: curve };
}

const lengthOf = (fades: ClipFades, edge: "in" | "out") =>
  edge === "in" ? fades.fadeInSeconds : fades.fadeOutSeconds;
const curveOf = (fades: ClipFades, edge: "in" | "out") =>
  edge === "in" ? fades.fadeInCurve : fades.fadeOutCurve;

/**
 * Dragging a clip's fade handles on the timeline lanes.
 *
 * Instantiated once (`useMemo`) and only invoked by the transport panel: the
 * lane's pointer-down asks `tryBegin` first, and when a handle is under the
 * pointer the gesture is ours and the clip move never starts. The drag lives
 * in module state (the canvas preview), never in React state, and commits ONE
 * `update_clip_fades` on release, for one clip or the whole selection.
 */
export function createClipFadeDrag(deps: ClipFadeDragDeps) {
  const updateFades = deps.updateFades ?? updateClipFades;
  const target = deps.target ?? window;
  let drag: DragState | null = null;

  const clearPreviews = (members: DragMember[]) => {
    for (const member of members) setClipFadePreview(member.clip.id, null);
  };

  /** What `member` looks like with the drag's current value, or null before
   * the pointer has moved. */
  const preview = (member: DragMember, state: DragState): ClipFades | null => {
    if (state.kind === "curve") return state.curve ? withCurve(member, state.edge, state.curve) : null;
    return state.length !== null ? withFadeEdge(member, state.edge, state.length) : null;
  };

  const onMove = (event: PointerEvent | MouseEvent) => {
    if (!drag) return;
    const dx = (event.clientX - drag.startClientX) / drag.scaleX;
    const dy = (event.clientY - drag.startClientY) / drag.scaleY;
    const distance = drag.kind === "curve" ? Math.hypot(dx, dy) : Math.abs(dx);
    if (!drag.moved && distance < drag.threshold) return;
    drag.moved = true;
    const { primary, edge } = drag;
    if (drag.kind === "curve") {
      // In the fade's own box: x towards full level (leftwards for a fade
      // out, which runs from the clip's end), y up.
      const towardsLevel = edge === "in" ? dx : -dx;
      drag.curve = applyClipCurveDrag(
        curveOf(primary.base, edge),
        towardsLevel / Math.max(1, drag.fadeWidthPx),
        -dy / Math.max(1, drag.laneHeightPx),
      );
    } else {
      const pps = deps.getPixelsPerSecond();
      if (pps <= 0) return;
      drag.length = lengthOf(applyClipFadeDrag(primary.clip, primary.base, edge, dx / pps), edge);
    }
    for (const member of drag.members) {
      setClipFadePreview(member.clip.id, preview(member, drag));
    }
  };

  const finish = (commit: boolean) => {
    const ended = drag;
    drag = null;
    target.removeEventListener("pointermove", onMove as EventListener);
    target.removeEventListener("pointerup", onUp as EventListener);
    target.removeEventListener("pointercancel", onCancel as EventListener);
    if (!ended) return;
    if (!ended.moved || (ended.length === null && ended.curve === null)) {
      clearPreviews(ended.members);
      // A click on a handle selects its clip, unless it belongs to a
      // selection of several: that would throw the selection away.
      if (commit && ended.members.length === 1) {
        deps.selectClip(ended.primary.clip.id, ended.primary.clip.trackId);
      }
      return;
    }
    const { edge, kind } = ended;
    const unchanged = ended.members.every((member) => {
      const after = preview(member, ended);
      if (!after) return true;
      return kind === "curve"
        ? sameCurve(curveOf(after, edge), curveOf(member.base, edge))
        : Math.abs(lengthOf(after, edge) - lengthOf(member.base, edge)) < 1e-6;
    });
    if (!commit || unchanged) {
      clearPreviews(ended.members);
      return;
    }
    for (const member of ended.members) markClipFadePreviewCommitted(member.clip.id);
    const ids = ended.members.map((member) => member.clip.id);
    void deps
      .runAction(async () => {
        const { curve, length } = ended;
        deps.applyPlaybackSnapshot(
          kind === "curve" && curve
            ? await updateFades(ids, null, null, edge === "in" ? { fadeInCurve: curve } : { fadeOutCurve: curve })
            : await updateFades(ids, edge === "in" ? length : null, edge === "out" ? length : null),
        );
      })
      .catch(() => clearPreviews(ended.members));
  };

  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  /**
   * Start a fade drag when the press lands on a handle. Returns true when it
   * did, so the caller skips its own clip move.
   */
  const tryBegin = (
    event: { clientX: number; clientY: number; preventDefault: () => void },
    lane: HTMLElement,
    clips: ClipSummary[],
  ): boolean => {
    if (drag) finish(false);
    const bounds = lane.getBoundingClientRect();
    const localX = clientXToLocalX(event.clientX, bounds, lane.offsetWidth);
    const localY = clientYToLocalY(event.clientY, bounds, lane.offsetHeight);
    const touch = isTouchPointer(event);
    const selected = deps.getSelectedClips();
    const selectedIds = new Set(selected.map((clip) => clip.id));
    const hit = hitClipFadeHandle(
      touch ? clips.filter((clip) => selectedIds.has(clip.id)) : clips,
      localX,
      localY,
      deps.getCameraX(),
      deps.getPixelsPerSecond(),
      touch ? TOUCH_HIT_SLOP : MOUSE_HIT_SLOP,
      { laneHeight: lane.offsetHeight || bounds.height, selectedIds },
    );
    if (!hit) return false;
    event.preventDefault();
    const inSelection = selectedIds.has(hit.clip.id);
    let clipsToEdit = inSelection && selected.length > 1 ? selected : [hit.clip];
    if (hit.kind === "curve") {
      // Bending a curve only means something on clips that have that fade.
      const withFade = clipsToEdit.filter((clip) =>
        (hit.edge === "in" ? clip.fadeInSeconds ?? 0 : clip.fadeOutSeconds ?? 0) > 0,
      );
      clipsToEdit = withFade.length > 0 ? withFade : [hit.clip];
    }
    const members = clipsToEdit.map((clip) => ({ clip, base: clipFadesOf(clip) }));
    const primary = members.find((member) => member.clip.id === hit.clip.id) ?? {
      clip: hit.clip,
      base: clipFadesOf(hit.clip),
    };
    const fadeSeconds = lengthOf(primary.base, hit.edge);
    drag = {
      primary,
      members,
      edge: hit.edge,
      kind: hit.kind,
      length: null,
      curve: null,
      fadeWidthPx: fadeSeconds * clipViewScale(primary.clip) * deps.getPixelsPerSecond(),
      laneHeightPx: lane.offsetHeight || bounds.height,
      startClientX: event.clientX,
      startClientY: event.clientY,
      scaleX: getElementScaleX(bounds, lane.offsetWidth),
      scaleY: getElementScaleY(bounds, lane.offsetHeight),
      threshold: touch ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX,
      moved: false,
    };
    target.addEventListener("pointermove", onMove as EventListener);
    target.addEventListener("pointerup", onUp as EventListener);
    target.addEventListener("pointercancel", onCancel as EventListener);
    return true;
  };

  return {
    tryBegin,
    isDragging: () => drag !== null,
    cancel: () => finish(false),
  };
}

export type ClipFadeDrag = ReturnType<typeof createClipFadeDrag>;

/** Lane hover: the cursor over a fade handle (sideways for a length, free
 * movement for a curve). Pure on the geometry, so TimelineCanvasPane can call
 * it without the drag instance. */
export function clipFadeCursorAt(
  event: { clientX: number; clientY: number },
  lane: HTMLElement,
  clips: ClipSummary[],
  cameraX: number,
  pixelsPerSecond: number,
  selectedIds: readonly string[] = [],
): string {
  const bounds = lane.getBoundingClientRect();
  const hit = hitClipFadeHandle(
    clips,
    clientXToLocalX(event.clientX, bounds, lane.offsetWidth),
    clientYToLocalY(event.clientY, bounds, lane.offsetHeight),
    cameraX,
    pixelsPerSecond,
    MOUSE_HIT_SLOP,
    { laneHeight: lane.offsetHeight || bounds.height, selectedIds: new Set(selectedIds) },
  );
  if (!hit) return "";
  return hit.kind === "curve" ? "move" : "ew-resize";
}

/**
 * Touch: is the finger on a fade handle of a selected clip? The timeline's
 * touch navigation asks this (with "is it on a selected clip?") BEFORE it
 * takes the gesture, because once it pans it cannot hand the finger back. The
 * touch slop reaches past the clip's edge, where the clip test alone says no.
 */
export function touchHitsSelectedClipFadeHandle(
  event: { clientX: number; clientY: number },
  lane: HTMLElement,
  clips: ClipSummary[],
  selectedIds: string[],
  cameraX: number,
  pixelsPerSecond: number,
): boolean {
  if (selectedIds.length === 0) return false;
  const selected = new Set(selectedIds);
  const bounds = lane.getBoundingClientRect();
  return (
    hitClipFadeHandle(
      clips.filter((clip) => selected.has(clip.id)),
      clientXToLocalX(event.clientX, bounds, lane.offsetWidth),
      clientYToLocalY(event.clientY, bounds, lane.offsetHeight),
      cameraX,
      pixelsPerSecond,
      TOUCH_HIT_SLOP,
      { laneHeight: lane.offsetHeight || bounds.height, selectedIds: selected },
    ) !== null
  );
}
