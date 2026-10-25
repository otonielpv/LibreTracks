import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
  type ClipSummary,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../../constants";
import { isMobileApp, type ClipMoveRequest } from "../../desktopApi";
import { buildClipSnapAnchors } from "../../timeline/clipSnapping";
import { snapToTimelineGrid } from "../../timeline/timelineMath";
import type { ClipDragMember } from "../../types";
import { useTimelineUIStore } from "../../uiStore";
import type { SongTimeScale } from "../songTimeScale";
import type { LaneClipHandlers } from "./laneClipHandlers";
import { resolveClipDrag, resolveClipTrim } from "./laneGestures";

export type ClipGestureMode = "move" | "trimStart" | "trimEnd";

type ClipGestureSources = {
  song: SongView;
  region: SongRegionSummary;
  scale: SongTimeScale;
  clipHandlers: LaneClipHandlers;
  getPlayheadSeconds: () => number;
};

/** If a commit never brings a snapshot back, the preview is dropped. */
export const LANE_PREVIEW_FALLBACK_MS = 400;

const clipElement = (root: ParentNode, clipId: string) =>
  root.querySelector<HTMLElement>(`[data-lane-clip-id="${clipId}"]`);

/** Removes every preview the lanes wrote (transforms, trimmed geometry). */
export function clearLanePreviews(root: ParentNode | null) {
  root?.querySelectorAll<HTMLElement>("[data-lane-clip-id]").forEach((element) => {
    element.style.removeProperty("transform");
    if (element.dataset.trimPreview) {
      element.style.left = element.dataset.trimLeft ?? "";
      element.style.width = element.dataset.trimWidth ?? "";
      delete element.dataset.trimPreview;
    }
  });
  root?.querySelectorAll<HTMLElement>(".lt-setlist-lane.is-drop-target").forEach((row) => {
    row.classList.remove("is-drop-target");
  });
}

/**
 * Pointer gestures on the clips of the lanes. During the gesture only the
 * DOM moves (a transform, or the trimmed left/width); React and the backend
 * hear nothing. On release ONE command (laneClipHandlers); Esc or a pointer
 * cancel undoes the preview without any command. Touch is conservative:
 * a clip has to be selected (a tap) before a finger can drag it, so sliding
 * over the lanes stays a scroll.
 */
export function useClipGestures(rootRef: RefObject<HTMLElement | null>, sources: ClipGestureSources) {
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const fallbackRef = useRef<number | null>(null);

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: ClipSummary, mode: ClipGestureMode) => {
      if (event.button !== 0) return;
      const root = rootRef.current;
      if (!root) return;
      event.stopPropagation();
      const { song, region, scale } = sourcesRef.current;
      const ui = useTimelineUIStore.getState();
      const wasSelected = ui.selectedClipIds.includes(clip.id);
      const additive = event.ctrlKey || event.metaKey;
      // Selection first, like the DAW: Ctrl/⌘ toggles (no drag), Shift adds.
      if (mode === "move") {
        if (additive && !event.shiftKey) {
          ui.toggleClipSelection(clip.id);
          return;
        }
        if (event.shiftKey && !wasSelected) {
          ui.setSelectedClipIds([...ui.selectedClipIds, clip.id]);
        } else if (!wasSelected) {
          ui.selectClip(clip.id, clip.trackId);
        }
        if (isMobileApp && !wasSelected) return;
      }
      if (mode !== "move" && region.warpEnabled) return;

      const selected = useTimelineUIStore.getState().selectedClipIds;
      const memberClips =
        mode === "move"
          ? song.clips.filter((candidate) => selected.includes(candidate.id))
          : [clip];
      const members: ClipDragMember[] = (memberClips.length > 0 ? memberClips : [clip]).map(
        (member) => ({
          clipId: member.id,
          originSeconds: member.timelineStartSeconds,
          previewSeconds: member.timelineStartSeconds,
          originTrackId: member.trackId,
        }),
      );
      const anchors = buildClipSnapAnchors(song, members, sourcesRef.current.getPlayheadSeconds());
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const element = clipElement(root, clip.id);
      if (element) {
        element.dataset.trimLeft = element.style.left;
        element.dataset.trimWidth = element.style.width;
      }
      let moved = false;
      let delta = 0;
      let targetTrackId: string | null = null;
      let trimWindow: ReturnType<typeof resolveClipTrim> | null = null;

      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      };
      const cancel = () => {
        detach();
        clearLanePreviews(root);
      };
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - startX;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        moved = true;
        const rawDelta = scale.pxPerSecond > 0 ? dx / scale.pxPerSecond : 0;
        const snapEnabled = useTimelineUIStore.getState().snapEnabled;
        if (mode === "move") {
          delta = resolveClipDrag({
            song,
            region,
            members,
            primaryClipId: clip.id,
            rawDeltaSeconds: rawDelta,
            pxPerSecond: scale.pxPerSecond,
            snapEnabled,
            magnet: moveEvent.ctrlKey || moveEvent.metaKey,
            anchors,
          }).groupDelta;
          for (const member of members) {
            clipElement(root, member.clipId)?.style.setProperty(
              "transform",
              `translate3d(${delta * scale.pxPerSecond}px, 0, 0)`,
            );
          }
          // A single clip can change track: the lane under the pointer.
          root.querySelectorAll(".lt-setlist-lane.is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
          targetTrackId = null;
          if (members.length === 1) {
            const under = document.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
            const row = under?.closest<HTMLElement>(".lt-setlist-lane[data-lane-track-id]");
            const id = row?.dataset.laneTrackId ?? null;
            if (row && id && id !== clip.trackId && row.dataset.laneKind === "audio") {
              targetTrackId = id;
              row.classList.add("is-drop-target");
            }
          }
          return;
        }
        // Trim: the dragged edge snaps to the grid like a move would.
        const edgeSeconds =
          mode === "trimStart"
            ? clip.timelineStartSeconds + rawDelta
            : clip.timelineStartSeconds + clip.durationSeconds + rawDelta;
        const timing = getSongTempoRegionAtPosition(song, edgeSeconds);
        const snappedEdge = snapEnabled
          ? snapToTimelineGrid(
              edgeSeconds,
              timing?.bpm ?? song.bpm,
              timing?.timeSignature ?? song.timeSignature,
              1,
              scale.pxPerSecond,
              buildSongTempoRegions(song),
            )
          : edgeSeconds;
        const snappedDelta = rawDelta + (snappedEdge - edgeSeconds);
        trimWindow = resolveClipTrim(clip, mode === "trimStart" ? "start" : "end", snappedDelta, region);
        if (element) {
          element.dataset.trimPreview = "1";
          element.style.left = `${scale.secondsToPx(trimWindow.timelineStartSeconds)}px`;
          element.style.width = `${trimWindow.durationSeconds * scale.pxPerSecond}px`;
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        detach();
        if (!moved) return;
        let committed = false;
        if (mode === "move" && (Math.abs(delta) > 1e-6 || targetTrackId)) {
          const moves: ClipMoveRequest[] = members.map((member) => ({
            clipId: member.clipId,
            timelineStartSeconds: member.originSeconds + delta,
            ...(targetTrackId ? { targetTrackId } : {}),
          }));
          committed = sourcesRef.current.clipHandlers.commitMove(moves);
        } else if (mode !== "move" && trimWindow) {
          committed = sourcesRef.current.clipHandlers.commitTrim(clip.id, trimWindow);
        }
        if (!committed) {
          clearLanePreviews(root);
          return;
        }
        if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
        fallbackRef.current = window.setTimeout(() => clearLanePreviews(root), LANE_PREVIEW_FALLBACK_MS);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) cancel();
      };
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cancel();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [rootRef],
  );
}
