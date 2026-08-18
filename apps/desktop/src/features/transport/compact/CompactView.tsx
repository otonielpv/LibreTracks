import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  meterDbToDisplayScale,
  peakToMeterDb,
  stepMeterDb,
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_MIN_DB,
} from "@libretracks/shared/meterBallistics";

import {
  CompactMixer,
  type CompactMixerHandlers,
} from "./CompactMixer";
import { CompactSongHeader } from "./CompactSongHeader";
import { columnDensityClass, useColumnResize } from "./useColumnResize";
import { isAndroidApp } from "../desktopApi";
import { LIBRARY_ASSET_DRAG_MIME } from "../library/dragDrop";
import { clientToZoomedCoords } from "../../../shared/uiZoom";
import {
  COMPACT_COLUMN_MAX_WIDTH_REM,
  COMPACT_COLUMN_MIN_WIDTH_REM,
} from "@libretracks/shared/models";
import {
  createEmptySong,
  regionEffectiveKey,
  type SongRegionSummary,
  type TrackSummary,
  type TransportSnapshot,
} from "../desktopApi";

export type CompactClipEntry = {
  id: string;
  clipName: string;
  trackId: string;
  trackName: string;
  /** Optional track accent colour propagated by the parent. When set,
   * the clip card paints a left ribbon + tinted name in that colour
   * — same affordance the DAW track header uses (via the
   * --lt-track-color custom property). null/undefined falls back to
   * the default neutral styling. */
  trackColor?: string | null;
};

/**
 * Track ids that have at least one clip inside the given song region —
 * the target set for the CompactMixer's "solo cancion activa" filter.
 * `null` (no active region) means the playhead sits between songs, and
 * the caller falls back to showing every track.
 *
 * Deliberately keyed on the region id, NOT on the playhead position: the
 * panel keeps the 60fps position in a ref on purpose, so a seconds-based
 * derivation silently freezes at whatever value the last unrelated render
 * happened to see. See CompactViewProps.activeRegionId.
 */
export function computeActiveSongTrackIds(
  activeRegionId: string | null,
  clipsByRegion: Record<string, CompactClipEntry[]>,
): Set<string> | null {
  if (!activeRegionId) return null;
  const ids = new Set<string>();
  for (const entry of clipsByRegion[activeRegionId] ?? []) {
    ids.add(entry.trackId);
  }
  return ids;
}

type CompactViewProps = {
  regions: SongRegionSummary[];
  tracks: TrackSummary[];
  /** Id of the song region the playhead is currently inside, or null when
   * it sits between songs. The parent resolves this (in syncLivePosition)
   * and re-renders only when the playhead crosses a song boundary — the
   * raw position is intentionally kept out of React state so the 60fps
   * playhead never re-renders this view. Drives both the active-song
   * highlight and the mixer's "solo cancion activa" filter. */
  activeRegionId: string | null;
  /** Id of the song that has an armed jump. Section-marker jumps do not
   * match a region id, so no song column is highlighted for those. */
  pendingRegionId: string | null;
  /** region_id → flat list of clips inside that song, in the same vertical
   * order tracks appear in the DAW header pane. Each entry carries the clip
   * filename and its track's name so the cell can label both without a
   * separate label column. */
  clipsByRegion: Record<string, CompactClipEntry[]>;
  /** Audio routing options for the mixer's audio_to selector — same list
   * the DAW track header uses. */
  audioRoutingOptions: Array<{ value: string; label: string }>;
  /** Mixer handlers — the very same callbacks the DAW track header uses. */
  mixerHandlers: CompactMixerHandlers;
  /** Right-click on a mixer strip routes to the parent's existing track
   * context-menu handler (the same one wired to the DAW track header),
   * so the seven actions there are reused without duplication. */
  onTrackContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  /** Track ids currently selected at the project level. Drives the
   * `is-selected` class on each mixer strip and feeds the drag
   * pipeline so multi-selection drag works the same way the DAW
   * track header does. */
  selectedTrackIds: string[];
  /** Click on a strip handle (name/parent band) → selection. Same
   * Ctrl/Shift modifiers as the DAW header. */
  onTrackSelect: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  /** Pointer-down on a strip handle starts a track-reorder drag. The
   * parent owns the move / drop pipeline (shared with the DAW). */
  onTrackDragStart: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  /** Id of the currently-selected song region, or null when nothing
   * is selected. Mirrors the project selection so the compact header
   * can paint `is-selected` consistently with the DAW. */
  selectedRegionId: string | null;
  /** Click on a song header selects that region project-wide. The
   * toolbar's Transpose/Warp/Master groups bind to this selection. */
  onSelectRegion: (regionId: string) => void;
  /** Controls the "Solo cancion activa" filter inside CompactMixer.
   * Owned by the project-wide parent so the toggle UI can live in
   * the TimelineToolbar without lifting more wiring than necessary. */
  compactMixerFilterActiveSong: boolean;
  /** Fired when the user wants to commit the master gain for a region. */
  onMasterGainChange: (regionId: string, gain: number) => void;
  onMasterGainCommit: (regionId: string) => void;
  /** Fired when the user drops one or more files (from the OS file
   * explorer) into a song's clip stack. The parent translates each File
   * into an auto-track + clip via createClipsWithAutoTracks. The drop
   * landing position is the song's start. */
  onDropOsFilesIntoSong: (regionId: string, files: File[]) => void;
  /** Fired when the user drags a library asset onto a song column. The
   * payload mirrors the LibrarySidebarPanel drag payload (file path +
   * cached duration). The parent translates this into createClipsWithAutoTracks
   * using the resolved file paths. */
  onDropLibraryAssetsIntoSong: (
    regionId: string,
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) => void;
  /** Fired from the per-clip context menu in the song column. */
  onMoveClipToTrack: (clipId: string, targetTrackId: string) => void;
  onDeleteClip: (clipId: string) => void;
  /** Fired from the per-column play button. Honours the project's global
   * song-jump configuration (trigger + transition mode) — same path the
   * Shift+digit keyboard shortcut uses. */
  onPlaySong: (regionId: string, regionName: string) => void;
  /** Fired from the song-column right-click menu. Renames the song
   * region; the prompt UI lives in the parent. */
  onRenameSong: (regionId: string) => void;
  /** Fired from the song-column right-click menu. Sets the BPM at the
   * song's start by inserting (or replacing) a tempo marker — never
   * touches the global project BPM, so reordering songs never silently
   * changes which tempo applies to which section. */
  onSetSongBpm: (regionId: string) => void;
  /** Fired from the song-column right-click menu. Deletes the song and
   * everything that lives inside its range (clips + tempo markers).
   * The confirm prompt lives in the parent so the destructive-action
   * copy can stay consistent with the DAW version of this action. */
  onDeleteSong: (regionId: string) => void;
  /** Fired from the song-column right-click menu. Exports the song as a
   * LibreTracks package (.ltpkg). Reuses the exact same backend command
   * the DAW's right-click "Exportar Cancion" uses, so the file dialog
   * and output format are identical between views. */
  onExportSong: (regionId: string) => void;
  /** Fired when the user finishes dragging a song column's resize handle
   * (or double-clicks it, which sends `null` to restore the default width).
   * Fires once per gesture, on release — never during the drag, which is
   * rendered locally. The parent persists it on the region. */
  onSongColumnWidthChange: (regionId: string, widthRem: number | null) => void;
  /** Fired from the song-column right-click menu's "Nota" submenu. Sets the
   * song's original key (`null` clears it). Reuses the same backend command
   * (`update_song_region_key`) the DAW context menu uses, so the effective-key
   * badge stays consistent between views and updates with the transpose. */
  onSetSongKey: (regionId: string, key: string | null) => void;
  /** Effective BPM at each song's start_seconds, computed by the parent so
   * the column reads "what tempo plays here" without re-doing the marker
   * resolution at render time. Empty / missing values fall back to the
   * project's global bpm via the visible badge. */
  bpmByRegion: Record<string, number>;
  /** Fired after a successful createEmptySong so the snapshot is applied
   * by whoever owns runAction / applyPlaybackSnapshot upstream. */
  onSnapshotApplied: (snapshot: TransportSnapshot) => void;
  /** Opens the OS file dialog filtered to .ltpkg and imports the chosen
   * package as a new song appended at the end of the project. The dialog
   * + insert-position math lives in the parent so we keep a single
   * source of truth for "where does a new song land". */
  onImportSongPackageFromDialog: () => void;
  /** Fired when the user drops a .ltpkg file from the OS file explorer
   * anywhere over the song strip. The parent appends it as a new song at
   * the end of the project, mirroring the DAW timeline behaviour. */
  onImportSongPackageFromOsFile: (file: File) => void;
  /** Live drag-over preview driven by the parent's native + library
   * drag pipelines (HTML5 dragover doesn't fire reliably under Tauri,
   * so the per-column dataTransfer-based detection was unreliable).
   *
   *   targetRegionId: the song column under the pointer; null when the
   *     pointer is on the strip but not on a column.
   *   count: how many files/assets will land (≥ 1).
   *   isPackage: true → render the strip-level ghost column (a .ltpkg
   *     import); false → render `count` dashed placeholders inside
   *     the target column.
   */
  dragPreview: {
    targetRegionId: string | null;
    count: number;
    isPackage: boolean;
  } | null;
};

/**
 * Compact, Ableton-Session-style projection of the project. Two zones:
 *
 *   Top — a horizontal strip of song columns. Each column has a header with
 *   the song name + master fader, and below it a vertical stack of every
 *   clip that lives inside that song. Clips are ordered by their track's
 *   index in the project, so reading top-to-bottom matches what the DAW
 *   view shows when the playhead enters the song. Each clip entry shows
 *   its filename and the track it belongs to.
 *
 *   Bottom — a horizontal-scroll mixer with one channel strip per track
 *   in the project. Mute / solo / volume / pan / audio_to / transpose
 *   controls are driven by the same handlers the DAW track header uses,
 *   so changes from either view stay consistent.
 *
 * The component is purely presentational regarding model state — the
 * parent owns the SongView snapshot and tells us what to render.
 */
function CompactViewComponent({
  regions,
  tracks,
  activeRegionId,
  pendingRegionId,
  clipsByRegion,
  audioRoutingOptions,
  mixerHandlers,
  onTrackContextMenu,
  onMasterGainChange,
  onMasterGainCommit,
  onDropOsFilesIntoSong,
  onDropLibraryAssetsIntoSong,
  onMoveClipToTrack,
  onDeleteClip,
  onPlaySong,
  onRenameSong,
  onSetSongBpm,
  onDeleteSong,
  onExportSong,
  onSetSongKey,
  onSongColumnWidthChange,
  bpmByRegion,
  onSnapshotApplied,
  onImportSongPackageFromDialog,
  onImportSongPackageFromOsFile: _onImportSongPackageFromOsFile,
  dragPreview,
  selectedTrackIds,
  onTrackSelect,
  onTrackDragStart,
  selectedRegionId,
  onSelectRegion,
  compactMixerFilterActiveSong,
}: CompactViewProps) {
  const isPackageDragOver = dragPreview?.isPackage === true;

  // Which column is mid-resize, if any. Lifted here only so the view root can
  // carry `is-resizing-column` (which pins the col-resize cursor and blocks
  // text selection across the whole strip while the pointer roams).
  const [resizingRegionId, setResizingRegionId] = useState<string | null>(null);

  // Stable identity: the column reports its drag state from an effect, so an
  // inline arrow here would change every render and re-fire it each time.
  const handleColumnResizingChange = useCallback(
    (regionId: string, active: boolean) => {
      setResizingRegionId((current) =>
        active ? regionId : current === regionId ? null : current,
      );
    },
    [],
  );

  const handleAddSong = useCallback(async () => {
    try {
      const snapshot = await createEmptySong();
      onSnapshotApplied(snapshot);
    } catch {
      // Surface failures via the parent's runAction wrapper if needed;
      // for now we swallow so the button doesn't crash the view.
    }
  }, [onSnapshotApplied]);

  // Build a "move to track" submenu list once per snapshot — every clip's
  // context menu uses the same set, sorted by the project's track order.
  // Folder tracks are excluded since clips can't live on folders.
  const moveTargets = useMemo(
    () =>
      tracks
        .filter((track) => track.kind === "audio")
        .map((track) => ({ id: track.id, name: track.name })),
    [tracks],
  );

  // Tracks that participate in the song the playhead is on. Used by
  // the CompactMixer's "solo cancion activa" filter. null = no
  // active song under the playhead (between regions, or fresh
  // project), in which case the filter has no target set and the
  // mixer falls back to showing every track. Keyed off activeRegionId
  // rather than the raw position: the parent only re-renders us when
  // the playhead crosses into another song, which is precisely when
  // this set can change.
  const activeSongTrackIds = useMemo<Set<string> | null>(
    () => computeActiveSongTrackIds(activeRegionId, clipsByRegion),
    [activeRegionId, clipsByRegion],
  );

  // Android: mixer collapsed by default on narrow (phone) screens, visible on
  // tablets; the user's explicit choice persists. Desktop: always visible.
  const [isMixerVisible, setIsMixerVisible] = useState(() => {
    if (!isAndroidApp) return true;
    try {
      const saved = window.localStorage.getItem(
        "libretracks.compact.mixerVisible",
      );
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {
      // Private mode → fall through to the width heuristic.
    }
    return window.innerWidth >= 1000;
  });
  const toggleMixerVisible = () => {
    setIsMixerVisible((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          "libretracks.compact.mixerVisible",
          next ? "1" : "0",
        );
      } catch {
        // Best effort.
      }
      return next;
    });
  };

  // Android: with the mixer open it takes the WHOLE compact view (pan +
  // routing were unreadable sharing the height with the song columns on a
  // phone); the toggle flips between songs and mixer rather than stacking.
  const mixerTakesFullHeight = isAndroidApp && isMixerVisible;

  return (
    <div
      className={`lt-compact-view${mixerTakesFullHeight ? " is-mixer-full" : ""}${
        resizingRegionId ? " is-resizing-column" : ""
      }`}
    >
      {/* Top zone: songs + master + clip stacks. Horizontal scroll when
          the project has more songs than fit on screen. Accepts OS drag
          of a .ltpkg file anywhere over the strip — the drop appends a
          new song at the end of the project, mirroring the DAW timeline. */}
      <div
        className={
          isPackageDragOver
            ? "lt-compact-songs is-package-drop"
            : "lt-compact-songs"
        }
      >
        {regions.map((region) => (
          <CompactSongColumn
            key={region.id}
            region={region}
            clips={clipsByRegion[region.id] ?? []}
            moveTargets={moveTargets}
            isActive={region.id === activeRegionId}
            isQueued={region.id === pendingRegionId}
            onMasterGainChange={(gain) => onMasterGainChange(region.id, gain)}
            onMasterGainCommit={() => onMasterGainCommit(region.id)}
            onDropOsFiles={(files) => onDropOsFilesIntoSong(region.id, files)}
            onDropLibraryAssets={(payload) =>
              onDropLibraryAssetsIntoSong(region.id, payload)
            }
            onMoveClipToTrack={onMoveClipToTrack}
            onDeleteClip={onDeleteClip}
            onPlay={() => onPlaySong(region.id, region.name)}
            onRename={() => onRenameSong(region.id)}
            onSetBpm={() => onSetSongBpm(region.id)}
            onDelete={() => onDeleteSong(region.id)}
            onExport={() => onExportSong(region.id)}
            onSetKey={(key) => onSetSongKey(region.id, key)}
            bpm={bpmByRegion[region.id]}
            placeholderCount={
              dragPreview &&
              !dragPreview.isPackage &&
              dragPreview.targetRegionId === region.id
                ? dragPreview.count
                : 0
            }
            isSelected={selectedRegionId === region.id}
            onSelect={() => onSelectRegion(region.id)}
            onWidthChange={onSongColumnWidthChange}
            onResizingChange={handleColumnResizingChange}
          />
        ))}
        {/* Ghost column previewed while the user drags a .ltpkg over the
            strip — shows them exactly where the imported song will land
            (always at the end, before the action buttons). */}
        {isPackageDragOver ? (
          <div
            className="lt-compact-song-column is-package-ghost"
            aria-hidden="true"
          >
            <div className="lt-compact-song-header is-package-ghost-header">
              <span className="material-symbols-outlined">
                library_music
              </span>
              <span>Importar aquí</span>
            </div>
          </div>
        ) : null}
        <div className="lt-compact-view-song-actions">
          <button
            type="button"
            className="lt-compact-view-add-song"
            onClick={handleAddSong}
          >
            + Nueva canción
          </button>
          <button
            type="button"
            className="lt-compact-view-import-song"
            onClick={onImportSongPackageFromDialog}
            title="Importar canción desde .ltpkg"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              folder_open
            </span>
            Importar .ltpkg
          </button>
        </div>
      </div>

      {/* Android: the mixer band eats most of a phone's landscape height, so
          it collapses behind a slim toggle. Wide screens (tablets) default to
          visible; the choice persists. Desktop keeps the mixer always on. */}
      {isAndroidApp ? (
        <button
          type="button"
          className="lt-compact-mixer-toggle"
          aria-expanded={isMixerVisible}
          onClick={toggleMixerVisible}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {isMixerVisible ? "expand_more" : "expand_less"}
          </span>
          {isMixerVisible ? "Ocultar mixer" : "Mixer"}
        </button>
      ) : null}

      {/* Bottom zone: global mixer over all tracks. Reusable so the DAW
          view can mount it later without forking the component. */}
      {isMixerVisible ? (
        <CompactMixer
          tracks={tracks}
          audioRoutingOptions={audioRoutingOptions}
          handlers={mixerHandlers}
          onTrackContextMenu={onTrackContextMenu}
          selectedTrackIds={selectedTrackIds}
          onTrackSelect={onTrackSelect}
          onTrackDragStart={onTrackDragStart}
          activeSongTrackIds={activeSongTrackIds}
          filterActiveSong={compactMixerFilterActiveSong}
        />
      ) : null}
    </div>
  );
}

export const CompactView = memo(CompactViewComponent);

type CompactSongColumnProps = {
  region: SongRegionSummary;
  clips: CompactClipEntry[];
  moveTargets: Array<{ id: string; name: string }>;
  isActive: boolean;
  isQueued: boolean;
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onDropOsFiles: (files: File[]) => void;
  onDropLibraryAssets: (
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) => void;
  onMoveClipToTrack: (clipId: string, targetTrackId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onPlay: () => void;
  onRename: () => void;
  onSetBpm: () => void;
  onDelete: () => void;
  onExport: () => void;
  onSetKey: (key: string | null) => void;
  bpm: number | undefined;
  /** Number of dashed placeholders to render at the end of the clip
   * stack while a drag is hovering this column. Driven by the parent's
   * `dragPreview`. 0 means no drag — render the empty-state hint if
   * the column has no clips. */
  placeholderCount: number;
  /** True when this region is the currently-selected region in the
   * project. Drives the header's `is-selected` styling. */
  isSelected: boolean;
  /** Called when the user clicks the header background — selects the
   * region so the toolbar's Transpose/Warp/Master controls bind to
   * it. */
  onSelect: () => void;
  /** Committed at the end of a resize gesture; `null` restores the default
   * width. Never fired mid-drag — see useColumnResize. Takes the region id
   * so the parent can pass one stable callback to every column. */
  onWidthChange: (regionId: string, widthRem: number | null) => void;
  /** Reports whether this column's resize drag is active, so the view root
   * can hold the col-resize cursor for the whole gesture. */
  onResizingChange: (regionId: string, active: boolean) => void;
};

function CompactSongColumnComponent({
  region,
  clips,
  moveTargets,
  isActive,
  isQueued,
  onMasterGainChange,
  onMasterGainCommit,
  onDropOsFiles,
  onDropLibraryAssets,
  onMoveClipToTrack,
  onDeleteClip,
  onPlay,
  onRename,
  onSetBpm,
  onDelete,
  onExport,
  onSetKey,
  bpm,
  placeholderCount,
  isSelected,
  onSelect,
  onWidthChange,
  onResizingChange,
}: CompactSongColumnProps) {
  const regionId = region.id;
  const handleWidthCommit = useCallback(
    (nextWidthRem: number | null) => onWidthChange(regionId, nextWidthRem),
    [onWidthChange, regionId],
  );
  const {
    widthRem,
    isResizing,
    handlePointerDown: handleResizePointerDown,
    handleKeyDown: handleResizeKeyDown,
    handleDoubleClick: handleResizeDoubleClick,
  } = useColumnResize({
    persistedWidthRem: region.compactColumnWidthRem,
    songName: region.name,
    // Mirrors the two badge conditions in CompactSongHeader, so the auto-fit
    // reserves room only for badges that are actually rendered.
    hasBadges: bpm !== undefined || Boolean(regionEffectiveKey(region)),
    onCommit: handleWidthCommit,
  });

  // Mirror the drag state up so the view root can pin the cursor. Reported
  // via an effect rather than from the hook's handlers so the parent state
  // update never lands mid-render of this component.
  useEffect(() => {
    onResizingChange(regionId, isResizing);
  }, [isResizing, onResizingChange, regionId]);

  const [contextMenu, setContextMenu] = useState<{
    clipId: string;
    x: number;
    y: number;
  } | null>(null);

  // Close the context menu on any outside click or escape, the way most
  // native menus behave. Listening on the window so we don't have to weave
  // a backdrop element through the grid layout.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // HTML5 dragover doesn't fire reliably under Tauri's native drag
  // pipeline, so the placeholder count is driven by the parent via
  // `placeholderCount` instead of computing it locally from
  // dataTransfer. We still keep the onDrop handler below for the
  // browser fallback path (running outside Tauri) and for the
  // synthetic drop the library pipeline might dispatch in the future.
  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const types = Array.from(event.dataTransfer.types ?? []);

      // Library-asset drag: same MIME the DAW uses. The payload is a JSON
      // array of { file_path, durationSeconds } records.
      if (types.includes(LIBRARY_ASSET_DRAG_MIME)) {
        try {
          const raw = event.dataTransfer.getData(LIBRARY_ASSET_DRAG_MIME);
          const payload = JSON.parse(raw) as Array<{
            file_path: string;
            durationSeconds?: number;
          }>;
          if (payload.length > 0) {
            onDropLibraryAssets(
              payload.map((item) => ({
                filePath: item.file_path,
                durationSeconds: item.durationSeconds,
              })),
            );
          }
        } catch {
          // Malformed payload — ignore the drop.
        }
        return;
      }

      // OS file drag: the browser exposes File objects directly.
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) {
        onDropOsFiles(files);
      }
    },
    [onDropLibraryAssets, onDropOsFiles],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, clipId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const { x, y } = clientToZoomedCoords(event.clientX, event.clientY);
      setContextMenu({ clipId, x, y });
    },
    [],
  );

  const activeClip = contextMenu
    ? clips.find((clip) => clip.id === contextMenu.clipId)
    : null;

  return (
    <div
      className={`lt-compact-song-column ${isActive ? "is-active" : ""} ${isQueued ? "is-queued" : ""} ${columnDensityClass(
        widthRem,
      )}`}
      /* data-region-id lets the library asset pointer-drag pipeline in
         TransportPanelContent identify which song the user just dropped
         onto without having to plumb a per-column React ref through the
         component tree. */
      data-region-id={region.id}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={
        {
          "--lt-compact-column-width": `${widthRem}rem`,
        } as CSSProperties
      }
    >
      <CompactSongHeader
        region={region}
        isActive={isActive}
        isQueued={isQueued}
        bpm={bpm}
        onMasterGainChange={onMasterGainChange}
        onMasterGainCommit={onMasterGainCommit}
        onPlay={onPlay}
        onRename={onRename}
        onSetBpm={onSetBpm}
        onDelete={onDelete}
        onExport={onExport}
        onSetKey={onSetKey}
        isSelected={isSelected}
        onSelect={onSelect}
      />
      <div
        className={
          placeholderCount > 0
            ? "lt-compact-song-clip-stack is-drop-target"
            : "lt-compact-song-clip-stack"
        }
      >
        {clips.length === 0 && placeholderCount === 0 ? (
          <div className="lt-compact-song-clip-stack-empty">
            Suelta clips aquí
          </div>
        ) : (
          clips.map((clip) => (
            <div
              className={
                clip.trackColor
                  ? "lt-compact-clip-entry is-coloured"
                  : "lt-compact-clip-entry"
              }
              key={clip.id}
              onContextMenu={(event) => openContextMenu(event, clip.id)}
              style={
                clip.trackColor
                  ? ({
                      // Same custom-prop the DAW track header sets, so
                      // styles stay symmetric across the two views.
                      "--lt-track-color": clip.trackColor,
                    } as CSSProperties)
                  : undefined
              }
            >
              <span className="lt-compact-clip-name" title={clip.clipName}>
                {clip.clipName}
              </span>
              <span
                className="lt-compact-clip-track-name"
                title={`Track: ${clip.trackName}`}
              >
                <span className="lt-compact-clip-track-label">Track:</span>{" "}
                {clip.trackName}
              </span>
            </div>
          ))
        )}
        {/* Dashed placeholders rendered while a drag hovers over the
            column. One placeholder per file/asset the user is about to
            drop, so the preview matches the resulting clip stack. */}
        {placeholderCount > 0
          ? Array.from({ length: placeholderCount }).map((_, index) => (
              <div
                key={`drop-placeholder-${index}`}
                className="lt-compact-clip-entry is-drop-placeholder"
                aria-hidden="true"
              >
                <span className="lt-compact-clip-name">Nuevo clip</span>
              </div>
            ))
          : null}
      </div>

      {contextMenu && activeClip ? (
        <div
          className="lt-compact-clip-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          // Stop pointerdown bubbling so opening the submenu doesn't close
          // the parent menu via the window listener above.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="lt-compact-clip-menu-group">
            <div className="lt-compact-clip-menu-label">Mover a track</div>
            <div className="lt-compact-clip-menu-list">
              {moveTargets
                .filter((target) => target.id !== activeClip.trackId)
                .map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className="lt-compact-clip-menu-item"
                    onClick={() => {
                      onMoveClipToTrack(activeClip.id, target.id);
                      setContextMenu(null);
                    }}
                  >
                    {target.name}
                  </button>
                ))}
              {moveTargets.filter((t) => t.id !== activeClip.trackId).length ===
              0 ? (
                <div className="lt-compact-clip-menu-empty">
                  No hay otras tracks disponibles
                </div>
              ) : null}
            </div>
          </div>
          <div className="lt-compact-clip-menu-divider" aria-hidden="true" />
          <button
            type="button"
            className="lt-compact-clip-menu-item is-destructive"
            onClick={() => {
              onDeleteClip(activeClip.id);
              setContextMenu(null);
            }}
          >
            Eliminar clip
          </button>
        </div>
      ) : null}

      {/* Drag the right edge to widen / narrow this song's column;
          double-click restores the default width. Rendered as a button so
          it is focusable and the arrow-key fallback works without a
          pointer. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Ancho de la columna ${region.name}`}
        aria-valuenow={Math.round(widthRem)}
        aria-valuemin={COMPACT_COLUMN_MIN_WIDTH_REM}
        aria-valuemax={COMPACT_COLUMN_MAX_WIDTH_REM}
        tabIndex={0}
        title="Arrastra para cambiar el ancho · doble clic para restablecer"
        className={
          isResizing
            ? "lt-compact-column-resizer is-resizing"
            : "lt-compact-column-resizer"
        }
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={handleResizeDoubleClick}
      />
    </div>
  );
}

const CompactSongColumn = memo(CompactSongColumnComponent);

