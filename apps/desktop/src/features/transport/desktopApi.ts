import { getCumulativeMusicalPosition, type TimelineRegion } from "./timelineMath";

export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type TrackKind = "audio" | "folder";
export type JumpTriggerLabel = "immediate" | "next_marker" | `after_bars:${number}`;

export type SectionMarkerSummary = {
  id: string;
  name: string;
  startSeconds: number;
  digit?: number | null;
};

export type SongRegionSummary = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
};

export type SongTempoRegionSummary = SongRegionSummary & TimelineRegion;

export type TempoMarkerSummary = {
  id: string;
  startSeconds: number;
  bpm: number;
};

export type PendingJumpSummary = {
  targetMarkerId: string;
  targetMarkerName: string;
  targetDigit?: number | null;
  trigger: JumpTriggerLabel;
  executeAtSeconds: number;
};

export type TrackSummary = {
  id: string;
  name: string;
  kind: TrackKind;
  parentTrackId?: string | null;
  depth: number;
  hasChildren: boolean;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

export type ClipSummary = {
  id: string;
  trackId: string;
  trackName: string;
  filePath: string;
  waveformKey: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  sourceDurationSeconds: number;
  durationSeconds: number;
  gain: number;
};

export type SongView = {
  id: string;
  title: string;
  artist?: string | null;
  key?: string | null;
  bpm: number;
  timeSignature: string;
  durationSeconds: number;
  tempoMarkers: TempoMarkerSummary[];
  regions: SongRegionSummary[];
  sectionMarkers: SectionMarkerSummary[];
  clips: ClipSummary[];
  tracks: TrackSummary[];
  projectRevision: number;
};

export type WaveformSummaryDto = {
  waveformKey: string;
  version: number;
  durationSeconds: number;
  sampleRate: number;
  lods: WaveformLodDto[];
  isPreview?: boolean;
};

export type WaveformLodDto = {
  resolutionFrames: number;
  bucketCount: number;
  minPeaks?: number[];
  maxPeaks?: number[];
  minPeaksBase64?: string;
  maxPeaksBase64?: string;
};

export type LibraryAssetSummary = {
  fileName: string;
  filePath: string;
  durationSeconds: number;
  detectedBpm?: number | null;
  folderPath?: string | null;
};

export type DesktopPerformanceSnapshot = {
  copyMillis: number;
  wavAnalysisMillis: number;
  waveformWriteMillis: number;
  songSaveMillis: number;
  transportSnapshotBuildMillis: number;
  songViewBuildMillis: number;
  waveformCacheHits: number;
  waveformCacheMisses: number;
  transportSnapshotBytes: number;
  songViewBytes: number;
  lastReactRenderMillis: number;
  projectRevision: number;
  cachedWaveforms: number;
};

function downsampleWaveformLod(lod: WaveformLodDto, targetResolutionFrames: number): WaveformLodDto {
  const sourceMin = lod.minPeaks ?? [];
  const sourceMax = lod.maxPeaks ?? [];
  const chunkSize = Math.max(1, Math.ceil(targetResolutionFrames / Math.max(1, lod.resolutionFrames)));
  const minPeaks: number[] = [];
  const maxPeaks: number[] = [];

  for (let chunkStart = 0; chunkStart < sourceMax.length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(sourceMax.length, chunkStart + chunkSize);
    let minPeak = 1;
    let maxPeak = -1;

    for (let index = chunkStart; index < chunkEnd; index += 1) {
      minPeak = Math.min(minPeak, sourceMin[index] ?? 0);
      maxPeak = Math.max(maxPeak, sourceMax[index] ?? 0);
    }

    minPeaks.push(minPeak);
    maxPeaks.push(maxPeak);
  }

  return {
    resolutionFrames: targetResolutionFrames,
    bucketCount: maxPeaks.length,
    minPeaks,
    maxPeaks,
  };
}

export function buildWaveformLodsFromPeaks(
  minPeaks: number[],
  maxPeaks: number[],
  durationSeconds: number,
  sampleRate: number,
): WaveformLodDto[] {
  const safeSampleRate = Math.max(1, Math.round(sampleRate));
  const safeDurationSeconds = Math.max(durationSeconds, 0.001);
  const baseResolutionFrames = Math.max(
    1,
    Math.ceil((safeDurationSeconds * safeSampleRate) / Math.max(1, maxPeaks.length)),
  );
  const lods: WaveformLodDto[] = [
    {
      resolutionFrames: baseResolutionFrames,
      bucketCount: maxPeaks.length,
      minPeaks,
      maxPeaks,
    },
  ];

  for (const targetResolutionFrames of [2048, 16384, 131072]) {
    const previous = lods[lods.length - 1];
    if (targetResolutionFrames <= previous.resolutionFrames) {
      continue;
    }

    lods.push(downsampleWaveformLod(previous, targetResolutionFrames));
  }

  return lods;
}

export type TransportSnapshot = {
  playbackState: PlaybackState;
  positionSeconds: number;
  currentMarker?: SectionMarkerSummary | null;
  pendingMarkerJump?: PendingJumpSummary | null;
  musicalPosition?: {
    barNumber: number;
    beatInBar: number;
    subBeat: number;
    display: string;
  };
  transportClock?: {
    anchorPositionSeconds: number;
    running: boolean;
    lastSeekPositionSeconds?: number | null;
    lastStartPositionSeconds?: number | null;
    lastJumpPositionSeconds?: number | null;
  };
  projectRevision: number;
  songDir?: string | null;
  songFilePath?: string | null;
  isNativeRuntime: boolean;
};

export type TransportClock = NonNullable<TransportSnapshot["transportClock"]>;

const SONG_TEMPO_REGION_VISUAL_END_SECONDS = 1_000_000;

export type TransportLifecycleEventKind = "play" | "pause" | "stop" | "seek";

export type TransportLifecycleEvent = {
  kind: TransportLifecycleEventKind;
  snapshot: TransportSnapshot;
  anchorPositionSeconds: number;
  emittedAtUnixMs: number;
};

export type AudioMeterLevel = {
  trackId: string;
  leftPeak: number;
  rightPeak: number;
};

export type AppSettings = {
  selectedOutputDevice?: string | null;
  splitStereoEnabled: boolean;
  locale?: string | null;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  selectedOutputDevice: null,
  splitStereoEnabled: false,
  locale: null,
};

export function normalizeAppSettings(settings: AppSettings): AppSettings {
  const selectedOutputDevice = settings.selectedOutputDevice?.trim() || null;
  const locale = settings.locale?.trim().toLowerCase();

  return {
    selectedOutputDevice,
    splitStereoEnabled: Boolean(settings.splitStereoEnabled),
    locale: locale === "en" || locale === "es" ? locale : null,
  };
}

export type AudioOutputDevices = {
  devices: string[];
  defaultDevice?: string | null;
};

export type LibraryImportProgressEvent = {
  percent: number;
  message: string;
};

export type WaveformReadyEvent = {
  songDir: string;
  waveformKey: string;
  summary: WaveformSummaryDto;
};

export type CreateClipArgs = {
  trackId: string;
  filePath: string;
  timelineStartSeconds: number;
};

const tauriWindow = window as Window & {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriApp = Boolean(tauriWindow.__TAURI_INTERNALS__);

type DemoClock = {
  anchorPositionSeconds: number;
  anchorStartedAt: number | null;
  lastSeekPositionSeconds: number | null;
  lastStartPositionSeconds: number | null;
  lastJumpPositionSeconds: number | null;
};

let demoSong = buildDemoSong();
let demoWaveforms = buildDemoWaveforms();
let demoLibraryAssets = buildDemoLibraryAssets(demoSong);
let demoLibraryFolders = collectDemoLibraryFolders(demoLibraryAssets);
let demoAppSettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
let demoPlaybackState: PlaybackState = "stopped";
let demoPendingJump: PendingJumpSummary | null = null;
let demoProjectRevision = demoSong.projectRevision;
let demoUndoStack: SongView[] = [];
let demoRedoStack: SongView[] = [];
let demoClock: DemoClock = {
  anchorPositionSeconds: 0,
  anchorStartedAt: null,
  lastSeekPositionSeconds: null,
  lastStartPositionSeconds: null,
  lastJumpPositionSeconds: null,
};

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function normalizeLibraryFolderPath(folderPath: string | null | undefined) {
  const normalized = folderPath?.trim().replace(/\\/g, "/").replace(/^\/|\/$/g, "") ?? "";
  if (!normalized) {
    return null;
  }

  return normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function collectDemoLibraryFolders(assets: LibraryAssetSummary[]) {
  const folders = new Set<string>();

  for (const asset of assets) {
    const folderPath = normalizeLibraryFolderPath(asset.folderPath);
    if (folderPath) {
      folders.add(folderPath);
    }
  }

  return [...folders].sort((left, right) => left.localeCompare(right));
}

function sortLibraryAssets(assets: LibraryAssetSummary[]) {
  return [...assets].sort((left, right) => {
    const leftFolder = normalizeLibraryFolderPath(left.folderPath) ?? "";
    const rightFolder = normalizeLibraryFolderPath(right.folderPath) ?? "";

    return leftFolder.localeCompare(rightFolder) || left.fileName.localeCompare(right.fileName);
  });
}

export async function listenToTransportLifecycle(
  handler: (event: TransportLifecycleEvent) => void,
): Promise<() => void> {
  if (!isTauriApp) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<TransportLifecycleEvent>("transport:lifecycle", (event) => {
    handler(event.payload);
  });
}

export async function listenToAudioMeters(
  handler: (levels: AudioMeterLevel[]) => void,
): Promise<() => void> {
  if (!isTauriApp) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<AudioMeterLevel[]>("audio:meters", (event) => {
    handler(event.payload);
  });
}

export async function listenToLibraryImportProgress(
  handler: (event: LibraryImportProgressEvent) => void,
): Promise<() => void> {
  if (!isTauriApp) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<LibraryImportProgressEvent>("library:import-progress", (event) => {
    handler(event.payload);
  });
}

export async function listenToWaveformReady(
  handler: (event: WaveformReadyEvent) => void,
): Promise<() => void> {
  if (!isTauriApp) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<WaveformReadyEvent>("waveform:ready", (event) => {
    handler(event.payload);
  });
}

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowSeconds() {
  return Date.now() / 1000;
}

function currentDemoPosition() {
  if (demoPlaybackState !== "playing" || demoClock.anchorStartedAt === null) {
    return demoClock.anchorPositionSeconds;
  }

  const elapsed = nowSeconds() - demoClock.anchorStartedAt;
  return demoClock.anchorPositionSeconds + elapsed;
}

function syncDemoPlayback() {
  const nextPosition = currentDemoPosition();
  demoClock.anchorPositionSeconds = nextPosition;

  if (demoPlaybackState === "playing") {
    demoClock.anchorStartedAt = nowSeconds();
  }
}

function updateDemoSong(mutator: (song: SongView) => SongView) {
  syncDemoPlayback();
  demoUndoStack.push(cloneSnapshot(demoSong));
  if (demoUndoStack.length > 50) {
    demoUndoStack.shift();
  }
  demoRedoStack = [];
  demoSong = normalizeSong(mutator(cloneSnapshot(demoSong)));
  demoProjectRevision += 1;
  demoSong.projectRevision = demoProjectRevision;
  demoWaveforms = Object.fromEntries(
    demoSong.clips
      .map((clip) => clip.waveformKey)
      .filter((waveformKey, index, keys) => keys.indexOf(waveformKey) === index)
      .map((waveformKey) => [waveformKey, demoWaveforms[waveformKey]])
      .filter((entry): entry is [string, WaveformSummaryDto] => Boolean(entry[1])),
  );
  demoClock.anchorPositionSeconds = Math.max(0, demoClock.anchorPositionSeconds);
}

function applyDemoHistorySong(song: SongView) {
  syncDemoPlayback();
  demoSong = normalizeSong(cloneSnapshot(song));
  demoProjectRevision += 1;
  demoSong.projectRevision = demoProjectRevision;
  demoWaveforms = Object.fromEntries(
    demoSong.clips
      .map((clip) => clip.waveformKey)
      .filter((waveformKey, index, keys) => keys.indexOf(waveformKey) === index)
      .map((waveformKey) => [waveformKey, demoWaveforms[waveformKey]])
      .filter((entry): entry is [string, WaveformSummaryDto] => Boolean(entry[1])),
  );
  demoClock.anchorPositionSeconds = Math.max(0, demoClock.anchorPositionSeconds);
}

function buildDemoSnapshot(): TransportSnapshot {
  syncDemoPlayback();
  const positionSeconds = demoClock.anchorPositionSeconds;
  const currentMarker =
    [...demoSong.sectionMarkers]
      .reverse()
      .find((marker) => positionSeconds >= marker.startSeconds) ?? null;

  return {
    playbackState: demoPlaybackState,
    positionSeconds,
    currentMarker,
    pendingMarkerJump: demoPendingJump ? cloneSnapshot(demoPendingJump) : null,
    musicalPosition: buildMusicalPosition(positionSeconds, demoSong),
    transportClock: {
      anchorPositionSeconds: demoClock.anchorPositionSeconds,
      running: demoPlaybackState === "playing",
      lastSeekPositionSeconds: demoClock.lastSeekPositionSeconds,
      lastStartPositionSeconds: demoClock.lastStartPositionSeconds,
      lastJumpPositionSeconds: demoClock.lastJumpPositionSeconds,
    },
    projectRevision: demoProjectRevision,
    songDir: "demo://session",
    songFilePath: "demo://session/song.ltsong",
    isNativeRuntime: false,
  };
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function getSongView(): Promise<SongView | null> {
  if (!isTauriApp) {
    return cloneSnapshot(demoSong);
  }

  return invokeCommand<SongView | null>("get_song_view");
}

export async function getWaveformSummaries(
  waveformKeys: string[],
): Promise<WaveformSummaryDto[]> {
  if (!isTauriApp) {
    return waveformKeys
      .map((waveformKey) => demoWaveforms[waveformKey])
      .filter((summary): summary is WaveformSummaryDto => Boolean(summary))
      .map((summary) => cloneSnapshot(summary));
  }

  return invokeCommand<WaveformSummaryDto[]>("get_waveform_summaries", { waveformKeys });
}

export async function getLibraryWaveformSummaries(
  filePaths: string[],
): Promise<WaveformSummaryDto[]> {
  if (!isTauriApp) {
    return filePaths
      .map((filePath) => demoWaveforms[filePath])
      .filter((summary): summary is WaveformSummaryDto => Boolean(summary))
      .map((summary) => cloneSnapshot(summary));
  }

  return invokeCommand<WaveformSummaryDto[]>("get_library_waveform_summaries", { filePaths });
}

export async function getLibraryAssets(): Promise<LibraryAssetSummary[]> {
  if (!isTauriApp) {
    return cloneSnapshot(sortLibraryAssets(demoLibraryAssets));
  }

  return invokeCommand<LibraryAssetSummary[]>("get_library_assets");
}

export async function getLibraryFolders(): Promise<string[]> {
  if (!isTauriApp) {
    const folders = new Set<string>(demoLibraryFolders);
    for (const folderPath of collectDemoLibraryFolders(demoLibraryAssets)) {
      folders.add(folderPath);
    }
    return [...folders].sort((left, right) => left.localeCompare(right));
  }

  return invokeCommand<string[]>("get_library_folders");
}

export async function getDesktopPerformanceSnapshot(): Promise<DesktopPerformanceSnapshot> {
  if (!isTauriApp) {
    return {
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
      projectRevision: demoProjectRevision,
      cachedWaveforms: Object.keys(demoWaveforms).length,
    };
  }

  return invokeCommand<DesktopPerformanceSnapshot>("get_desktop_performance_snapshot");
}

export async function getSettings(): Promise<AppSettings> {
  if (!isTauriApp) {
    return normalizeAppSettings(cloneSnapshot(demoAppSettings));
  }

  return invokeCommand<AppSettings>("get_settings");
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isTauriApp) {
    demoAppSettings = normalizeAppSettings(cloneSnapshot(settings));
    return cloneSnapshot(demoAppSettings);
  }

  return invokeCommand<AppSettings>("save_settings", { settings });
}

export async function updateAudioSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isTauriApp) {
    demoAppSettings = normalizeAppSettings(cloneSnapshot(settings));
    return cloneSnapshot(demoAppSettings);
  }

  return invokeCommand<AppSettings>("update_audio_settings", { settings });
}

export async function getAudioOutputDevices(): Promise<AudioOutputDevices> {
  if (!isTauriApp) {
    return {
      devices: ["Default Speakers", "USB Audio Interface"],
      defaultDevice: "Default Speakers",
    };
  }

  return invokeCommand<AudioOutputDevices>("get_audio_output_devices");
}

export async function reportUiRenderMetric(renderMillis: number): Promise<void> {
  if (!isTauriApp) {
    return;
  }

  await invokeCommand("report_ui_render_metric", { renderMillis });
}

export async function createSong(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    demoSong = normalizeSong({
      id: `song-demo-${Date.now()}`,
      title: "Nueva Cancion",
      artist: null,
      key: null,
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 60,
      tempoMarkers: [],
      regions: [],
      sectionMarkers: [],
      clips: [],
      tracks: [],
      projectRevision: demoProjectRevision + 1,
    });
    demoWaveforms = {};
    demoLibraryAssets = [];
    demoLibraryFolders = [];
    demoProjectRevision = demoSong.projectRevision;
    demoUndoStack = [];
    demoRedoStack = [];
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock = {
      anchorPositionSeconds: 0,
      anchorStartedAt: null,
      lastSeekPositionSeconds: 0,
      lastStartPositionSeconds: null,
      lastJumpPositionSeconds: null,
    };
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("create_song");
}

export async function saveProject(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("save_project");
}

export async function saveProjectAs(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("save_project_as");
}

export async function undoAction(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const previousSong = demoUndoStack.pop();
    if (!previousSong) {
      return buildDemoSnapshot();
    }

    demoRedoStack.push(cloneSnapshot(demoSong));
    applyDemoHistorySong(previousSong);
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("undo_action");
}

export async function redoAction(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const nextSong = demoRedoStack.pop();
    if (!nextSong) {
      return buildDemoSnapshot();
    }

    demoUndoStack.push(cloneSnapshot(demoSong));
    if (demoUndoStack.length > 50) {
      demoUndoStack.shift();
    }
    applyDemoHistorySong(nextSong);
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("redo_action");
}

export async function updateSongTempo(bpm: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      bpm: Math.max(1, bpm),
      tempoMarkers: [],
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_song_tempo", { bpm });
}

export async function upsertSongTempoMarker(
  startSeconds: number,
  bpm: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const clampedStartSeconds = Math.max(0, startSeconds);
      if (clampedStartSeconds <= 0.0001) {
        return {
          ...song,
          bpm: Math.max(1, bpm),
        };
      }

      const existingMarker = song.tempoMarkers.find(
        (marker) => Math.abs(marker.startSeconds - clampedStartSeconds) < 0.0001,
      );

      return {
        ...song,
        tempoMarkers: existingMarker
          ? song.tempoMarkers.map((marker) =>
              marker.id === existingMarker.id ? { ...marker, bpm: Math.max(1, bpm) } : marker,
            )
          : [
              ...song.tempoMarkers,
              {
                id: `tempo-marker-${Date.now()}`,
                startSeconds: clampedStartSeconds,
                bpm: Math.max(1, bpm),
              },
            ],
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("upsert_song_tempo_marker", { startSeconds, bpm });
}

export async function deleteSongTempoMarker(markerId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      tempoMarkers: song.tempoMarkers.filter((marker) => marker.id !== markerId),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_song_tempo_marker", { markerId });
}

export async function openProject(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    demoSong = buildDemoSong();
    demoWaveforms = buildDemoWaveforms();
    demoLibraryAssets = buildDemoLibraryAssets(demoSong);
    demoLibraryFolders = collectDemoLibraryFolders(demoLibraryAssets);
    demoProjectRevision = demoSong.projectRevision;
    demoUndoStack = [];
    demoRedoStack = [];
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock.anchorPositionSeconds = 0;
    demoClock.anchorStartedAt = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("open_project_from_dialog");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot | null>("pick_and_import_song_from_dialog");
}

export async function importLibraryAssetsFromDialog(): Promise<LibraryAssetSummary[] | null> {
  if (!isTauriApp) {
    const nextIndex = demoLibraryAssets.length + 1;
    demoLibraryAssets = [
      ...demoLibraryAssets,
      {
        fileName: `imported-${nextIndex}.wav`,
        filePath: `audio/imported-${nextIndex}.wav`,
        durationSeconds: 12 + nextIndex * 4,
        detectedBpm: 120,
        folderPath: null,
      },
    ];
    demoLibraryAssets = sortLibraryAssets(demoLibraryAssets);
    return cloneSnapshot(demoLibraryAssets);
  }

  return invokeCommand<LibraryAssetSummary[] | null>("import_library_assets_from_dialog");
}

export async function deleteLibraryAsset(filePath: string): Promise<LibraryAssetSummary[]> {
  if (!isTauriApp) {
    if (demoSong.clips.some((clip) => clip.filePath === filePath)) {
      throw new Error("cannot delete a library asset that is already used on the timeline");
    }

    demoLibraryAssets = demoLibraryAssets.filter((asset) => asset.filePath !== filePath);
    delete demoWaveforms[filePath];
    return cloneSnapshot(demoLibraryAssets);
  }

  return invokeCommand<LibraryAssetSummary[]>("delete_library_asset", { filePath });
}

export async function moveLibraryAsset(
  filePath: string,
  newFolderPath: string | null,
): Promise<LibraryAssetSummary[]> {
  if (!isTauriApp) {
    const normalizedFolderPath = normalizeLibraryFolderPath(newFolderPath);
    demoLibraryAssets = sortLibraryAssets(
      demoLibraryAssets.map((asset) =>
        asset.filePath === filePath
          ? {
              ...asset,
              folderPath: normalizedFolderPath,
            }
          : asset,
      ),
    );
    if (normalizedFolderPath) {
      demoLibraryFolders = [...new Set([...demoLibraryFolders, normalizedFolderPath])].sort((left, right) =>
        left.localeCompare(right),
      );
    }
    return cloneSnapshot(demoLibraryAssets);
  }

  return invokeCommand<LibraryAssetSummary[]>("move_library_asset", {
    filePath,
    newFolderPath,
  });
}

export async function createLibraryFolder(folderPath: string): Promise<string[]> {
  if (!isTauriApp) {
    const normalizedFolderPath = normalizeLibraryFolderPath(folderPath);
    if (!normalizedFolderPath) {
      throw new Error("folder path cannot be empty");
    }
    demoLibraryFolders = [...new Set([...demoLibraryFolders, normalizedFolderPath])].sort((left, right) =>
      left.localeCompare(right),
    );
    return cloneSnapshot(demoLibraryFolders);
  }

  return invokeCommand<string[]>("create_library_folder", { folderPath });
}

export async function renameLibraryFolder(
  oldFolderPath: string,
  newFolderPath: string,
): Promise<LibraryAssetSummary[]> {
  if (!isTauriApp) {
    const normalizedOldFolderPath = normalizeLibraryFolderPath(oldFolderPath);
    const normalizedNewFolderPath = normalizeLibraryFolderPath(newFolderPath);
    if (!normalizedOldFolderPath || !normalizedNewFolderPath) {
      throw new Error("folder path cannot be empty");
    }

    demoLibraryAssets = sortLibraryAssets(
      demoLibraryAssets.map((asset) => {
        const folderPath = normalizeLibraryFolderPath(asset.folderPath);
        if (!folderPath) {
          return asset;
        }

        if (folderPath !== normalizedOldFolderPath && !folderPath.startsWith(`${normalizedOldFolderPath}/`)) {
          return asset;
        }

        const suffix = folderPath.slice(normalizedOldFolderPath.length).replace(/^\//, "");
        return {
          ...asset,
          folderPath: suffix ? `${normalizedNewFolderPath}/${suffix}` : normalizedNewFolderPath,
        };
      }),
    );
    demoLibraryFolders = [...new Set(
      demoLibraryFolders.map((folderPath) => {
        const normalizedFolderPath = normalizeLibraryFolderPath(folderPath) ?? "";
        if (
          normalizedFolderPath !== normalizedOldFolderPath &&
          !normalizedFolderPath.startsWith(`${normalizedOldFolderPath}/`)
        ) {
          return normalizedFolderPath;
        }

        const suffix = normalizedFolderPath.slice(normalizedOldFolderPath.length).replace(/^\//, "");
        return suffix ? `${normalizedNewFolderPath}/${suffix}` : normalizedNewFolderPath;
      }),
    )].sort((left, right) => left.localeCompare(right));
    return cloneSnapshot(demoLibraryAssets);
  }

  return invokeCommand<LibraryAssetSummary[]>("rename_library_folder", {
    oldFolderPath,
    newFolderPath,
  });
}

export async function deleteLibraryFolder(folderPath: string): Promise<LibraryAssetSummary[]> {
  if (!isTauriApp) {
    const normalizedFolderPath = normalizeLibraryFolderPath(folderPath);
    if (!normalizedFolderPath) {
      throw new Error("folder path cannot be empty");
    }

    demoLibraryAssets = sortLibraryAssets(
      demoLibraryAssets.map((asset) => {
        const assetFolderPath = normalizeLibraryFolderPath(asset.folderPath);
        if (!assetFolderPath) {
          return asset;
        }

        return assetFolderPath === normalizedFolderPath || assetFolderPath.startsWith(`${normalizedFolderPath}/`)
          ? {
              ...asset,
              folderPath: null,
            }
          : asset;
      }),
    );
    demoLibraryFolders = demoLibraryFolders.filter((existingFolderPath) => {
      const normalizedExistingFolderPath = normalizeLibraryFolderPath(existingFolderPath);
      return !normalizedExistingFolderPath || (
        normalizedExistingFolderPath !== normalizedFolderPath &&
        !normalizedExistingFolderPath.startsWith(`${normalizedFolderPath}/`)
      );
    });
    return cloneSnapshot(demoLibraryAssets);
  }

  return invokeCommand<LibraryAssetSummary[]>("delete_library_folder", { folderPath });
}

export async function playTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    syncDemoPlayback();
    demoPlaybackState = "playing";
    demoClock.anchorStartedAt = nowSeconds();
    demoClock.lastStartPositionSeconds = demoClock.anchorPositionSeconds;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("play_transport");
}

export async function pauseTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    syncDemoPlayback();
    demoPlaybackState = "paused";
    demoClock.anchorStartedAt = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("pause_transport");
}

export async function stopTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoPlaybackState = "stopped";
    demoPendingJump = null;
    demoClock.anchorPositionSeconds = 0;
    demoClock.anchorStartedAt = null;
    demoClock.lastSeekPositionSeconds = 0;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("stop_transport");
}

export async function seekTransport(positionSeconds: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoClock.anchorPositionSeconds = Math.max(0, positionSeconds);
    demoClock.anchorStartedAt = demoPlaybackState === "playing" ? nowSeconds() : null;
    demoClock.lastSeekPositionSeconds = demoClock.anchorPositionSeconds;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("seek_transport", { positionSeconds });
}

export async function scheduleMarkerJump(
  targetMarkerId: string,
  trigger: "immediate" | "next_marker" | "after_bars",
  bars?: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    syncDemoPlayback();
    const currentPosition = demoClock.anchorPositionSeconds;
    const targetMarker = demoSong.sectionMarkers.find((marker) => marker.id === targetMarkerId) ?? null;
    if (targetMarker) {
      if (trigger === "immediate") {
        demoClock.anchorPositionSeconds = targetMarker.startSeconds;
        demoClock.lastJumpPositionSeconds = targetMarker.startSeconds;
        demoPendingJump = null;
      } else {
        const nextMarkerAhead =
          trigger === "next_marker"
            ? demoSong.sectionMarkers.find((marker) => marker.startSeconds > currentPosition) ?? null
            : null;

        if (trigger === "next_marker" && !nextMarkerAhead) {
          demoPendingJump = null;
          return buildDemoSnapshot();
        }

        demoPendingJump = {
          targetMarkerId,
          targetMarkerName: targetMarker.name,
          targetDigit: targetMarker.digit ?? null,
          trigger: trigger === "after_bars" ? `after_bars:${bars ?? 4}` : "next_marker",
          executeAtSeconds: nextMarkerAhead?.startSeconds ?? demoClock.anchorPositionSeconds,
        };
      }
    }
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("schedule_marker_jump", {
    targetMarkerId,
    trigger,
    bars,
  });
}

export async function cancelMarkerJump(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    demoPendingJump = null;
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("cancel_marker_jump");
}

export async function moveClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
            }
          : clip,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("move_clip", { clipId, timelineStartSeconds });
}

export async function moveClipLive(
  clipId: string,
  timelineStartSeconds: number,
): Promise<void> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
            }
          : clip,
      ),
    }));
    return;
  }

  await invokeCommand("move_clip_live", { clipId, timelineStartSeconds });
}

export async function deleteClip(clipId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.filter((clip) => clip.id !== clipId),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_clip", { clipId });
}

export async function updateClipWindow(
  clipId: string,
  timelineStartSeconds: number,
  sourceStartSeconds: number,
  durationSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      clips: song.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              timelineStartSeconds: Math.max(0, timelineStartSeconds),
              sourceStartSeconds: Math.max(0, sourceStartSeconds),
              durationSeconds: Math.max(0.05, durationSeconds),
            }
          : clip,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_clip_window", {
    clipId,
    timelineStartSeconds,
    sourceStartSeconds,
    durationSeconds,
  });
}

export async function duplicateClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const sourceClip = song.clips.find((clip) => clip.id === clipId);
      if (!sourceClip) {
        return song;
      }

      return {
        ...song,
        clips: [
          ...song.clips,
          {
            ...sourceClip,
            id: `clip-demo-${Date.now()}`,
            timelineStartSeconds: Math.max(0, timelineStartSeconds),
          },
        ],
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("duplicate_clip", { clipId, timelineStartSeconds });
}

export async function splitClip(
  clipId: string,
  splitSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const index = song.clips.findIndex((clip) => clip.id === clipId);
      if (index === -1) {
        return song;
      }

      const sourceClip = song.clips[index];
      const clipEnd = sourceClip.timelineStartSeconds + sourceClip.durationSeconds;
      if (splitSeconds <= sourceClip.timelineStartSeconds || splitSeconds >= clipEnd) {
        return song;
      }

      const leftDuration = splitSeconds - sourceClip.timelineStartSeconds;
      const rightDuration = clipEnd - splitSeconds;
      const clips = [...song.clips];
      clips.splice(index, 1, {
        ...sourceClip,
        id: `${sourceClip.id}-a`,
        durationSeconds: leftDuration,
      }, {
        ...sourceClip,
        id: `${sourceClip.id}-b`,
        timelineStartSeconds: splitSeconds,
        sourceStartSeconds: sourceClip.sourceStartSeconds + leftDuration,
        durationSeconds: rightDuration,
      });

      return {
        ...song,
        clips,
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("split_clip", { clipId, splitSeconds });
}

export async function createSongRegion(
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const bounds = sanitizeDemoRegionBounds(song, startSeconds, endSeconds);
      if (!bounds) {
        return song;
      }

      const [clampedStartSeconds, clampedEndSeconds] = bounds;
      const template = getDemoRegionTemplate(song, clampedStartSeconds, clampedEndSeconds);
      return replaceDemoRegionRange(song, {
        id: `region-demo-${Date.now()}-${song.regions.length}`,
        name: `Region ${song.regions.length}`,
        startSeconds: clampedStartSeconds,
        endSeconds: clampedEndSeconds,
      });
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_song_region", { startSeconds, endSeconds });
}

export async function updateSongRegion(
  regionId: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const existingRegion = song.regions.find((region) => region.id === regionId);
      const trimmedName = name.trim();
      const bounds = sanitizeDemoRegionBounds(song, startSeconds, endSeconds);
      if (!existingRegion || !trimmedName || !bounds) {
        return song;
      }

      const [clampedStartSeconds, clampedEndSeconds] = bounds;
      return replaceDemoRegionRange(song, {
        ...existingRegion,
        name: trimmedName,
        startSeconds: clampedStartSeconds,
        endSeconds: clampedEndSeconds,
      });
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_song_region", {
    regionId,
    name,
    startSeconds,
    endSeconds,
  });
}

export async function deleteSongRegion(regionId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const regionIndex = song.regions.findIndex((region) => region.id === regionId);
      if (regionIndex === -1) {
        return song;
      }

      const regions = [...song.regions];
      const [deletedRegion] = regions.splice(regionIndex, 1);
      if (!deletedRegion) {
        return song;
      }

      if (regions.length === 0) {
        return {
          ...song,
          regions,
        };
      }

      if (regionIndex > 0) {
        const previousRegion = regions[regionIndex - 1];
        if (previousRegion) {
          previousRegion.endSeconds = deletedRegion.endSeconds;
        }
      } else {
        const nextRegion = regions[0];
        if (nextRegion) {
          nextRegion.startSeconds = deletedRegion.startSeconds;
        }
      }

      return {
        ...song,
        regions,
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_song_region", { regionId });
}

export async function createSectionMarker(startSeconds: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sectionMarkers: [...song.sectionMarkers, {
        id: `section-marker-demo-${Date.now()}`,
        name: `Marker ${song.sectionMarkers.length}`,
        startSeconds: Math.max(0, startSeconds),
        digit: null,
      }],
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_section_marker", { startSeconds });
}

export async function updateSectionMarker(
  sectionId: string,
  name: string,
  startSeconds: number,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sectionMarkers: song.sectionMarkers.map((marker) =>
        marker.id === sectionId
          ? {
              ...marker,
              name,
              startSeconds,
            }
          : marker,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_section_marker", {
    sectionId,
    name,
    startSeconds,
  });
}

export async function deleteSectionMarker(sectionId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sectionMarkers: song.sectionMarkers.filter((marker) => marker.id !== sectionId),
    }));
    if (demoPendingJump?.targetMarkerId === sectionId) {
      demoPendingJump = null;
    }
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_section_marker", { sectionId });
}

export async function assignSectionMarkerDigit(
  sectionId: string,
  digit: number | null,
): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      sectionMarkers: song.sectionMarkers.map((marker) => {
        if (marker.id === sectionId) {
          return { ...marker, digit };
        }
        if (digit !== null && marker.digit === digit) {
          return { ...marker, digit: null };
        }
        return marker;
      }),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("assign_section_marker_digit", { sectionId, digit });
}

export async function createTrack(args: {
  name: string;
  kind: TrackKind;
  insertAfterTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => {
      const nextTrack: TrackSummary = {
        id: `track-demo-${Date.now()}`,
        name: args.name,
        kind: args.kind,
        parentTrackId: args.parentTrackId ?? null,
        depth: 0,
        hasChildren: false,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
      };
      return {
        ...song,
        tracks: insertTrack(song.tracks, nextTrack, args.insertAfterTrackId ?? null, args.parentTrackId ?? null),
      };
    });
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_track", args);
}

export async function createClip(args: {
  trackId: string;
  filePath: string;
  timelineStartSeconds: number;
}): Promise<TransportSnapshot> {
  return createClipsBatch([args]);
}

export async function createClipsBatch(args: CreateClipArgs[]): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    const nextArgs = args.filter((entry) => {
      const track = demoSong.tracks.find((candidate) => candidate.id === entry.trackId);
      return Boolean(track && track.kind !== "folder");
    });

    if (!nextArgs.length) {
      return buildDemoSnapshot();
    }

    updateDemoSong((song) => ({
      ...song,
      clips: [
        ...song.clips,
        ...nextArgs.map((entry, index) => {
          const track = song.tracks.find((candidate) => candidate.id === entry.trackId);
          const asset = demoLibraryAssets.find((candidate) => candidate.filePath === entry.filePath);
          const durationSeconds = asset?.durationSeconds ?? 8;

          if (!demoWaveforms[entry.filePath]) {
            const generatedWaveform = buildWaveform(96, "smooth");
            demoWaveforms[entry.filePath] = {
              waveformKey: entry.filePath,
              version: 3,
              durationSeconds,
              sampleRate: 48_000,
              lods: buildWaveformLodsFromPeaks(
                generatedWaveform.min,
                generatedWaveform.max,
                durationSeconds,
                48_000,
              ),
            };
          }

          return {
            id: `clip-demo-${Date.now()}-${index}`,
            trackId: entry.trackId,
            trackName: track?.name ?? entry.trackId,
            filePath: entry.filePath,
            waveformKey: entry.filePath,
            timelineStartSeconds: Math.max(0, entry.timelineStartSeconds),
            sourceStartSeconds: 0,
            sourceDurationSeconds: durationSeconds,
            durationSeconds,
            gain: 1,
          };
        }),
      ],
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("create_clips_batch", { requests: args });
}

export async function moveTrack(args: {
  trackId: string;
  insertAfterTrackId?: string | null;
  insertBeforeTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      tracks: moveTrackInList(
        song.tracks,
        args.trackId,
        args.insertAfterTrackId ?? null,
        args.insertBeforeTrackId ?? null,
        args.parentTrackId ?? null,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("move_track", args);
}

export async function updateTrack(args: {
  trackId: string;
  name?: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => ({
      ...song,
      tracks: song.tracks.map((track) =>
        track.id === args.trackId
          ? {
              ...track,
              name: args.name ?? track.name,
              volume: args.volume ?? track.volume,
              pan: args.pan ?? track.pan,
              muted: args.muted ?? track.muted,
              solo: args.solo ?? track.solo,
            }
          : track,
      ),
    }));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("update_track", args);
}

export async function updateTrackMixLive(args: {
  trackId: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<void> {
  if (!isTauriApp) {
    syncDemoPlayback();
    demoSong = normalizeSong({
      ...demoSong,
      tracks: demoSong.tracks.map((track) =>
        track.id === args.trackId
          ? {
              ...track,
              volume: args.volume ?? track.volume,
              pan: args.pan ?? track.pan,
              muted: args.muted ?? track.muted,
              solo: args.solo ?? track.solo,
            }
          : track,
      ),
    });
    demoSong.projectRevision = demoProjectRevision;
    return;
  }

  await invokeCommand("update_track_mix_live", args);
}

export async function deleteTrack(trackId: string): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    updateDemoSong((song) => deleteTrackFromSong(song, trackId));
    return buildDemoSnapshot();
  }

  return invokeCommand<TransportSnapshot>("delete_track", { trackId });
}

function deleteTrackFromSong(song: SongView, trackId: string): SongView {
  const track = song.tracks.find((entry) => entry.id === trackId);
  if (!track) {
    return song;
  }

  const nextTracks = song.tracks
    .filter((entry) => entry.id !== trackId)
    .map((entry) =>
      entry.parentTrackId === trackId ? { ...entry, parentTrackId: track.parentTrackId ?? null } : entry,
    );

  return {
    ...song,
    tracks: nextTracks,
    clips: track.kind === "audio" ? song.clips.filter((clip) => clip.trackId !== trackId) : song.clips,
  };
}

function normalizeSong(song: SongView): SongView {
  const bpm = Number.isFinite(song.bpm) && song.bpm > 0 ? song.bpm : 120;
  const timeSignature = song.timeSignature?.trim() ? song.timeSignature : "4/4";
  const tempoMarkers = [...(song.tempoMarkers ?? [])]
    .map((marker) => ({
      ...marker,
      startSeconds: Math.max(0, marker.startSeconds),
      bpm: Number.isFinite(marker.bpm) && marker.bpm > 0 ? marker.bpm : bpm,
    }))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const regions = [...song.regions].sort((left, right) => {
    if (left.startSeconds !== right.startSeconds) {
      return left.startSeconds - right.startSeconds;
    }

    return left.endSeconds - right.endSeconds;
  });
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
    regions.reduce((maxDuration, region) => Math.max(maxDuration, region.endSeconds), 0),
    normalizedClips.reduce(
      (maxDuration, clip) => Math.max(maxDuration, clip.timelineStartSeconds + clip.durationSeconds),
      0,
    ),
  );
  const sectionMarkers = [...song.sectionMarkers]
    .sort((left, right) => left.startSeconds - right.startSeconds);

  return {
    ...song,
    bpm,
    timeSignature,
    durationSeconds,
    tempoMarkers,
    regions,
    tracks: normalizedTracks,
    clips: normalizedClips,
    sectionMarkers,
  };
}

export function buildSongTempoRegions(song: SongView | null | undefined): SongTempoRegionSummary[] {
  if (!song) {
    return [];
  }

  const markers = [...song.tempoMarkers]
    .filter((marker) => marker.startSeconds > 0)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const regions: SongTempoRegionSummary[] = [];
  let startSeconds = 0;
  let bpm = getSongBaseBpm(song);

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
      timeSignature: getSongBaseTimeSignature(song),
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
    timeSignature: getSongBaseTimeSignature(song),
  });

  return regions;
}

function sanitizeDemoRegionBounds(
  song: SongView,
  startSeconds: number,
  endSeconds: number,
): [number, number] | null {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return null;
  }

  const clampedStartSeconds = clamp(startSeconds, 0, Math.max(song.durationSeconds - 0.0001, 0));
  const clampedEndSeconds = clamp(endSeconds, 0, song.durationSeconds);
  if (clampedEndSeconds <= clampedStartSeconds) {
    return null;
  }

  return [clampedStartSeconds, clampedEndSeconds];
}

function getDemoRegionTemplate(
  song: SongView,
  startSeconds: number,
  endSeconds: number,
): SongRegionSummary {
  const probeSeconds = Math.min(
    (startSeconds + endSeconds) * 0.5,
    Math.max(song.durationSeconds - 0.0001, 0),
  );

  return (
    song.regions.find(
      (region) => probeSeconds >= region.startSeconds && probeSeconds < region.endSeconds,
    ) ??
    song.regions.find(
      (region) => startSeconds >= region.startSeconds && startSeconds < region.endSeconds,
    ) ??
    getSongTempoRegionAtPosition(song, probeSeconds) ??
    song.regions[0] ?? {
      id: "region-template",
      name: song.title,
      startSeconds: 0,
      endSeconds: song.durationSeconds,
    }
  );
}

function replaceDemoRegionRange(song: SongView, replacement: SongRegionSummary): SongView {
  const timestamp = Date.now();
  let fragmentIndex = 0;
  const regions: SongRegionSummary[] = [];

  for (const region of song.regions) {
    if (region.endSeconds <= replacement.startSeconds || region.startSeconds >= replacement.endSeconds) {
      regions.push(region);
      continue;
    }

    if (region.startSeconds < replacement.startSeconds) {
      fragmentIndex += 1;
      regions.push({
        ...region,
        id: `${region.id}-fragment-${timestamp}-${fragmentIndex}`,
        endSeconds: replacement.startSeconds,
      });
    }

    if (region.endSeconds > replacement.endSeconds) {
      fragmentIndex += 1;
      regions.push({
        ...region,
        id: `${region.id}-fragment-${timestamp}-${fragmentIndex}`,
        startSeconds: replacement.endSeconds,
      });
    }
  }

  return {
    ...song,
    regions: [...regions, replacement],
  };
}

export function getPrimarySongRegion(song: SongView | null | undefined): SongRegionSummary | null {
  if (!song || song.regions.length === 0) {
    return null;
  }

  return song.regions[0] ?? null;
}

export function getSongBaseBpm(song: SongView | null | undefined): number {
  return song?.bpm ?? 120;
}

export function getSongBaseTimeSignature(song: SongView | null | undefined): string {
  return song?.timeSignature ?? "4/4";
}

export function getSongTempoRegionAtPosition(
  song: SongView | null | undefined,
  positionSeconds: number,
): SongTempoRegionSummary | null {
  const tempoRegions = buildSongTempoRegions(song);
  if (!tempoRegions.length) {
    return null;
  }

  return (
    tempoRegions.find(
      (region) => positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
    ) ??
    [...tempoRegions].reverse().find((region) => positionSeconds >= region.endSeconds) ??
    tempoRegions[0] ??
    null
  );
}

export function getSongRegionAtPosition(
  song: SongView | null | undefined,
  positionSeconds: number,
): SongRegionSummary | null {
  if (!song || song.regions.length === 0) {
    return null;
  }

  return (
    song.regions.find(
      (region) => positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
    ) ??
    [...song.regions].reverse().find((region) => positionSeconds >= region.endSeconds) ??
    song.regions[0] ??
    null
  );
}

function buildMusicalPosition(positionSeconds: number, song: SongView) {
  return getCumulativeMusicalPosition(
    positionSeconds,
    buildSongTempoRegions(song),
    song.bpm,
    song.timeSignature,
  );
}

function insertTrack(
  tracks: TrackSummary[],
  track: TrackSummary,
  insertAfterTrackId: string | null,
  parentTrackId: string | null,
) {
  const nextTracks = [...tracks];
  track.parentTrackId = parentTrackId;
  const insertIndex = resolveInsertIndex(nextTracks, insertAfterTrackId, null, parentTrackId);
  nextTracks.splice(insertIndex, 0, track);
  return nextTracks;
}

function moveTrackInList(
  tracks: TrackSummary[],
  trackId: string,
  insertAfterTrackId: string | null,
  insertBeforeTrackId: string | null,
  parentTrackId: string | null,
) {
  const nextTracks = [...tracks];
  const start = nextTracks.findIndex((track) => track.id === trackId);
  if (start === -1) {
    return nextTracks;
  }

  const rootDepth = nextTracks[start].depth;
  let end = start + 1;
  while (end < nextTracks.length && nextTracks[end].depth > rootDepth) {
    end += 1;
  }

  const block = nextTracks.splice(start, end - start);
  block[0] = {
    ...block[0],
    parentTrackId,
  };
  const insertIndex = resolveInsertIndex(
    nextTracks,
    insertAfterTrackId,
    insertBeforeTrackId,
    parentTrackId,
  );
  nextTracks.splice(insertIndex, 0, ...block);
  return nextTracks;
}

function resolveInsertIndex(
  tracks: TrackSummary[],
  insertAfterTrackId: string | null,
  insertBeforeTrackId: string | null,
  parentTrackId: string | null,
) {
  if (insertAfterTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === insertAfterTrackId);
    if (anchorIndex === -1) {
      return tracks.length;
    }

    const anchorDepth = tracks[anchorIndex].depth;
    let end = anchorIndex + 1;
    while (end < tracks.length && tracks[end].depth > anchorDepth) {
      end += 1;
    }
    return end;
  }

  if (insertBeforeTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === insertBeforeTrackId);
    return anchorIndex === -1 ? tracks.length : anchorIndex;
  }

  if (parentTrackId) {
    const anchorIndex = tracks.findIndex((track) => track.id === parentTrackId);
    if (anchorIndex === -1) {
      return tracks.length;
    }

    const anchorDepth = tracks[anchorIndex].depth;
    let end = anchorIndex + 1;
    while (end < tracks.length && tracks[end].depth > anchorDepth) {
      end += 1;
    }
    return end;
  }

  return tracks.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildDemoSong(): SongView {
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
        id: "region_1",
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

function buildDemoWaveforms(): Record<string, WaveformSummaryDto> {
  const rhythmWave = buildWaveform(176, "smooth");
  const bassWave = buildWaveform(176, "pulse");
  const clickWave = buildWaveform(176, "ticks");
  const vocalWave = buildWaveform(176, "phrases");

  return {
    "audio/drums.wav": {
      waveformKey: "audio/drums.wav",
      version: 3,
      durationSeconds: 180,
      sampleRate: 48_000,
      lods: buildWaveformLodsFromPeaks(rhythmWave.min, rhythmWave.max, 180, 48_000),
    },
    "audio/bass.wav": {
      waveformKey: "audio/bass.wav",
      version: 3,
      durationSeconds: 164,
      sampleRate: 48_000,
      lods: buildWaveformLodsFromPeaks(bassWave.min, bassWave.max, 164, 48_000),
    },
    "audio/click.wav": {
      waveformKey: "audio/click.wav",
      version: 3,
      durationSeconds: 180,
      sampleRate: 48_000,
      lods: buildWaveformLodsFromPeaks(clickWave.min, clickWave.max, 180, 48_000),
    },
    "audio/guide.wav": {
      waveformKey: "audio/guide.wav",
      version: 3,
      durationSeconds: 140,
      sampleRate: 48_000,
      lods: buildWaveformLodsFromPeaks(vocalWave.min, vocalWave.max, 140, 48_000),
    },
  };
}

function buildDemoLibraryAssets(song: SongView): LibraryAssetSummary[] {
  const assetsByPath = new Map<string, LibraryAssetSummary>();

  for (const clip of song.clips) {
    if (assetsByPath.has(clip.filePath)) {
      continue;
    }

    const fileName = clip.filePath.split("/").at(-1) ?? clip.filePath;
    assetsByPath.set(clip.filePath, {
      fileName,
      filePath: clip.filePath,
      durationSeconds: clip.sourceDurationSeconds,
      detectedBpm: clip.filePath.includes("click") ? 120 : null,
      folderPath: null,
    });
  }

  return sortLibraryAssets([...assetsByPath.values()]);
}

function buildWaveform(sampleCount: number, mode: "smooth" | "pulse" | "ticks" | "phrases") {
  const min: number[] = [];
  const max: number[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / Math.max(1, sampleCount - 1);
    let amplitude = 0.16;

    if (mode === "smooth") {
      amplitude =
        0.18 +
        Math.abs(Math.sin(progress * 15.5)) * 0.2 +
        Math.abs(Math.sin(progress * 52.0)) * 0.08 +
        Math.abs(Math.cos(progress * 7.0)) * 0.07;
    } else if (mode === "pulse") {
      amplitude =
        0.08 +
        Math.pow(Math.abs(Math.sin(progress * 24.0)), 1.5) * 0.34 +
        Math.abs(Math.cos(progress * 6.2)) * 0.06;
    } else if (mode === "ticks") {
      const subdivision = Math.floor(progress * 32);
      amplitude = subdivision % 2 === 0 ? 0.42 : 0.1;
    } else if (mode === "phrases") {
      amplitude =
        0.04 +
        Math.max(0, Math.sin(progress * 11.0)) * 0.22 +
        Math.abs(Math.sin(progress * 33.0)) * 0.09;
      if (progress > 0.18 && progress < 0.28) {
        amplitude += 0.18;
      }
      if (progress > 0.52 && progress < 0.68) {
        amplitude += 0.24;
      }
      if (progress > 0.82 && progress < 0.9) {
        amplitude += 0.28;
      }
    }

    const ceiling = clamp(amplitude, 0.04, 0.94);
    max.push(ceiling);
    min.push(-ceiling);
  }

  return { min, max };
}
