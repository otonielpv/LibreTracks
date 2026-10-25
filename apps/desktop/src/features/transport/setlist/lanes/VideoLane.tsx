import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { VideoClipSummary } from "@libretracks/shared/models";

import { DRAG_THRESHOLD_PX } from "../../constants";
import { isMobileApp } from "../../desktopApi";
import { cancelGatedFrame, requestGatedFrame } from "../../frameGate";
import { useTimelineUIStore } from "../../uiStore";
import { applyVideoDrag, type VideoDragMode } from "../../video/useVideoClipHotspots";
import { getThumbnailStrip, thumbnailIndexForMediaTime } from "../../video/videoCanvasState";
import { useVideoStore } from "../../video/videoStore";
import { resolvePointDrag } from "./automationLaneModel";
import type { SongLaneRenderProps, SongLaneType } from "./laneTypes";
import { LANE_PREVIEW_FALLBACK_MS } from "./useClipGestures";

export const VIDEO_LANE_HEIGHT = 64;
/** A clip never starts ON the song end: it would belong to the next song. */
const SONG_END_MARGIN_SECONDS = 0.05;

/**
 * The clip's thumbnails, drawn from the strips the video feature already
 * loaded for the session (useVideoThumbnails, run once by useVideoFeature):
 * nothing is requested here, so changing the zoom never asks again. Until
 * the strip arrives the clip shows stripes; it is drawn again when it does.
 */
function VideoClipThumbnails({ clip, widthPx, heightPx }: { clip: VideoClipSummary; widthPx: number; heightPx: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frameId = 0;
    let disposed = false;
    const loading: HTMLImageElement[] = [];
    const draw = () => {
      if (disposed) return;
      const width = Math.max(1, Math.round(widthPx));
      const height = Math.max(1, Math.round(heightPx));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext?.("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      const strip = clip.isMissing ? null : getThumbnailStrip(clip.filePath);
      if (!strip || strip.images.length === 0 || strip.height <= 0) {
        context.strokeStyle = "rgba(255, 255, 255, 0.07)";
        context.lineWidth = 6;
        for (let x = -height; x < width; x += 14) {
          context.beginPath();
          context.moveTo(x, height);
          context.lineTo(x + height, 0);
          context.stroke();
        }
        // The strip may still be on its way: look again on the next frames.
        if (!clip.isMissing) frameId = requestGatedFrame(draw);
        return;
      }
      const tileWidth = Math.max(8, (height * strip.width) / strip.height);
      for (let x = 0; x < width; x += tileWidth) {
        const media = clip.sourceStartSeconds + (x / width) * clip.sourceDurationSeconds;
        const image = strip.images[thumbnailIndexForMediaTime(media, strip.intervalSeconds, strip.images.length)];
        if (image?.complete && image.naturalWidth > 0) {
          context.drawImage(image, x, 0, tileWidth, height);
        } else if (image && !loading.includes(image)) {
          loading.push(image);
          image.addEventListener("load", draw, { once: true });
        }
      }
    };
    draw();
    return () => {
      disposed = true;
      cancelGatedFrame(frameId);
      for (const image of loading) image.removeEventListener("load", draw);
    };
  }, [clip.filePath, clip.isMissing, clip.sourceDurationSeconds, clip.sourceStartSeconds, heightPx, widthPx]);
  return <canvas ref={canvasRef} className="lt-setlist-video-thumbs" aria-hidden="true" />;
}

const clearVideoPreviews = (root: ParentNode | null) => {
  root?.querySelectorAll<HTMLElement>("[data-lane-video-clip-id]").forEach((element) => {
    element.style.removeProperty("transform");
    if (element.dataset.trimLeft !== undefined) {
      element.style.left = element.dataset.trimLeft;
      element.style.width = element.dataset.trimWidth ?? "";
      delete element.dataset.trimLeft;
      delete element.dataset.trimWidth;
    }
  });
  root?.querySelectorAll<HTMLElement>(".lt-setlist-lane.is-drop-target").forEach((row) => {
    row.classList.remove("is-drop-target");
  });
};

/**
 * A video track in Edit → Lanes: each clip of the song is a block with its
 * thumbnails on the view's time scale. Every action is the DAW's, through
 * the video feature's handlers: select like the DAW (Ctrl/Shift add),
 * dragging the body moves with one `moveClip` on release (onto another video
 * track too), dragging an edge trims with one `trimClip`, the menu is the
 * DAW's clip menu; split / duplicate / delete are the lanes toolbar's
 * shortcut actions, which already act on the video selection. Same rules as
 * the DAW's video drag (`applyVideoDrag`). Touch: a tap selects first.
 */
function VideoLaneComponent({ track, song, region, scale, video }: SongLaneRenderProps) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const selectedIds = useVideoStore((state) => state.selectedVideoClipIds);
  const assets = useVideoStore((state) => state.assets);
  const readOnly = !video || video.readOnly;
  const clips = (song.videoClips ?? []).filter(
    (clip) =>
      clip.trackId === track.id &&
      clip.timelineStartSeconds < region.endSeconds &&
      clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds,
  );
  useLayoutEffect(
    () => clearVideoPreviews(laneRef.current?.closest(".lt-setlist-lanes") ?? null),
    [song.videoClips],
  );

  const startGesture = (event: ReactPointerEvent<HTMLElement>, clip: VideoClipSummary, mode: VideoDragMode) => {
    if (event.button !== 0 || !video) return;
    event.stopPropagation();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const wasSelected = useVideoStore.getState().selectedVideoClipIds.includes(clip.id);
    if (mode === "move") {
      if (additive) {
        useVideoStore.getState().selectVideoClip(clip.id, true);
        return;
      }
      if (!wasSelected) {
        useVideoStore.getState().selectVideoClip(clip.id, false);
        useTimelineUIStore.setState({ selectedClipId: null, selectedClipIds: [] });
      }
      if (isMobileApp && !wasSelected) return;
    }
    if (readOnly) return;
    const element = (event.currentTarget.closest("[data-lane-video-clip-id]") as HTMLElement | null) ?? event.currentTarget;
    const root = element.closest(".lt-setlist-lanes");
    element.dataset.trimLeft = element.style.left;
    element.dataset.trimWidth = element.style.width;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const mediaDuration =
      assets.find((asset) => asset.filePath === clip.filePath)?.info.durationSeconds ?? null;
    let moved = false;
    let preview = applyVideoDrag(clip, mode, 0, mediaDuration);
    let targetTrackId: string | null = null;

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const cancel = () => {
      detach();
      clearVideoPreviews(root);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const raw = scale.pxPerSecond > 0 ? dx / scale.pxPerSecond : 0;
      // The edge being dragged snaps to the grid, like the DAW.
      const edge =
        mode === "trimEnd" ? clip.timelineStartSeconds + clip.durationSeconds : clip.timelineStartSeconds;
      const snappedEdge = resolvePointDrag({
        song,
        region: { startSeconds: region.startSeconds, endSeconds: Number.POSITIVE_INFINITY },
        originSeconds: edge,
        rawDeltaSeconds: raw,
        pxPerSecond: scale.pxPerSecond,
        snapEnabled: useTimelineUIStore.getState().snapEnabled,
      });
      preview = applyVideoDrag(clip, mode, snappedEdge - edge, mediaDuration);
      if (mode === "move") {
        const start = Math.max(
          region.startSeconds,
          Math.min(region.endSeconds - SONG_END_MARGIN_SECONDS, preview.startSeconds),
        );
        preview = { ...preview, startSeconds: start };
        element.style.setProperty(
          "transform",
          `translate3d(${(start - clip.timelineStartSeconds) * scale.pxPerSecond}px, 0, 0)`,
        );
        root?.querySelectorAll(".lt-setlist-lane.is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
        targetTrackId = null;
        const under = document.elementFromPoint?.(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
        const row = under?.closest<HTMLElement>(".lt-setlist-lane[data-lane-track-id]");
        const id = row?.dataset.laneTrackId ?? null;
        if (row && id && id !== clip.trackId && row.dataset.laneKind === "video") {
          targetTrackId = id;
          row.classList.add("is-drop-target");
        }
        return;
      }
      element.style.left = `${scale.secondsToPx(preview.startSeconds)}px`;
      element.style.width = `${Math.max(2, preview.durationSeconds * scale.pxPerSecond)}px`;
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      detach();
      if (!moved) {
        clearVideoPreviews(root);
        return;
      }
      if (mode === "move") {
        if (Math.abs(preview.startSeconds - clip.timelineStartSeconds) < 1e-6 && !targetTrackId) {
          clearVideoPreviews(root);
          return;
        }
        video.handlers.moveClip(clip.id, preview.startSeconds, targetTrackId);
      } else {
        video.handlers.trimClip(clip.id, preview.startSeconds, preview.startSeconds + preview.durationSeconds);
      }
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = window.setTimeout(() => clearVideoPreviews(root), LANE_PREVIEW_FALLBACK_MS);
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
  };

  return (
    <div ref={laneRef} className="lt-setlist-lane is-video" data-lane-track-id={track.id} data-lane-kind="video">
      {clips.map((clip) => {
        const left = scale.secondsToPx(clip.timelineStartSeconds);
        const width = Math.max(2, clip.durationSeconds * scale.pxPerSecond);
        if (left + width < -40 || left > scale.widthPx + 40) return null;
        const name = clip.filePath.split(/[\\/]/).pop() ?? clip.id;
        const selected = selectedIds.includes(clip.id);
        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={0}
            className={`lt-setlist-video-clip${selected ? " is-selected" : ""}${clip.isMissing ? " is-missing" : ""}`}
            data-lane-video-clip-id={clip.id}
            style={
              {
                left: `${left}px`,
                width: `${width}px`,
                ...(clip.color ? { "--lt-video-clip-color": clip.color } : {}),
              } as CSSProperties
            }
            aria-label={name}
            aria-pressed={selected}
            title={name}
            onPointerDown={(event) => startGesture(event, clip, "move")}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!useVideoStore.getState().selectedVideoClipIds.includes(clip.id)) {
                useVideoStore.getState().selectVideoClip(clip.id, false);
              }
              video?.onContextMenu(event, clip);
            }}
          >
            <VideoClipThumbnails clip={clip} widthPx={width} heightPx={VIDEO_LANE_HEIGHT - 22} />
            <span className="lt-setlist-video-clip-name">{name}</span>
            {readOnly ? null : (
              <>
                <span
                  className="lt-setlist-lane-trim is-start"
                  aria-hidden="true"
                  onPointerDown={(event) => startGesture(event, clip, "trimStart")}
                />
                <span
                  className="lt-setlist-lane-trim is-end"
                  aria-hidden="true"
                  onPointerDown={(event) => startGesture(event, clip, "trimEnd")}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const VideoLane = memo(VideoLaneComponent);

function VideoLaneHeaderComponent({ track }: SongLaneRenderProps) {
  const { t } = useTranslation();
  return (
    <>
      <span className="material-symbols-outlined lt-setlist-lane-kind-icon" aria-hidden="true">movie</span>
      <strong className="lt-setlist-lane-name" title={t("setlistView.video.trackTitle", { name: track.name })}>
        {track.name}
      </strong>
    </>
  );
}

export const VideoLaneHeader = memo(VideoLaneHeaderComponent);

export const videoLaneType: SongLaneType = {
  kind: "video",
  rowHeight: VIDEO_LANE_HEIGHT,
  accepts: (track) => track.kind === "video",
  showEmpty: true,
  render: (props) => <VideoLane {...props} />,
  renderHeader: (props) => <VideoLaneHeader {...props} />,
};
