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

export type TimeSignatureMarkerSummary = {
  id: string;
  startSeconds: number;
  signature: string;
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
  isMissing: boolean;
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
  timeSignatureMarkers: TimeSignatureMarkerSummary[];
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
  isMissing: boolean;
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

export type MidiBinding = {
  status: number;
  data1: number;
  isCc: boolean;
};

export type AppSettings = {
  selectedOutputDevice: string | null;
  selectedMidiDevice: string | null;
  suppressMissingMidiDeviceWarning: boolean;
  splitStereoEnabled: boolean;
  locale: string | null;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  globalJumpMode: "immediate" | "after_bars" | "next_marker";
  globalJumpBars: number;
  songJumpTrigger: "immediate" | "region_end" | "after_bars";
  songJumpBars: number;
  songTransitionMode: "instant" | "fade_out";
  vampMode: "section" | "bars";
  vampBars: number;
  midiMappings: Record<string, MidiBinding>;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  selectedOutputDevice: null,
  selectedMidiDevice: null,
  suppressMissingMidiDeviceWarning: false,
  splitStereoEnabled: false,
  locale: null,
  metronomeEnabled: false,
  metronomeVolume: 0.8,
  globalJumpMode: "immediate",
  globalJumpBars: 4,
  songJumpTrigger: "immediate",
  songJumpBars: 4,
  songTransitionMode: "instant",
  vampMode: "section",
  vampBars: 4,
  midiMappings: {},
};

function normalizeJumpBars(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeMidiBinding(binding: MidiBinding): MidiBinding {
  return {
    status: Math.max(0, Math.min(255, Math.floor(binding.status) || 0)),
    data1: Math.max(0, Math.min(255, Math.floor(binding.data1) || 0)),
    isCc: Boolean(binding.isCc),
  };
}

export function normalizeAppSettings(settings: AppSettings): AppSettings {
  const selectedOutputDevice = settings.selectedOutputDevice?.trim() || null;
  const selectedMidiDevice = settings.selectedMidiDevice?.trim() || null;
  const locale = settings.locale?.trim().toLowerCase();
  const metronomeVolume = Number.isFinite(settings.metronomeVolume)
    ? Math.min(1, Math.max(0, settings.metronomeVolume))
    : DEFAULT_APP_SETTINGS.metronomeVolume;
  const globalJumpMode =
    settings.globalJumpMode === "after_bars" || settings.globalJumpMode === "next_marker"
      ? settings.globalJumpMode
      : DEFAULT_APP_SETTINGS.globalJumpMode;
  const songJumpTrigger =
    settings.songJumpTrigger === "after_bars" || settings.songJumpTrigger === "region_end"
      ? settings.songJumpTrigger
      : DEFAULT_APP_SETTINGS.songJumpTrigger;
  const songTransitionMode =
    settings.songTransitionMode === "fade_out" ? settings.songTransitionMode : DEFAULT_APP_SETTINGS.songTransitionMode;
  const vampMode = settings.vampMode === "bars" ? settings.vampMode : DEFAULT_APP_SETTINGS.vampMode;
  const midiMappings = Object.fromEntries(
    Object.entries(settings.midiMappings ?? {}).map(([key, binding]) => [key, normalizeMidiBinding(binding)]),
  );

  return {
    selectedOutputDevice,
    selectedMidiDevice,
    suppressMissingMidiDeviceWarning: Boolean(settings.suppressMissingMidiDeviceWarning),
    splitStereoEnabled: Boolean(settings.splitStereoEnabled),
    locale: locale === "en" || locale === "es" ? locale : null,
    metronomeEnabled: Boolean(settings.metronomeEnabled),
    metronomeVolume,
    globalJumpMode,
    globalJumpBars: normalizeJumpBars(settings.globalJumpBars, DEFAULT_APP_SETTINGS.globalJumpBars),
    songJumpTrigger,
    songJumpBars: normalizeJumpBars(settings.songJumpBars, DEFAULT_APP_SETTINGS.songJumpBars),
    songTransitionMode,
    vampMode,
    vampBars: normalizeJumpBars(settings.vampBars, DEFAULT_APP_SETTINGS.vampBars),
    midiMappings,
  };
}

export type AudioOutputDevices = {
  devices: string[];
  defaultDevice?: string | null;
};

export type MidiRawMessage = {
  status: number;
  data1: number;
  data2: number;
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

  const boundaries = [
    ...song.tempoMarkers
      .filter((marker) => marker.startSeconds > 0)
      .map((marker) => ({ startSeconds: marker.startSeconds, bpm: marker.bpm, timeSignature: null as string | null })),
    ...song.timeSignatureMarkers
      .filter((marker) => marker.startSeconds > 0)
      .map((marker) => ({ startSeconds: marker.startSeconds, bpm: null as number | null, timeSignature: marker.signature })),
  ].sort((left, right) => left.startSeconds - right.startSeconds);
  const regions: SongTempoRegionSummary[] = [];
  let startSeconds = 0;
  let bpm = getSongBaseBpm(song);
  let timeSignature = getSongBaseTimeSignature(song);

  for (const marker of boundaries) {
    if (marker.startSeconds <= startSeconds) {
      bpm = marker.bpm ?? bpm;
      timeSignature = marker.timeSignature ?? timeSignature;
      continue;
    }

    regions.push({
      id: `tempo-region-${startSeconds.toFixed(4)}`,
      name: `Tempo ${bpm.toFixed(2)} ${timeSignature}`,
      startSeconds,
      endSeconds: marker.startSeconds,
      bpm,
      timeSignature,
    });
    startSeconds = marker.startSeconds;
    bpm = marker.bpm ?? bpm;
    timeSignature = marker.timeSignature ?? timeSignature;
  }

  regions.push({
    id: `tempo-region-${startSeconds.toFixed(4)}-tail`,
    name: `Tempo ${bpm.toFixed(2)} ${timeSignature}`,
    startSeconds,
    endSeconds: Math.max(startSeconds, SONG_TEMPO_REGION_VISUAL_END_SECONDS),
    bpm,
    timeSignature,
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
