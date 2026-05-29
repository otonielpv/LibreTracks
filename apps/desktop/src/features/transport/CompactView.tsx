import {
  memo,
  useCallback,
  useRef,
  type DragEvent as ReactDragEvent,
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
  /** Fired when the user drops a file into a song's clip stack. The
   * specific (region, track) mapping is established by the parent: we hand
   * over the song id and the timeline position and the parent decides
   * what track to land on. Wired in step 5.4. */
  onDropFileIntoSong: (
    regionId: string,
    file: File,
    timelineStartSeconds: number,
  ) => void;
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
  onDropFileIntoSong,
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
            isActive={
              playheadSeconds >= region.startSeconds &&
              playheadSeconds < region.endSeconds
            }
            onMasterGainChange={(gain) => onMasterGainChange(region.id, gain)}
            onMasterGainCommit={() => onMasterGainCommit(region.id)}
            onDropFile={(file) =>
              onDropFileIntoSong(region.id, file, region.startSeconds)
            }
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
  isActive: boolean;
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onDropFile: (file: File) => void;
};

function CompactSongColumnComponent({
  region,
  clips,
  isActive,
  onMasterGainChange,
  onMasterGainCommit,
  onDropFile,
}: CompactSongColumnProps) {
  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      onDropFile(file);
    },
    [onDropFile],
  );

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
      />
      <div className="lt-compact-song-clip-stack">
        {clips.length === 0 ? (
          <div className="lt-compact-song-clip-stack-empty">
            Suelta clips aquí
          </div>
        ) : (
          clips.map((clip) => (
            <div className="lt-compact-clip-entry" key={clip.id}>
              <span className="lt-compact-clip-name" title={clip.clipName}>
                {clip.clipName}
              </span>
              <span
                className="lt-compact-clip-track-name"
                title={clip.trackName}
              >
                {clip.trackName}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const CompactSongColumn = memo(CompactSongColumnComponent);

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
