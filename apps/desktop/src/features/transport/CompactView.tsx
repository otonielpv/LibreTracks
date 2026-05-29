import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  meterDbToDisplayScale,
  peakToMeterDb,
  stepMeterDb,
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_MIN_DB,
} from "@libretracks/shared/meterBallistics";

import {
  createEmptySong,
  type SongRegionSummary,
  type TrackSummary,
  type TransportSnapshot,
} from "./desktopApi";
import { useTransportStore } from "./store";

type CompactViewProps = {
  regions: SongRegionSummary[];
  tracks: TrackSummary[];
  /** Linear timeline position so we can highlight the active song. */
  playheadSeconds: number;
  /** region_id → track_id → list of clips (sorted by timeline_start) that
   * fall inside that song on that track. Provided by the parent because it
   * already has the SongView. Empty arrays / missing keys mean "no clip in
   * this cell" — the cell renders as an empty drop target. */
  clipsByRegionAndTrack: Record<
    string,
    Record<string, { id: string; name: string }[]>
  >;
  /** Fired when the user wants to commit the master gain for a region. */
  onMasterGainChange: (regionId: string, gain: number) => void;
  onMasterGainCommit: (regionId: string) => void;
  /** Fired when the user drops a file onto a (region, track) cell. The
   * parent translates this into a createClip call with the right starting
   * timestamp inside the region. */
  onDropFileIntoCell: (
    regionId: string,
    trackId: string,
    file: File,
    timelineStartSeconds: number,
  ) => void;
  /** Fired after a successful createEmptySong so the snapshot is applied
   * by whoever owns runAction / applyPlaybackSnapshot upstream. */
  onSnapshotApplied: (snapshot: TransportSnapshot) => void;
};

/**
 * Compact, Ableton-Session-style projection of the same project: columns
 * are songs (in start_seconds order), rows are tracks that have at least
 * one clip in any of the visible songs. Tracks that don't contribute to a
 * given song show an "empty" placeholder cell that doubles as a drop
 * target for adding a clip to that (song, track) pair.
 *
 * This component is purely presentational regarding model state — the
 * parent owns the SongView snapshot and tells us which regions+tracks to
 * render. Mutations (createEmptySong, drop-into-cell) are dispatched via
 * the callbacks passed in.
 */
function CompactViewComponent({
  regions,
  tracks,
  playheadSeconds,
  clipsByRegionAndTrack,
  onMasterGainChange,
  onMasterGainCommit,
  onDropFileIntoCell,
  onSnapshotApplied,
}: CompactViewProps) {
  const { t } = useTranslation();

  // Filter tracks to only "active in at least one visible song" so the
  // grid stays as clean as Session View. Tracks the user owns but has
  // not used yet appear when they drop a clip on a cell or when the
  // DAW view adds them; either way the compact view never invents rows.
  const visibleTracks = useMemo(() => {
    const usedTrackIds = new Set<string>();
    for (const region of regions) {
      const perTrack = clipsByRegionAndTrack[region.id];
      if (!perTrack) continue;
      for (const trackId of Object.keys(perTrack)) {
        if (perTrack[trackId].length > 0) usedTrackIds.add(trackId);
      }
    }
    return tracks.filter((track) => usedTrackIds.has(track.id));
  }, [regions, tracks, clipsByRegionAndTrack]);

  const handleAddSong = useCallback(async () => {
    try {
      const snapshot = await createEmptySong();
      onSnapshotApplied(snapshot);
    } catch {
      // Surface failures via the parent's runAction wrapper if needed;
      // for now we swallow so the button doesn't crash the view.
    }
  }, [onSnapshotApplied]);

  // Explicit grid template so React doesn't have to rely on auto-fill.
  // Columns: [track-label] [song 1] [song 2] ... [song N] [+ add song].
  // Each song column is sized between a comfortable minimum and a fixed cap
  // so a project with a single song doesn't stretch its column across the
  // whole screen — extra width simply stays empty to the right.
  const gridTemplateColumns = `minmax(8rem, max-content) repeat(${regions.length}, minmax(10rem, 14rem)) 8rem`;

  // Suppress unused-import warning for t() until we localise the button copy.
  void t;

  return (
    <div className="lt-compact-view">
      <div className="lt-compact-view-grid" style={{ gridTemplateColumns }}>
        {/* Top-left empty corner — column 1 of the header row. */}
        <div className="lt-compact-view-corner" aria-hidden="true" />

        {/* Header row: one cell per song with name + master fader. */}
        {regions.map((region) => (
          <CompactSongHeader
            key={region.id}
            region={region}
            isActive={
              playheadSeconds >= region.startSeconds &&
              playheadSeconds < region.endSeconds
            }
            onMasterGainChange={(gain) => onMasterGainChange(region.id, gain)}
            onMasterGainCommit={() => onMasterGainCommit(region.id)}
          />
        ))}

        {/* "+ Nueva canción" cell — last column of the header row. */}
        <button
          type="button"
          className="lt-compact-view-add-song"
          onClick={handleAddSong}
        >
          + Nueva canción
        </button>

        {/* Track rows: label column on the left, then one cell per song,
            then an empty spacer aligning with the "+ add song" column. */}
        {visibleTracks.map((track) => (
          <CompactTrackRow
            key={track.id}
            track={track}
            regions={regions}
            clipsByRegionAndTrack={clipsByRegionAndTrack}
            onDropFileIntoCell={onDropFileIntoCell}
          />
        ))}
      </div>
    </div>
  );
}

export const CompactView = memo(CompactViewComponent);

type CompactSongHeaderProps = {
  region: SongRegionSummary;
  isActive: boolean;
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
};

function CompactSongHeaderComponent({
  region,
  isActive,
  onMasterGainChange,
  onMasterGainCommit,
}: CompactSongHeaderProps) {
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

  // Same animation loop the toolbar's RegionMasterFader uses. Pulled out
  // here so each song header gets its own ballistics state without the
  // parent having to coordinate them. The store update arrives via the
  // shared useRegionMeters hook already wired in TransportPanelContent.
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
      <div className="lt-compact-song-name" title={region.name}>
        {region.name}
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
          onChange={(event) =>
            onMasterGainChange(Number(event.target.value) || 0)
          }
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

type CompactTrackRowProps = {
  track: TrackSummary;
  regions: SongRegionSummary[];
  clipsByRegionAndTrack: Record<
    string,
    Record<string, { id: string; name: string }[]>
  >;
  onDropFileIntoCell: (
    regionId: string,
    trackId: string,
    file: File,
    timelineStartSeconds: number,
  ) => void;
};

function CompactTrackRowComponent({
  track,
  regions,
  clipsByRegionAndTrack,
  onDropFileIntoCell,
}: CompactTrackRowProps) {
  return (
    <>
      <div className="lt-compact-track-label" title={track.name}>
        {track.name}
      </div>
      {regions.map((region) => {
        const clips =
          clipsByRegionAndTrack[region.id]?.[track.id] ?? [];
        return (
          <CompactCell
            key={`${region.id}:${track.id}`}
            regionId={region.id}
            trackId={track.id}
            regionStart={region.startSeconds}
            clips={clips}
            onDropFile={onDropFileIntoCell}
          />
        );
      })}
      {/* Trailing empty cell so the row aligns with the +Nueva canción
          button column. */}
      <div className="lt-compact-cell-spacer" aria-hidden="true" />
    </>
  );
}

const CompactTrackRow = memo(CompactTrackRowComponent);

type CompactCellProps = {
  regionId: string;
  trackId: string;
  regionStart: number;
  clips: { id: string; name: string }[];
  onDropFile: (
    regionId: string,
    trackId: string,
    file: File,
    timelineStartSeconds: number,
  ) => void;
};

function CompactCellComponent({
  regionId,
  trackId,
  regionStart,
  clips,
  onDropFile,
}: CompactCellProps) {
  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      // Drop lands at the song's start. The backend will resize the
      // region if the dropped clip is longer than the placeholder.
      onDropFile(regionId, trackId, file, regionStart);
    },
    [onDropFile, regionId, trackId, regionStart],
  );

  // The cell shows the name of the first clip the track has in this song;
  // if there are several, a "+N" badge hints at the others. This replaces
  // the previous "thin teal stripe" marker that didn't tell the user what
  // actually lives in the cell.
  const primary = clips[0];
  const extraCount = clips.length - 1;
  const isActive = clips.length > 0;

  return (
    <div
      className={`lt-compact-cell ${isActive ? "is-active" : "is-empty"}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {primary ? (
        <span className="lt-compact-cell-name" title={primary.name}>
          {primary.name}
        </span>
      ) : null}
      {extraCount > 0 ? (
        <span className="lt-compact-cell-extra" aria-hidden="true">
          +{extraCount}
        </span>
      ) : null}
    </div>
  );
}

const CompactCell = memo(CompactCellComponent);
