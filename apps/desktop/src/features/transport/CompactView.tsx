import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  /** Fired after a successful createEmptySong so the snapshot is applied
   * by whoever owns runAction / applyPlaybackSnapshot upstream. */
  onSnapshotApplied: (snapshot: TransportSnapshot) => void;
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
  onMasterGainChange,
  onMasterGainCommit,
  onDropOsFilesIntoSong,
  onDropLibraryAssetsIntoSong,
  onMoveClipToTrack,
  onDeleteClip,
  onPlaySong,
  onSnapshotApplied,
}: CompactViewProps) {
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

  return (
    <div className="lt-compact-view">
      {/* Top zone: songs + master + clip stacks. Horizontal scroll when
          the project has more songs than fit on screen. */}
      <div className="lt-compact-songs">
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
          />
        ))}
        <button
          type="button"
          className="lt-compact-view-add-song"
          onClick={handleAddSong}
        >
          + Nueva canción
        </button>
      </div>

      {/* Bottom zone: global mixer over all tracks. Reusable so the DAW
          view can mount it later without forking the component. */}
      <CompactMixer
        tracks={tracks}
        audioRoutingOptions={audioRoutingOptions}
        handlers={mixerHandlers}
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

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

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
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <CompactSongHeader
        region={region}
        isActive={isActive}
        onMasterGainChange={onMasterGainChange}
        onMasterGainCommit={onMasterGainCommit}
        onPlay={onPlay}
      />
      <div className="lt-compact-song-clip-stack">
        {clips.length === 0 ? (
          <div className="lt-compact-song-clip-stack-empty">
            Suelta clips aquí
          </div>
        ) : (
          clips.map((clip) => (
            <div
              className="lt-compact-clip-entry"
              key={clip.id}
              onContextMenu={(event) => openContextMenu(event, clip.id)}
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
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onPlay: () => void;
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
  onMasterGainChange,
  onMasterGainCommit,
  onPlay,
}: CompactSongHeaderProps) {
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

  return (
    <div
      className={`lt-compact-song-header ${isActive ? "is-active" : ""}`}
    >
      <div className="lt-compact-song-name-row">
        <button
          type="button"
          className="lt-compact-song-play"
          aria-label={`Reproducir ${region.name}`}
          title={`Reproducir ${region.name} (respeta la transición global)`}
          onClick={onPlay}
        >
          <span className="material-symbols-outlined">play_arrow</span>
        </button>
        <div className="lt-compact-song-name" title={region.name}>
          {region.name}
        </div>
      </div>
      <div className="lt-compact-song-master">
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
