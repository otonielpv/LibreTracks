import { useNetworkPermissions } from "../../network/useNetworkPermissions";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  SongRegionSummary,
  SongView,
  TrackSummary,
  VideoClipSummary,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import { isMobileApp } from "../desktopApi";
import { formatMusicalPosition } from "../helpers";
import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import { useTimelineUIStore } from "../uiStore";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import { applyVideoDrag, type VideoDragMode } from "../video/useVideoClipHotspots";
import { useVideoStore } from "../video/videoStore";
import { addVideoAt } from "./addVideo";
import { resolvePointDrag, sectionAt } from "./lanes/automationLaneModel";
import { SongScrubView } from "./SongScrubView";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistVideoPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  tracks: TrackSummary[];
  layout: SetlistLayoutClass;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
  menus: Pick<TimelineMenus, "openMenu" | "trackContextMenu">;
  /** The video feature (absent: no video in this build). */
  video?: VideoLaneBindings;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The song's video clips in time order. */
export function songVideoClips(song: SongView, region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">) {
  return (song.videoClips ?? [])
    .filter((clip) => clip.timelineStartSeconds < region.endSeconds && clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds)
    .sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
}

/**
 * Edit → Video: the song's waveform (SongScrubView) with each video clip as
 * a bar where it plays, the video tracks on top (their DAW menu: rename,
 * colour, delete…) and «+ Video» at the line. Every action is the DAW's
 * video feature: clips can be moved, trimmed and faded directly on the
 * waveform; the list keeps duplicate and clip-menu actions within reach.
 */
function SetlistVideoPanelComponent({
  song,
  region,
  tracks,
  layout,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  runShortcutAction,
  menus,
  video,
}: SetlistVideoPanelProps) {
  const { canUseFiles } = useNetworkPermissions();
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<number | null>(null);
  const videoTracks = tracks.filter((track) => track.kind === "video");
  const clips = songVideoClips(song, region);
  const selectedIds = useVideoStore((state) => state.selectedVideoClipIds);
  const assets = useVideoStore((state) => state.assets);
  const readOnly = !video || video.readOnly;
  const rowOf = (id: string) => Math.max(0, videoTracks.findIndex((track) => track.id === id));
  const trackName = (id: string) => tracks.find((track) => track.id === id)?.name ?? "";

  const commitClipEdit = (
    clip: VideoClipSummary,
    mode: VideoDragMode,
    preview: ReturnType<typeof applyVideoDrag>,
  ) => {
    if (!video) return;
    if (mode === "move") {
      video.handlers.moveClip(clip.id, preview.startSeconds, null);
    } else if (mode === "trimStart" || mode === "trimEnd") {
      video.handlers.trimClip(clip.id, preview.startSeconds, preview.startSeconds + preview.durationSeconds);
    } else {
      video.handlers.setFades(clip.id, preview.fadeInSeconds, preview.fadeOutSeconds);
    }
  };

  const previewClipEdit = (
    clip: VideoClipSummary,
    mode: VideoDragMode,
    rawDeltaSeconds: number,
    pxPerSecond: number,
    snapEnabled: boolean,
  ) => {
    let deltaSeconds = rawDeltaSeconds;
    if (mode !== "fadeIn" && mode !== "fadeOut") {
      const edge = mode === "trimEnd" ? clip.timelineStartSeconds + clip.durationSeconds : clip.timelineStartSeconds;
      const snappedEdge = resolvePointDrag({
        song,
        region,
        originSeconds: edge,
        rawDeltaSeconds,
        pxPerSecond,
        snapEnabled,
      });
      deltaSeconds = snappedEdge - edge;
    }
    let preview = applyVideoDrag(
      clip,
      mode,
      deltaSeconds,
      assets.find((asset) => asset.filePath === clip.filePath)?.info.durationSeconds ?? null,
    );
    if (mode === "move") {
      preview = {
        ...preview,
        startSeconds: Math.max(
          region.startSeconds,
          Math.min(region.endSeconds - 0.05, preview.startSeconds),
        ),
      };
    }
    return preview;
  };

  const startGesture = (
    event: ReactPointerEvent<HTMLElement>,
    clip: VideoClipSummary,
    mode: VideoDragMode,
    pxPerSecond: number,
  ) => {
    if (event.button !== 0 || !video || readOnly || pxPerSecond <= 0) return;
    event.stopPropagation();
    const selected = useVideoStore.getState().selectedVideoClipIds.includes(clip.id);
    if (!selected) {
      useVideoStore.getState().selectVideoClip(clip.id, false);
      if (mode === "move" && isMobileApp) return;
    }
    event.preventDefault();

    const element = event.currentTarget.closest<HTMLElement>(".lt-setlist-scrub-video");
    if (!element) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const baseStyle = {
      left: element.style.left,
      width: element.style.width,
      fadeIn: element.style.getPropertyValue("--lt-video-fade-in"),
      fadeOut: element.style.getPropertyValue("--lt-video-fade-out"),
    };
    const restorePreview = () => {
      element.style.left = baseStyle.left;
      element.style.width = baseStyle.width;
      if (baseStyle.fadeIn) element.style.setProperty("--lt-video-fade-in", baseStyle.fadeIn);
      else element.style.removeProperty("--lt-video-fade-in");
      if (baseStyle.fadeOut) element.style.setProperty("--lt-video-fade-out", baseStyle.fadeOut);
      else element.style.removeProperty("--lt-video-fade-out");
    };
    let moved = false;
    let preview = applyVideoDrag(clip, mode, 0, null);

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      preview = previewClipEdit(
        clip,
        mode,
        dx / pxPerSecond,
        pxPerSecond,
        useTimelineUIStore.getState().snapEnabled && !moveEvent.shiftKey,
      );
      element.style.left = `${(preview.startSeconds - region.startSeconds) * pxPerSecond}px`;
      element.style.width = `${Math.max(24, preview.durationSeconds * pxPerSecond)}px`;
      element.style.setProperty("--lt-video-fade-in", `${preview.fadeInSeconds * pxPerSecond}px`);
      element.style.setProperty("--lt-video-fade-out", `${preview.fadeOutSeconds * pxPerSecond}px`);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      detach();
      if (!moved) {
        restorePreview();
        return;
      }
      commitClipEdit(clip, mode, preview);
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = window.setTimeout(() => {
        restorePreview();
        fallbackRef.current = null;
      }, 350);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      detach();
      restorePreview();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const nudgeClip = (
    event: ReactKeyboardEvent<HTMLElement>,
    clip: VideoClipSummary,
    mode: VideoDragMode,
    pxPerSecond: number,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 1 : 0.25;
    const preview = previewClipEdit(
      clip,
      mode,
      (event.key === "ArrowRight" ? 1 : -1) * step,
      pxPerSecond,
      useTimelineUIStore.getState().snapEnabled,
    );
    commitClipEdit(clip, mode, preview);
  };

  useLayoutEffect(() => {
    if (fallbackRef.current !== null) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    const clipById = new Map((song.videoClips ?? []).map((clip) => [clip.id, clip]));
    rootRef.current?.querySelectorAll<HTMLElement>("[data-video-clip-id]").forEach((element) => {
      const clip = clipById.get(element.dataset.videoClipId ?? "");
      const pxPerSecond = Number(element.dataset.pxPerSecond);
      if (!clip || !Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return;
      element.style.left = `${(clip.timelineStartSeconds - region.startSeconds) * pxPerSecond}px`;
      element.style.width = `${Math.max(24, clip.durationSeconds * pxPerSecond)}px`;
      element.style.setProperty("--lt-video-fade-in", `${(clip.fadeInSeconds ?? 0) * pxPerSecond}px`);
      element.style.setProperty("--lt-video-fade-out", `${(clip.fadeOutSeconds ?? 0) * pxPerSecond}px`);
    });
  }, [region.startSeconds, song.videoClips]);

  useEffect(
    () => () => {
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
    },
    [],
  );

  const selectClip = (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => {
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    useVideoStore.getState().selectVideoClip(clip.id, additive);
    if (!additive) useTimelineUIStore.setState({ selectedClipId: null, selectedClipIds: [] });
  };

  const openClipMenu = (event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.includes(clip.id)) useVideoStore.getState().selectVideoClip(clip.id, false);
    video?.onContextMenu(event, clip);
  };

  const add = (event: ReactMouseEvent<HTMLElement>, seconds: number) => {
    if (!video) return;
    if (!isMobileApp) {
      addVideoAt(video, tracks, seconds);
      return;
    }
    menus.openMenu(event, t("setlistView.video.add"), [
      { label: t("transport.video.addFromGallery"), onSelect: () => addVideoAt(video, tracks, seconds, { source: "gallery" }) },
      { label: t("transport.video.addFromFiles"), onSelect: () => addVideoAt(video, tracks, seconds, { source: "files" }) },
    ]);
  };

  const bar = (clip: VideoClipSummary, x: number, width: number, pxPerSecond: number) => {
    const selected = selectedIds.includes(clip.id);
    const name = fileName(clip.filePath);
    const handle = (mode: VideoDragMode, className: string, labelKey: string) => (
      <button
        key={mode}
        type="button"
        className={`lt-setlist-scrub-video-handle ${className}`}
        aria-label={t(labelKey, { name })}
        title={t(labelKey, { name })}
        onPointerDown={(event) => startGesture(event, clip, mode, pxPerSecond)}
        onKeyDown={(event) => nudgeClip(event, clip, mode, pxPerSecond)}
      />
    );

    return (
      <div
      key={clip.id}
        className={`lt-setlist-scrub-video${selected ? " is-selected" : ""}${clip.isMissing ? " is-missing" : ""}`}
        data-video-clip-id={clip.id}
        data-px-per-second={pxPerSecond}
        role="group"
        aria-label={`${trackName(clip.trackId)}: ${name}`}
        style={{
          left: `${x}px`,
          width: `${Math.max(24, width)}px`,
          "--lt-video-row": rowOf(clip.trackId),
          "--lt-video-fade-in": `${(clip.fadeInSeconds ?? 0) * pxPerSecond}px`,
          "--lt-video-fade-out": `${(clip.fadeOutSeconds ?? 0) * pxPerSecond}px`,
        } as CSSProperties}
      >
        <button
          type="button"
          className="lt-setlist-scrub-video-body"
          aria-pressed={selected}
          aria-label={t("setlistView.video.moveClip", { name })}
          title={t("setlistView.video.moveClip", { name })}
          onPointerDown={(event) => startGesture(event, clip, "move", pxPerSecond)}
          onClick={(event) => selectClip(event, clip)}
          onContextMenu={(event) => openClipMenu(event, clip)}
        >
          <span className="lt-setlist-scrub-video-fade is-in" aria-hidden="true" />
          <span className="lt-setlist-scrub-video-fade is-out" aria-hidden="true" />
          <span className="material-symbols-outlined" aria-hidden="true">movie</span>
          <span className="lt-setlist-scrub-video-name">{name}</span>
        </button>
        {selected && !readOnly ? (
          <>
            {handle("trimStart", "is-trim-start", "setlistView.video.trimStart")}
            {handle("trimEnd", "is-trim-end", "setlistView.video.trimEnd")}
            {handle("fadeIn", "is-fade-in", "setlistView.video.fadeIn")}
            {handle("fadeOut", "is-fade-out", "setlistView.video.fadeOut")}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div ref={rootRef} className={`lt-setlist-automation lt-setlist-video is-${layout}`}>
      <div className="lt-setlist-track-bar" role="toolbar" aria-label={t("setlistView.video.tracks")}>
        {videoTracks.map((track) => (
          <span key={track.id} className="lt-setlist-track-chip">
            <span className="lt-setlist-track-chip-name" title={track.name}>{track.name}</span>
            <button
              type="button"
              className="lt-setlist-track-chip-icon material-symbols-outlined"
              aria-label={t("setlistView.sections.menu", { name: track.name })}
              title={t("setlistView.sections.menu", { name: track.name })}
              onClick={(event) => menus.openMenu(event, track.name, menus.trackContextMenu(track))}
            >
              more_vert
            </button>
          </span>
        ))}
        {video && !readOnly ? (
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("transport.video.addTrack")}
            title={t("transport.video.addTrack")}
            onClick={() => video.handlers.addVideoTrack(videoTracks.at(-1)?.id ?? null)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {videoTracks.length === 0 ? t("transport.video.addTrack") : null}
          </button>
        ) : null}
      </div>
      <SongScrubView
        song={song}
        region={region}
        waveformSummaries={waveformSummaries}
        positionSecondsRef={positionSecondsRef}
        onSeek={onSeek}
        runShortcutAction={runShortcutAction}
        overlay={({ xOf, pxPerSecond }) =>
          clips.map((clip) => bar(clip, xOf(clip.timelineStartSeconds), clip.durationSeconds * pxPerSecond, pxPerSecond))
        }
        actions={({ cursorSeconds }) =>
          readOnly || !canUseFiles ? null : (
            <button
              type="button"
              className="lt-setlist-settings-button is-primary"
              aria-haspopup={isMobileApp ? "menu" : undefined}
              aria-label={t("setlistView.video.addHere")}
              title={t("setlistView.video.addHere")}
              onClick={(event) => add(event, cursorSeconds())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">movie</span>
              {t("setlistView.video.addShort")}
            </button>
          )
        }
      />
      {video && clips.length > 0 ? <p className="lt-setlist-video-edit-hint">{t("setlistView.video.editHint")}</p> : null}
      {!video ? <p className="lt-setlist-sections-hint">{t("setlistView.video.unavailable")}</p> : null}
      {video && clips.length === 0 ? <p className="lt-setlist-sections-hint">{t("setlistView.video.empty")}</p> : null}
      <ul className="lt-setlist-automation-list" aria-label={t("setlistView.video.list")}>
        {clips.map((clip) => {
          const section = sectionAt(song, region, Math.max(region.startSeconds, clip.timelineStartSeconds));
          return (
            <li key={clip.id} className={`lt-setlist-automation-item lt-setlist-video-item${selectedIds.includes(clip.id) ? " is-selected" : ""}`}>
              <span className="material-symbols-outlined lt-setlist-video-icon" aria-hidden="true">movie</span>
              <button
                type="button"
                className="lt-setlist-automation-main"
                aria-pressed={selectedIds.includes(clip.id)}
                onClick={(event) => selectClip(event, clip)}
                onContextMenu={(event) => openClipMenu(event, clip)}
              >
                <span className="lt-setlist-automation-when">
                  <span className="lt-setlist-sections-position">{formatMusicalPosition(clip.timelineStartSeconds, song)}</span>
                  {section ? <span className="lt-setlist-automation-section">{section.name}</span> : null}
                  <span className="lt-setlist-automation-section">{trackName(clip.trackId)}</span>
                </span>
                <strong className="lt-setlist-automation-name">{fileName(clip.filePath)}</strong>
              </button>
              {video && !readOnly ? (
                <>
                  <button
                    type="button"
                    className="lt-setlist-song-button"
                    aria-label={t("setlistView.video.duplicate", { name: fileName(clip.filePath) })}
                    title={t("setlistView.video.duplicate", { name: fileName(clip.filePath) })}
                    onClick={() => video.handlers.duplicateClips([clip.id])}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
                  </button>
                  <button
                    type="button"
                    className="lt-setlist-song-button"
                    aria-label={t("setlistView.sections.menu", { name: fileName(clip.filePath) })}
                    title={t("setlistView.sections.menu", { name: fileName(clip.filePath) })}
                    onClick={(event) => openClipMenu(event, clip)}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">more_horiz</span>
                  </button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const SetlistVideoPanel = memo(SetlistVideoPanelComponent);
