import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { buildSongTempoRegions } from "@libretracks/shared/models";
import type { SongView, VideoClipSummary } from "../desktopApi";
import {
  getElementScaleX,
  secondsToScreenX,
  snapToTimelineGrid,
} from "../timeline/timelineMath";
import { useTimelineUIStore } from "../uiStore";
import type { VideoClipHandlers } from "./videoClipHandlers";
import {
  getVideoClipPreview,
  setVideoClipPreview,
  type VideoClipPreview,
} from "./videoCanvasState";
import { useVideoStore } from "./videoStore";

export type VideoDragMode = "move" | "trimStart" | "trimEnd" | "fadeIn" | "fadeOut";

/** Shortest clip a trim may leave; matches MIN_VIDEO_CLIP_SECONDS in Rust. */
export const MIN_VIDEO_CLIP_SECONDS = 0.05;
const DRAG_THRESHOLD_PX = 4;

type DragState = {
  clip: VideoClipSummary;
  mode: VideoDragMode;
  pointerId: number;
  startClientX: number;
  scaleX: number;
  moved: boolean;
  targetTrackId: string;
  preview: VideoClipPreview;
};

function previewOf(clip: VideoClipSummary): VideoClipPreview {
  return {
    startSeconds: clip.timelineStartSeconds,
    durationSeconds: clip.durationSeconds,
    sourceStartSeconds: clip.sourceStartSeconds,
    fadeInSeconds: clip.fadeInSeconds ?? 0,
    fadeOutSeconds: clip.fadeOutSeconds ?? 0,
  };
}

/**
 * Pure geometry of a drag: what the clip becomes when the pointer has moved
 * `deltaSeconds` (already snapped for the edges that snap). Exported for
 * tests. `mediaDurationSeconds` bounds a right-edge trim when known.
 */
export function applyVideoDrag(
  clip: VideoClipSummary,
  mode: VideoDragMode,
  deltaSeconds: number,
  mediaDurationSeconds: number | null,
): VideoClipPreview {
  const base = previewOf(clip);
  const end = base.startSeconds + base.durationSeconds;
  // Media seconds per view second (≠ 1 under warp).
  const mediaRate = clip.sourceDurationSeconds / Math.max(1e-9, clip.durationSeconds);
  switch (mode) {
    case "move":
      return { ...base, startSeconds: Math.max(0, base.startSeconds + deltaSeconds) };
    case "trimStart": {
      // Not before the first frame, not past the end minus the minimum.
      const earliest = base.startSeconds - base.sourceStartSeconds / mediaRate;
      const start = Math.min(
        end - MIN_VIDEO_CLIP_SECONDS,
        Math.max(Math.max(0, earliest), base.startSeconds + deltaSeconds),
      );
      const duration = end - start;
      return {
        ...base,
        startSeconds: start,
        durationSeconds: duration,
        sourceStartSeconds: base.sourceStartSeconds + (start - base.startSeconds) * mediaRate,
        fadeInSeconds: Math.min(base.fadeInSeconds, duration),
        fadeOutSeconds: Math.min(base.fadeOutSeconds, Math.max(0, duration - base.fadeInSeconds)),
      };
    }
    case "trimEnd": {
      const latest =
        mediaDurationSeconds !== null
          ? base.startSeconds + (mediaDurationSeconds - base.sourceStartSeconds) / mediaRate
          : Number.POSITIVE_INFINITY;
      const newEnd = Math.max(
        base.startSeconds + MIN_VIDEO_CLIP_SECONDS,
        Math.min(latest, end + deltaSeconds),
      );
      const duration = newEnd - base.startSeconds;
      return {
        ...base,
        durationSeconds: duration,
        fadeInSeconds: Math.min(base.fadeInSeconds, duration),
        fadeOutSeconds: Math.min(base.fadeOutSeconds, Math.max(0, duration - base.fadeInSeconds)),
      };
    }
    case "fadeIn":
      return {
        ...base,
        fadeInSeconds: Math.min(
          Math.max(0, base.fadeInSeconds + deltaSeconds),
          base.durationSeconds - base.fadeOutSeconds,
        ),
      };
    case "fadeOut":
      return {
        ...base,
        fadeOutSeconds: Math.min(
          Math.max(0, base.fadeOutSeconds - deltaSeconds),
          base.durationSeconds - base.fadeInSeconds,
        ),
      };
  }
}

export type VideoHotspotDeps = {
  song: SongView | null;
  cameraXRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  snapEnabled?: boolean;
  /** Mobile: clips are shown but not editable. */
  readOnly: boolean;
  handlers: VideoClipHandlers;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => void;
};

/**
 * Hit targets for the video clips and their drags.
 *
 * Every drag lives in refs and the canvas preview registry, never in React
 * state: moving a video clip must not re-render the transport panel (paso 05,
 * C3). Placement runs on rAF because the lane area has no camera wrapper, the
 * same reason as the MIDI and automation hotspots.
 */
export function useVideoClipHotspots(deps: VideoHotspotDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const clipsRef = useRef(new Map<string, VideoClipSummary>());
  clipsRef.current = new Map((deps.song?.videoClips ?? []).map((clip) => [clip.id, clip]));
  const dragRef = useRef<DragState | null>(null);

  const register = useCallback((clipId: string, element: HTMLDivElement | null) => {
    if (element) elementsRef.current.set(clipId, element);
    else elementsRef.current.delete(clipId);
  }, []);

  useEffect(() => {
    let frame = 0;
    const last = new Map<string, string>();
    const sync = () => {
      const { cameraXRef, livePixelsPerSecondRef, pixelsPerSecond } = depsRef.current;
      const pps = livePixelsPerSecondRef.current ?? pixelsPerSecond;
      for (const [clipId, element] of elementsRef.current) {
        const clip = clipsRef.current.get(clipId);
        if (!clip) continue;
        const geometry = getVideoClipPreview(clipId) ?? previewOf(clip);
        const left = secondsToScreenX(geometry.startSeconds, cameraXRef.current, pps);
        const width = Math.max(4, geometry.durationSeconds * pps);
        const key = `${left}|${width}|${geometry.fadeInSeconds}|${geometry.fadeOutSeconds}`;
        if (last.get(clipId) === key) continue;
        last.set(clipId, key);
        element.style.left = `${left}px`;
        element.style.width = `${width}px`;
        element.style.setProperty("--lt-video-fade-in", `${geometry.fadeInSeconds * pps}px`);
        element.style.setProperty("--lt-video-fade-out", `${geometry.fadeOutSeconds * pps}px`);
      }
      frame = window.requestAnimationFrame(sync);
    };
    frame = window.requestAnimationFrame(sync);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: VideoClipSummary, mode: VideoDragMode) => {
      if (event.button !== 0 || depsRef.current.readOnly) return;
      event.stopPropagation();
      const element = elementsRef.current.get(clip.id);
      dragRef.current = {
        clip,
        mode,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        scaleX: element
          ? getElementScaleX(element.getBoundingClientRect(), element.offsetWidth)
          : 1,
        moved: false,
        targetTrackId: clip.trackId,
        preview: previewOf(clip),
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some engines refuse capture on a not-yet-hovered element.
      }
    },
    [],
  );

  const updateDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startClientX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const { song, livePixelsPerSecondRef, pixelsPerSecond, snapEnabled } = depsRef.current;
    const pps = livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (pps <= 0) return;
    let delta = (event.clientX - drag.startClientX) / drag.scaleX / pps;

    // Moves and edge trims snap the edge being dragged; Shift bypasses it.
    if (song && snapEnabled && !event.shiftKey && drag.mode !== "fadeIn" && drag.mode !== "fadeOut") {
      const edge =
        drag.mode === "trimEnd"
          ? drag.clip.timelineStartSeconds + drag.clip.durationSeconds
          : drag.clip.timelineStartSeconds;
      const snapped = snapToTimelineGrid(
        edge + delta,
        song.bpm,
        song.timeSignature,
        1,
        pps,
        buildSongTempoRegions(song),
      );
      delta = snapped - edge;
    }

    const asset = useVideoStore
      .getState()
      .assets.find((item) => item.filePath === drag.clip.filePath);
    drag.preview = applyVideoDrag(drag.clip, drag.mode, delta, asset?.info.durationSeconds ?? null);
    setVideoClipPreview(drag.clip.id, drag.preview);

    if (drag.mode === "move" && typeof document.elementFromPoint === "function") {
      const lane = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-video-lane-track-id]");
      drag.targetTrackId = lane?.dataset.videoLaneTrackId ?? drag.clip.trackId;
    }
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setVideoClipPreview(drag.clip.id, null);
    const { handlers } = depsRef.current;

    if (!drag.moved) {
      // A click: select, additively with Ctrl/Cmd/Shift (then alongside any
      // selected audio clips; a plain click selects only this clip).
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      useVideoStore.getState().selectVideoClip(drag.clip.id, additive);
      if (!additive) {
        useTimelineUIStore.setState({ selectedClipId: null, selectedClipIds: [] });
      }
      return;
    }

    const preview = drag.preview;
    switch (drag.mode) {
      case "move":
        handlers.moveClip(
          drag.clip.id,
          preview.startSeconds,
          drag.targetTrackId !== drag.clip.trackId ? drag.targetTrackId : null,
        );
        break;
      case "trimStart":
      case "trimEnd":
        handlers.trimClip(
          drag.clip.id,
          preview.startSeconds,
          preview.startSeconds + preview.durationSeconds,
        );
        break;
      case "fadeIn":
      case "fadeOut":
        handlers.setFades(drag.clip.id, preview.fadeInSeconds, preview.fadeOutSeconds);
        break;
    }
  }, []);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => {
      event.preventDefault();
      event.stopPropagation();
      if (!useVideoStore.getState().selectedVideoClipIds.includes(clip.id)) {
        useVideoStore.getState().selectVideoClip(clip.id, false);
      }
      depsRef.current.onContextMenu?.(event, clip);
    },
    [],
  );

  return { register, beginDrag, updateDrag, endDrag, openContextMenu, readOnly: deps.readOnly };
}

export type VideoClipHotspotController = ReturnType<typeof useVideoClipHotspots>;
