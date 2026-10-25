import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  ActiveVampSummary,
  AppSettings,
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
  SongView,
  TrackSummary,
  TransportSnapshot,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import type { CompactMixerHandlers } from "../compact/CompactMixer";
import type { RulerMarkerHandlers } from "../rulerMarkers/rulerMarkerHandlers";
import type { MetronomeDeviceHandlers } from "../settings/metronomeDeviceHandlers";
import type { MultiTrackMixActions } from "../tracks/MultiTrackMixControls";
import type { CompactClipEntry } from "../compact/CompactView";

/**
 * What any song view (Compacta, Setlist) receives from the panel: snapshot
 * data plus the song, track and mix handlers the DAW already uses.
 *
 * The panel builds ONE plain object per render and spreads it into each view.
 * The views are `memo`, and a spread makes `memo` compare field by field, so
 * the container's identity does not matter but every field's does: each one
 * must come from a `useMemo`/`useCallback`/factory, never an inline literal.
 * See songViewBindings.test.tsx.
 */
export type SongViewBindings = {
  regions: SongRegionSummary[];
  tracks: TrackSummary[];
  /** Id of the song region the playhead is inside, or null between songs.
   * Re-rendered only when the playhead crosses a song boundary: the raw
   * position stays out of React state so the 60fps playhead never
   * re-renders a song view. */
  activeRegionId: string | null;
  /** Id of the song that has an armed jump. Section-marker jumps do not
   * match a region id, so no song is highlighted for those. */
  pendingRegionId: string | null;
  /** region_id → clips inside that song, in the DAW's track order. */
  clipsByRegion: Record<string, CompactClipEntry[]>;
  /** Options for the mixer's audio_to selector (same list as the DAW). */
  audioRoutingOptions: Array<{ value: string; label: string }>;
  /** The very same callbacks the DAW track header uses. */
  mixerHandlers: CompactMixerHandlers;
  /** The DAW track header's context menu. */
  onTrackContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  /** Project-level track selection (Ctrl/Shift like the DAW header). */
  selectedTrackIds: string[];
  onTrackSelect: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  /** Starts a track-reorder drag; the pipeline is shared with the DAW. */
  onTrackDragStart: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  /** Project-wide song selection: the toolbar's Transpose/Warp/Master
   * groups bind to it. */
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  /** Folded folder tracks, shared with the DAW header. */
  collapsedFolders: Set<string>;
  onToggleFolder: (trackId: string) => void;
  onMasterGainChange: (regionId: string, gain: number) => void;
  onMasterGainCommit: (regionId: string) => void;
  /** OS files dropped into a song: one auto-track + clip per file at the
   * song's start. */
  onDropOsFilesIntoSong: (regionId: string, files: File[]) => void;
  /** Library assets dropped into a song (LibrarySidebarPanel payload). */
  onDropLibraryAssetsIntoSong: (
    regionId: string,
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) => void;
  onMoveClipToTrack: (clipId: string, targetTrackId: string) => void;
  onDeleteClip: (clipId: string) => void;
  /** Honours the global song-jump configuration (trigger + transition),
   * the same path as the Shift+digit shortcut. */
  onPlaySong: (regionId: string, regionName: string) => void;
  /** The DAW's section-marker menu (rename, kind, colour, digit, delete,
   * jump…), the same function as the DAW ruler's. Like in the DAW it
   * clears the song selection and selects the section. */
  onSectionContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    markerId: string,
  ) => void;
  /** The DAW ruler's marker group actions (move, duplicate, delete, menu). */
  rulerMarkers: RulerMarkerHandlers;
  /** Moves a marker to an exact position: the same commit as dragging its
   * flag in the DAW (the section menu's «Position…» editor uses it). */
  onCommitMarkerPosition: (markerId: string, startSeconds: number) => void;
  /** New edges for a song; the DAW region band's commit. */
  onResizeSong: (regionId: string, startSeconds: number, endSeconds: number) => void;
  /** Moves the whole song by `deltaSeconds`; the DAW region band's move. */
  onMoveSong: (regionId: string, deltaSeconds: number) => void;
  /** The panel's action runner (status on error) and status line: a view
   * that runs a command itself goes through them (00 §5). */
  runAction: (action: () => Promise<void>, options?: { busy?: boolean }) => Promise<void>;
  setStatus: (message: string) => void;
  /** The toolbar's handlers for the SELECTED song (transpose, warp, tempo). */
  onSelectedRegionTransposeChange: (nextTransposeSemitones: number) => void;
  onSelectedRegionWarpToggle: (nextEnabled: boolean) => void;
  onSelectedRegionTempoChange: (region: SongRegionSummary, nextBpm: number) => void;
  /** End of the timeline workspace: the cap a typed position is clamped to. */
  workspaceEndSeconds: number;
  /** Stopped: put the playhead at the song's start, without playing. */
  onCueSong: (regionId: string) => void;
  /** The DAW's own song menu (rename with library-folder sync, key,
   * analyse, render, arrangement, fades, count style, split…). The same
   * function the DAW timeline's region band uses. */
  onSongContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    regionId: string,
  ) => void;
  onRenameSong: (regionId: string) => void;
  /** Sets the BPM at the song's start with a tempo marker; never touches
   * the project's global BPM. */
  onSetSongBpm: (regionId: string) => void;
  onDeleteSong: (regionId: string) => void;
  onExportSong: (regionId: string) => void;
  /** Sets the song's original key (`null` clears it). */
  onSetSongKey: (regionId: string, key: string | null) => void;
  /** `targetIndex` is the song's final position in `regions` (0 = first).
   * Optional so a view still renders where reordering isn't wired. */
  onReorderSong?: (regionId: string, targetIndex: number) => void;
  /** The waveform summaries the DAW already fetched, by waveform key. */
  waveformSummaries: Record<string, WaveformSummaryDto>;
  /** Effective BPM at each song's start. */
  bpmByRegion: Record<string, number>;
  /** The app settings (click, guide and pad state for the console). */
  appSettings: AppSettings;
  /** The click / guide / pad handlers the DAW's popovers use (one stable
   * object from settings/metronomeDeviceHandlers). */
  auxHandlers: MetronomeDeviceHandlers;
  /** The click's output route (from settings/settingsHandlers). */
  onMetronomeOutputChange: (value: string) => void;
  /** The click volume while its fader is being dragged. */
  metronomeVolumeDraft: number;
  midiLearnMode: string | null;
  onMidiLearnTarget: (command: string) => void;
  /** Mix of the whole track selection, the DAW's (tracks/MultiTrackMixControls). */
  multiTrackMix: MultiTrackMixActions;
  /** Publishes a snapshot returned by a command the view ran itself. */
  onSnapshotApplied: (snapshot: TransportSnapshot) => void;
  /** `.ltpkg` picker; the package lands as a new song at the end. */
  onImportSongPackageFromDialog: () => void;
  /** `.ltpkg` dropped from the OS anywhere over the song strip. */
  onImportSongPackageFromOsFile: (file: File) => void;
};

/** The settings a live view reads: the jump modes. A network-session guest
 * only has the host's copy of these, not a whole `AppSettings`. */
export type LiveViewSettings = Pick<
  AppSettings,
  | "globalJumpMode"
  | "globalJumpBars"
  | "songJumpTrigger"
  | "songJumpBars"
  | "songTransitionMode"
  | "vampMode"
  | "vampBars"
>;

/**
 * What a performance view (Live, Setlist) needs: the position by ref (never
 * by state), the jump and vamp settings, and the primary actions on songs
 * and markers.
 */
export type PerformanceBindings = {
  song: SongView;
  positionSecondsRef: { readonly current: number };
  settings: LiveViewSettings;
  pendingMarkerId: string | null;
  pendingMarkerName: string | null;
  activeVamp: ActiveVampSummary | null;
  onMarkerAction: (marker: SectionMarkerSummary) => void;
  onSongAction: (region: SongRegionSummary) => void;
  /** Drag a setlist song to another position; `targetIndex` is its final
   * position in start order (0 = first). */
  onReorderSong?: (regionId: string, targetIndex: number) => void;
  /** Replace a song's lyrics and chords (`null` removes them). */
  onChartChange: (regionId: string, chart: SongChart | null) => Promise<void>;
  onToggleVamp: () => void;
  onCancelPendingJump: () => void;
  /** Seek to a timeline point: the panel's coalesced seek (performSeek). */
  onSeek: (seconds: number) => void;
  onGlobalJumpModeChange: (mode: AppSettings["globalJumpMode"]) => void;
  onGlobalJumpBarsChange: (bars: number) => void;
  onSongJumpTriggerChange: (trigger: AppSettings["songJumpTrigger"]) => void;
  onSongJumpBarsChange: (bars: number) => void;
  onSongTransitionModeChange: (mode: AppSettings["songTransitionMode"]) => void;
  onVampModeChange: (mode: AppSettings["vampMode"]) => void;
  onVampBarsChange: (bars: number) => void;
  /** The vamp between songs setting; the toggle shows only with a handler
   * (not on a network-session guest, which has no settings of its own). */
  vampBetweenSongs?: boolean;
  onVampBetweenSongsChange?: (enabled: boolean) => void;
};
