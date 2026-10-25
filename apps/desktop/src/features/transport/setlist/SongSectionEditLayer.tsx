import {
  memo,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  markerCategory,
  markerColor,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { isMobileApp } from "../desktopApi";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import { useTimelineUIStore } from "../uiStore";
import type { SectionEditHandlers } from "./sectionEditHandlers";
import { snappedSectionDelta } from "./sectionEditModel";
import { createSongTimeScale } from "./songTimeScale";

type SongSectionEditLayerProps = {
  song: SongView;
  region: SongRegionSummary;
  handlers: SectionEditHandlers;
};

/** Below this, a press on a handle is a click (select), not a drag. */
const DRAG_THRESHOLD_PX = 3;
/** If a commit never brings a snapshot back (refused, failed), the preview
 * is dropped after this. */
const PREVIEW_FALLBACK_MS = 400;

/**
 * The handles of the song's sections and cues over its waveform, while
 * editing. Dragging a section's handle moves its start, which is what changes
 * the length of the sections on both sides; the handle at the end changes the
 * song's end (the last section's length). Positions come from the view's one
 * time scale (percent of the song). A drag is previewed locally with a
 * transform; on release ONE commit. The layer itself lets clicks through to
 * the waveform (double click creates, right click opens the ruler menu); only
 * the handles take the pointer. Touch: only a handle drags, a long-press on it
 * opens its menu.
 */
function SongSectionEditLayerComponent({ song, region, handlers }: SongSectionEditLayerProps) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const touchMenu = useTouchContextMenu();
  const snapEnabled = useTimelineUIStore((state) => state.snapEnabled);
  // Two narrow selectors, not selectedRulerMarkers (it builds a new array).
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);
  const selectedIds = new Set(
    selectedMarkers.length > 0
      ? selectedMarkers.filter((marker) => marker.kind === "section").map((marker) => marker.id)
      : selectedSectionId
        ? [selectedSectionId]
        : [],
  );
  const percent = createSongTimeScale({
    startSeconds: region.startSeconds,
    endSeconds: region.endSeconds,
    widthPx: 100,
  });
  // Sections and cues ("avisos") alike: both are section markers.
  const markers = song.sectionMarkers.filter(
    (marker) =>
      marker.startSeconds >= region.startSeconds && marker.startSeconds < region.endSeconds,
  );

  // A new snapshot puts every handle where the model says: drop any preview.
  const previewTimerRef = useRef<number | null>(null);
  const clearPreview = () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    layerRef.current
      ?.querySelectorAll<HTMLElement>("[data-section-handle]")
      .forEach((element) => element.style.removeProperty("transform"));
  };
  useLayoutEffect(clearPreview, [song.sectionMarkers]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, markerId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const layer = layerRef.current;
    const marker = song.sectionMarkers.find((entry) => entry.id === markerId);
    if (!layer || !marker) return;
    const widthPx = layer.offsetWidth || layer.getBoundingClientRect().width;
    const scale = createSongTimeScale({
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
      widthPx,
    });
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const modifiers = { additive: event.ctrlKey || event.metaKey, range: event.shiftKey };
    let groupIds: string[] | null = null;
    let delta = 0;
    let moved = false;

    const elementsFor = (ids: readonly string[]) =>
      ids
        .map((id) => layer.querySelector<HTMLElement>(`[data-section-handle="${id}"]`))
        .filter((element): element is HTMLElement => Boolean(element));

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      groupIds ??= handlers.dragGroup(markerId);
      const starts = groupIds
        .map((id) => song.sectionMarkers.find((entry) => entry.id === id)?.startSeconds)
        .filter((value): value is number => value !== undefined);
      delta = snappedSectionDelta(
        song,
        region,
        marker.startSeconds,
        scale.pxPerSecond > 0 ? dx / scale.pxPerSecond : 0,
        starts,
        snapEnabled,
      );
      const offsetPx = delta * scale.pxPerSecond;
      for (const element of elementsFor(groupIds)) {
        element.style.setProperty("transform", `translate3d(${offsetPx}px, 0, 0)`);
      }
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!moved) {
        handlers.select(markerId, modifiers);
        return;
      }
      const committed = upEvent.type === "pointerup" && groupIds
        ? handlers.commitMove(groupIds, delta)
        : false;
      if (!committed) {
        clearPreview();
        return;
      }
      previewTimerRef.current = window.setTimeout(clearPreview, PREVIEW_FALLBACK_MS);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /** The song-end handle: previewed with a transform, one resize on release. */
  const handleEndPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const layer = layerRef.current;
    const element = event.currentTarget;
    if (!layer) return;
    const widthPx = layer.offsetWidth || layer.getBoundingClientRect().width;
    const pxPerSecond = widthPx / Math.max(1e-6, region.endSeconds - region.startSeconds);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let moved = false;
    let dx = 0;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      element.style.setProperty("transform", `translate3d(${dx}px, 0, 0)`);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const committed =
        moved && upEvent.type === "pointerup" && pxPerSecond > 0
          ? handlers.resizeSongEnd(region.endSeconds + dx / pxPerSecond)
          : false;
      if (!committed) element.style.removeProperty("transform");
      else previewTimerRef.current = window.setTimeout(clearPreview, PREVIEW_FALLBACK_MS);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={layerRef}
      className={`lt-setlist-section-layer${isMobileApp ? " is-touch" : ""}`}
      aria-label={t("setlistView.sections.layer", { name: region.name })}
      onPointerDownCapture={isMobileApp ? touchMenu.begin : undefined}
      onPointerMoveCapture={isMobileApp ? touchMenu.move : undefined}
      onPointerUpCapture={isMobileApp ? touchMenu.cancel : undefined}
      onPointerCancelCapture={isMobileApp ? touchMenu.cancel : undefined}
    >
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className={`lt-setlist-section-handle is-${markerCategory(marker)}${selectedIds.has(marker.id) ? " is-selected" : ""}`}
          data-section-handle={marker.id}
          style={
            {
              left: `${percent.secondsToPx(marker.startSeconds)}%`,
              "--lt-setlist-block-color": markerColor(marker),
            } as CSSProperties
          }
          aria-label={t("setlistView.sections.handle", { name: marker.name })}
          aria-pressed={selectedIds.has(marker.id)}
          onPointerDown={(event) => handlePointerDown(event, marker.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handlers.openMenu(event, marker.id);
          }}
        >
          <span className="lt-setlist-section-flag">{marker.name}</span>
        </button>
      ))}
      <button
        type="button"
        className="lt-setlist-section-handle is-song-end"
        data-section-handle="song-end"
        style={{ left: "100%" }}
        aria-label={t("setlistView.sections.songEnd", { name: region.name })}
        onPointerDown={handleEndPointerDown}
      />
    </div>
  );
}

export const SongSectionEditLayer = memo(SongSectionEditLayerComponent);
