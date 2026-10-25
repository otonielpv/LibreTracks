import {
  memo,
  useCallback,
  useMemo,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { regionEffectiveKey, type SongRegionSummary } from "../desktopApi";
import { LIBRARY_ASSET_DRAG_MIME } from "../library/dragDrop";
import { formatLiveClock } from "../live/liveMarkerModel";
import { SongReorderHandle, type SongReorderHandleProps } from "../songs/SongReorderHandle";
import { SONG_REORDER_ID_ATTRIBUTE } from "../songs/useSongReorder";
import { ArrangementBadge } from "../structure/ArrangementBadge";
import type { SongViewBindings } from "../songs/songViewBindings";
import type { SetlistLayoutClass } from "./useSetlistLayout";

/** The stable callbacks every tile shares (created once by the row). */
export type SetlistSongTileActions = {
  /** Click / tap: select, and cue the song when the transport is stopped. */
  onActivate: (regionId: string) => void;
  onPlaySong: SongViewBindings["onPlaySong"];
  onSongContextMenu: SongViewBindings["onSongContextMenu"];
  onDropOsFilesIntoSong: SongViewBindings["onDropOsFilesIntoSong"];
  onDropLibraryAssetsIntoSong: SongViewBindings["onDropLibraryAssetsIntoSong"];
  reorderHandleProps?: (regionId: string) => SongReorderHandleProps;
  reorderSurfaceProps?: (regionId: string) => {
    onPointerDown: SongReorderHandleProps["onPointerDown"];
  };
};

type SetlistSongTileProps = {
  region: SongRegionSummary;
  index: number;
  bpm: number | undefined;
  layout: SetlistLayoutClass;
  isSelected: boolean;
  isActive: boolean;
  isPending: boolean;
  isDropTarget: boolean;
  /** Only the sounding tile gets it: the row's rAF loop writes its width. */
  progressFillRef?: RefObject<HTMLSpanElement | null>;
  actions: SetlistSongTileActions;
};

/**
 * One song card, Playback-style. It only SHOWS data (number, name, key, BPM,
 * duration, arrangement) and has two buttons, ▶ and «…». No faders, no inline
 * editors: the master lives in the console (step 06) and the settings in
 * Edit → Song (step 07).
 */
function SetlistSongTileComponent({
  region,
  index,
  bpm,
  layout,
  isSelected,
  isActive,
  isPending,
  isDropTarget,
  progressFillRef,
  actions,
}: SetlistSongTileProps) {
  const { t } = useTranslation();
  const regionId = region.id;
  const songKey = regionEffectiveKey(region);
  const duration = formatLiveClock(region.endSeconds - region.startSeconds);
  const bpmLabel = bpm !== undefined ? `${Math.round(bpm)} BPM` : null;
  const handleProps = useMemo(
    () => actions.reorderHandleProps?.(regionId),
    [actions, regionId],
  );
  const surfaceProps = useMemo(
    () => actions.reorderSurfaceProps?.(regionId),
    [actions, regionId],
  );

  const openMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      actions.onSongContextMenu(event, regionId);
    },
    [actions, regionId],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const types = Array.from(event.dataTransfer.types ?? []);
      if (types.includes(LIBRARY_ASSET_DRAG_MIME)) {
        try {
          const payload = JSON.parse(
            event.dataTransfer.getData(LIBRARY_ASSET_DRAG_MIME),
          ) as Array<{ file_path: string; durationSeconds?: number }>;
          if (payload.length > 0) {
            actions.onDropLibraryAssetsIntoSong(
              regionId,
              payload.map((item) => ({
                filePath: item.file_path,
                durationSeconds: item.durationSeconds,
              })),
            );
          }
        } catch {
          // Malformed payload: ignore the drop.
        }
        return;
      }
      const files = Array.from(event.dataTransfer.files ?? []);
      // A .ltpkg is a new song: the row imports it, not this card.
      if (files.length > 0 && !files.some((file) => /\.ltpkg$/i.test(file.name))) {
        event.stopPropagation();
        actions.onDropOsFilesIntoSong(regionId, files);
      }
    },
    [actions, regionId],
  );

  const className = [
    "lt-setlist-song-tile",
    `is-${layout}`,
    isSelected ? "is-selected" : "",
    isActive ? "is-playing" : "",
    isPending ? "is-queued" : "",
    isDropTarget ? "is-drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      data-region-id={regionId}
      {...{ [SONG_REORDER_ID_ATTRIBUTE]: regionId }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={t("setlistView.songs.tileLabel", { index: index + 1, name: region.name })}
      title={t("setlistView.songs.tileLabel", { index: index + 1, name: region.name })}
      onClick={() => actions.onActivate(regionId)}
      onDoubleClick={() => actions.onPlaySong(regionId, region.name)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") actions.onPlaySong(regionId, region.name);
        else if (event.key === " ") {
          event.preventDefault();
          actions.onActivate(regionId);
        }
      }}
      onContextMenu={openMenu}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={handleDrop}
      onPointerDown={surfaceProps?.onPointerDown}
    >
      {handleProps ? (
        <SongReorderHandle
          name={region.name}
          handleProps={handleProps}
          className="lt-setlist-song-grip"
        />
      ) : null}
      <span className="lt-setlist-song-index">{index + 1}</span>
      <span className="lt-setlist-song-main">
        <span className="lt-setlist-song-name" title={region.name}>
          {region.name}
        </span>
        <span className="lt-setlist-song-meta">
          {songKey ? <span className="lt-setlist-song-key">{songKey}</span> : null}
          {layout !== "short" && bpmLabel ? (
            <span className="lt-setlist-song-bpm">{bpmLabel}</span>
          ) : null}
          {layout !== "short" ? (
            <span className="lt-setlist-song-duration">{duration}</span>
          ) : null}
        </span>
      </span>
      {layout !== "short" ? <ArrangementBadge region={region} /> : null}
      <span className="lt-setlist-song-actions" data-no-song-reorder="">
        <button
          type="button"
          className="lt-setlist-song-button"
          aria-label={t("setlistView.songs.play", { name: region.name })}
          title={t("setlistView.songs.play", { name: region.name })}
          onClick={(event) => {
            event.stopPropagation();
            actions.onPlaySong(regionId, region.name);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            play_arrow
          </span>
        </button>
        <button
          type="button"
          className="lt-setlist-song-button"
          aria-label={t("setlistView.songs.menu", { name: region.name })}
          title={t("setlistView.songs.menu", { name: region.name })}
          onClick={openMenu}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            more_horiz
          </span>
        </button>
      </span>
      {isActive ? (
        <span className="lt-setlist-song-progress" aria-hidden="true">
          <span ref={progressFillRef} className="lt-setlist-song-progress-fill" />
        </span>
      ) : null}
    </div>
  );
}

export const SetlistSongTile = memo(SetlistSongTileComponent);
