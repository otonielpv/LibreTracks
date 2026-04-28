import { getCumulativeMusicalPosition, type TimelineRegion } from "./timelineMath";

export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type TrackKind = "audio" | "folder";
export type JumpTriggerLabel = "immediate" | "next_marker" | "region_end" | `after_bars:${number}`;
export type TransitionTypeLabel = "instant" | `fade_out:${number}`;

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
  transition: TransitionTypeLabel;
};

export type ActiveVampSummary = {
  startSeconds: number;
  endSeconds: number;
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
  activeVamp?: ActiveVampSummary | null;
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

export type TransportLifecycleEventKind = "play" | "pause" | "stop" | "seek" | "sync";

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
  selectedMidiDevice?: string | null;
  splitStereoEnabled: boolean;
  locale?: string | null;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  selectedOutputDevice: null,
  selectedMidiDevice: null,
  splitStereoEnabled: false,
  locale: null,
};

export function normalizeAppSettings(settings: AppSettings): AppSettings {
  const selectedOutputDevice = settings.selectedOutputDevice?.trim() || null;
  const selectedMidiDevice = settings.selectedMidiDevice?.trim() || null;
  const locale = settings.locale?.trim().toLowerCase();

  return {
    selectedOutputDevice,
    selectedMidiDevice,
    splitStereoEnabled: Boolean(settings.splitStereoEnabled),
    locale: locale === "en" || locale === "es" ? locale : null,
  };
}

export type AudioOutputDevices = {
  devices: string[];
  defaultDevice?: string | null;
};

export type RemoteServerInfo = {
  bindIp: string;
  localIp: string;
  hostname: string;
  localHostnameOrigin?: string | null;
  port: number;
  origin: string;
  wsUrl: string;
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

export function getMusicalPositionForSong(
  song: SongView | null | undefined,
  positionSeconds: number,
) {
  return getCumulativeMusicalPosition(
    positionSeconds,
    buildSongTempoRegions(song),
    getSongBaseBpm(song),
    getSongBaseTimeSignature(song),
  );
}
