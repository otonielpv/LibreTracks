import { getCumulativeMusicalPosition, type TimelineRegion } from "../features/transport/timelineMath";
import type {
  AppSettings,
  AudioMeterLevel,
  AudioOutputDevices,
  CreateClipArgs,
  JumpTriggerLabel,
  LibraryAssetSummary,
  LibraryImportProgressEvent,
  PendingJumpSummary,
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
  TempoMarkerSummary,
  TrackKind,
  TrackSummary,
  TransportLifecycleEvent,
  TransportSnapshot,
  WaveformReadyEvent,
  WaveformSummaryDto,
} from "../features/transport/desktopApi";

type PlaybackState = TransportSnapshot["playbackState"];

type DesktopApiMockState = {
  appSettings: AppSettings;
  audioOutputDevices: AudioOutputDevices;
  libraryAssets: LibraryAssetSummary[];
  libraryFolders: string[];
  pendingMarkerJump: PendingJumpSummary | null;
  playbackPositionSeconds: number;
  playbackState: PlaybackState;
  projectRevision: number;
  song: SongView;
  songDir: string;
  songFilePath: string;
  waveforms: Record<string, WaveformSummaryDto>;
};

const SONG_TEMPO_REGION_VISUAL_END_SECONDS = 1_000_000;
const MOCK_SONG_DIR = "C:/mock/session";
const MOCK_SONG_FILE_PATH = `${MOCK_SONG_DIR}/song.ltsong`;

let state = buildInitialState();
let idCounter = 0;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function nextRevision() {
  state.projectRevision += 1;
  state.song.projectRevision = state.projectRevision;
  return state.projectRevision;
}

function sortLibraryAssets(assets: LibraryAssetSummary[]) {
  return [...assets].sort((left, right) => {
    const leftFolder = (left.folderPath ?? "").toLowerCase();
    const rightFolder = (right.folderPath ?? "").toLowerCase();
    return leftFolder.localeCompare(rightFolder) || left.fileName.localeCompare(right.fileName);
  });
}

function buildWaveformSummary(waveformKey: string, durationSeconds: number): WaveformSummaryDto {
  const bucketCount = 96;
  const minPeaks: number[] = [];
  const maxPeaks: number[] = [];

  for (let index = 0; index < bucketCount; index += 1) {
    const progress = index / Math.max(1, bucketCount - 1);
    const amplitude = 0.12 + Math.abs(Math.sin(progress * 18)) * 0.28 + Math.abs(Math.cos(progress * 5)) * 0.08;
    maxPeaks.push(Math.min(0.92, amplitude));
    minPeaks.push(-Math.min(0.92, amplitude));
  }

  return {
    waveformKey,
    version: 1,
    durationSeconds,
    sampleRate: 48_000,
    lods: [
      {
        resolutionFrames: 2_048,
        bucketCount,
        minPeaks,
        maxPeaks,
      },
    ],
  };
}

function buildInitialSong(): SongView {
  return normalizeSong({
    id: "song-demo",
    title: "LibreTracks Session",
    artist: "Demo Ensemble",
    key: "Am",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 180,
    tempoMarkers: [],
    regions: [
      {
        id: "region-1",
        name: "LibreTracks Session",
        startSeconds: 0,
        endSeconds: 180,
      },
    ],
    tracks: [
      {
        id: "track-folder-rhythm",
        name: "Rhythm",
        kind: "folder",
        parentTrackId: null,
        depth: 0,
        hasChildren: true,
        volume: 0.92,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-drums",
        name: "Drums",
        kind: "audio",
        parentTrackId: "track-folder-rhythm",
        depth: 1,
        hasChildren: false,
        volume: 0.88,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-bass",
        name: "Bass",
        kind: "audio",
        parentTrackId: "track-folder-rhythm",
        depth: 1,
        hasChildren: false,
        volume: 0.84,
        pan: -0.04,
        muted: false,
        solo: false,
      },
      {
        id: "track-folder-guide",
        name: "Guide",
        kind: "folder",
        parentTrackId: null,
        depth: 0,
        hasChildren: true,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-click",
        name: "Click",
        kind: "audio",
        parentTrackId: "track-folder-guide",
        depth: 1,
        hasChildren: false,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      },
      {
        id: "track-vocal",
        name: "Guide Vox",
        kind: "audio",
        parentTrackId: "track-folder-guide",
        depth: 1,
        hasChildren: false,
        volume: 0.8,
        pan: 0.08,
        muted: false,
        solo: false,
      },
      {
        id: "track-keys",
        name: "Keys",
        kind: "audio",
        parentTrackId: null,
        depth: 0,
        hasChildren: false,
        volume: 0.78,
        pan: 0.12,
        muted: false,
        solo: false,
      },
    ],
    clips: [
      {
        id: "clip-drums",
        trackId: "track-drums",
        trackName: "Drums",
        filePath: "audio/drums.wav",
        waveformKey: "audio/drums.wav",
        timelineStartSeconds: 0,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 180,
        durationSeconds: 180,
        gain: 1,
      },
      {
        id: "clip-bass",
        trackId: "track-bass",
        trackName: "Bass",
        filePath: "audio/bass.wav",
        waveformKey: "audio/bass.wav",
        timelineStartSeconds: 8,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 164,
        durationSeconds: 164,
        gain: 0.94,
      },
      {
        id: "clip-click",
        trackId: "track-click",
        trackName: "Click",
        filePath: "audio/click.wav",
        waveformKey: "audio/click.wav",
        timelineStartSeconds: 0,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 180,
        durationSeconds: 180,
        gain: 1,
      },
      {
        id: "clip-vocal",
        trackId: "track-vocal",
        trackName: "Guide Vox",
        filePath: "audio/guide.wav",
        waveformKey: "audio/guide.wav",
        timelineStartSeconds: 12,
        sourceStartSeconds: 0,
        sourceDurationSeconds: 140,
        durationSeconds: 140,
        gain: 0.86,
      },
    ],
    sectionMarkers: [
      { id: "section-intro", name: "Intro", startSeconds: 0, digit: 1 },
      { id: "section-verse", name: "Verse", startSeconds: 24, digit: 2 },
      { id: "section-bridge", name: "Bridge", startSeconds: 72, digit: 3 },
      { id: "section-outro", name: "Outro", startSeconds: 108, digit: 4 },
    ],
    projectRevision: 1,
  });
}

function buildEmptySong(): SongView {
  return normalizeSong({
    id: nextId("song"),
    title: "Untitled Song",
    artist: null,
    key: null,
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 0,
    tempoMarkers: [],
    regions: [],
    tracks: [],
    clips: [],
    sectionMarkers: [],
    projectRevision: state.projectRevision + 1,
  });
}

function buildInitialState(): DesktopApiMockState {
  const song = buildInitialSong();
  const waveforms: Record<string, WaveformSummaryDto> = {
    "audio/drums.wav": buildWaveformSummary("audio/drums.wav", 180),
    "audio/bass.wav": buildWaveformSummary("audio/bass.wav", 164),
    "audio/click.wav": buildWaveformSummary("audio/click.wav", 180),
    "audio/guide.wav": buildWaveformSummary("audio/guide.wav", 140),
  };
  const libraryAssets = sortLibraryAssets([
    {
      fileName: "drums.wav",
      filePath: "audio/drums.wav",
      durationSeconds: 180,
      detectedBpm: null,
      folderPath: null,
    },
    {
      fileName: "bass.wav",
      filePath: "audio/bass.wav",
      durationSeconds: 164,
      detectedBpm: null,
      folderPath: null,
    },
    {
      fileName: "click.wav",
      filePath: "audio/click.wav",
      durationSeconds: 180,
      detectedBpm: 120,
      folderPath: null,
    },
    {
      fileName: "guide.wav",
      filePath: "audio/guide.wav",
      durationSeconds: 140,
      detectedBpm: null,
      folderPath: null,
    },
  ]);

  return {
    appSettings: {
      selectedOutputDevice: null,
      splitStereoEnabled: false,
      locale: "en",
    },
    audioOutputDevices: {
      devices: ["Mock Built-in Output"],
      defaultDevice: "Mock Built-in Output",
    },
    libraryAssets,
    libraryFolders: [],
    pendingMarkerJump: null,
    playbackPositionSeconds: 0,
    playbackState: "stopped",
    projectRevision: 1,
    song,
    songDir: MOCK_SONG_DIR,
    songFilePath: MOCK_SONG_FILE_PATH,
    waveforms,
  };
}

function buildSongTempoRegions(song: SongView | null | undefined): Array<SongRegionSummary & TimelineRegion> {
  if (!song) {
    return [];
  }

  const markers = [...song.tempoMarkers]
    .filter((marker) => marker.startSeconds > 0)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const regions: Array<SongRegionSummary & TimelineRegion> = [];
  let startSeconds = 0;
  let bpm = song.bpm;

  for (const marker of markers) {
    if (marker.startSeconds <= startSeconds) {
      bpm = marker.bpm;
      continue;
    }

    regions.push({
      id: `tempo-region-${startSeconds.toFixed(4)}`,
      name: `Tempo ${bpm.toFixed(2)}`,
      startSeconds,
      endSeconds: marker.startSeconds,
      bpm,
      timeSignature: song.timeSignature,
    });
    startSeconds = marker.startSeconds;
    bpm = marker.bpm;
  }

  regions.push({
    id: `tempo-region-${startSeconds.toFixed(4)}-tail`,
    name: `Tempo ${bpm.toFixed(2)}`,
    startSeconds,
    endSeconds: Math.max(startSeconds, SONG_TEMPO_REGION_VISUAL_END_SECONDS),
    bpm,
    timeSignature: song.timeSignature,
  });

  return regions;
}

function normalizeSong(song: SongView): SongView {
  const tracks = song.tracks.map((track) => ({
    ...track,
    parentTrackId: track.parentTrackId ?? null,
  }));
  const trackIndex = new Map(tracks.map((track) => [track.id, track]));
  const normalizedTracks = tracks.map((track) => {
    let depth = 0;
    let cursor = track.parentTrackId;

    while (cursor) {
      depth += 1;
      cursor = trackIndex.get(cursor)?.parentTrackId ?? null;
    }

    return {
      ...track,
      depth,
      hasChildren: tracks.some((candidate) => candidate.parentTrackId === track.id),
    };
  });

  const normalizedClips = song.clips.map((clip) => ({
    ...clip,
    trackName: trackIndex.get(clip.trackId)?.name ?? clip.trackName,
  }));

  const durationSeconds = Math.max(
    song.durationSeconds,
    normalizedClips.reduce(
      (maxDuration, clip) => Math.max(maxDuration, clip.timelineStartSeconds + clip.durationSeconds),
      0,
    ),
    song.regions.reduce((maxDuration, region) => Math.max(maxDuration, region.endSeconds), 0),
  );

  return {
    ...song,
    durationSeconds,
    tracks: normalizedTracks,
    clips: normalizedClips,
    regions: [...song.regions].sort((left, right) => left.startSeconds - right.startSeconds),
    sectionMarkers: [...song.sectionMarkers].sort((left, right) => left.startSeconds - right.startSeconds),
    tempoMarkers: [...song.tempoMarkers].sort((left, right) => left.startSeconds - right.startSeconds),
  };
}

function buildSnapshot(): TransportSnapshot {
  const currentMarker =
    [...state.song.sectionMarkers]
      .reverse()
      .find((marker) => state.playbackPositionSeconds >= marker.startSeconds) ?? null;
  const musicalPosition = getCumulativeMusicalPosition(
    state.playbackPositionSeconds,
    buildSongTempoRegions(state.song),
    state.song.bpm,
    state.song.timeSignature,
  );

  return {
    playbackState: state.playbackState,
    positionSeconds: state.playbackPositionSeconds,
    currentMarker,
    pendingMarkerJump: state.pendingMarkerJump ? clone(state.pendingMarkerJump) : null,
    musicalPosition,
    transportClock: {
      anchorPositionSeconds: state.playbackPositionSeconds,
      running: state.playbackState === "playing",
      lastSeekPositionSeconds: state.playbackPositionSeconds,
      lastStartPositionSeconds: state.playbackState === "playing" ? state.playbackPositionSeconds : null,
      lastJumpPositionSeconds: null,
    },
    projectRevision: state.projectRevision,
    songDir: state.songDir,
    songFilePath: state.songFilePath,
    isNativeRuntime: true,
  };
}

function replaceSong(nextSong: SongView) {
  state.song = normalizeSong({
    ...nextSong,
    projectRevision: nextRevision(),
  });
}

function getTrack(trackId: string) {
  return state.song.tracks.find((track) => track.id === trackId) ?? null;
}

function getTrackInsertIndex(insertAfterTrackId: string | null, parentTrackId: string | null) {
  const tracks = state.song.tracks;
  if (insertAfterTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === insertAfterTrackId);
    if (anchorIndex >= 0) {
      const anchorDepth = tracks[anchorIndex]?.depth ?? 0;
      let end = anchorIndex + 1;
      while ((tracks[end]?.depth ?? -1) > anchorDepth) {
        end += 1;
      }
      return end;
    }
  }

  if (parentTrackId) {
    const parentIndex = tracks.findIndex((track) => track.id === parentTrackId);
    if (parentIndex >= 0) {
      let end = parentIndex + 1;
      while ((tracks[end]?.depth ?? -1) > (tracks[parentIndex]?.depth ?? 0)) {
        end += 1;
      }
      return end;
    }
  }

  return tracks.length;
}

function ensureWaveform(filePath: string, durationSeconds: number) {
  if (!state.waveforms[filePath]) {
    state.waveforms[filePath] = buildWaveformSummary(filePath, durationSeconds);
  }
}

function findLibraryAsset(filePath: string) {
  return state.libraryAssets.find((asset) => asset.filePath === filePath) ?? null;
}

function createPendingJump(marker: SectionMarkerSummary, trigger: JumpTriggerLabel): PendingJumpSummary {
  return {
    targetMarkerId: marker.id,
    targetMarkerName: marker.name,
    targetDigit: marker.digit ?? null,
    trigger,
    executeAtSeconds: trigger === "immediate" ? marker.startSeconds : Math.max(state.playbackPositionSeconds, marker.startSeconds),
  };
}

function createRegionFromSelection(startSeconds: number, endSeconds: number): SongRegionSummary {
  return {
    id: nextId("region"),
    name: state.song.title,
    startSeconds: Math.max(0, startSeconds),
    endSeconds: Math.max(startSeconds, endSeconds),
  };
}

export function resetTestDesktopApiMock() {
  idCounter = 0;
  state = buildInitialState();
}

export const testDesktopApiMock = {
  listenToTransportLifecycle: async (_handler: (event: TransportLifecycleEvent) => void) => () => {},
  listenToAudioMeters: async (_handler: (levels: AudioMeterLevel[]) => void) => () => {},
  listenToLibraryImportProgress: async (_handler: (event: LibraryImportProgressEvent) => void) => () => {},
  listenToWaveformReady: async (_handler: (event: WaveformReadyEvent) => void) => () => {},
  getTransportSnapshot: async () => clone(buildSnapshot()),
  getSongView: async () => clone(state.song),
  getWaveformSummaries: async (waveformKeys: string[]) =>
    waveformKeys.map((waveformKey) => state.waveforms[waveformKey]).filter(Boolean).map((entry) => clone(entry)),
  getLibraryWaveformSummaries: async (filePaths: string[]) =>
    filePaths.map((filePath) => state.waveforms[filePath]).filter(Boolean).map((entry) => clone(entry)),
  getLibraryAssets: async () => clone(sortLibraryAssets(state.libraryAssets)),
  getLibraryFolders: async () => clone(state.libraryFolders),
  getDesktopPerformanceSnapshot: async () => ({
    copyMillis: 0,
    wavAnalysisMillis: 0,
    waveformWriteMillis: 0,
    songSaveMillis: 0,
    transportSnapshotBuildMillis: 0,
    songViewBuildMillis: 0,
    waveformCacheHits: 0,
    waveformCacheMisses: 0,
    transportSnapshotBytes: 0,
    songViewBytes: 0,
    lastReactRenderMillis: 0,
    projectRevision: state.projectRevision,
    cachedWaveforms: Object.keys(state.waveforms).length,
  }),
  getSettings: async () => clone(state.appSettings),
  saveSettings: async (settings: AppSettings) => {
    state.appSettings = clone(settings);
    return clone(state.appSettings);
  },
  updateAudioSettings: async (settings: AppSettings) => {
    state.appSettings = clone(settings);
    return clone(state.appSettings);
  },
  getAudioOutputDevices: async () => clone(state.audioOutputDevices),
  reportUiRenderMetric: async (_renderMillis: number) => {},
  createSong: async () => {
    replaceSong(buildEmptySong());
    state.libraryAssets = [];
    state.libraryFolders = [];
    state.pendingMarkerJump = null;
    state.playbackPositionSeconds = 0;
    state.playbackState = "stopped";
    return clone(buildSnapshot());
  },
  saveProject: async () => clone(buildSnapshot()),
  saveProjectAs: async () => clone(buildSnapshot()),
  undoAction: async () => clone(buildSnapshot()),
  redoAction: async () => clone(buildSnapshot()),
  updateSongTempo: async (bpm: number) => {
    replaceSong({
      ...state.song,
      bpm,
    });
    return clone(buildSnapshot());
  },
  upsertSongTempoMarker: async (args: { markerId?: string | null; startSeconds: number; bpm: number }) => {
    const nextMarkers = state.song.tempoMarkers.filter((marker) => marker.id !== args.markerId);
    nextMarkers.push({
      id: args.markerId ?? nextId("tempo-marker"),
      startSeconds: Math.max(0, args.startSeconds),
      bpm: args.bpm,
    });
    replaceSong({
      ...state.song,
      tempoMarkers: nextMarkers,
    });
    return clone(buildSnapshot());
  },
  deleteSongTempoMarker: async (markerId: string) => {
    replaceSong({
      ...state.song,
      tempoMarkers: state.song.tempoMarkers.filter((marker) => marker.id !== markerId),
    });
    return clone(buildSnapshot());
  },
  openProject: async () => {
    resetTestDesktopApiMock();
    return clone(buildSnapshot());
  },
  pickAndImportSong: async () => clone(buildSnapshot()),
  importLibraryAssetsFromDialog: async () => clone(state.libraryAssets),
  deleteLibraryAsset: async (filePath: string) => {
    state.libraryAssets = state.libraryAssets.filter((asset) => asset.filePath !== filePath);
    delete state.waveforms[filePath];
    return clone(state.libraryAssets);
  },
  moveLibraryAsset: async (filePath: string, folderPath?: string | null) => {
    state.libraryAssets = sortLibraryAssets(
      state.libraryAssets.map((asset) =>
        asset.filePath === filePath
          ? {
              ...asset,
              folderPath: folderPath ?? null,
            }
          : asset,
      ),
    );
    if (folderPath && !state.libraryFolders.includes(folderPath)) {
      state.libraryFolders = [...state.libraryFolders, folderPath].sort((left, right) => left.localeCompare(right));
    }
    return clone(state.libraryAssets);
  },
  createLibraryFolder: async (folderPath: string) => {
    if (!state.libraryFolders.includes(folderPath)) {
      state.libraryFolders = [...state.libraryFolders, folderPath].sort((left, right) => left.localeCompare(right));
    }
    return clone(state.libraryFolders);
  },
  renameLibraryFolder: async (from: string, to: string) => {
    state.libraryFolders = state.libraryFolders
      .map((folderPath) => (folderPath === from ? to : folderPath))
      .sort((left, right) => left.localeCompare(right));
    state.libraryAssets = sortLibraryAssets(
      state.libraryAssets.map((asset) => ({
        ...asset,
        folderPath: asset.folderPath === from ? to : asset.folderPath,
      })),
    );
    return clone(state.libraryAssets);
  },
  deleteLibraryFolder: async (folderPath: string) => {
    state.libraryFolders = state.libraryFolders.filter((entry) => entry !== folderPath);
    state.libraryAssets = sortLibraryAssets(
      state.libraryAssets.map((asset) => ({
        ...asset,
        folderPath: asset.folderPath === folderPath ? null : asset.folderPath,
      })),
    );
    return clone(state.libraryAssets);
  },
  playTransport: async () => {
    state.playbackState = "playing";
    return clone(buildSnapshot());
  },
  pauseTransport: async () => {
    state.playbackState = "paused";
    return clone(buildSnapshot());
  },
  stopTransport: async () => {
    state.playbackState = "stopped";
    state.playbackPositionSeconds = 0;
    state.pendingMarkerJump = null;
    return clone(buildSnapshot());
  },
  seekTransport: async (positionSeconds: number) => {
    state.playbackPositionSeconds = Math.max(0, positionSeconds);
    return clone(buildSnapshot());
  },
  scheduleMarkerJump: async (targetMarkerId: string, trigger: Exclude<JumpTriggerLabel, `after_bars:${number}`> | "after_bars", bars?: number) => {
    const marker = state.song.sectionMarkers.find((entry) => entry.id === targetMarkerId) ?? null;
    if (!marker) {
      return clone(buildSnapshot());
    }

    if (trigger === "immediate") {
      state.playbackPositionSeconds = marker.startSeconds;
      state.pendingMarkerJump = null;
      return clone(buildSnapshot());
    }

    if (trigger === "next_marker") {
      const hasMarkerAhead = state.song.sectionMarkers.some(
        (entry) => entry.startSeconds > state.playbackPositionSeconds,
      );
      state.pendingMarkerJump = hasMarkerAhead ? createPendingJump(marker, "next_marker") : null;
      return clone(buildSnapshot());
    }

    state.pendingMarkerJump = createPendingJump(marker, `after_bars:${Math.max(1, bars ?? 1)}`);
    return clone(buildSnapshot());
  },
  cancelMarkerJump: async () => {
    state.pendingMarkerJump = null;
    return clone(buildSnapshot());
  },
  moveClip: async (clipId: string, timelineStartSeconds: number) => {
    replaceSong({
      ...state.song,
      clips: state.song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
            }
          : clip,
      ),
    });
    return clone(buildSnapshot());
  },
  moveClipLive: async (_clipId: string, _timelineStartSeconds: number) => {},
  deleteClip: async (clipId: string) => {
    replaceSong({
      ...state.song,
      clips: state.song.clips.filter((clip) => clip.id !== clipId),
    });
    return clone(buildSnapshot());
  },
  updateClipWindow: async (args: { clipId: string; sourceStartSeconds: number; durationSeconds: number }) => {
    replaceSong({
      ...state.song,
      clips: state.song.clips.map((clip) =>
        clip.id === args.clipId
          ? {
              ...clip,
              sourceStartSeconds: Math.max(0, args.sourceStartSeconds),
              durationSeconds: Math.max(0.01, args.durationSeconds),
            }
          : clip,
      ),
    });
    return clone(buildSnapshot());
  },
  duplicateClip: async (clipId: string, timelineStartSeconds: number) => {
    const clip = state.song.clips.find((entry) => entry.id === clipId) ?? null;
    if (!clip) {
      return clone(buildSnapshot());
    }

    replaceSong({
      ...state.song,
      clips: [
        ...state.song.clips,
        {
          ...clip,
          id: nextId("clip"),
          timelineStartSeconds,
        },
      ],
    });
    return clone(buildSnapshot());
  },
  splitClip: async (clipId: string, splitSeconds: number) => {
    const clip = state.song.clips.find((entry) => entry.id === clipId) ?? null;
    if (!clip) {
      return clone(buildSnapshot());
    }

    const splitOffset = splitSeconds - clip.timelineStartSeconds;
    if (splitOffset <= 0 || splitOffset >= clip.durationSeconds) {
      return clone(buildSnapshot());
    }

    const nextClips = state.song.clips.flatMap((entry) => {
      if (entry.id !== clipId) {
        return [entry];
      }

      return [
        {
          ...entry,
          durationSeconds: splitOffset,
        },
        {
          ...entry,
          id: nextId("clip"),
          timelineStartSeconds: splitSeconds,
          sourceStartSeconds: entry.sourceStartSeconds + splitOffset,
          durationSeconds: entry.durationSeconds - splitOffset,
        },
      ];
    });

    replaceSong({
      ...state.song,
      clips: nextClips,
    });
    return clone(buildSnapshot());
  },
  createSongRegion: async (startSeconds: number, endSeconds: number) => {
    replaceSong({
      ...state.song,
      regions: [...state.song.regions, createRegionFromSelection(startSeconds, endSeconds)],
    });
    return clone(buildSnapshot());
  },
  updateSongRegion: async (args: { regionId: string; name?: string; startSeconds?: number; endSeconds?: number }) => {
    replaceSong({
      ...state.song,
      regions: state.song.regions.map((region) =>
        region.id === args.regionId
          ? {
              ...region,
              name: args.name ?? region.name,
              startSeconds: args.startSeconds ?? region.startSeconds,
              endSeconds: args.endSeconds ?? region.endSeconds,
            }
          : region,
      ),
    });
    return clone(buildSnapshot());
  },
  deleteSongRegion: async (regionId: string) => {
    replaceSong({
      ...state.song,
      regions: state.song.regions.filter((region) => region.id !== regionId),
    });
    return clone(buildSnapshot());
  },
  createSectionMarker: async (startSeconds: number) => {
    const markerNumber = state.song.sectionMarkers.length + 1;
    replaceSong({
      ...state.song,
      sectionMarkers: [
        ...state.song.sectionMarkers,
        {
          id: nextId("section"),
          name: `Marker ${markerNumber}`,
          startSeconds: Math.max(0, startSeconds),
          digit: null,
        },
      ],
    });
    return clone(buildSnapshot());
  },
  updateSectionMarker: async (args: { sectionId: string; name?: string; startSeconds?: number }) => {
    replaceSong({
      ...state.song,
      sectionMarkers: state.song.sectionMarkers.map((marker) =>
        marker.id === args.sectionId
          ? {
              ...marker,
              name: args.name ?? marker.name,
              startSeconds: args.startSeconds ?? marker.startSeconds,
            }
          : marker,
      ),
    });
    return clone(buildSnapshot());
  },
  deleteSectionMarker: async (sectionId: string) => {
    replaceSong({
      ...state.song,
      sectionMarkers: state.song.sectionMarkers.filter((marker) => marker.id !== sectionId),
    });
    return clone(buildSnapshot());
  },
  assignSectionMarkerDigit: async (sectionId: string, digit: number | null) => {
    replaceSong({
      ...state.song,
      sectionMarkers: state.song.sectionMarkers.map((marker) =>
        marker.id === sectionId
          ? {
              ...marker,
              digit,
            }
          : marker,
      ),
    });
    return clone(buildSnapshot());
  },
  createTrack: async (args: {
    name: string;
    kind: TrackKind;
    insertAfterTrackId?: string | null;
    parentTrackId?: string | null;
  }) => {
    const nextTracks = [...state.song.tracks];
    nextTracks.splice(getTrackInsertIndex(args.insertAfterTrackId ?? null, args.parentTrackId ?? null), 0, {
      id: nextId("track"),
      name: args.name,
      kind: args.kind,
      parentTrackId: args.parentTrackId ?? null,
      depth: 0,
      hasChildren: false,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
    });
    replaceSong({
      ...state.song,
      tracks: nextTracks,
    });
    return clone(buildSnapshot());
  },
  createClip: async (args: CreateClipArgs) => testDesktopApiMock.createClipsBatch([args]),
  createClipsBatch: async (args: CreateClipArgs[]) => {
    const nextClips = [...state.song.clips];
    for (const entry of args) {
      const track = getTrack(entry.trackId);
      const asset = findLibraryAsset(entry.filePath);
      const durationSeconds = asset?.durationSeconds ?? 180;
      ensureWaveform(entry.filePath, durationSeconds);
      nextClips.push({
        id: nextId("clip"),
        trackId: entry.trackId,
        trackName: track?.name ?? entry.trackId,
        filePath: entry.filePath,
        waveformKey: entry.filePath,
        timelineStartSeconds: Math.max(0, entry.timelineStartSeconds),
        sourceStartSeconds: 0,
        sourceDurationSeconds: durationSeconds,
        durationSeconds,
        gain: 1,
      });
    }
    replaceSong({
      ...state.song,
      clips: nextClips,
    });
    return clone(buildSnapshot());
  },
  moveTrack: async (args: {
    trackId: string;
    insertAfterTrackId?: string | null;
    insertBeforeTrackId?: string | null;
    parentTrackId?: string | null;
  }) => {
    const tracks = [...state.song.tracks];
    const startIndex = tracks.findIndex((track) => track.id === args.trackId);
    if (startIndex < 0) {
      return clone(buildSnapshot());
    }

    const rootDepth = tracks[startIndex]?.depth ?? 0;
    let endIndex = startIndex + 1;
    while ((tracks[endIndex]?.depth ?? -1) > rootDepth) {
      endIndex += 1;
    }

    const block = tracks.splice(startIndex, endIndex - startIndex);
    block[0] = {
      ...block[0],
      parentTrackId: args.parentTrackId ?? null,
    };

    const insertIndex = args.insertBeforeTrackId
      ? Math.max(0, tracks.findIndex((track) => track.id === args.insertBeforeTrackId))
      : (() => {
          if (args.insertAfterTrackId) {
            const anchorIndex = tracks.findIndex((track) => track.id === args.insertAfterTrackId);
            if (anchorIndex >= 0) {
              const anchorDepth = tracks[anchorIndex]?.depth ?? 0;
              let end = anchorIndex + 1;
              while ((tracks[end]?.depth ?? -1) > anchorDepth) {
                end += 1;
              }
              return end;
            }
          }

          return getTrackInsertIndex(null, args.parentTrackId ?? null);
        })();

    tracks.splice(insertIndex, 0, ...block);
    replaceSong({
      ...state.song,
      tracks,
    });
    return clone(buildSnapshot());
  },
  updateTrack: async (args: {
    trackId: string;
    name?: string;
    muted?: boolean;
    solo?: boolean;
    volume?: number;
    pan?: number;
  }) => {
    replaceSong({
      ...state.song,
      tracks: state.song.tracks.map((track) =>
        track.id === args.trackId
          ? {
              ...track,
              name: args.name ?? track.name,
              muted: args.muted ?? track.muted,
              solo: args.solo ?? track.solo,
              volume: args.volume ?? track.volume,
              pan: args.pan ?? track.pan,
            }
          : track,
      ),
    });
    return clone(buildSnapshot());
  },
  updateTrackMixLive: async (args: {
    trackId: string;
    muted?: boolean;
    solo?: boolean;
    volume?: number;
    pan?: number;
  }) => {
    replaceSong({
      ...state.song,
      tracks: state.song.tracks.map((track) =>
        track.id === args.trackId
          ? {
              ...track,
              muted: args.muted ?? track.muted,
              solo: args.solo ?? track.solo,
              volume: args.volume ?? track.volume,
              pan: args.pan ?? track.pan,
            }
          : track,
      ),
    });
  },
  deleteTrack: async (trackId: string) => {
    const track = getTrack(trackId);
    if (!track) {
      return clone(buildSnapshot());
    }

    const nextTracks = state.song.tracks
      .filter((entry) => entry.id !== trackId)
      .map((entry) =>
        entry.parentTrackId === trackId
          ? {
              ...entry,
              parentTrackId: track.parentTrackId ?? null,
            }
          : entry,
      );

    replaceSong({
      ...state.song,
      tracks: nextTracks,
      clips: track.kind === "audio"
        ? state.song.clips.filter((clip) => clip.trackId !== trackId)
        : state.song.clips,
    });
    return clone(buildSnapshot());
  },
};