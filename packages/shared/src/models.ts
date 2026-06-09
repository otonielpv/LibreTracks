import {
  getCumulativeMusicalPosition,
  type TimelineRegion,
} from "./timelineMath";

export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type TrackKind = "audio" | "folder";
export type JumpTriggerLabel =
  | "immediate"
  | "next_marker"
  | "region_end"
  | `after_bars:${number}`;
export type TransitionTypeLabel = "instant" | `fade_out:${number}`;

/** Semantic section type. Mirrors Rust `MarkerKind` (snake_case serde). Drives
 * the pre-recorded voice-guide clip and the marker's colour/icon. `custom` is
 * the default for user-defined sections and for markers from sessions saved
 * before the voice-guide feature. */
export type MarkerKind =
  | "intro"
  | "verse"
  | "pre_chorus"
  | "chorus"
  | "post_chorus"
  | "bridge"
  | "breakdown"
  | "drop"
  | "solo"
  | "outro"
  | "acapella"
  | "instrumental"
  | "interlude"
  | "refrain"
  | "tag"
  | "vamp"
  | "ending"
  | "exhortation"
  | "rap"
  | "turnaround"
  | "custom";

export type SectionMarkerSummary = {
  id: string;
  name: string;
  startSeconds: number;
  digit?: number | null;
  /** Optional for backward compat with snapshots that predate the field;
   * treat a missing value as "custom". */
  kind?: MarkerKind;
  /** Numbered section variant (Verse 2, Chorus 3). Absent = unnumbered base. */
  variant?: number | null;
};

export type SongMasterSummary = {
  /** Linear gain multiplier applied by the mixer to the post-mix bus while the
   * playhead lies inside this region. 1.0 means unity. */
  gain: number;
};

export type SongRegionSummary = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  transposeSemitones: number;
  /** When true, the region's audio is time-stretched so its `warpSourceBpm`
   * aligns with the effective timeline tempo. Applies to ALL tracks in the
   * region, independent of `transposeSemitones`. */
  warpEnabled: boolean;
  /** Original BPM of the source audio at unity speed. May be persisted while
   * `warpEnabled` is false so toggling preserves the user's value. */
  warpSourceBpm: number | null;
  /** Per-song master fader. Defaults to `{ gain: 1.0 }` if the project
   * predates the field. */
  master: SongMasterSummary;
};

export type SongTempoRegionSummary = SongRegionSummary & TimelineRegion;

export type TempoMarkerSummary = {
  id: string;
  startSeconds: number;
  sourceStartSeconds?: number;
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
  audioTo: string;
  transposeEnabled: boolean;
  color?: string | null;
  /** True for tracks the system conjured because a clip needed a home (e.g.
   * drop into the compact view's song column). Auto-tracks are removed
   * automatically the moment their last clip leaves them — user-created
   * tracks never disappear on their own. Optional + defaults to false for
   * back-compat with older snapshots that lacked the field. */
  autoCreated?: boolean;
};

export function formatTransposeSemitones(value: number): string {
  if (value === 0) {
    return "0";
  }

  return value > 0 ? `+${value}` : `${value}`;
}

export type ClipSummary = {
  id: string;
  trackId: string;
  trackName: string;
  filePath: string;
  waveformKey: string;
  isMissing: boolean;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  sourceWindowDurationSeconds: number;
  sourceDurationSeconds: number;
  durationSeconds: number;
  gain: number;
  color?: string | null;
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
  waveforms?: WaveformSummaryDto[];
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
  minPeaksRight?: number[];
  maxPeaksRight?: number[];
  minPeaksBase64?: string;
  maxPeaksBase64?: string;
  minPeaksRightBase64?: string;
  maxPeaksRightBase64?: string;
};

export type LibraryAssetSummary = {
  fileName: string;
  filePath: string;
  durationSeconds: number;
  isMissing: boolean;
  folderPath?: string | null;
};

export type SongPackageImportResponse = {
  snapshot: TransportSnapshot;
  libraryAssets: LibraryAssetSummary[];
};

export type AudioFileImportPayload = {
  fileName: string;
  bytes: Uint8Array | number[];
};

export type AudioFilePathImportPayload = {
  fileName: string;
  sourcePath: string;
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

function downsampleWaveformLod(
  lod: WaveformLodDto,
  targetResolutionFrames: number,
): WaveformLodDto {
  const sourceMin = lod.minPeaks ?? [];
  const sourceMax = lod.maxPeaks ?? [];
  const sourceMinRight = lod.minPeaksRight ?? [];
  const sourceMaxRight = lod.maxPeaksRight ?? [];
  const hasRightChannel =
    sourceMinRight.length === sourceMax.length &&
    sourceMaxRight.length === sourceMax.length;
  const chunkSize = Math.max(
    1,
    Math.ceil(targetResolutionFrames / Math.max(1, lod.resolutionFrames)),
  );
  const minPeaks: number[] = [];
  const maxPeaks: number[] = [];
  const minPeaksRight: number[] = [];
  const maxPeaksRight: number[] = [];

  for (
    let chunkStart = 0;
    chunkStart < sourceMax.length;
    chunkStart += chunkSize
  ) {
    const chunkEnd = Math.min(sourceMax.length, chunkStart + chunkSize);
    let minPeak = 1;
    let maxPeak = -1;
    let minPeakRight = 1;
    let maxPeakRight = -1;

    for (let index = chunkStart; index < chunkEnd; index += 1) {
      minPeak = Math.min(minPeak, sourceMin[index] ?? 0);
      maxPeak = Math.max(maxPeak, sourceMax[index] ?? 0);
      if (hasRightChannel) {
        minPeakRight = Math.min(minPeakRight, sourceMinRight[index] ?? 0);
        maxPeakRight = Math.max(maxPeakRight, sourceMaxRight[index] ?? 0);
      }
    }

    minPeaks.push(minPeak);
    maxPeaks.push(maxPeak);
    if (hasRightChannel) {
      minPeaksRight.push(minPeakRight);
      maxPeaksRight.push(maxPeakRight);
    }
  }

  return {
    resolutionFrames: targetResolutionFrames,
    bucketCount: maxPeaks.length,
    minPeaks,
    maxPeaks,
    ...(hasRightChannel ? { minPeaksRight, maxPeaksRight } : {}),
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
    Math.ceil(
      (safeDurationSeconds * safeSampleRate) / Math.max(1, maxPeaks.length),
    ),
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
    playbackRate?: number;
    running: boolean;
    lastSeekPositionSeconds?: number | null;
    lastStartPositionSeconds?: number | null;
    lastJumpPositionSeconds?: number | null;
  };
  pitch?: PitchPrepareSummary;
  projectRevision: number;
  songDir?: string | null;
  songFilePath?: string | null;
  isNativeRuntime: boolean;
};

export type TransportClock = NonNullable<TransportSnapshot["transportClock"]>;

const SONG_TEMPO_REGION_VISUAL_END_SECONDS = 1_000_000;

export type TransportLifecycleEventKind =
  | "play"
  | "pause"
  | "stop"
  | "seek"
  | "sync";

export type TransportLifecycleEvent = {
  kind: TransportLifecycleEventKind;
  snapshot: TransportSnapshot;
  anchorPositionSeconds: number;
  emittedAtUnixMs: number;
};

export type ProjectLoadCompleteEvent = {
  snapshot: TransportSnapshot | null;
  error: string | null;
};

export type AudioMeterLevel = {
  trackId: string;
  leftPeak: number;
  rightPeak: number;
};

export type RegionMeterLevel = {
  regionId: string;
  /** Linear peak amplitude (max(|L|, |R|)) of the post-region-master signal,
   * smoothed by a 200ms release in the engine. 0 means silence or inactive. */
  peak: number;
};

export type MidiBinding = {
  status: number;
  data1: number;
  isCc: boolean;
};

// Procedural metronome click timbres. Index order MUST match the C++
// `SoundPreset` enum (metronome_renderer.h) — append, never reorder.
export const METRONOME_SOUND_PRESETS = [
  "sine",
  "beep",
  "woodblock",
  "click",
  "rimshot",
  "cowbell",
  "clave",
] as const;

export type MetronomeSoundPreset = (typeof METRONOME_SOUND_PRESETS)[number];

// Allowed subdivision divisors: 1 = off, 2 = eighths, 3 = triplets, 4 = sixteenths.
export const METRONOME_SUBDIVISIONS = [1, 2, 3, 4] as const;

const METRONOME_PITCH_RANGE = 24; // semitones, +/-

export type AppSettings = {
  selectedOutputDevice: string | null;
  selectedAudioBackend: AudioBackendKind | null;
  selectedOutputDeviceId: string | null;
  selectedOutputDeviceName: string | null;
  outputSampleRate: number | null;
  outputBufferSize: AudioBufferSizeRequest;
  outputChannelMapping: OutputChannelRequest;
  outputSampleFormat: AudioSampleFormat | null;
  audioSafeMode: boolean;
  selectedMidiDevice: string | null;
  suppressMissingMidiDeviceWarning: boolean;
  enabledOutputChannels: number[];
  locale: string | null;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  metronomeOutput: string;
  metronomeAccentEnabled: boolean;
  metronomeAccentPreset: number;
  metronomeBeatPreset: number;
  metronomeAccentPitch: number;
  metronomeBeatPitch: number;
  metronomeSubdivision: number;
  metronomeSubdivisionPreset: number;
  metronomeSubdivisionPitch: number;
  metronomeSubdivisionGain: number;
  globalJumpMode: "immediate" | "after_bars" | "next_marker";
  globalJumpBars: number;
  songJumpTrigger: "immediate" | "region_end" | "after_bars";
  songJumpBars: number;
  songTransitionMode: "instant" | "fade_out";
  vampMode: "section" | "bars";
  vampBars: number;
  timelineNavigationScheme: "ableton" | "libretracks";
  midiMappings: Record<string, MidiBinding>;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  selectedOutputDevice: null,
  selectedAudioBackend: null,
  selectedOutputDeviceId: null,
  selectedOutputDeviceName: null,
  outputSampleRate: null,
  outputBufferSize: "default",
  outputChannelMapping: { channels: [0, 1] },
  outputSampleFormat: null,
  audioSafeMode: false,
  selectedMidiDevice: null,
  suppressMissingMidiDeviceWarning: false,
  enabledOutputChannels: [0, 1],
  locale: null,
  metronomeEnabled: false,
  metronomeVolume: 0.8,
  metronomeOutput: "master",
  metronomeAccentEnabled: true,
  metronomeAccentPreset: 0,
  metronomeBeatPreset: 0,
  metronomeAccentPitch: 0,
  metronomeBeatPitch: 0,
  metronomeSubdivision: 1,
  metronomeSubdivisionPreset: 0,
  metronomeSubdivisionPitch: 0,
  metronomeSubdivisionGain: 0.5,
  globalJumpMode: "immediate",
  globalJumpBars: 4,
  songJumpTrigger: "immediate",
  songJumpBars: 4,
  songTransitionMode: "instant",
  vampMode: "section",
  vampBars: 4,
  timelineNavigationScheme: "ableton",
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
  const selectedAudioBackend = normalizeAudioBackendKind(
    settings.selectedAudioBackend,
  );
  const selectedOutputDeviceId =
    settings.selectedOutputDeviceId?.trim() || null;
  const selectedOutputDeviceName =
    settings.selectedOutputDeviceName?.trim() || selectedOutputDevice || null;
  const outputSampleRate =
    Number.isFinite(settings.outputSampleRate) &&
    Number(settings.outputSampleRate) > 0
      ? Math.floor(Number(settings.outputSampleRate))
      : null;
  const outputBufferSize = normalizeAudioBufferSizeRequest(
    settings.outputBufferSize,
  );
  const outputSampleFormat = normalizeAudioSampleFormat(
    settings.outputSampleFormat,
  );
  const selectedMidiDevice = settings.selectedMidiDevice?.trim() || null;
  const locale = settings.locale?.trim().toLowerCase();
  const metronomeVolume = Number.isFinite(settings.metronomeVolume)
    ? Math.min(1, Math.max(0, settings.metronomeVolume))
    : DEFAULT_APP_SETTINGS.metronomeVolume;
  const normalizePreset = (value: number, fallback: number) => {
    const index = Math.floor(value);
    return Number.isFinite(index) &&
      index >= 0 &&
      index < METRONOME_SOUND_PRESETS.length
      ? index
      : fallback;
  };
  const normalizePitch = (value: number, fallback: number) =>
    Number.isFinite(value)
      ? Math.max(-METRONOME_PITCH_RANGE, Math.min(METRONOME_PITCH_RANGE, value))
      : fallback;
  const metronomeAccentPreset = normalizePreset(
    settings.metronomeAccentPreset,
    DEFAULT_APP_SETTINGS.metronomeAccentPreset,
  );
  const metronomeBeatPreset = normalizePreset(
    settings.metronomeBeatPreset,
    DEFAULT_APP_SETTINGS.metronomeBeatPreset,
  );
  const metronomeSubdivisionPreset = normalizePreset(
    settings.metronomeSubdivisionPreset,
    DEFAULT_APP_SETTINGS.metronomeSubdivisionPreset,
  );
  const metronomeAccentPitch = normalizePitch(
    settings.metronomeAccentPitch,
    DEFAULT_APP_SETTINGS.metronomeAccentPitch,
  );
  const metronomeBeatPitch = normalizePitch(
    settings.metronomeBeatPitch,
    DEFAULT_APP_SETTINGS.metronomeBeatPitch,
  );
  const metronomeSubdivisionPitch = normalizePitch(
    settings.metronomeSubdivisionPitch,
    DEFAULT_APP_SETTINGS.metronomeSubdivisionPitch,
  );
  const metronomeSubdivision = (
    METRONOME_SUBDIVISIONS as readonly number[]
  ).includes(Math.floor(settings.metronomeSubdivision))
    ? Math.floor(settings.metronomeSubdivision)
    : DEFAULT_APP_SETTINGS.metronomeSubdivision;
  const metronomeSubdivisionGain = Number.isFinite(
    settings.metronomeSubdivisionGain,
  )
    ? Math.min(1, Math.max(0, settings.metronomeSubdivisionGain))
    : DEFAULT_APP_SETTINGS.metronomeSubdivisionGain;
  const enabledOutputChannels = Array.from(
    new Set(
      (
        settings.enabledOutputChannels ??
        DEFAULT_APP_SETTINGS.enabledOutputChannels
      )
        .map((channel) => Math.floor(channel))
        .filter(
          (channel) => Number.isFinite(channel) && channel >= 0 && channel < 64,
        ),
    ),
  ).sort((left, right) => left - right);
  const metronomeOutput =
    settings.metronomeOutput?.trim().toLowerCase() ||
    DEFAULT_APP_SETTINGS.metronomeOutput;
  const globalJumpMode =
    settings.globalJumpMode === "after_bars" ||
    settings.globalJumpMode === "next_marker"
      ? settings.globalJumpMode
      : DEFAULT_APP_SETTINGS.globalJumpMode;
  const songJumpTrigger =
    settings.songJumpTrigger === "after_bars" ||
    settings.songJumpTrigger === "region_end"
      ? settings.songJumpTrigger
      : DEFAULT_APP_SETTINGS.songJumpTrigger;
  const songTransitionMode =
    settings.songTransitionMode === "fade_out"
      ? settings.songTransitionMode
      : DEFAULT_APP_SETTINGS.songTransitionMode;
  const vampMode =
    settings.vampMode === "bars"
      ? settings.vampMode
      : DEFAULT_APP_SETTINGS.vampMode;
  const timelineNavigationScheme =
    settings.timelineNavigationScheme === "libretracks"
      ? settings.timelineNavigationScheme
      : DEFAULT_APP_SETTINGS.timelineNavigationScheme;
  const midiMappings = Object.fromEntries(
    Object.entries(settings.midiMappings ?? {}).map(([key, binding]) => [
      key,
      normalizeMidiBinding(binding),
    ]),
  );

  return {
    selectedOutputDevice,
    selectedAudioBackend,
    selectedOutputDeviceId,
    selectedOutputDeviceName,
    outputSampleRate,
    outputBufferSize,
    outputChannelMapping: {
      channels: enabledOutputChannels.length
        ? enabledOutputChannels
        : DEFAULT_APP_SETTINGS.enabledOutputChannels,
    },
    outputSampleFormat,
    audioSafeMode: Boolean(settings.audioSafeMode),
    selectedMidiDevice,
    suppressMissingMidiDeviceWarning: Boolean(
      settings.suppressMissingMidiDeviceWarning,
    ),
    enabledOutputChannels: enabledOutputChannels.length
      ? enabledOutputChannels
      : DEFAULT_APP_SETTINGS.enabledOutputChannels,
    locale: locale === "en" || locale === "es" ? locale : null,
    metronomeEnabled: Boolean(settings.metronomeEnabled),
    metronomeVolume,
    metronomeOutput,
    metronomeAccentEnabled: settings.metronomeAccentEnabled ?? true,
    metronomeAccentPreset,
    metronomeBeatPreset,
    metronomeAccentPitch,
    metronomeBeatPitch,
    metronomeSubdivision,
    metronomeSubdivisionPreset,
    metronomeSubdivisionPitch,
    metronomeSubdivisionGain,
    globalJumpMode,
    globalJumpBars: normalizeJumpBars(
      settings.globalJumpBars,
      DEFAULT_APP_SETTINGS.globalJumpBars,
    ),
    songJumpTrigger,
    songJumpBars: normalizeJumpBars(
      settings.songJumpBars,
      DEFAULT_APP_SETTINGS.songJumpBars,
    ),
    songTransitionMode,
    vampMode,
    vampBars: normalizeJumpBars(
      settings.vampBars,
      DEFAULT_APP_SETTINGS.vampBars,
    ),
    timelineNavigationScheme,
    midiMappings,
  };
}

export type AudioOutputDevices = {
  devices: string[];
  defaultDevice?: string | null;
  channelCounts?: Record<string, number>;
  backends?: AudioBackendKind[];
  deviceDescriptors?: AudioDeviceDescriptor[];
};

export type PitchPrepareStatus = "idle" | "preparing" | "failed" | string;

export type PitchPrepareSummary = {
  pitchPrepareActive: boolean;
  pitchPreparePending: boolean;
  pitchPrepareProgress: number;
  pitchProxyBlocksReady: number;
  pitchProxyBlocksMissing: number;
  pitchProxyBlocksPending: number;
  pitchJobsPending: number;
  pitchJobsRunning: number;
  pitchJobsCompleted: number;
  pitchJobsFailed: number;
  pitchPrepareStatus: PitchPrepareStatus;
  pitchPrepareMessage: string;
  activePitchRenderPath: string;
  lastPitchPrepareReason: string;
  lastPitchProxyError: string;
  lastMissingProxyKey: string;
  lastMissingProxyBlockIndex: number;
};

export type AudioBackendKind =
  | "asio"
  | "wasapi"
  | "core_audio"
  | "alsa"
  | "jack"
  | "direct_sound"
  | "mme"
  | "unknown";

export type AudioSampleFormat = "f32" | "i16" | "u16" | "unknown";

export type AudioBufferSizeRequest = "default" | { fixed: number };

export type OutputChannelRequest = {
  channels: number[];
};

export type AudioDeviceDescriptor = {
  backend: AudioBackendKind;
  backendId: string;
  stableId: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  maxOutputChannels: number;
  defaultSampleRate?: number | null;
  supportedSampleRates: number[];
  supportedBufferSizes: number[];
  supportedSampleFormats: AudioSampleFormat[];
};

function normalizeAudioBackendKind(value: unknown): AudioBackendKind | null {
  return typeof value === "string" &&
    [
      "asio",
      "wasapi",
      "core_audio",
      "alsa",
      "jack",
      "direct_sound",
      "mme",
      "unknown",
    ].includes(value)
    ? (value as AudioBackendKind)
    : null;
}

function normalizeAudioSampleFormat(value: unknown): AudioSampleFormat | null {
  return typeof value === "string" && ["f32", "i16", "u16"].includes(value)
    ? (value as AudioSampleFormat)
    : null;
}

function normalizeAudioBufferSizeRequest(
  value: unknown,
): AudioBufferSizeRequest {
  if (value && typeof value === "object" && "fixed" in value) {
    const fixed = Number((value as { fixed?: unknown }).fixed);
    return Number.isFinite(fixed) && fixed > 0
      ? { fixed: Math.floor(fixed) }
      : "default";
  }
  return "default";
}

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

export type LibraryImportCompleteEvent = {
  assets: LibraryAssetSummary[] | null;
  error: string | null;
};

export type ProjectLoadProgressEvent = {
  percent: number;
  message: string;
  sourcesReady: number;
  sourcesTotal: number;
  ramCacheMb: number;
  diskCacheMb: number;
  emittedAtUnixMs?: number;
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

export function buildSongTempoRegions(
  song: SongView | null | undefined,
): SongTempoRegionSummary[] {
  if (!song) {
    return [];
  }

  const boundaries = [
    ...song.tempoMarkers
      .filter((marker) => marker.startSeconds > 0)
      .map((marker) => ({
        startSeconds: marker.startSeconds,
        bpm: marker.bpm,
        timeSignature: null as string | null,
      })),
    ...song.timeSignatureMarkers
      .filter((marker) => marker.startSeconds > 0)
      .map((marker) => ({
        startSeconds: marker.startSeconds,
        bpm: null as number | null,
        timeSignature: marker.signature,
      })),
    ...song.regions
      .filter(
        (region) =>
          !region.warpEnabled &&
          region.transposeSemitones !== 0 &&
          region.startSeconds > 0,
      )
      .map((region) => ({
        startSeconds: region.startSeconds,
        bpm: null as number | null,
        timeSignature: null as string | null,
      })),
    ...song.regions
      .filter(
        (region) =>
          !region.warpEnabled &&
          region.transposeSemitones !== 0 &&
          region.endSeconds > 0,
      )
      .map((region) => ({
        startSeconds: region.endSeconds,
        bpm: null as number | null,
        timeSignature: null as string | null,
      })),
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

    const displayBpm = applyVarispeedBpmAt(song, startSeconds, bpm);
    regions.push({
      id: `tempo-region-${startSeconds.toFixed(4)}`,
      name: `Tempo ${displayBpm.toFixed(2)} ${timeSignature}`,
      startSeconds,
      endSeconds: marker.startSeconds,
      bpm: displayBpm,
      timeSignature,
      transposeSemitones: 0,
      warpEnabled: false,
      warpSourceBpm: null,
      master: { gain: 1.0 },
    });
    startSeconds = marker.startSeconds;
    bpm = marker.bpm ?? bpm;
    timeSignature = marker.timeSignature ?? timeSignature;
  }

  const displayBpm = applyVarispeedBpmAt(song, startSeconds, bpm);
  regions.push({
    id: `tempo-region-${startSeconds.toFixed(4)}-tail`,
    name: `Tempo ${displayBpm.toFixed(2)} ${timeSignature}`,
    startSeconds,
    endSeconds: Math.max(startSeconds, SONG_TEMPO_REGION_VISUAL_END_SECONDS),
    bpm: displayBpm,
    timeSignature,
    transposeSemitones: 0,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1.0 },
  });

  return regions;
}

export function getPrimarySongRegion(
  song: SongView | null | undefined,
): SongRegionSummary | null {
  if (!song || song.regions.length === 0) {
    return null;
  }

  return song.regions[0] ?? null;
}

export function getSongBaseBpm(song: SongView | null | undefined): number {
  return song?.bpm ?? 120;
}

function semitonesToPitchScale(semitones: number): number {
  const scale = 2 ** (semitones / 12);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function varispeedScaleAt(
  song: SongView | null | undefined,
  positionSeconds: number,
): number {
  if (!song) return 1;
  const region = song.regions.find(
    (candidate) =>
      !candidate.warpEnabled &&
      candidate.transposeSemitones !== 0 &&
      positionSeconds >= candidate.startSeconds &&
      positionSeconds < candidate.endSeconds,
  );
  return region ? semitonesToPitchScale(region.transposeSemitones) : 1;
}

function applyVarispeedBpmAt(
  song: SongView | null | undefined,
  positionSeconds: number,
  bpm: number,
): number {
  return bpm * varispeedScaleAt(song, positionSeconds);
}

/**
 * Effective BPM at a given timeline position. Walks the song's tempo markers
 * and returns the latest one at-or-before `positionSeconds`, falling back to
 * `song.bpm` when no marker applies. Mirrors the Rust-side `effective_bpm_at`.
 */
export function getEffectiveBpmAt(
  song: SongView | null | undefined,
  positionSeconds: number,
): number {
  const base = getSongBaseBpm(song);
  if (!song || song.tempoMarkers.length === 0) return base;
  let bestBpm = base;
  let bestStart = -Infinity;
  for (const marker of song.tempoMarkers) {
    if (
      marker.startSeconds <= positionSeconds + 0.001 &&
      marker.startSeconds > bestStart
    ) {
      bestStart = marker.startSeconds;
      bestBpm = marker.bpm;
    }
  }
  return applyVarispeedBpmAt(song, positionSeconds, bestBpm);
}

export function getSongBaseTimeSignature(
  song: SongView | null | undefined,
): string {
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
      (region) =>
        positionSeconds >= region.startSeconds &&
        positionSeconds < region.endSeconds,
    ) ??
    [...tempoRegions]
      .reverse()
      .find((region) => positionSeconds >= region.endSeconds) ??
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
      (region) =>
        positionSeconds >= region.startSeconds &&
        positionSeconds < region.endSeconds,
    ) ??
    [...song.regions]
      .reverse()
      .find((region) => positionSeconds >= region.endSeconds) ??
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
