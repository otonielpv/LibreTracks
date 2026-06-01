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
import { LIBRARY_ASSET_DRAG_MIME } from "./dragDrop";
import {
  createEmptySong,
  type SongRegionSummary,
  type TrackSummary,
  type TransportSnapshot,
} from "./desktopApi";
import { useTransportStore } from "./store";

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

type CompactViewProps = {
  regions: SongRegionSummary[];
  tracks: TrackSummary[];
  /** Linear timeline position so we can highlight the active song. */
  playheadSeconds: number;
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
  playheadSeconds,
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
  // mixer falls back to showing every track. Recalculated on every
  // playhead move; the underlying set is tiny so the cost is fine.
  const activeSongTrackIds = useMemo<Set<string> | null>(() => {
    const activeRegion = regions.find(
      (region) =>
        playheadSeconds >= region.startSeconds &&
        playheadSeconds < region.endSeconds,
    );
    if (!activeRegion) return null;
    const ids = new Set<string>();
    for (const entry of clipsByRegion[activeRegion.id] ?? []) {
      ids.add(entry.trackId);
    }
    return ids;
  }, [regions, playheadSeconds, clipsByRegion]);

  return (
    <div className="lt-compact-view">
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
            isActive={
              playheadSeconds >= region.startSeconds &&
              playheadSeconds < region.endSeconds
            }
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

      {/* Bottom zone: global mixer over all tracks. Reusable so the DAW
          view can mount it later without forking the component. */}
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
    </div>
  );
}

export const CompactView = memo(CompactViewComponent);

type CompactSongColumnProps = {
  region: SongRegionSummary;
  clips: CompactClipEntry[];
  moveTargets: Array<{ id: string; name: string }>;
  isActive: boolean;
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
};

function CompactSongColumnComponent({
  region,
  clips,
  moveTargets,
  isActive,
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
  bpm,
  placeholderCount,
  isSelected,
  onSelect,
}: CompactSongColumnProps) {
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
      setContextMenu({ clipId, x: event.clientX, y: event.clientY });
    },
    [],
  );

  const activeClip = contextMenu
    ? clips.find((clip) => clip.id === contextMenu.clipId)
    : null;

  return (
    <div
      className={`lt-compact-song-column ${isActive ? "is-active" : ""}`}
      /* data-region-id lets the library asset pointer-drag pipeline in
         TransportPanelContent identify which song the user just dropped
         onto without having to plumb a per-column React ref through the
         component tree. */
      data-region-id={region.id}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <CompactSongHeader
        region={region}
        isActive={isActive}
        bpm={bpm}
        onMasterGainChange={onMasterGainChange}
        onMasterGainCommit={onMasterGainCommit}
        onPlay={onPlay}
        onRename={onRename}
        onSetBpm={onSetBpm}
        onDelete={onDelete}
        onExport={onExport}
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
    </div>
  );
}

const CompactSongColumn = memo(CompactSongColumnComponent);

type CompactSongHeaderProps = {
  region: SongRegionSummary;
  isActive: boolean;
  bpm: number | undefined;
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onPlay: () => void;
  onRename: () => void;
  onSetBpm: () => void;
  onDelete: () => void;
  onExport: () => void;
  /** True when this region matches the project selection. Drives the
   * `is-selected` styling so the user sees which song the toolbar's
   * Transpose / Warp / Master controls are bound to. */
  isSelected: boolean;
  /** Click on the header (anywhere except the play button or fader)
   * selects the region — same selection slot the DAW uses, so the
   * Transposition / Warp / Master groups in the toolbar pick this up
   * automatically. */
  onSelect: () => void;
};

// Master fader snaps to unity (1.0) within ±3% of full range (0..2), so the
// magnetic zone is [0.94, 1.06]. Shift bypasses, double-click resets.
const MASTER_SNAP_TARGET = 1.0;
const MASTER_SNAP_RANGE = 2.0;
const MASTER_SNAP_THRESHOLD = MASTER_SNAP_RANGE * 0.03;

function applyMasterSnap(value: number, bypass: boolean): number {
  if (bypass) return value;
  return Math.abs(value - MASTER_SNAP_TARGET) <= MASTER_SNAP_THRESHOLD
    ? MASTER_SNAP_TARGET
    : value;
}

function CompactSongHeaderComponent({
  region,
  isActive,
  bpm,
  onMasterGainChange,
  onMasterGainCommit,
  onPlay,
  onRename,
  onSetBpm,
  onDelete,
  onExport,
  isSelected,
  onSelect,
}: CompactSongHeaderProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
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
  const openMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);
  // Track Shift state via window listeners so the slider's onChange can
  // read it; same pattern as the CompactMixerStrip volume / pan.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
  const optimistic = useTransportStore((state) =>
    state.optimisticRegionMaster[region.id],
  );
  const gain = optimistic ?? region.master?.gain ?? 1.0;

  const meterFillRef = useRef<HTMLDivElement | null>(null);
  const animationStateRef = useRef({
    frameId: null as number | null,
    lastFrameAt: 0,
    currentDb: METER_MIN_DB,
    targetDb: METER_MIN_DB,
  });

  // Same animation loop the toolbar's RegionMasterFader uses. The store
  // update arrives via the shared useRegionMeters hook already wired in
  // TransportPanelContent.
  const driveAnimation = useCallback(() => {
    const animationState = animationStateRef.current;
    const applyFill = () => {
      const element = meterFillRef.current;
      if (!element) return;
      const scale = meterDbToDisplayScale(animationState.currentDb);
      element.style.width = `${(scale * 100).toFixed(2)}%`;
      element.style.opacity = scale > 0 ? "1" : "0";
    };
    const step = (now: number) => {
      const elapsed =
        animationState.lastFrameAt > 0 ? now - animationState.lastFrameAt : 16.67;
      animationState.lastFrameAt = now;
      animationState.currentDb = stepMeterDb(
        animationState.currentDb,
        animationState.targetDb,
        elapsed,
        DEFAULT_METER_FALLOFF_DB_PER_SECOND,
      );
      applyFill();
      const settled =
        Math.abs(animationState.currentDb - animationState.targetDb) <
        METER_ACTIVE_EPSILON_DB;
      if (settled) {
        animationState.currentDb = animationState.targetDb;
        applyFill();
        animationState.frameId = null;
        animationState.lastFrameAt = 0;
        return;
      }
      animationState.frameId = requestAnimationFrame(step);
    };
    if (animationState.frameId === null) {
      animationState.frameId = requestAnimationFrame(step);
    }
  }, []);

  useTransportStore.subscribe(
    (state) => state.regionMeters[region.id] ?? 0,
    (peak) => {
      animationStateRef.current.targetDb = peakToMeterDb(peak);
      driveAnimation();
    },
  );

  // Click on the header (anywhere but the play button or the fader)
  // selects the region. We listen on the root with a check that the
  // event reached us un-stopped — the play button and master fader
  // call stopPropagation when they handle the click, so this only
  // fires for clicks on the header's body.
  const handleHeaderClick = useCallback(() => {
    onSelect();
  }, [onSelect]);

  return (
    <div
      className={`lt-compact-song-header ${isActive ? "is-active" : ""} ${
        isSelected ? "is-selected" : ""
      }`}
      onContextMenu={openMenu}
      onClick={handleHeaderClick}
    >
      <div className="lt-compact-song-name-row">
        <button
          type="button"
          className="lt-compact-song-play"
          aria-label={`Reproducir ${region.name}`}
          title={`Reproducir ${region.name} (respeta la transición global)`}
          onClick={(event) => {
            // Don't bubble to the header — the play button shouldn't
            // also select the region, only transport-jump to it.
            event.stopPropagation();
            onPlay();
          }}
        >
          <span className="material-symbols-outlined">play_arrow</span>
        </button>
        <div className="lt-compact-song-name" title={region.name}>
          {region.name}
        </div>
        {bpm !== undefined ? (
          <div
            className="lt-compact-song-bpm"
            title={`BPM efectivo al inicio de la canción`}
          >
            {bpm.toFixed(bpm % 1 === 0 ? 0 : 2)} BPM
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          className="lt-compact-clip-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="lt-compact-clip-menu-item"
            onClick={() => {
              setContextMenu(null);
              onRename();
            }}
          >
            Renombrar canción
          </button>
          <button
            type="button"
            className="lt-compact-clip-menu-item"
            onClick={() => {
              setContextMenu(null);
              onSetBpm();
            }}
          >
            Cambiar BPM…
          </button>
          <button
            type="button"
            className="lt-compact-clip-menu-item"
            onClick={() => {
              setContextMenu(null);
              onExport();
            }}
          >
            Exportar canción
          </button>
          <div className="lt-compact-clip-menu-divider" aria-hidden="true" />
          <button
            type="button"
            className="lt-compact-clip-menu-item is-destructive"
            onClick={() => {
              setContextMenu(null);
              onDelete();
            }}
          >
            Eliminar canción
          </button>
        </div>
      ) : null}
      <div
        className="lt-compact-song-master"
        // The master fader sits inside the clickable header. Swallow
        // clicks so dragging or double-clicking the fader doesn't
        // re-fire the header's selection handler.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lt-compact-song-meter" aria-hidden="true">
          <div className="lt-compact-song-meter-fill" ref={meterFillRef} />
        </div>
        <input
          className="lt-compact-song-fader"
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={gain}
          aria-label={`Master gain for ${region.name}`}
          onChange={(event) => {
            const next = Number(event.target.value) || 0;
            onMasterGainChange(applyMasterSnap(next, shiftPressedRef.current));
          }}
          onDoubleClick={() => {
            onMasterGainChange(MASTER_SNAP_TARGET);
            onMasterGainCommit();
          }}
          onPointerUp={onMasterGainCommit}
          onPointerCancel={onMasterGainCommit}
          onKeyUp={(event) => {
            if (
              event.key === "ArrowUp" ||
              event.key === "ArrowDown" ||
              event.key === "ArrowLeft" ||
              event.key === "ArrowRight" ||
              event.key === "PageUp" ||
              event.key === "PageDown" ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              onMasterGainCommit();
            }
          }}
        />
      </div>
    </div>
  );
}

const CompactSongHeader = memo(CompactSongHeaderComponent);
