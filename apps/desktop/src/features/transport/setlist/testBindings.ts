import { DEFAULT_APP_SETTINGS, type SongView } from "@libretracks/shared/models";

import type { MetronomeDeviceHandlers } from "../settings/metronomeDeviceHandlers";

import type { TimelineMenus } from "../menus/timelineMenus";
import type {
  PerformanceBindings,
  SongViewBindings,
} from "../songs/songViewBindings";

const noop = () => {};

/** Minimal region for Setlist tests; override what the test is about. */
export function testRegion(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    startSeconds: 0,
    endSeconds: 60,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    ...overrides,
  } as unknown as SongViewBindings["regions"][number];
}

/** Every SongViewBindings field as a stable no-op, plus a performance
 * object over `song`. Tests spread the result and override. */
export function testSetlistProps(song: Partial<SongView> = {}) {
  const regions = (song.regions ?? [
    testRegion("song-1"),
  ]) as SongViewBindings["regions"];
  const fullSong = {
    title: "Session",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 60,
    tracks: [],
    clips: [],
    sectionMarkers: [],
    tempoMarkers: [],
    timeSignatureMarkers: [],
    ...song,
    regions,
  } as unknown as SongView;
  const bindings: SongViewBindings = {
    regions,
    tracks: fullSong.tracks,
    activeRegionId: null,
    pendingRegionId: null,
    clipsByRegion: {},
    audioRoutingOptions: [],
    mixerHandlers: {
      onToggleMute: noop,
      onToggleSolo: noop,
      onToggleTranspose: noop,
      onVolumeChange: noop,
      onCommitVolume: noop,
      onPanChange: noop,
      onCommitPan: noop,
      onAudioToChange: noop,
    },
    onTrackContextMenu: noop,
    selectedTrackIds: [],
    onTrackSelect: noop,
    onTrackDragStart: noop,
    selectedRegionId: null,
    onSelectRegion: noop,
    collapsedFolders: new Set<string>(),
    onToggleFolder: noop,
    onMasterGainChange: noop,
    onMasterGainCommit: noop,
    onDropOsFilesIntoSong: noop,
    onDropLibraryAssetsIntoSong: noop,
    onMoveClipToTrack: noop,
    onDeleteClip: noop,
    onPlaySong: noop,
    onCueSong: noop,
    onSongContextMenu: noop,
    onSectionContextMenu: noop,
    onCommitMarkerPosition: noop,
    onResizeSong: noop,
    onMoveSong: noop,
    runAction: async (action: () => Promise<void>) => {
      await action();
    },
    setStatus: noop,
    onSelectedRegionTransposeChange: noop,
    onSelectedRegionWarpToggle: noop,
    onSelectedRegionTempoChange: noop,
    workspaceEndSeconds: 600,
    onRenameSong: noop,
    onSetSongBpm: noop,
    onDeleteSong: noop,
    onExportSong: noop,
    onSetSongKey: noop,
    onReorderSong: noop,
    bpmByRegion: {},
    waveformSummaries: {},
    appSettings: DEFAULT_APP_SETTINGS,
    auxHandlers: {} as MetronomeDeviceHandlers,
    metronomeVolumeDraft: 1,
    onMetronomeOutputChange: noop,
    midiLearnMode: null,
    onMidiLearnTarget: noop,
    multiTrackMix: {
      setVolume: noop,
      commitVolume: noop,
      setPan: noop,
      commitPan: noop,
      setAudioTo: noop,
      toggleTranspose: noop,
    },
    onSnapshotApplied: noop,
    onImportSongPackageFromDialog: noop,
    onImportSongPackageFromOsFile: noop,
  };
  const performance: PerformanceBindings = {
    song: fullSong,
    positionSecondsRef: { current: 0 },
    settings: {
      globalJumpMode: "immediate",
      globalJumpBars: 4,
      songJumpTrigger: "immediate",
      songJumpBars: 4,
      songTransitionMode: "instant",
      vampMode: "section",
      vampBars: 4,
    },
    pendingMarkerId: null,
    pendingMarkerName: null,
    activeVamp: null,
    onMarkerAction: noop,
    onSongAction: noop,
    onChartChange: async () => {},
    onToggleVamp: noop,
    onCancelPendingJump: noop,
    onSeek: noop,
    onGlobalJumpModeChange: noop,
    onGlobalJumpBarsChange: noop,
    onSongJumpTriggerChange: noop,
    onSongJumpBarsChange: noop,
    onSongTransitionModeChange: noop,
    onVampModeChange: noop,
    onVampBarsChange: noop,
  };
  return {
    ...bindings,
    performance,
    menus: {} as TimelineMenus,
    onOpenInDaw: noop,
  };
}
