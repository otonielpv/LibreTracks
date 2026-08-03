import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  getElementScaleX,
  screenXToSeconds,
  secondsToScreenX,
  snapToTimelineGrid,
} from "../timeline/timelineMath";
import { buildSongTempoRegions } from "@libretracks/shared/models";
import type { MidiClipSummary, SongView } from "../desktopApi";

/** Position a clip is being dragged to, while the drag is in flight. */
export type MidiClipMovePreview = {
  clipId: string;
  startSeconds: number;
} | null;

export type MidiClipHotspotDeps = {
  clips: MidiClipSummary[] | undefined;
  cameraXRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  /** Committed zoom, used only as a fallback before the live ref is seeded. */
  pixelsPerSecond: number;
  /** Song, for the tempo grid the drag snaps to. */
  song: SongView | null;
  /** Whether grid snapping is on; Shift bypasses it either way. */
  snapEnabled?: boolean;
  /** Commit a finished drag. */
  onMoveClip: (clipId: string, timelineStartSeconds: number) => void;
};

/** Pixels the pointer must travel before a press counts as a drag, so a plain
 * click still opens the editor. Matches the marker-drag threshold. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Keeps the MIDI clip hit targets glued to the markers the canvas paints, and
 * owns their drag.
 *
 * Same problem and same solution as `useAutomationCueHotspots`: the lane area
 * has no camera/zoom wrapper, so a hotspot placed at `atSeconds *
 * pixelsPerSecond` drifts off its marker after any scroll or zoom. `cameraX`
 * and the live zoom change without re-rendering, so placement runs on rAF
 * rather than through React.
 *
 * The drag lives here rather than in `useMarkerMoveDrag` because that hook is
 * built around markers moving between the ruler's two lanes (section vs cue) —
 * a concept MIDI clips don't have.
 */
export function useMidiClipHotspots({
  clips,
  cameraXRef,
  livePixelsPerSecondRef,
  pixelsPerSecond,
  song,
  snapEnabled,
  onMoveClip,
}: MidiClipHotspotDeps) {
  const hotspotsRef = useRef(new Map<string, HTMLButtonElement>());
  const positionsRef = useRef(new Map<string, number>());
  const previewRef = useRef<MidiClipMovePreview>(null);
  const [preview, setPreview] = useState<MidiClipMovePreview>(null);
  const dragRef = useRef<{
    clipId: string;
    pointerId: number;
    pointerStartClientX: number;
    /** Where the MARKER sat when grabbed, in local px. */
    pointerStartLocalX: number;
    /** CSS-zoom factor, so a scaled UI doesn't inflate the pointer delta. */
    pointerScaleX: number;
    initialStartSeconds: number;
    moved: boolean;
  } | null>(null);
  /** Set on drop, read (and cleared) by the click that follows it. */
  const justDraggedRef = useRef(false);

  positionsRef.current = new Map(
    (clips ?? []).map((clip) => [clip.id, clip.timelineStartSeconds]),
  );

  const registerHotspot = useCallback(
    (clipId: string, element: HTMLButtonElement | null) => {
      if (element) {
        hotspotsRef.current.set(clipId, element);
      } else {
        hotspotsRef.current.delete(clipId);
      }
    },
    [],
  );

  const beginMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, clip: MidiClipSummary) => {
      if (event.button !== 0) return;
      // Anchor on the MARKER's own position, not the cursor's: the pointer may
      // land anywhere inside the 24px hotspot, and using the cursor as the
      // origin would jump the clip by that offset on the first move.
      const pointerStartLocalX = secondsToScreenX(
        clip.timelineStartSeconds,
        cameraXRef.current,
        livePixelsPerSecondRef.current ?? pixelsPerSecond,
      );
      dragRef.current = {
        clipId: clip.id,
        pointerId: event.pointerId,
        pointerStartClientX: event.clientX,
        pointerStartLocalX,
        pointerScaleX: getElementScaleX(
          event.currentTarget.getBoundingClientRect(),
          event.currentTarget.offsetWidth,
        ),
        initialStartSeconds: clip.timelineStartSeconds,
        moved: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some engines refuse capture on a not-yet-hovered element; ignore.
      }
    },
    [cameraXRef, livePixelsPerSecondRef, pixelsPerSecond],
  );

  const updateMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const effectivePixelsPerSecond =
        livePixelsPerSecondRef.current ?? pixelsPerSecond;
      if (effectivePixelsPerSecond <= 0) return;

      if (
        !drag.moved &&
        Math.abs(event.clientX - drag.pointerStartClientX) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      drag.moved = true;

      // Same resolution the automation cues use: convert the pointer's travel
      // (de-scaled by the UI zoom) from the marker's grab-time local x, against
      // the LIVE camera — so the clip keeps tracking the pointer even if the
      // timeline pans mid-drag. Feeding clientX straight to screenXToSeconds
      // ignored both the container's origin and the CSS zoom, which is what
      // made the marker land away from the cursor.
      const pointerDeltaPx =
        (event.clientX - drag.pointerStartClientX) / drag.pointerScaleX;
      const rawDelta =
        screenXToSeconds(
          drag.pointerStartLocalX + pointerDeltaPx,
          cameraXRef.current,
          effectivePixelsPerSecond,
        ) - drag.initialStartSeconds;

      let next = drag.initialStartSeconds + rawDelta;

      // Snap to the same grid the user sees; Shift bypasses it.
      if (song && snapEnabled && !event.shiftKey) {
        next = snapToTimelineGrid(
          next,
          song.bpm,
          song.timeSignature,
          1,
          effectivePixelsPerSecond,
          buildSongTempoRegions(song),
        );
      }

      previewRef.current = {
        clipId: drag.clipId,
        startSeconds: Math.max(0, next),
      };
      setPreview(previewRef.current);
    },
    [cameraXRef, livePixelsPerSecondRef, pixelsPerSecond, snapEnabled, song],
  );

  const endMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;

      const dropped = previewRef.current;
      previewRef.current = null;
      setPreview(null);

      // The click event fires AFTER pointerup, so the flag has to outlive the
      // drag record — reading dragRef in the click handler would always find
      // it already cleared and let the editor open on every drop.
      justDraggedRef.current = drag.moved;

      if (drag.moved && dropped) {
        onMoveClip(drag.clipId, dropped.startSeconds);
      }
    },
    [onMoveClip],
  );

  /** True right after a drag, so the click that follows doesn't open the
   * editor. Reading it clears it, so it only suppresses one click. */
  const consumeDragClick = useCallback(() => {
    const wasDragging = justDraggedRef.current;
    justDraggedRef.current = false;
    return wasDragging;
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    const lastLeftByClip = new Map<string, number>();

    const sync = () => {
      const cameraX = cameraXRef.current;
      const livePixelsPerSecond =
        livePixelsPerSecondRef.current ?? pixelsPerSecond;
      const inFlight = previewRef.current;

      for (const [clipId, element] of hotspotsRef.current.entries()) {
        const atSeconds =
          inFlight?.clipId === clipId
            ? inFlight.startSeconds
            : positionsRef.current.get(clipId);
        if (atSeconds === undefined) continue;

        const left = secondsToScreenX(atSeconds, cameraX, livePixelsPerSecond);
        // Only touch style when it actually changes; this runs every frame.
        if (lastLeftByClip.get(clipId) !== left) {
          element.style.left = `${left}px`;
          lastLeftByClip.set(clipId, left);
        }
      }

      animationFrameId = window.requestAnimationFrame(sync);
    };

    animationFrameId = window.requestAnimationFrame(sync);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [cameraXRef, livePixelsPerSecondRef, pixelsPerSecond]);

  // Named to match MidiClipHotspots' props so the caller can spread them.
  return {
    /** Where the drop guide should sit, or null when no drag is in flight. */
    guideSeconds: preview?.startSeconds ?? null,
    registerHotspot,
    onBeginMove: beginMove,
    onUpdateMove: updateMove,
    onEndMove: endMove,
    consumeDragClick,
    preview,
  };
}
