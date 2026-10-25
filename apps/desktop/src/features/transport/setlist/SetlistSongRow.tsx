import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { AppSettings } from "@libretracks/shared/models";

import { createEmptySong, isMobileApp } from "../desktopApi";
import { SongGapVampToggle } from "../live/SongGapVampToggle";
import { useLiveProgressBars } from "../live/useLiveProgressBars";
import type { SongViewBindings } from "../songs/songViewBindings";
import { useSongReorder } from "../songs/useSongReorder";
import { useTransportStore } from "../store";
import { NewSongTemplateMenu } from "../templates/NewSongTemplateMenu";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import { SetlistSongTile, type SetlistSongTileActions } from "./SetlistSongTile";
import type { SetlistLayoutClass } from "./useSetlistLayout";

export type SetlistDragPreview = {
  targetRegionId: string | null;
  count: number;
  isPackage: boolean;
} | null;

type SetlistSongRowProps = Pick<
  SongViewBindings,
  | "regions"
  | "selectedRegionId"
  | "activeRegionId"
  | "pendingRegionId"
  | "bpmByRegion"
  | "onSelectRegion"
  | "onCueSong"
  | "onPlaySong"
  | "onSongContextMenu"
  | "onReorderSong"
  | "onDropOsFilesIntoSong"
  | "onDropLibraryAssetsIntoSong"
  | "onSnapshotApplied"
  | "onImportSongPackageFromDialog"
  | "onImportSongPackageFromOsFile"
> & {
  layout: SetlistLayoutClass;
  positionSecondsRef: { readonly current: number };
  dragPreview?: SetlistDragPreview;
  transitionMode: AppSettings["songTransitionMode"];
  onTransitionModeChange: (mode: AppSettings["songTransitionMode"]) => void;
  vampBetweenSongs?: boolean;
  onVampBetweenSongsChange?: (enabled: boolean) => void;
};

const NO_FILL = { current: null };

function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * The setlist: one card per song in timeline order, plus «+». A horizontal
 * row in `wide`/`medium` and a vertical column with its own scroll in
 * `short`. Tapping a card selects (and, stopped, cues) the song; a double
 * tap or ▶ plays it with the global transition; the menu is the DAW's own
 * song menu (`onSongContextMenu`).
 *
 * The sounding card's progress bar is written by a rAF loop from
 * `positionSecondsRef`; the playhead never re-renders this row.
 */
function SetlistSongRowComponent({
  regions,
  selectedRegionId,
  activeRegionId,
  pendingRegionId,
  bpmByRegion,
  onSelectRegion,
  onCueSong,
  onPlaySong,
  onSongContextMenu,
  onReorderSong,
  onDropOsFilesIntoSong,
  onDropLibraryAssetsIntoSong,
  onSnapshotApplied,
  onImportSongPackageFromDialog,
  onImportSongPackageFromOsFile,
  layout,
  positionSecondsRef,
  dragPreview = null,
  transitionMode,
  onTransitionModeChange,
  vampBetweenSongs,
  onVampBetweenSongsChange,
}: SetlistSongRowProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const progressFillRef = useRef<HTMLSpanElement | null>(null);
  const [transitionMenuOpen, setTransitionMenuOpen] = useState(false);
  const regionIds = useMemo(() => regions.map((region) => region.id), [regions]);
  const songReorder = useSongReorder({
    itemIds: regionIds,
    containerRef: listRef,
    onReorder: onReorderSong,
  });
  const touchMenu = useTouchContextMenu();

  const activeRegion = regions.find((region) => region.id === activeRegionId) ?? null;
  useLiveProgressBars({
    positionSecondsRef,
    markerStartSeconds: null,
    markerEndSeconds: null,
    regionStartSeconds: activeRegion?.startSeconds ?? null,
    regionEndSeconds: activeRegion?.endSeconds ?? null,
    markerFillRef: NO_FILL,
    songFillRef: progressFillRef,
  });

  const actions = useMemo<SetlistSongTileActions>(
    () => ({
      onActivate: (regionId) => {
        onSelectRegion(regionId);
        // Read at click time, not subscribed: the row must not re-render on
        // every transport change. Sounding, a tap only prepares the song.
        const playing =
          useTransportStore.getState().playback?.playbackState === "playing";
        if (!playing) onCueSong(regionId);
      },
      onPlaySong,
      onSongContextMenu,
      onDropOsFilesIntoSong,
      onDropLibraryAssetsIntoSong,
      reorderHandleProps: songReorder.enabled ? songReorder.handleProps : undefined,
      reorderSurfaceProps: songReorder.enabled ? songReorder.surfaceProps : undefined,
    }),
    [
      onCueSong,
      onDropLibraryAssetsIntoSong,
      onDropOsFilesIntoSong,
      onPlaySong,
      onSelectRegion,
      onSongContextMenu,
      songReorder.enabled,
      songReorder.handleProps,
      songReorder.surfaceProps,
    ],
  );

  // The selected card comes into view when the song changes (keyboard,
  // remote, next/previous song), without animation if the user asked so.
  useEffect(() => {
    if (!selectedRegionId) return;
    const tile = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(".lt-setlist-song-tile") ?? [],
    ).find((element) => element.dataset.regionId === selectedRegionId);
    tile?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selectedRegionId]);

  const handleAddSong = useCallback(
    async (template?: string) => {
      try {
        onSnapshotApplied(await createEmptySong(undefined, template));
      } catch {
        // Same as Compacta: a failed create must not crash the view.
      }
    },
    [onSnapshotApplied],
  );

  // A .ltpkg dropped anywhere over the row is a new song at the end.
  const handleRowDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const packageFile = Array.from(event.dataTransfer.files ?? []).find((file) =>
        /\.ltpkg$/i.test(file.name),
      );
      if (!packageFile) return;
      event.preventDefault();
      onImportSongPackageFromOsFile(packageFile);
    },
    [onImportSongPackageFromOsFile],
  );

  const transitionIcon = transitionMode === "fade_out" ? "trending_down" : "arrow_forward";
  const transitionLabel =
    transitionMode === "fade_out" ? t("liveView.fadeOut") : t("liveView.cleanCut");
  const isVertical = layout === "short";

  return (
    <div
      ref={listRef}
      className={`lt-setlist-songs is-${layout}${isVertical ? " is-vertical" : " is-horizontal"}${dragPreview?.isPackage ? " is-package-drag" : ""}`}
      role="list"
      aria-label={t("setlistView.songs.label")}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleRowDrop}
      onPointerDownCapture={isMobileApp ? touchMenu.begin : undefined}
      onPointerMoveCapture={isMobileApp ? touchMenu.move : undefined}
      onPointerUpCapture={isMobileApp ? touchMenu.cancel : undefined}
      onPointerCancelCapture={isMobileApp ? touchMenu.cancel : undefined}
      onClickCapture={
        isMobileApp
          ? (event) => {
              // The finger lifted after a long-press menu: not a tap.
              if (touchMenu.consumeTriggered()) {
                event.stopPropagation();
                event.preventDefault();
              }
            }
          : undefined
      }
    >
      {regions.map((region, index) => (
        <Fragment key={region.id}>
          {index > 0 && !isVertical ? (
            <button
              type="button"
              className={`lt-setlist-transition${vampBetweenSongs ? " has-vamp" : ""}`}
              aria-label={t("setlistView.songs.transitionTitle", { mode: transitionLabel })}
              title={t("setlistView.songs.transitionTitle", { mode: transitionLabel })}
              onClick={() => setTransitionMenuOpen((open) => !open)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                {transitionIcon}
              </span>
              {vampBetweenSongs ? (
                <span className="material-symbols-outlined" aria-hidden="true">
                  all_inclusive
                </span>
              ) : null}
            </button>
          ) : null}
          <div role="listitem" className="lt-setlist-song-item">
            <SetlistSongTile
              region={region}
              index={index}
              bpm={bpmByRegion[region.id]}
              layout={layout}
              isSelected={region.id === selectedRegionId}
              isActive={region.id === activeRegionId}
              isPending={region.id === pendingRegionId}
              isDropTarget={
                !dragPreview?.isPackage && dragPreview?.targetRegionId === region.id
              }
              progressFillRef={region.id === activeRegionId ? progressFillRef : undefined}
              actions={actions}
            />
          </div>
        </Fragment>
      ))}
      <div role="listitem" className="lt-setlist-song-item is-add">
        <div className={`lt-setlist-add-song is-${layout}`}>
          <button
            type="button"
            className="lt-setlist-add-song-button"
            aria-label={t("setlistView.songs.newSong")}
            title={t("setlistView.songs.newSong")}
            onClick={() => void handleAddSong()}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {isVertical ? null : <span>{t("setlistView.songs.newSong")}</span>}
          </button>
          {FEATURE_FLAGS.songTemplates ? (
            <NewSongTemplateMenu onCreate={(template) => void handleAddSong(template)} />
          ) : null}
          <button
            type="button"
            className="lt-setlist-add-song-button"
            aria-label={t("setlistView.songs.importPackage")}
            title={t("setlistView.songs.importPackage")}
            onClick={onImportSongPackageFromDialog}
          >
            <span className="material-symbols-outlined" aria-hidden="true">folder_open</span>
          </button>
        </div>
      </div>
      {transitionMenuOpen ? (
        <div
          className="lt-setlist-transition-menu"
          role="dialog"
          aria-label={t("setlistView.songs.transitionMenu")}
        >
          {(["instant", "fade_out"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={transitionMode === mode}
              className={transitionMode === mode ? "is-active" : ""}
              onClick={() => {
                onTransitionModeChange(mode);
                setTransitionMenuOpen(false);
              }}
            >
              {mode === "fade_out" ? t("liveView.fadeOut") : t("liveView.cleanCut")}
            </button>
          ))}
          {onVampBetweenSongsChange ? (
            <SongGapVampToggle
              enabled={vampBetweenSongs ?? false}
              onChange={onVampBetweenSongsChange}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const SetlistSongRow = memo(SetlistSongRowComponent);
