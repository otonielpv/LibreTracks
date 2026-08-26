import { AUX_FADER_SCALE, positionToGain } from "./faderScale";
import {
  getCumulativeMusicalPosition,
  type TimelineRegion,
} from "./timelineMath";

/** Max linear gain the click / voice-guide aux faders reach (+20 dB ≈ 10×). */
const AUX_MAX_GAIN = positionToGain(1, AUX_FADER_SCALE);

export type PlaybackState = "empty" | "stopped" | "playing" | "paused";
export type TrackKind = "audio" | "folder" | "midi";
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
  // Dynamic guide cues (Build, All In, Drums In, ...): one-shot spoken
  // instructions within a section, no count-in. Appended after the sections;
  // the C++ clip bank indexes by order, so never reorder, only append.
  | "ad_lib"
  | "all_in"
  | "bass"
  | "big_ending"
  | "break"
  | "build"
  | "drums_in"
  | "drums"
  | "guitar"
  | "hits"
  | "hold"
  | "key_change_down"
  | "key_change_up"
  | "keys"
  | "last_time"
  | "slowly_build"
  | "softly"
  | "swell"
  | "worship_freely"
  | "ease_down"
  | "get_ready"
  | "next_song"
  | "custom";

/** Whether a marker behaves as a song section (Verse, Chorus — name + count-in)
 * or a dynamic cue (Build, All In — one-shot, no count-in). Normally derived
 * from the kind; a marker dragged to the other ruler lane stores an override
 * (see `categoryOverride` on {@link SectionMarkerSummary}). */
export type MarkerCategory = "section" | "cue";

/** The dynamic-cue kinds. Single source of truth shared by every surface
 * (desktop editor, voice-guide labels, and the remote, which must NOT offer
 * cues as jump targets). Mirrors the cue half of the Rust `MarkerKind` enum. */
export const CUE_KINDS: readonly MarkerKind[] = [
  "get_ready",
  "build",
  "slowly_build",
  "ease_down",
  "all_in",
  "drums_in",
  "break",
  "hold",
  "softly",
  "swell",
  "hits",
  "last_time",
  "big_ending",
  "key_change_up",
  "key_change_down",
  "drums",
  "bass",
  "guitar",
  "keys",
  "ad_lib",
  "worship_freely",
] as const;

const CUE_KIND_SET: ReadonlySet<MarkerKind> = new Set(CUE_KINDS);

/** Whether a kind is a dynamic cue or a song section (mirrors Rust
 * `MarkerKind::category`). `custom` and any unknown value count as a section. */
export function markerKindCategory(
  kind: MarkerKind | undefined,
): MarkerCategory {
  return kind && CUE_KIND_SET.has(kind) ? "cue" : "section";
}

/** The category that actually governs a marker: the lane the user dragged it
 * into, else the one its kind implies. Mirrors Rust `Marker::category`.
 *
 * Anything that branches on section-vs-cue — which ruler lane it draws in,
 * whether it is a jump target, whether it gets a count-in — must call this
 * rather than {@link markerKindCategory}, or a dragged marker keeps behaving
 * like its old category. Use `markerKindCategory` only when asking about a bare
 * kind with no marker in hand (e.g. building the "Type" menu). */
export function markerCategory(marker: {
  kind?: MarkerKind;
  categoryOverride?: MarkerCategory | null;
}): MarkerCategory {
  return marker.categoryOverride ?? markerKindCategory(marker.kind);
}

/** Resting-state colour per marker kind. Sections read as distinct hues;
 * cues share a warmer accent family; `custom` is a neutral grey. Single source
 * of truth shared by the desktop timeline and the remote. */
const MARKER_KIND_COLORS: Record<MarkerKind, string> = {
  intro: "#8ea3b0",
  verse: "#5aa9e6",
  pre_chorus: "#7ec4cf",
  chorus: "#f6a14c",
  post_chorus: "#f4c95d",
  bridge: "#b08be0",
  breakdown: "#9b8cff",
  drop: "#e8607a",
  solo: "#e0d35a",
  outro: "#8ea3b0",
  acapella: "#d98fb0",
  instrumental: "#6fbf9b",
  interlude: "#88c0a8",
  refrain: "#6ec0d6",
  tag: "#c9a26b",
  vamp: "#a6c47e",
  ending: "#9aa0a8",
  exhortation: "#d4a05a",
  rap: "#c77dd4",
  turnaround: "#7fa8d0",
  custom: "#bacac5",
  build: "#e0894a",
  slowly_build: "#d98f5c",
  all_in: "#e07a4a",
  drums_in: "#d4924a",
  break: "#8a96a0",
  hold: "#9aa6b0",
  softly: "#9fb0bd",
  swell: "#c0a06a",
  hits: "#e06a6a",
  last_time: "#cf8a5a",
  big_ending: "#d9665a",
  key_change_up: "#6fbf9b",
  key_change_down: "#6fa8bf",
  drums: "#caa06a",
  bass: "#b0926a",
  guitar: "#c2a072",
  keys: "#b89a72",
  ad_lib: "#c79a8a",
  worship_freely: "#b89ad0",
  // Warm oranges mirror the intensity cues (build/all_in); next_song borrows the
  // structural blue of the section palette since it is announced like one.
  get_ready: "#d9a05c",
  ease_down: "#8fb0a8",
  next_song: "#7f9fd0",
};

/** Resting-state colour for a kind. Falls back to the custom grey for unknown
 * values (e.g. a snapshot from a newer build). */
export function markerKindColor(kind: MarkerKind | undefined): string {
  return MARKER_KIND_COLORS[kind ?? "custom"] ?? MARKER_KIND_COLORS.custom;
}

/** Effective colour of a marker: an explicit per-marker `color` override (used
 * by Custom markers) wins; otherwise the kind palette. Shared by desktop and
 * remote so both render the same colour. */
export function markerColor(marker: {
  kind?: MarkerKind;
  color?: string | null;
}): string {
  return marker.color ?? markerKindColor(marker.kind);
}

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
  /** User-chosen colour override (Custom markers). Absent = use the kind
   * palette. */
  color?: string | null;
  /** Lane the user dragged this marker into, overriding what its kind implies.
   * Absent — the default, and what every marker created before this feature has
   * — means "wherever my kind belongs". Read it via {@link markerCategory}. */
  categoryOverride?: MarkerCategory | null;
};

export type SongMasterSummary = {
  /** Linear gain multiplier applied by the mixer to the post-mix bus while the
   * playhead lies inside this region. 1.0 means unity. */
  gain: number;
};

/** Fallback width (rem) for a compact-view song column, used only when the
 * title cannot be measured (SSR / jsdom). Normally a column with no persisted
 * width sizes itself to its song's name, with the "Song 1" baseline as the
 * floor — see `autoColumnWidthRem`. Kept in sync with the
 * `--lt-compact-column-width` fallback in styles.css. */
export const COMPACT_COLUMN_DEFAULT_WIDTH_REM = 14;
/** Bounds for a width the user drags to, mirroring
 * MIN/MAX_COMPACT_COLUMN_WIDTH_REM in the Rust validation module. The backend
 * clamps to the same range, so a value that escapes the UI (hand-edited
 * session) still lands somewhere usable.
 *
 * Note this MIN is deliberately below the auto-fit baseline: the default
 * width keeps a song's title readable, but a user who explicitly drags a
 * column narrower is allowed to go all the way down to a play button and a
 * truncated name. */
export const COMPACT_COLUMN_MIN_WIDTH_REM = 5;
export const COMPACT_COLUMN_MAX_WIDTH_REM = 48;

export type SongRegionSummary = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  transposeSemitones: number;
  /** The song's original musical key in canonical sharp notation (e.g. `"Dm"`,
   * `"F#"`), or `null` when unset. The key shown on the region is this value
   * transposed by `transposeSemitones` — see `regionEffectiveKey`. */
  key: string | null;
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
  /** Width in rem of this song's column in the compact view, or `null` to
   * use the view's default. Pure view state persisted with the project so a
   * layout the user arranged survives reopening the session. */
  compactColumnWidthRem: number | null;
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
  /** Jump destination in view seconds — marks where playback lands. */
  targetSeconds?: number | null;
  transition: TransitionTypeLabel;
};

export type ActiveVampSummary = {
  startSeconds: number;
  endSeconds: number;
};

export type AutomationTransitionMode = "instant" | "fade_out";

export type AutomationTransitionSummary = {
  mode: AutomationTransitionMode;
  durationSeconds?: number | null;
};

export type AutomationJumpTargetSummary =
  | { kind: "marker"; markerId: string }
  | { kind: "region"; regionId: string }
  | { kind: "frame"; seconds: number };

/** One action of a cue's job. Discriminated by `type`. A `jump`, if present,
 * is always the last action. */
export type AutomationActionSummary =
  | {
      type: "jump";
      target: AutomationJumpTargetSummary;
      transition: AutomationTransitionSummary;
      mixSceneId?: string | null;
    }
  | { type: "setTrackMute"; trackId: string; muted: boolean }
  | { type: "setTrackSolo"; trackId: string; solo: boolean }
  | {
      type: "setTrackMix";
      trackId: string;
      volume?: number | null;
      pan?: number | null;
      rampSeconds?: number | null;
    }
  | { type: "applyScene"; sceneId: string; rampSeconds?: number | null }
  | {
      type: "setPad";
      enabled: boolean;
      padId: string;
      padKey: number;
      volume: number;
      output: string;
      /** Soft-entrance seconds when this cue turns the pad on (0/undefined = instant). */
      fadeInSeconds?: number | null;
      /** Soft-exit seconds when this cue turns the pad off / swaps key (0/undefined = fast). */
      fadeOutSeconds?: number | null;
    }
  | { type: "wait"; durationSeconds: number };

export type AutomationCueSummary = {
  id: string;
  name: string;
  atSeconds: number;
  enabled: boolean;
  /** Max times the cue fires per session; null/undefined = unlimited. */
  maxRuns?: number | null;
  /** True once the cue used up its run limit this session (shown as off). */
  exhausted?: boolean;
  /** Ordered actions executed in sequence when the playhead reaches atSeconds. */
  actions: AutomationActionSummary[];
};

export type MixSceneTrackOverrideSummary = {
  trackId: string;
  volume?: number | null;
  pan?: number | null;
  muted?: boolean | null;
  solo?: boolean | null;
};

export type MixSceneSummary = {
  id: string;
  name: string;
  trackOverrides: MixSceneTrackOverrideSummary[];
};

export type PendingAutomationCueSummary = {
  cueId: string;
  cueName: string;
  executeAtSeconds: number;
  /** Jump destination in view seconds — lets the playhead move there instantly. */
  targetSeconds: number;
  target: AutomationJumpTargetSummary;
};

/**
 * Present (non-null) only when the user has added the automation track to the
 * timeline. The track is a synthetic UI lane, not a real `TrackSummary`.
 */
export type AutomationTrackSummary = {
  /** Id of the audio track the lane sits after; `null` = first row. */
  afterTrackId?: string | null;
  /** Whether the lane runs. Cues stay authored while it is off. */
  enabled?: boolean;
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
  /**
   * MIDI routing, meaningful only on `kind === "midi"` tracks. The port is the
   * cable the messages leave by (null = the app-wide output device); the
   * channel is which of the 16 addresses inside that cable they are tagged
   * with, and every event inherits it unless it overrides it.
   */
  midiPort?: string | null;
  midiChannel?: number;
  /** Whether a midi track sends. Its equivalent of mute/solo. */
  midiEnabled?: boolean;
  /** Whether a folder track is collapsed in the arrangement. Persisted with
   * the song so a folder the user collapsed is still collapsed next time they
   * open the session. Optional + defaults to false for back-compat with
   * snapshots written before the field existed. */
  collapsed?: boolean;
};

export function formatTransposeSemitones(value: number): string {
  if (value === 0) {
    return "0";
  }

  return value > 0 ? `+${value}` : `${value}`;
}

/** Display a tempo without inventing or destroying precision.
 *
 * BPM is stored as f64 all the way down (tempo markers, `warpSourceBpm`), so a
 * 130.5 marker really is 130.5. Formatting it with `toFixed(0)` used to render
 * it as "131", which reads as if warp had rounded the tempo it was matching.
 * Integers stay bare (`120`), fractional values keep up to two decimals with
 * trailing zeros trimmed (`130.5`, `96.41`).
 */
export function formatBpm(bpm: number): string {
  if (!Number.isFinite(bpm)) return "";
  if (Number.isInteger(bpm)) return String(bpm);
  return bpm.toFixed(2).replace(/\.?0+$/, "");
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

/** Mirrors Rust `MidiEventKind` (serde camelCase, internally tagged on `type`). */
export type MidiEventKindSummary =
  | { type: "note"; note: number; velocity: number; durationSeconds: number }
  | { type: "controlChange"; controller: number; value: number }
  | { type: "programChange"; program: number }
  | {
      type: "controlCurve";
      controller: number;
      fromValue: number;
      toValue: number;
      durationSeconds: number;
    };

export type MidiEventSummary = {
  id: string;
  /** Offset from the clip start in seconds; 0 = fires with the clip. */
  atSeconds: number;
  /**
   * Per-event channel override (1-16). Absent/null — the normal case — means
   * "use the track's channel", so a track that talks to one device is
   * configured in one place.
   */
  channel?: number | null;
  kind: MidiEventKindSummary;
};

/**
 * A bundle of MIDI messages anchored to one point on the timeline. Not a piano
 * roll — the unit is "at this point, fire these messages", which is what a
 * multitrack player needs to drive lighting desks and lyric projection.
 */
export type MidiClipSummary = {
  id: string;
  trackId: string;
  timelineStartSeconds: number;
  name: string;
  events: MidiEventSummary[];
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
  /** Absent on snapshots from before MIDI tracks existed. */
  midiClips?: MidiClipSummary[];
  tracks: TrackSummary[];
  automationCues?: AutomationCueSummary[];
  mixScenes?: MixSceneSummary[];
  automationTrack?: AutomationTrackSummary | null;
  waveforms?: WaveformSummaryDto[];
  /** Name of the loaded session folder. Absent on snapshots from before the
   * session name was surfaced, or when no session is loaded from disk. */
  sessionName?: string | null;
  projectRevision: number;
};

export type WaveformSummaryDto = {
  waveformKey: string;
  version: number;
  durationSeconds: number;
  sampleRate: number;
  lods: WaveformLodDto[];
  /** Set only on the partial summaries pushed by `waveform:progress` while a
   * file is still being analysed: how many seconds of the source the peaks
   * actually cover. The peaks past that point are zero-filled padding, so the
   * renderer draws the waveform up to here and marks the rest as pending.
   * Absent on a finished summary. */
  analyzedSeconds?: number;
};

export type WaveformWindowDto = {
  sampleRate: number;
  startSeconds: number;
  endSeconds: number;
  bucketCount: number;
  minPeaksBase64: string;
  maxPeaksBase64: string;
  minPeaksRightBase64?: string;
  maxPeaksRightBase64?: string;
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

/**
 * Current OS resource usage for the top-bar resource meter. Mirrors the Rust
 * `SystemResourceSnapshot`. CPU values are percentages (0..100);
 * `processCpuPercent` is normalised across all cores to match Task Manager.
 * Disk values are bytes per second (0 on the first sample — no baseline yet).
 */
export type SystemResourceSnapshot = {
  processCpuPercent: number;
  processMemoryBytes: number;
  systemCpuPercent: number;
  systemMemoryUsedBytes: number;
  systemMemoryTotalBytes: number;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
  /** Audio-callback load (Ableton-style CPU meter). >100% means dropouts.
   * Only meaningful when `audioEngineActive` is true. */
  audioLoadPercent: number;
  audioUnderrunCount: number;
  audioEngineActive: boolean;
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
  pendingAutomationCue?: PendingAutomationCueSummary | null;
  activeVamp?: ActiveVampSummary | null;
  automationCues?: AutomationCueSummary[];
  mixScenes?: MixSceneSummary[];
  automationTrack?: AutomationTrackSummary | null;
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
  sources?: SourceReadinessSummary;
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

/** Final stereo peaks after track mix, routing, region/master gain and pan. */
export type AudioOutputMeterLevel = {
  leftPeak: number;
  rightPeak: number;
};

/** E2E-only: the most recent final stereo output frames for spectral analysis. */
export type AudioOutputCapture = {
  sampleRate: number;
  left: number[];
  right: number[];
};

/** Output-device health, emitted as `audio:device_status`. `fallbackActive`
 * means the device died (or never opened) and the engine keeps the transport
 * running on its internal silent clock while it retries the device. */
export type AudioDeviceStatusEvent = {
  fallbackActive: boolean;
  deviceName: string;
  lastError: string;
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
  "clickTrack",
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
  /** Android only: open the output stream in AAudio low-latency mode. */
  lowLatencyOutput: boolean;
  selectedMidiDevice: string | null;
  /** Port the timeline MIDI tracks send to. Separate from the input device. */
  selectedMidiOutputDevice: string | null;
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
  voiceGuideEnabled: boolean;
  voiceGuideOutput: string;
  voiceGuideVolume: number;
  voiceGuideLeadBars: number;
  voiceGuideCountInEnabled: boolean;
  voiceGuideLanguage: string;
  padEnabled: boolean;
  /** Installed pad folder id currently selected ("" = none). */
  padId: string;
  /** Selected key, 0..11 (C..B). */
  padKey: number;
  padVolume: number;
  padOutput: string;
  /** Soft-entrance duration in seconds when the pad is enabled (0 = instant). */
  padFadeInSeconds: number;
  /** Soft-exit duration in seconds on disable / key swap (0 = fast swap). */
  padFadeOutSeconds: number;
  /**
   * When true the pad's key follows the song's tonic (the region under the
   * playhead) and its transpose, instead of the manual key selection.
   */
  padFollowSongKey: boolean;
  /**
   * When true the pad follows the transport: it fades out (using
   * padFadeOutSeconds) when playback stops/pauses and returns on play, without
   * clearing padEnabled — the switch stays on. Default false: the pad otherwise
   * keeps sounding between songs, which is the point of an ambient pad.
   */
  padStopWithTransport: boolean;
  globalJumpMode: "immediate" | "after_bars" | "next_marker";
  globalJumpBars: number;
  songJumpTrigger: "immediate" | "region_end" | "after_bars" | "next_marker";
  songJumpBars: number;
  songTransitionMode: "instant" | "fade_out";
  vampMode: "section" | "bars";
  vampBars: number;
  timelineNavigationScheme: "ableton" | "libretracks";
  timelinePlayheadFollowMode: "ahead" | "center";
  /**
   * When true (default) importing a song package whose track name and kind
   * already exist in the session appends its clips onto that existing track,
   * keeping one lane per instrument across every song. When false each imported
   * song brings its own tracks, even if two songs both name a track "Batería".
   */
  importMergeMatchingTracks: boolean;
  /**
   * When true (default) the loaded session is saved on its own every
   * `autoSaveIntervalMinutes`, so an unexpected crash or power cut loses at most
   * one interval of work. The timer only fires when the project actually changed
   * since the last save (tracked by `projectRevision`), so an idle session never
   * touches the disk.
   */
  autoSaveEnabled: boolean;
  /** Minutes between autosaves. Clamped to AUTO_SAVE_INTERVAL_RANGE. */
  autoSaveIntervalMinutes: number;
  midiMappings: Record<string, MidiBinding>;
};

/**
 * Bounds for `autoSaveIntervalMinutes`. The floor keeps a large session from
 * saving so often that the writes are noticeable; the ceiling keeps "autosave
 * on" from meaning "an hour of lost work".
 */
export const AUTO_SAVE_INTERVAL_RANGE = { min: 1, max: 60 } as const;

/**
 * Intervals offered in the Settings dropdown. A fixed list (rather than free
 * numeric entry) keeps the field consistent with the other selects on the tab
 * and stops anyone typing a value that only produces disk churn. Every entry
 * must sit inside AUTO_SAVE_INTERVAL_RANGE — asserted in the tests.
 */
export const AUTO_SAVE_INTERVAL_PRESETS: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60,
];

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
  lowLatencyOutput: false,
  selectedMidiDevice: null,
  selectedMidiOutputDevice: null,
  suppressMissingMidiDeviceWarning: false,
  enabledOutputChannels: [0, 1],
  locale: null,
  metronomeEnabled: false,
  // Linear gain (~+6 dB), matching `default_metronome_volume` in
  // apps/desktop/src-tauri/src/infra/settings.rs. This is the level the click
  // has always played at: the old model saved 0.8 and applied a fixed 2.5x
  // boost before the engine.
  metronomeVolume: 2.0,
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
  voiceGuideEnabled: false,
  voiceGuideOutput: "monitor",
  voiceGuideVolume: 1.0,
  voiceGuideLeadBars: 1,
  voiceGuideCountInEnabled: true,
  voiceGuideLanguage: "es",
  padEnabled: false,
  padId: "",
  padKey: 0,
  padVolume: 1.0,
  padOutput: "master",
  padFadeInSeconds: 0,
  padFadeOutSeconds: 0,
  padFollowSongKey: false,
  padStopWithTransport: false,
  globalJumpMode: "immediate",
  globalJumpBars: 4,
  songJumpTrigger: "immediate",
  songJumpBars: 4,
  songTransitionMode: "instant",
  vampMode: "section",
  vampBars: 4,
  timelineNavigationScheme: "ableton",
  timelinePlayheadFollowMode: "ahead",
  importMergeMatchingTracks: true,
  autoSaveEnabled: true,
  autoSaveIntervalMinutes: 5,
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
  const selectedMidiOutputDevice =
    settings.selectedMidiOutputDevice?.trim() || null;
  const locale = settings.locale?.trim().toLowerCase();
  // Aux faders (click / voice guide) run an Ableton-style dB scale up to
  // +20 dB, i.e. a linear gain of ~10. Clamp to that headroom, not to unity.
  const metronomeVolume = Number.isFinite(settings.metronomeVolume)
    ? Math.min(AUX_MAX_GAIN, Math.max(0, settings.metronomeVolume))
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
    ? Math.min(AUX_MAX_GAIN, Math.max(0, settings.metronomeSubdivisionGain))
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
  const voiceGuideOutput =
    settings.voiceGuideOutput?.trim().toLowerCase() ||
    DEFAULT_APP_SETTINGS.voiceGuideOutput;
  const padOutput =
    settings.padOutput?.trim().toLowerCase() || DEFAULT_APP_SETTINGS.padOutput;
  const globalJumpMode =
    settings.globalJumpMode === "after_bars" ||
    settings.globalJumpMode === "next_marker"
      ? settings.globalJumpMode
      : DEFAULT_APP_SETTINGS.globalJumpMode;
  const songJumpTrigger =
    settings.songJumpTrigger === "after_bars" ||
    settings.songJumpTrigger === "region_end" ||
    settings.songJumpTrigger === "next_marker"
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
  const timelinePlayheadFollowMode =
    settings.timelinePlayheadFollowMode === "center"
      ? settings.timelinePlayheadFollowMode
      : DEFAULT_APP_SETTINGS.timelinePlayheadFollowMode;
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
    lowLatencyOutput: Boolean(settings.lowLatencyOutput),
    selectedMidiDevice,
    selectedMidiOutputDevice,
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
    voiceGuideEnabled: Boolean(settings.voiceGuideEnabled),
    voiceGuideOutput,
    voiceGuideVolume: Number.isFinite(settings.voiceGuideVolume)
      ? Math.min(AUX_MAX_GAIN, Math.max(0, settings.voiceGuideVolume))
      : DEFAULT_APP_SETTINGS.voiceGuideVolume,
    voiceGuideLeadBars: Number.isFinite(settings.voiceGuideLeadBars)
      ? Math.min(4, Math.max(1, Math.round(settings.voiceGuideLeadBars)))
      : DEFAULT_APP_SETTINGS.voiceGuideLeadBars,
    voiceGuideCountInEnabled: settings.voiceGuideCountInEnabled ?? true,
    voiceGuideLanguage:
      settings.voiceGuideLanguage ?? DEFAULT_APP_SETTINGS.voiceGuideLanguage,
    padEnabled: Boolean(settings.padEnabled),
    padId: typeof settings.padId === "string" ? settings.padId : "",
    padKey: Number.isFinite(settings.padKey)
      ? Math.min(11, Math.max(0, Math.round(settings.padKey)))
      : DEFAULT_APP_SETTINGS.padKey,
    padVolume: Number.isFinite(settings.padVolume)
      ? Math.min(AUX_MAX_GAIN, Math.max(0, settings.padVolume))
      : DEFAULT_APP_SETTINGS.padVolume,
    padOutput,
    padFadeInSeconds: Number.isFinite(settings.padFadeInSeconds)
      ? Math.min(30, Math.max(0, settings.padFadeInSeconds))
      : DEFAULT_APP_SETTINGS.padFadeInSeconds,
    padFadeOutSeconds: Number.isFinite(settings.padFadeOutSeconds)
      ? Math.min(30, Math.max(0, settings.padFadeOutSeconds))
      : DEFAULT_APP_SETTINGS.padFadeOutSeconds,
    padFollowSongKey: Boolean(settings.padFollowSongKey),
    padStopWithTransport: Boolean(settings.padStopWithTransport),
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
    timelinePlayheadFollowMode,
    // Defaults to true when absent (older settings files) so existing users
    // keep the historical merge-on-import behaviour.
    importMergeMatchingTracks: settings.importMergeMatchingTracks ?? true,
    // Absent in settings files written before autosave shipped: default to on,
    // matching DEFAULT_APP_SETTINGS.
    autoSaveEnabled: settings.autoSaveEnabled ?? true,
    autoSaveIntervalMinutes: normalizeAutoSaveIntervalMinutes(
      settings.autoSaveIntervalMinutes,
    ),
    midiMappings,
  };
}

/**
 * Clamp the autosave period into AUTO_SAVE_INTERVAL_RANGE, falling back to the
 * default for NaN/absent values. Guards against a hand-edited settings.json
 * asking for a 0-minute interval, which would autosave on every tick.
 */
export function normalizeAutoSaveIntervalMinutes(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_APP_SETTINGS.autoSaveIntervalMinutes;
  }
  return Math.min(
    AUTO_SAVE_INTERVAL_RANGE.max,
    Math.max(AUTO_SAVE_INTERVAL_RANGE.min, Math.round(value as number)),
  );
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

/** Aggregate readiness of the engine's audio sources (decode + PCM cache).
 * Drives the global "Preparing audio…" indicator. `sourcesProgressPercent` is
 * real (averaged from each source's live progress), never indeterminate. */
export type SourceReadinessSummary = {
  sourcesReady: boolean;
  sourcesTotal: number;
  sourcesReadyCount: number;
  sourcesLoadingCount: number;
  sourcesFailedCount: number;
  sourcesProgressPercent: number;
  cacheRamUsedMb: number;
  cacheDiskUsedMb: number;
};

export type AudioBackendKind =
  | "asio"
  | "wasapi"
  | "core_audio"
  | "alsa"
  | "jack"
  | "direct_sound"
  | "mme"
  // Android (Oboe -> AAudio). The Settings UI hides the backend selector on
  // Android, but device descriptors still carry the backend.
  | "oboe"
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
      "oboe",
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

export type SessionExportProgressEvent = {
  percent: number;
  message: string;
  /** True on the terminal event (success or failure). */
  done: boolean;
  /** Set when the export failed. */
  error: string | null;
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

// ── Ambient pads ─────────────────────────────────────────────────────────────

/** A pad offered by the catalog, plus its local install state. */
export type PadCatalogEntry = {
  id: string;
  name: string;
  description: string;
  sizeBytes: number;
  downloadUrl: string;
  /** True when all 12 keys are present on disk. */
  installed: boolean;
  /** Number of the 12 keys present (partial-install hint). */
  keysPresent: number;
  /** Per-key presence, indexed 0..11 (C..B). Lets the UI disable the exact
   * tonalities a pad is missing (chiefly for user-created pads). */
  keysPresentMask: boolean[];
  /** True when created locally by the user (editable in the pad manager). */
  isUser: boolean;
};

export type PadsCatalog = {
  pads: PadCatalogEntry[];
  /** Installed ids no longer in the manifest (still usable/removable). */
  orphanInstalled: string[];
  /** True when the manifest couldn't be fetched (offline). */
  offline: boolean;
};

/** Progress of a single pad download/unzip/install, shaped like the
 * project-load progress so the same "preparing audio"-style indicator can
 * render it. */
export type PadDownloadProgressEvent = {
  padId: string;
  percent: number;
  message: string;
  done: boolean;
  error?: string;
  emittedAtUnixMs?: number;
};

export type WaveformReadyEvent = {
  songDir: string;
  waveformKey: string;
  summary: WaveformSummaryDto;
};

/** Pushed repeatedly while a waveform is being analysed, carrying the peaks
 * completed so far so the clip paints in pieces instead of sitting on a static
 * "analyzing" placeholder. A `WaveformReadyEvent` for the same key always
 * follows and supersedes it. */
export type WaveformProgressEvent = {
  songDir: string;
  waveformKey: string;
  analyzedSeconds: number;
  durationSeconds: number;
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
      key: null,
      warpEnabled: false,
      warpSourceBpm: null,
      master: { gain: 1.0 },
      compactColumnWidthRem: null,
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
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1.0 },
    compactColumnWidthRem: null,
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

/**
 * The twelve pitch classes in sharp notation, indexed by semitone offset from C.
 * Canonical output notation always uses sharps (no flats) so that
 * {@link transposeKey} round-trips deterministically.
 */
const PITCH_CLASSES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

/**
 * Maps every accepted note-name spelling (sharps and flats) to its semitone
 * offset from C. Used to parse a stored `song.key` regardless of how it was
 * written. Case is normalised by {@link parseSongKey} before lookup.
 */
const NOTE_TO_SEMITONE: Record<string, number> = {
  C: 0,
  "C#": 1,
  DB: 1,
  D: 2,
  "D#": 3,
  EB: 3,
  E: 4,
  FB: 4,
  F: 5,
  "E#": 5,
  "F#": 6,
  GB: 6,
  G: 7,
  "G#": 8,
  AB: 8,
  A: 9,
  "A#": 10,
  BB: 10,
  B: 11,
  CB: 11,
};

/**
 * The 24 selectable song keys (12 pitch classes × major/minor) in canonical
 * sharp notation — the closed vocabulary offered by the key picker. Order is
 * all majors C→B, then all minors Cm→Bm.
 */
export const SONG_KEY_OPTIONS: readonly string[] = [
  ...PITCH_CLASSES,
  ...PITCH_CLASSES.map((note) => `${note}m`),
];

export type ParsedSongKey = {
  /** Semitone offset of the tonic from C, in the range 0..11. */
  semitone: number;
  /** True when the key is minor (a trailing `m`), false for major. */
  minor: boolean;
};

/**
 * Parses a stored key string (e.g. `"Dm"`, `"F#"`, `"eb"`) into a tonic
 * semitone + mode. Returns `null` when the string is empty or not a recognised
 * note, so callers can fall back to showing raw text or nothing.
 */
export function parseSongKey(
  key: string | null | undefined,
): ParsedSongKey | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;

  // A trailing "m" (but not "maj") marks a minor key. Everything before it is
  // the note name.
  const minor = /m$/i.test(trimmed) && !/maj$/i.test(trimmed);
  const noteName = (minor ? trimmed.slice(0, -1) : trimmed).trim();
  const normalised =
    noteName.charAt(0).toUpperCase() + noteName.slice(1).toUpperCase();
  const semitone = NOTE_TO_SEMITONE[normalised];
  if (semitone === undefined) return null;

  return { semitone, minor };
}

/**
 * Canonical label for a parsed key, always in sharp notation (`"Dm"`, `"F#"`).
 */
export function formatSongKey(parsed: ParsedSongKey): string {
  return `${PITCH_CLASSES[parsed.semitone]}${parsed.minor ? "m" : ""}`;
}

/**
 * Transposes a stored key by a number of semitones and returns the canonical
 * label of the result. When `key` cannot be parsed the original string is
 * returned unchanged (with the semitone count appended only by the caller if
 * desired). A `0` shift returns the canonicalised original key.
 */
export function transposeKey(
  key: string | null | undefined,
  semitones: number,
): string | null {
  const parsed = parseSongKey(key);
  if (!parsed) return null;
  const shifted = (((parsed.semitone + semitones) % 12) + 12) % 12;
  return formatSongKey({ semitone: shifted, minor: parsed.minor });
}

/**
 * The effective musical key of a region (song): the region's own original
 * `key` transposed by its `transposeSemitones`. Returns `null` when the region
 * has no key set or it is unparseable, so display sites can hide the label.
 *
 * The transpose always applies, warp or not: warp and pitch are independent
 * parameters of the same Bungee voice (warp sets the time-ratio, transpose sets
 * the pitch-scale), so a warped region with a transpose still sounds — and is
 * labelled — at the shifted key.
 */
export function regionEffectiveKey(
  region: Pick<SongRegionSummary, "key" | "transposeSemitones"> | null | undefined,
): string | null {
  if (!region) return null;
  return transposeKey(region.key, region.transposeSemitones);
}

/**
 * The pad key (0..11, C..B) that matches a region's tonic, for the pad's
 * "follow song key" mode. A pad is a tonal drone — a sustained fundamental — so
 * only the tonic matters, not major/minor: a song in `Dm` and one in `D` both
 * drive the pad to `D` (index 2). Returns `null` when the region has no
 * (parseable) key, so callers leave the manual pad key untouched.
 */
export function regionPadKey(
  region: Pick<SongRegionSummary, "key" | "transposeSemitones"> | null | undefined,
): number | null {
  const parsed = parseSongKey(regionEffectiveKey(region));
  return parsed ? parsed.semitone : null;
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
