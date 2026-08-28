import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import {
  buildSongTempoRegions,
  getSongRegionAtPosition,
  getSongTempoRegionAtPosition,
  formatTransposeSemitones,
  METRONOME_SOUND_PRESETS,
  markerColor,
  regionEffectiveKey,
  type AppSettings,
  type AudioMeterLevel,
  type PadsCatalog,
  type SongRegionSummary,
  type SongView,
  type TrackSummary,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import {
  BASE_PIXELS_PER_SECOND,
  buildVisibleTimelineGrid,
  getCumulativeMusicalPosition,
  secondsToAbsoluteX,
} from "@libretracks/shared/timelineMath";
import {
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_CLIP_HOLD_MS,
  METER_CLIP_THRESHOLD,
  METER_MIN_DB,
  METER_PEAK_DECAY_DB_PER_SECOND,
  METER_PEAK_HOLD_MS,
  meterStyleFromDb,
  peakHoldStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "@libretracks/shared/meterBallistics";
import {
  AUX_FADER_SCALE,
  TRACK_FADER_SCALE,
  faderTicks,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";
import { getRemoteStrings } from "./i18n";
import { buildMarkerCards, buildTimelineMarkerChips } from "./markerCards";
import {
  advanceRemoteClock,
  idleRemoteAnchor,
  type PlaybackVisualAnchor,
  resolveLivePosition,
} from "./remoteClock";
import { resolveMarkerAutoScrollTop } from "./markerAutoScroll";
import {
  CountdownWidget,
  CurrentKeyWidget,
  NextMarkerWidget,
  NextSongWidget,
  ProgressToMarkerWidget,
  ProgressToSongWidget,
  useLiveMusicalContext,
} from "./liveWidgets";
import {
  DEFAULT_METRONOME_WIDGET_HEIGHT,
  DEFAULT_PADS_WIDGET_HEIGHT,
  LAYOUT_COLUMNS,
  LAYOUT_MAX_ROWS,
  TAB_HEIGHT_MAX_REM,
  TAB_HEIGHT_MIN_REM,
  clampTabHeight,
  clearStoredLayout,
  computeFoldRow,
  containingGroupId,
  defaultLayout,
  layoutExportFilename,
  makeEmptyTab,
  moveWidgetWithGroup,
  newWidgetId,
  parseLayoutFile,
  pushWidgetsDown,
  readStoredLayout,
  reconcileWidgetGroup,
  rectContainsPoint,
  serializeLayoutFile,
  writeStoredLayout,
  type LayoutPlacementMode,
  type LayoutTab,
  type LayoutPresetProfile,
  type RemoteLayout,
  type WidgetConfig,
  type WidgetPlacement,
  type WidgetType,
} from "./remoteLayout";
import {
  bpmForRegion,
  clipsForRegion,
  compactSongPlayIntent,
  formatBpm,
  keyForRegion,
  type SongClipEntry,
} from "./songWidgets";
import {
  TIMELINE_PENDING_SEEK_TIMEOUT_MS,
  isTimelineTap,
  resolvePendingSeek,
  timelineTapPositionSeconds,
  type PendingSeek,
} from "./timelineSeek";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type JumpMode = "immediate" | "next_marker" | "after_bars";
type SongJumpTrigger = "immediate" | "region_end" | "after_bars" | "next_marker";
type SongTransitionMode = "instant" | "fade_out";
type VampMode = "section" | "bars";

type RemoteConnectionState = {
  status: ConnectionStatus;
  error: string | null;
  socket: WebSocket | null;
  setConnection: (socket: WebSocket | null, status: ConnectionStatus, error?: string | null) => void;
};

type RemoteSyncState = {
  snapshot: TransportSnapshot | null;
  songView: SongView | null;
  settings: AppSettings | null;
  padsCatalog: PadsCatalog | null;
  meters: Record<string, AudioMeterLevel>;
  /** The visual clock, and the ONLY record of when a snapshot landed: the
   * arrival time lives inside the anchor. Folded forward on every snapshot so a
   * poll that merely confirms the extrapolation leaves the playhead gliding. */
  visualAnchor: PlaybackVisualAnchor;
  setSnapshot: (snapshot: TransportSnapshot) => void;
  setSongView: (songView: SongView | null) => void;
  setSettings: (settings: AppSettings) => void;
  setPadsCatalog: (catalog: PadsCatalog) => void;
  setMeters: (meters: AudioMeterLevel[]) => void;
};

type TrackOptimisticState = {
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
};

type OptimisticState = {
  tracks: Record<string, TrackOptimisticState>;
  pendingJumpTargetId: string | null;
  setTrackState: (trackId: string, patch: TrackOptimisticState) => void;
  clearTracks: () => void;
  setPendingJumpTarget: (markerId: string | null) => void;
};

type TransportReadout = {
  positionSeconds: number;
  timecode: string;
  musicalDisplay: string;
  bpm: number;
  timeSignature: string;
  regionName: string;
};

type RemoteJumpState = {
  mode: JumpMode;
  bars: number;
  songTrigger: SongJumpTrigger;
  songBars: number;
  songTransition: SongTransitionMode;
  vampMode: VampMode;
  vampBars: number;
  setMode: (mode: JumpMode) => void;
  setBars: (bars: number) => void;
  setSongTrigger: (mode: SongJumpTrigger) => void;
  setSongBars: (bars: number) => void;
  setSongTransition: (mode: SongTransitionMode) => void;
  setVampMode: (mode: VampMode) => void;
  setVampBars: (bars: number) => void;
};

type FolderPalette = {
  background: string;
  border: string;
  accent: string;
};

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

const CHROME_TIMELINE_PIXELS_PER_SECOND = BASE_PIXELS_PER_SECOND * 2.35;
const PAN_CENTER_MAGNET = 0.08;
// Track-fader dB tick marks, positioned at their true travel offset so "0"
// lands where 0 dB actually sits (~30% down), not at the vertical midpoint.
const TRACK_FADER_TICKS = faderTicks(TRACK_FADER_SCALE);
// Holding Shift while dragging scales pointer travel by this factor for fine
// dB adjustments (Reaper-style). Mirrors the desktop useFineDragRange factor.
const FINE_DRAG_FACTOR = 0.25;
// Song master fader: linear gain 0..2, snapping to unity (1.0) within ±3% of
// the range. Mirrors the desktop master fader (TimelineToolbar) so the remote
// and desktop feel identical.
const MASTER_GAIN_MIN = 0;
const MASTER_GAIN_MAX = 2;
const MASTER_SNAP_TARGET = 1.0;
const MASTER_SNAP_THRESHOLD = MASTER_GAIN_MAX * 0.03;
const REMOTE_SIZE_STORAGE_KEY = "libretracks.remote.uiSize";
const MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY = "libretracks.remote.mixerFilterActiveSong";

const useMixerUiStore = create<{
  filterActiveSong: boolean;
  setFilterActiveSong: (value: boolean) => void;
}>((set) => ({
  filterActiveSong:
    typeof window !== "undefined" &&
    window.localStorage.getItem(MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY) === "1",
  setFilterActiveSong: (value) => {
    try {
      window.localStorage.setItem(MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Storage can be unavailable; the in-memory editor still works.
    }
    set({ filterActiveSong: value });
  },
}));
const HIDDEN_MARKERS_STORAGE_KEY = "libretracks.remote.hiddenMarkerIds";
const TIMELINE_CLICK_SEEK_STORAGE_KEY = "libretracks.remote.timelineClickSeek";

/**
 * Tap-to-seek on the cinta. Off by default: on stage an accidental tap on the
 * timeline must never jump playback, so the user opts in from the toggle in the
 * corner of the ruler. Persisted per-device like the other remote preferences.
 */
const useTimelineUiStore = create<{
  clickToSeek: boolean;
  setClickToSeek: (value: boolean) => void;
}>((set) => ({
  clickToSeek:
    typeof window !== "undefined" &&
    window.localStorage.getItem(TIMELINE_CLICK_SEEK_STORAGE_KEY) === "1",
  setClickToSeek: (value) => {
    try {
      window.localStorage.setItem(TIMELINE_CLICK_SEEK_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Storage can be unavailable; the in-memory preference still works.
    }
    set({ clickToSeek: value });
  },
}));
const MAX_REMOTE_SIZE_LEVEL = 3;
const TIMELINE_JITTER_RESET_THRESHOLD_SECONDS = 0.18;
// Lower snap threshold so the playhead re-aligns with the real position sooner
// (was 0.32) — the user wants the cinta to track playback tightly.
const TIMELINE_CORRECTION_SNAP_THRESHOLD_SECONDS = 0.14;
// Much stronger forward correction so the visual playhead closes the latency
// gap within a couple of frames instead of trailing for ~a second (was 10).
const TIMELINE_FORWARD_CORRECTION_PER_SECOND = 60;
// How long the manually-dragged timeline offset is held before it eases back to
// the auto-following (playhead-centred) position.
const TIMELINE_MANUAL_HOLD_MS = 6000;
// Per-second exponential ease used to return the manual offset to zero once the
// hold expires (higher = snappier return).
const TIMELINE_MANUAL_RETURN_PER_SECOND = 4;
const READOUT_MIN_UPDATE_INTERVAL_MS = 1000 / 30;
const STRINGS = getRemoteStrings();

function isTimelineDebugEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  const query = new URLSearchParams(window.location.search);
  return query.get("timelineDebug") === "1" || window.localStorage.getItem("libretracks.remote.timelineDebug") === "1";
}

function getTransportRepositionToken(snapshot: TransportSnapshot | null) {
  const transportClock = snapshot?.transportClock;
  return [
    snapshot?.playbackState ?? "none",
    transportClock?.lastSeekPositionSeconds ?? "none",
    transportClock?.lastJumpPositionSeconds ?? "none",
    transportClock?.lastStartPositionSeconds ?? "none",
  ].join("|");
}

function readRemoteSizeLevel() {
  if (typeof window === "undefined") {
    return 0;
  }

  const storedValue = window.localStorage.getItem(REMOTE_SIZE_STORAGE_KEY);
  if (storedValue === "large") {
    return 1;
  }

  const parsedLevel = Number(storedValue);
  if (!Number.isFinite(parsedLevel)) {
    return 0;
  }

  return Math.min(MAX_REMOTE_SIZE_LEVEL, Math.max(0, Math.floor(parsedLevel)));
}

/** Marker ids the user has hidden from the jump grid, persisted per-device. */
function readHiddenMarkerIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(HIDDEN_MARKERS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeHiddenMarkerIds(ids: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      HIDDEN_MARKERS_STORAGE_KEY,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    // Storage blocked — keep the in-memory set only.
  }
}

const useRemoteConnectionStore = create<RemoteConnectionState>()((set) => ({
  status: "connecting",
  error: null,
  socket: null,
  setConnection: (socket, status, error = null) => {
    set({ socket, status, error });
  },
}));

const useRemoteSyncStore = create<RemoteSyncState>()(
  subscribeWithSelector((set) => ({
    snapshot: null,
    songView: null,
    settings: null,
    padsCatalog: null,
    meters: {},
    visualAnchor: idleRemoteAnchor(performance.now()),
    setSnapshot: (snapshot) => {
      set((state) => {
        const nowMs = performance.now();
        return {
          snapshot,
          visualAnchor: advanceRemoteClock({
            anchor: state.visualAnchor,
            previousSnapshot: state.snapshot,
            nextSnapshot: snapshot,
            nowMs,
          }),
        };
      });
    },
    setSongView: (songView) => {
      set({ songView });
    },
    setSettings: (settings) => {
      set({ settings });
    },
    setPadsCatalog: (padsCatalog) => {
      set({ padsCatalog });
    },
    setMeters: (meters) => {
      set({
        meters: Object.fromEntries(meters.map((meter) => [meter.trackId, meter])),
      });
    },
  })),
);

const useOptimisticStore = create<OptimisticState>()((set) => ({
  tracks: {},
  pendingJumpTargetId: null,
  setTrackState: (trackId, patch) => {
    set((state) => ({
      tracks: {
        ...state.tracks,
        [trackId]: {
          ...state.tracks[trackId],
          ...patch,
        },
      },
    }));
  },
  clearTracks: () => {
    set({ tracks: {} });
  },
  setPendingJumpTarget: (markerId) => {
    set({ pendingJumpTargetId: markerId });
  },
}));

const useRemoteJumpStore = create<RemoteJumpState>()((set) => ({
  mode: "immediate",
  bars: 4,
  songTrigger: "immediate",
  songBars: 4,
  songTransition: "instant",
  vampMode: "section",
  vampBars: 4,
  setMode: (mode) => {
    set({ mode });
  },
  setBars: (bars) => {
    set({ bars: Math.max(1, Math.floor(bars) || 1) });
  },
  setSongTrigger: (songTrigger) => {
    set({ songTrigger });
  },
  setSongBars: (songBars) => {
    set({ songBars: Math.max(1, Math.floor(songBars) || 1) });
  },
  setSongTransition: (songTransition) => {
    set({ songTransition });
  },
  setVampMode: (vampMode) => {
    set({ vampMode });
  },
  setVampBars: (vampBars) => {
    set({ vampBars: Math.max(1, Math.floor(vampBars) || 1) });
  },
}));

type RemoteUiState = {
  /** Region whose markers/transpose the control deck acts on. */
  selectedRegionId: string | null;
  /** Which inline settings sheet (vamp/jump/song) is open in the deck. */
  activePanel: RemotePanelKey | null;
  activePanelOwnerId: string | null;
  activePanelAnchor: RemotePanelAnchor | null;
  /** Marker ids hidden from the jump grid, mirrored to localStorage. */
  hiddenMarkerIds: Set<string>;
  /** Whether hidden markers are temporarily revealed (dimmed) for restoring. */
  revealHiddenMarkers: boolean;
  setSelectedRegionId: (regionId: string | null) => void;
  toggleActivePanel: (panel: RemotePanelKey, ownerId: string, anchor: RemotePanelAnchor) => void;
  closeActivePanel: () => void;
  toggleMarkerHidden: (markerId: string) => void;
  setRevealHiddenMarkers: (reveal: boolean) => void;
};

// UI state shared by the (soon independent) control-deck and marker-grid
// widgets. Lifted out of TransportView so each can be an autonomous widget on
// the layout canvas without prop-drilling. `hiddenMarkerIds` keeps its
// localStorage persistence here so the store stays the single source of truth.
const useRemoteUiStore = create<RemoteUiState>()((set) => ({
  selectedRegionId: null,
  activePanel: null,
  activePanelOwnerId: null,
  activePanelAnchor: null,
  hiddenMarkerIds: readHiddenMarkerIds(),
  revealHiddenMarkers: false,
  setSelectedRegionId: (selectedRegionId) => {
    set({ selectedRegionId });
  },
  toggleActivePanel: (panel, ownerId, activePanelAnchor) => {
    set((state) => {
      const closing = state.activePanel === panel && state.activePanelOwnerId === ownerId;
      return closing
        ? { activePanel: null, activePanelOwnerId: null, activePanelAnchor: null }
        : { activePanel: panel, activePanelOwnerId: ownerId, activePanelAnchor };
    });
  },
  closeActivePanel: () => {
    set({ activePanel: null, activePanelOwnerId: null, activePanelAnchor: null });
  },
  toggleMarkerHidden: (markerId) => {
    set((state) => {
      const next = new Set(state.hiddenMarkerIds);
      if (next.has(markerId)) {
        next.delete(markerId);
      } else {
        next.add(markerId);
      }
      writeHiddenMarkerIds(next);
      return { hiddenMarkerIds: next };
    });
  },
  setRevealHiddenMarkers: (revealHiddenMarkers) => {
    set({ revealHiddenMarkers });
  },
}));

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function sendCommand(command: Record<string, unknown>) {
  const socket = useRemoteConnectionStore.getState().socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(command));
}

function sendMetronomePatch(patch: { enabled?: boolean; volume?: number }) {
  sendCommand({
    cmd: "updateMetronome",
    enabled: patch.enabled,
    volume: patch.volume,
  });
}

function sendSettingsUpdate(settings: AppSettings) {
  useRemoteSyncStore.getState().setSettings(settings);
  sendCommand({
    cmd: "updateSettings",
    settings,
  });
}

function sendPadSettingsUpdate(settings: AppSettings) {
  useRemoteSyncStore.getState().setSettings(settings);
  sendCommand({ cmd: "updatePadSettings", settings });
}

/**
 * Schedule a jump to a song region honouring the project's global song-jump
 * config (trigger + transition), read from the jump store. Shared by the
 * control deck and the compact-song widget while transport is already running.
 * Starting a song from stopped/paused uses playCompactSong below instead.
 */
function scheduleRegionJumpFromStore(regionId: string) {
  const jump = useRemoteJumpStore.getState();
  sendCommand({
    cmd: "scheduleRegionJump",
    targetRegionId: regionId,
    trigger: jump.songTrigger,
    bars: jump.songTrigger === "after_bars" ? jump.songBars : undefined,
    transition: jump.songTransition,
    durationSeconds: jump.songTransition === "fade_out" ? 0.35 : undefined,
  });
}

function parsePendingJumpMode(trigger: string | undefined): { mode: JumpMode; bars?: number } {
  if (!trigger) {
    return { mode: "immediate" };
  }

  if (trigger.startsWith("after_bars:")) {
    const bars = Number(trigger.split(":")[1] ?? "4");
    return {
      mode: "after_bars",
      bars: Math.max(1, Math.floor(bars) || 1),
    };
  }

  if (trigger === "next_marker") {
    return { mode: "next_marker" };
  }

  if (trigger === "region_end") {
    return { mode: "immediate" };
  }

  return { mode: "immediate" };
}

function formatJumpModeLabel(mode: JumpMode, bars: number) {
  if (mode === "immediate") {
    return STRINGS.immediate;
  }

  if (mode === "next_marker") {
    return STRINGS.nextMarker;
  }

  return `${bars} ${STRINGS.bars.toLowerCase()}`;
}

function formatSongTriggerLabel(trigger: SongJumpTrigger, bars: number) {
  if (trigger === "immediate") {
    return STRINGS.immediate;
  }

  if (trigger === "region_end") {
    return STRINGS.songEnd;
  }

  if (trigger === "next_marker") {
    return STRINGS.nextMarker;
  }

  return `${bars} ${STRINGS.bars.toLowerCase()}`;
}

function StepperField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="jump-bars-field">
      <span>{label}</span>
      <div className="bars-stepper" role="group" aria-label={label}>
        <button type="button" onClick={() => onChange(Math.max(1, value - 1))}>-</button>
        <input type="number" min={1} step={1} value={value} readOnly />
        <button type="button" onClick={() => onChange(value + 1)}>+</button>
      </div>
    </label>
  );
}

type RemotePanelKey = "jump" | "vamp" | "song";
type RemotePanelAnchor = { top: number; right: number; bottom: number; left: number };

function magnetizePanValue(value: number) {
  return Math.abs(value) <= PAN_CENTER_MAGNET ? 0 : value;
}

/** Pan readout for the mixer strip: "C" centred, else "L 50" / "R 32". */
function formatRemotePan(value: number) {
  if (Math.abs(value) < 0.005) {
    return "C";
  }
  const side = value < 0 ? "L" : "R";
  return `${side} ${Math.round(Math.abs(value) * 100)}`;
}

/** Volume readout: linear gain shown as a dB value (0 dB = unity). */
function formatRemoteVolume(value: number) {
  return `${formatGainDb(value)} dB`;
}

function snapMasterGain(value: number) {
  return Math.abs(value - MASTER_SNAP_TARGET) <= MASTER_SNAP_THRESHOLD
    ? MASTER_SNAP_TARGET
    : value;
}

function formatMasterGainSummary(gain: number) {
  const db = gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
  const dbLabel = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-∞ dB";
  return `${gain.toFixed(2)}× (${dbLabel})`;
}

function clampColorChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixColor(color: RgbColor, target: RgbColor, amount: number): RgbColor {
  const safeAmount = Math.max(0, Math.min(1, amount));
  return {
    r: clampColorChannel(color.r + (target.r - color.r) * safeAmount),
    g: clampColorChannel(color.g + (target.g - color.g) * safeAmount),
    b: clampColorChannel(color.b + (target.b - color.b) * safeAmount),
  };
}

function colorToRgba(color: RgbColor, alpha: number) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function parseTrackColor(color: string | null | undefined): RgbColor | null {
  const value = color?.trim();
  if (!value) {
    return null;
  }

  const shortHexMatch = /^#([\da-f]{3})$/i.exec(value);
  if (shortHexMatch) {
    const [r, g, b] = shortHexMatch[1].split("").map((channel) => Number.parseInt(`${channel}${channel}`, 16));
    return { r, g, b };
  }

  const fullHexMatch = /^#([\da-f]{6})$/i.exec(value);
  if (fullHexMatch) {
    return {
      r: Number.parseInt(fullHexMatch[1].slice(0, 2), 16),
      g: Number.parseInt(fullHexMatch[1].slice(2, 4), 16),
      b: Number.parseInt(fullHexMatch[1].slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:\d*\.\d+|\d+))?\s*\)$/i.exec(value);
  if (rgbMatch) {
    return {
      r: clampColorChannel(Number(rgbMatch[1])),
      g: clampColorChannel(Number(rgbMatch[2])),
      b: clampColorChannel(Number(rgbMatch[3])),
    };
  }

  return null;
}

function paletteFromTrackColor(color: string | null | undefined): FolderPalette | null {
  const baseColor = parseTrackColor(color);
  if (!baseColor) {
    return null;
  }

  const upperBackground = mixColor(baseColor, { r: 18, g: 18, b: 18 }, 0.7);
  const lowerBackground = mixColor(baseColor, { r: 10, g: 10, b: 10 }, 0.82);
  const accent = mixColor(baseColor, { r: 255, g: 255, b: 255 }, 0.12);

  return {
    background: `linear-gradient(180deg, ${colorToRgba(upperBackground, 0.96)}, ${colorToRgba(lowerBackground, 0.98)})`,
    border: colorToRgba(baseColor, 0.34),
    accent: colorToRgba(accent, 0.96),
  };
}

function buildFolderPaletteMap(tracks: TrackSummary[]) {
  const paletteByTrackId = new Map<string, FolderPalette>();
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  for (const track of tracks) {
    if (track.kind === "folder") {
      const palette = paletteFromTrackColor(track.color);
      if (palette) {
        paletteByTrackId.set(track.id, palette);
      }
    }
  }

  for (const track of tracks) {
    if (paletteByTrackId.has(track.id)) {
      continue;
    }

    let cursor = track.parentTrackId ?? null;
    while (cursor) {
      const palette = paletteByTrackId.get(cursor);
      if (palette) {
        paletteByTrackId.set(track.id, palette);
        break;
      }
      cursor = trackById.get(cursor)?.parentTrackId ?? null;
    }
  }

  return paletteByTrackId;
}

/**
 * Track ids that participate in the song the playhead is currently on. A
 * track participates when it has at least one clip whose timeline span
 * overlaps the active region. Returns `null` when the playhead is not inside
 * any region (between songs, or fresh project), in which case the caller
 * should fall back to showing every track. Mirrors the desktop
 * CompactView's `activeSongTrackIds` derivation so the two views agree on
 * what "the active song's tracks" means.
 */
function computeActiveSongTrackIds(
  songView: SongView | null,
  positionSeconds: number,
): Set<string> | null {
  if (!songView) {
    return null;
  }

  const activeRegion = songView.regions.find(
    (region) =>
      positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
  );
  if (!activeRegion) {
    return null;
  }

  const ids = new Set<string>();
  for (const clip of songView.clips) {
    const clipEnd = clip.timelineStartSeconds + clip.durationSeconds;
    if (
      clipEnd > activeRegion.startSeconds &&
      clip.timelineStartSeconds < activeRegion.endSeconds
    ) {
      ids.add(clip.trackId);
    }
  }
  return ids;
}

/**
 * Given the set of tracks that participate in the active song, expand it
 * to also include every ancestor folder so a child strip never appears
 * orphaned from its folder. Returns the visible track list in project
 * order. When `activeSongTrackIds` is null (no active song) every track is
 * returned unchanged. Mirrors the desktop CompactMixer filter.
 */
function filterTracksToActiveSong(
  tracks: TrackSummary[],
  activeSongTrackIds: Set<string> | null,
): TrackSummary[] {
  if (!activeSongTrackIds) {
    return tracks;
  }

  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const visibleIds = new Set<string>(activeSongTrackIds);
  for (const id of activeSongTrackIds) {
    let current = trackById.get(id);
    while (current?.parentTrackId) {
      if (visibleIds.has(current.parentTrackId)) {
        break;
      }
      visibleIds.add(current.parentTrackId);
      current = trackById.get(current.parentTrackId);
    }
  }
  return tracks.filter((track) => visibleIds.has(track.id));
}

function useRemoteBridge() {
  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;

    const connect = () => {
      if (disposed) {
        return;
      }

      useRemoteConnectionStore.getState().setConnection(null, "connecting");
      const socket = new WebSocket(getSocketUrl());
      socket.binaryType = "arraybuffer";

      socket.addEventListener("open", () => {
        useRemoteConnectionStore.getState().setConnection(socket, "connected");
        socket.send(JSON.stringify({ cmd: "requestPadsCatalog" }));
      });

      socket.addEventListener("message", (event) => {
        const rawPayload =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : "";
        if (!rawPayload) {
          return;
        }

        const message = JSON.parse(rawPayload) as {
          event?: string;
          payload?: unknown;
        };

        if (message.event === "transportSnapshot") {
          useRemoteSyncStore.getState().setSnapshot(message.payload as TransportSnapshot);
          useOptimisticStore.getState().setPendingJumpTarget(
            (message.payload as TransportSnapshot).pendingMarkerJump?.targetMarkerId ?? null,
          );
          return;
        }

        if (message.event === "songView") {
          useRemoteSyncStore.getState().setSongView(message.payload as SongView | null);
          useOptimisticStore.getState().clearTracks();
          return;
        }

        if (message.event === "settings") {
          useRemoteSyncStore.getState().setSettings(message.payload as AppSettings);
          return;
        }

        if (message.event === "padsCatalog") {
          useRemoteSyncStore.getState().setPadsCatalog(message.payload as PadsCatalog);
          return;
        }

        if (message.event === "meters") {
          useRemoteSyncStore.getState().setMeters(message.payload as AudioMeterLevel[]);
        }
      });

      socket.addEventListener("close", () => {
        useRemoteConnectionStore.getState().setConnection(null, "disconnected");
        retryTimer = window.setTimeout(connect, 900);
      });

      socket.addEventListener("error", () => {
        useRemoteConnectionStore.getState().setConnection(
          null,
          "error",
          STRINGS.connectionError,
        );
        socket.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      useRemoteConnectionStore.getState().socket?.close();
      useRemoteConnectionStore.getState().setConnection(null, "disconnected");
    };
  }, []);
}

function resolveEffectiveTrack(track: TrackSummary, optimisticState: TrackOptimisticState | undefined) {
  return {
    ...track,
    volume: optimisticState?.volume ?? track.volume,
    pan: optimisticState?.pan ?? track.pan,
    muted: optimisticState?.muted ?? track.muted,
    solo: optimisticState?.solo ?? track.solo,
  };
}

function formatTimecode(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const centiseconds = Math.floor((safeSeconds % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function formatTimelineSecondLabel(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function useTransportReadout(): TransportReadout {
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const songView = useRemoteSyncStore((state) => state.songView);
  const visualAnchor = useRemoteSyncStore((state) => state.visualAnchor);
  const [readout, setReadout] = useState<TransportReadout>({
    positionSeconds: 0,
    timecode: "00:00.00",
    musicalDisplay: "1.1.00",
    bpm: 120,
    timeSignature: "4/4",
    regionName: "--",
  });

  const timelineRegions = useMemo(() => buildSongTempoRegions(songView), [songView]);
  const snapshotRef = useRef(snapshot);
  const songViewRef = useRef(songView);
  const timelineRegionsRef = useRef(timelineRegions);
  const visualAnchorRef = useRef(visualAnchor);
  const lastReadoutCommitAtRef = useRef(0);

  useEffect(() => {
    snapshotRef.current = snapshot;
    songViewRef.current = songView;
    timelineRegionsRef.current = timelineRegions;
    visualAnchorRef.current = visualAnchor;
  }, [snapshot, songView, visualAnchor, timelineRegions]);

  useEffect(() => {
    let frameId = 0;

    const render = () => {
      const currentSnapshot = snapshotRef.current;
      const currentSongView = songViewRef.current;
      const currentTimelineRegions = timelineRegionsRef.current;
      const positionSeconds = resolveLivePosition(visualAnchorRef.current);
      const currentRegion = getSongRegionAtPosition(currentSongView, positionSeconds);
      const tempoRegion =
        getSongTempoRegionAtPosition(currentSongView, positionSeconds) ??
        currentTimelineRegions[0] ?? {
          bpm: currentSongView?.bpm ?? 120,
          timeSignature: currentSongView?.timeSignature ?? "4/4",
        };

      const musicalPosition = currentRegion
        ? getCumulativeMusicalPosition(
            positionSeconds,
            currentTimelineRegions,
            tempoRegion.bpm,
            tempoRegion.timeSignature,
          )
        : {
            display: "1.1.00",
            barNumber: 1,
            beatInBar: 1,
            subBeat: 0,
          };

      const nextReadout = {
        positionSeconds,
        timecode: formatTimecode(positionSeconds),
        musicalDisplay: musicalPosition.display,
        bpm: tempoRegion.bpm,
        timeSignature: tempoRegion.timeSignature,
        regionName: currentRegion?.name ?? "--",
      };

      const isPlaying = currentSnapshot?.playbackState === "playing";
      const now = performance.now();

      setReadout((currentReadout) => {
        const intervalElapsed = now - lastReadoutCommitAtRef.current >= READOUT_MIN_UPDATE_INTERVAL_MS;
        const displayChanged =
          nextReadout.timecode !== currentReadout.timecode ||
          nextReadout.musicalDisplay !== currentReadout.musicalDisplay ||
          nextReadout.bpm !== currentReadout.bpm ||
          nextReadout.timeSignature !== currentReadout.timeSignature ||
          nextReadout.regionName !== currentReadout.regionName;

        if (isPlaying && !intervalElapsed && !displayChanged) {
          return currentReadout;
        }

        lastReadoutCommitAtRef.current = now;
        return nextReadout;
      });

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return readout;
}

const SharedTimeline = memo(function SharedTimeline({
  songView,
  snapshot,
  visualAnchor,
  pendingJumpTargetId,
}: {
  songView: SongView | null;
  snapshot: TransportSnapshot | null;
  visualAnchor: PlaybackVisualAnchor;
  pendingJumpTargetId: string | null;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef(snapshot);
  const visualAnchorRef = useRef(visualAnchor);
  const visibleGridMarkerCountRef = useRef(0);
  const visibleSectionMarkerCountRef = useRef(0);
  const visualPositionRef = useRef(0);
  const lastTransportRepositionTokenRef = useRef(getTransportRepositionToken(snapshot));
  const lastFrameAtMsRef = useRef<number | null>(null);
  const lastDebugLogAtMsRef = useRef(0);
  const debugStatsRef = useRef({
    frameCount: 0,
    snapshotCount: 0,
    accumulatedCorrectionSeconds: 0,
    maxCorrectionSeconds: 0,
  });
  const lastTimelinePlaybackRef = useRef<{ playing: boolean; positionSeconds: number }>({
    playing: false,
    positionSeconds: 0,
  });
  // Manual scrub: users can drag the cinta to peek ahead. `manualOffsetRef`
  // holds the extra px offset added on top of the auto-follow translate; after
  // `TIMELINE_MANUAL_HOLD_MS` of no interaction it eases back to 0 so the
  // playhead recentres itself. Kept in refs so dragging never re-renders.
  const manualOffsetRef = useRef(0);
  const lastManualInteractionAtRef = useRef(0);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragLastClientXRef = useRef(0);
  // Tap-to-seek bookkeeping: a pointer only counts as a tap if it never moved
  // beyond `TIMELINE_TAP_SLOP_PX` and was released quickly, so scrubbing the
  // cinta never fires an accidental seek on release.
  const dragStartClientXRef = useRef(0);
  const dragStartAtMsRef = useRef(0);
  const dragMovedRef = useRef(false);
  // The rAF loop owns the ruler transform, so React never sees it. Mirror it in
  // a ref so a tap can convert its screen X back into a timeline position.
  const translateXRef = useRef(0);
  // Optimistic tap-to-seek. The desktop snapshot round-trips over the WebSocket,
  // so between the tap and its confirmation the rAF loop would keep animating
  // from the OLD position (and, when stopped, overwrite the playhead with it
  // every frame). Hold the requested position until a snapshot confirms the
  // reposition, or the deadline lapses if the command was dropped.
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const clickToSeek = useTimelineUiStore((state) => state.clickToSeek);
  const setClickToSeek = useTimelineUiStore((state) => state.setClickToSeek);
  const clickToSeekRef = useRef(clickToSeek);
  clickToSeekRef.current = clickToSeek;
  // While the cinta is manually scrolled, the render window must follow what the
  // user is LOOKING at (the dragged centre), not the playhead — otherwise the
  // grid/markers of a far-away region aren't rendered. Published from the rAF
  // loop (throttled to whole-second changes) so distant scrolls stay populated;
  // null means "follow the playhead" (no manual scroll active).
  const [manualCenterSeconds, setManualCenterSeconds] = useState<number | null>(null);
  const publishedManualCenterRef = useRef<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const durationSeconds = Math.max(songView?.durationSeconds ?? 0, 8);
  const regions = useMemo(() => buildSongTempoRegions(songView), [songView]);
  const gridEndSeconds = Math.max(durationSeconds + 12, 24);
  const grid = useMemo(
    () =>
      buildVisibleTimelineGrid({
        durationSeconds,
        bpm: songView?.bpm ?? 120,
        timeSignature: songView?.timeSignature ?? "4/4",
        regions,
        zoomLevel: 8,
        pixelsPerSecond: CHROME_TIMELINE_PIXELS_PER_SECOND,
        viewportStartSeconds: 0,
        viewportEndSeconds: gridEndSeconds,
      }),
    [durationSeconds, gridEndSeconds, regions, songView?.bpm, songView?.timeSignature],
  );
  const contentWidth = Math.max(
    Math.max(viewportWidth, 1) * 1.5,
    (Math.max(durationSeconds, gridEndSeconds) + 4) * CHROME_TIMELINE_PIXELS_PER_SECOND,
  );
  const viewportDurationSeconds = Math.max(1, viewportWidth / CHROME_TIMELINE_PIXELS_PER_SECOND);
  // Centre the render window on the dragged view when the user is scrubbing,
  // else on the live playhead, so distant scroll positions render their grid.
  const renderCenterSeconds =
    manualCenterSeconds ?? resolveLivePosition(visualAnchor);
  const renderWindowStartSeconds = Math.max(0, renderCenterSeconds - viewportDurationSeconds * 1.5);
  const renderWindowEndSeconds = Math.max(
    renderWindowStartSeconds + viewportDurationSeconds * 3,
    renderCenterSeconds + viewportDurationSeconds * 1.5,
  );
  const markers = songView?.sectionMarkers ?? [];
  const timeLabelStepSeconds = durationSeconds > 300 ? 30 : durationSeconds > 120 ? 15 : 10;
  const visibleTimeLabels = useMemo(() => {
    const labels: number[] = [];
    const startIndex = Math.max(0, Math.floor(renderWindowStartSeconds / timeLabelStepSeconds) - 1);
    const endIndex = Math.ceil(renderWindowEndSeconds / timeLabelStepSeconds) + 1;

    for (let index = startIndex; index <= endIndex; index += 1) {
      labels.push(index * timeLabelStepSeconds);
    }

    return labels;
  }, [renderWindowEndSeconds, renderWindowStartSeconds, timeLabelStepSeconds]);
  const visibleBarMarkers = useMemo(
    () =>
      grid.markers.filter(
        (marker) =>
          marker.isBarStart &&
          marker.seconds >= renderWindowStartSeconds &&
          marker.seconds <= renderWindowEndSeconds,
      ),
    [grid.markers, renderWindowEndSeconds, renderWindowStartSeconds],
  );
  const visibleGridMarkers = useMemo(
    () =>
      grid.markers.filter(
        (marker) => marker.seconds >= renderWindowStartSeconds && marker.seconds <= renderWindowEndSeconds,
      ),
    [grid.markers, renderWindowEndSeconds, renderWindowStartSeconds],
  );
  // Sections AND dynamic cues (Build, All In, ...) both draw on the ribbon. A
  // cue sitting on a section's beat is folded into that section's chip by
  // buildTimelineMarkerChips, so stacked markers never overdraw each other.
  const visibleSectionMarkers = useMemo(
    () =>
      buildTimelineMarkerChips(markers, markerColor).filter(
        (chip) =>
          chip.startSeconds >= renderWindowStartSeconds - viewportDurationSeconds * 0.25 &&
          chip.startSeconds <= renderWindowEndSeconds + viewportDurationSeconds * 0.25,
      ),
    [markers, renderWindowEndSeconds, renderWindowStartSeconds, viewportDurationSeconds],
  );
  const pendingJump = snapshot?.pendingMarkerJump ?? null;
  const activeVamp = snapshot?.activeVamp ?? null;
  const timelineDebugEnabled = isTimelineDebugEnabled();
  const pendingJumpX =
    pendingJump && Number.isFinite(pendingJump.executeAtSeconds)
      ? secondsToAbsoluteX(pendingJump.executeAtSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)
      : null;
  const activeVampStyle =
    activeVamp && Number.isFinite(activeVamp.startSeconds) && Number.isFinite(activeVamp.endSeconds)
      ? {
          left: `${secondsToAbsoluteX(activeVamp.startSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px`,
          width: `${Math.max(
            2,
            (activeVamp.endSeconds - activeVamp.startSeconds) * CHROME_TIMELINE_PIXELS_PER_SECOND,
          )}px`,
        }
      : null;

  useEffect(() => {
    snapshotRef.current = snapshot;
    visualAnchorRef.current = visualAnchor;

    if (timelineDebugEnabled && snapshot) {
      debugStatsRef.current.snapshotCount += 1;
    }
  }, [snapshot, visualAnchor]);

  useEffect(() => {
    visibleGridMarkerCountRef.current = visibleGridMarkers.length;
    visibleSectionMarkerCountRef.current = visibleSectionMarkers.length;
  }, [visibleGridMarkers.length, visibleSectionMarkers.length]);

  useEffect(() => {
    const updateWidth = () => {
      setViewportWidth(shellRef.current?.clientWidth ?? window.innerWidth);
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined" || !shellRef.current) {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frameId = 0;

    const render = (frameAtMs: number) => {
      const width = shellRef.current?.clientWidth ?? viewportWidth;
      // Read the store in the animation loop as well as keeping the prop refs.
      // This avoids waiting for a React effect when snapshots arrive rapidly or
      // while a mobile browser is recovering from a throttled/background frame.
      const syncState = useRemoteSyncStore.getState();
      const currentSnapshot = syncState.snapshot ?? snapshotRef.current;
      const repositionToken = getTransportRepositionToken(currentSnapshot);
      const explicitTransportReposition = repositionToken !== lastTransportRepositionTokenRef.current;
      const rawPositionSeconds = resolveLivePosition(
        syncState.snapshot ? syncState.visualAnchor : visualAnchorRef.current,
        frameAtMs,
      );
      const isPlaying = currentSnapshot?.playbackState === "playing";
      const lastFrameAtMs = lastFrameAtMsRef.current;
      const deltaSeconds = lastFrameAtMs === null ? 0 : Math.min(0.05, Math.max(0, frameAtMs - lastFrameAtMs) / 1000);
      lastFrameAtMsRef.current = frameAtMs;

      if (explicitTransportReposition) {
        lastTransportRepositionTokenRef.current = repositionToken;
      }

      // A tap-to-seek is confirmed once the transport reports a reposition (the
      // token carries lastSeekPositionSeconds) — or abandoned once it times out.
      pendingSeekRef.current = resolvePendingSeek(pendingSeekRef.current, {
        transportRepositioned: explicitTransportReposition,
        frameAtMs,
      });
      if (pendingSeekRef.current) {
        // Hold the requested position: pin the playhead there and skip the
        // follow/correction maths entirely, which would otherwise drag the
        // cinta back to the pre-seek position for the length of the round-trip.
        visualPositionRef.current = pendingSeekRef.current.positionSeconds;
      }
      // While a seek is pending the position above is authoritative, so both the
      // follow and the correction passes are skipped for the round-trip.
      if (!pendingSeekRef.current) {
        if (!isPlaying) {
          visualPositionRef.current = rawPositionSeconds;
        } else if (explicitTransportReposition) {
          visualPositionRef.current = rawPositionSeconds;
        } else if (lastFrameAtMs !== null) {
          visualPositionRef.current += deltaSeconds;
        } else if (!lastTimelinePlaybackRef.current.playing) {
          visualPositionRef.current = rawPositionSeconds;
        }

        if (isPlaying && !lastTimelinePlaybackRef.current.playing) {
          visualPositionRef.current = rawPositionSeconds;
        } else if (isPlaying) {
          const correctionSeconds = rawPositionSeconds - visualPositionRef.current;
          if (correctionSeconds > TIMELINE_CORRECTION_SNAP_THRESHOLD_SECONDS) {
            visualPositionRef.current = rawPositionSeconds;
          } else if (
            correctionSeconds < -TIMELINE_JITTER_RESET_THRESHOLD_SECONDS &&
            explicitTransportReposition
          ) {
            visualPositionRef.current = rawPositionSeconds;
          } else if (correctionSeconds > 0) {
            visualPositionRef.current +=
              correctionSeconds * Math.min(1, deltaSeconds * TIMELINE_FORWARD_CORRECTION_PER_SECOND);
          }

          if (timelineDebugEnabled) {
            debugStatsRef.current.accumulatedCorrectionSeconds += Math.abs(correctionSeconds);
            debugStatsRef.current.maxCorrectionSeconds = Math.max(
              debugStatsRef.current.maxCorrectionSeconds,
              Math.abs(correctionSeconds),
            );
          }
        }
      }

      visualPositionRef.current = Math.max(0, visualPositionRef.current);

      lastTimelinePlaybackRef.current = {
        playing: isPlaying,
        positionSeconds: rawPositionSeconds,
      };

      if (timelineDebugEnabled) {
        debugStatsRef.current.frameCount += 1;
        if (frameAtMs - lastDebugLogAtMsRef.current >= 1000) {
          const elapsedMs = Math.max(1, frameAtMs - lastDebugLogAtMsRef.current || 1000);
          const averageCorrectionMs =
            (debugStatsRef.current.accumulatedCorrectionSeconds * 1000) /
            Math.max(1, debugStatsRef.current.frameCount);
          console.info("[remote timeline]", {
            fps: Number(((debugStatsRef.current.frameCount * 1000) / elapsedMs).toFixed(1)),
            snapshotHz: Number(((debugStatsRef.current.snapshotCount * 1000) / elapsedMs).toFixed(1)),
            avgCorrectionMs: Number(averageCorrectionMs.toFixed(2)),
            maxCorrectionMs: Number((debugStatsRef.current.maxCorrectionSeconds * 1000).toFixed(2)),
            visibleGridMarkers: visibleGridMarkerCountRef.current,
            visibleSectionMarkers: visibleSectionMarkerCountRef.current,
            viewportWidth,
          });
          debugStatsRef.current.frameCount = 0;
          debugStatsRef.current.snapshotCount = 0;
          debugStatsRef.current.accumulatedCorrectionSeconds = 0;
          debugStatsRef.current.maxCorrectionSeconds = 0;
          lastDebugLogAtMsRef.current = frameAtMs;
        }
      }

      const currentX = secondsToAbsoluteX(visualPositionRef.current, CHROME_TIMELINE_PIXELS_PER_SECOND);
      const desiredTranslate = width / 2 - currentX;
      const minTranslate = Math.min(0, width - contentWidth);
      const maxTranslate = width / 2;
      const autoTranslate = Math.max(minTranslate, Math.min(maxTranslate, desiredTranslate));

      // Fold in the manual drag offset. While the user is dragging (or within
      // the hold window) keep it; once the window lapses, ease it back to 0 so
      // the auto-follow position takes over smoothly.
      const isDragging = dragPointerIdRef.current !== null;
      const sinceInteraction = frameAtMs - lastManualInteractionAtRef.current;
      if (!isDragging && sinceInteraction > TIMELINE_MANUAL_HOLD_MS) {
        const ease = Math.min(1, deltaSeconds * TIMELINE_MANUAL_RETURN_PER_SECOND);
        manualOffsetRef.current += (0 - manualOffsetRef.current) * ease;
        if (Math.abs(manualOffsetRef.current) < 0.5) {
          manualOffsetRef.current = 0;
        }
      }

      // Clamp the combined translate to the same content bounds so dragging
      // can't scroll past the start/end of the cinta.
      const translateX = Math.max(
        minTranslate,
        Math.min(maxTranslate, autoTranslate + manualOffsetRef.current),
      );

      translateXRef.current = translateX;

      if (rulerRef.current) {
        rulerRef.current.style.transform = `translate3d(${translateX}px, 0, 0)`;
      }

      // Keep the playhead glued to the real playback position instead of the
      // viewport centre: while the cinta is dragged to peek ahead, the playhead
      // travels with the content (its true screen X = currentX + translateX)
      // rather than staying pinned at the middle.
      if (playheadRef.current) {
        const playheadScreenX = currentX + translateX;
        playheadRef.current.style.transform = `translate3d(${playheadScreenX}px, 0, 0)`;
        // Hide it when it scrolls out of view so it doesn't stick to an edge.
        playheadRef.current.style.opacity =
          playheadScreenX < -2 || playheadScreenX > width + 2 ? "0" : "1";
      }

      // Publish the dragged view centre so the render window (grid/markers)
      // follows the scroll. Throttled to whole-second changes to avoid a
      // re-render every frame; cleared once the manual offset eases back to 0.
      if (Math.abs(manualOffsetRef.current) > 0.5) {
        const visibleCenterSeconds = (width / 2 - translateX) / CHROME_TIMELINE_PIXELS_PER_SECOND;
        const rounded = Math.max(0, Math.round(visibleCenterSeconds));
        if (publishedManualCenterRef.current !== rounded) {
          publishedManualCenterRef.current = rounded;
          setManualCenterSeconds(rounded);
        }
      } else if (publishedManualCenterRef.current !== null) {
        publishedManualCenterRef.current = null;
        setManualCenterSeconds(null);
      }

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => {
      lastFrameAtMsRef.current = null;
      window.cancelAnimationFrame(frameId);
    };
  }, [contentWidth, timelineDebugEnabled, viewportWidth]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Only primary button / touch drives the scrub.
    if (event.button !== 0 && event.pointerType === "mouse") {
      return;
    }
    dragPointerIdRef.current = event.pointerId;
    dragLastClientXRef.current = event.clientX;
    dragStartClientXRef.current = event.clientX;
    dragStartAtMsRef.current = performance.now();
    dragMovedRef.current = false;
    lastManualInteractionAtRef.current = performance.now();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragLastClientXRef.current;
    dragLastClientXRef.current = event.clientX;
    // Track the furthest excursion, not just the final delta, so a gesture that
    // wanders out and comes back still counts as a scrub.
    if (
      !isTimelineTap({
        startClientX: dragStartClientXRef.current,
        endClientX: event.clientX,
        durationMs: 0,
      })
    ) {
      dragMovedRef.current = true;
    }
    // A fresh scrub overrides a seek still waiting for its confirmation, so the
    // cinta follows the finger instead of staying pinned to the tapped position.
    pendingSeekRef.current = null;
    // Dragging right reveals earlier content (offset grows), left reveals the
    // future. The rAF loop clamps the final translate to the content bounds.
    manualOffsetRef.current += deltaX;
    lastManualInteractionAtRef.current = performance.now();
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, allowSeek: boolean) => {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }
    dragPointerIdRef.current = null;
    const releasedAtMs = performance.now();
    const wasTap =
      !dragMovedRef.current &&
      isTimelineTap({
        startClientX: dragStartClientXRef.current,
        endClientX: event.clientX,
        durationMs: releasedAtMs - dragStartAtMsRef.current,
      });
    // Start the hold countdown from release so the peeked view lingers.
    lastManualInteractionAtRef.current = releasedAtMs;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!allowSeek || !wasTap || !clickToSeekRef.current) {
      return;
    }

    const positionSeconds = timelineTapPositionSeconds({
      clientX: event.clientX,
      shellLeft: event.currentTarget.getBoundingClientRect().left,
      translateX: translateXRef.current,
      pixelsPerSecond: CHROME_TIMELINE_PIXELS_PER_SECOND,
    });
    if (positionSeconds === null) {
      return;
    }

    // Land the cinta on the target instead of leaving it parked on whatever the
    // user had scrubbed to. Three things have to happen together:
    //  1. Drop the manual scrub offset (and its hold window) so the rAF loop
    //     goes straight back to auto-follow — otherwise the old peeked view
    //     lingers for TIMELINE_MANUAL_HOLD_MS and the jump looks like nothing
    //     happened.
    //  2. Clear the published manual centre so the grid/markers render window
    //     re-centres on the playhead.
    //  3. Move the visual playhead now rather than waiting for the desktop
    //     snapshot to round-trip over the WebSocket.
    manualOffsetRef.current = 0;
    lastManualInteractionAtRef.current = 0;
    if (publishedManualCenterRef.current !== null) {
      publishedManualCenterRef.current = null;
      setManualCenterSeconds(null);
    }
    visualPositionRef.current = positionSeconds;
    pendingSeekRef.current = {
      positionSeconds,
      expiresAtMs: releasedAtMs + TIMELINE_PENDING_SEEK_TIMEOUT_MS,
    };

    sendCommand({ cmd: "seek", positionSeconds });
  }, []);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, true),
    [endDrag],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, false),
    [endDrag],
  );

  return (
    <div
      ref={shellRef}
      className={`timeline-shell timeline-shell-shared ${clickToSeek ? "is-click-seek" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <button
        type="button"
        className={`timeline-click-seek-toggle ${clickToSeek ? "is-active" : ""}`}
        aria-pressed={clickToSeek}
        title={clickToSeek ? STRINGS.clickToSeekOn : STRINGS.clickToSeekOff}
        aria-label={clickToSeek ? STRINGS.clickToSeekOn : STRINGS.clickToSeekOff}
        // The shell owns a pointer-drag scrub; stop the toggle's own pointer
        // from starting one (and from being swallowed as a tap-to-seek).
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setClickToSeek(!clickToSeek);
        }}
      >
        ⇥
      </button>
      <div ref={playheadRef} className="fixed-playhead" aria-hidden="true" />
      <div ref={rulerRef} className="timeline-ruler" style={{ width: contentWidth }}>
        <div className="timeline-header-row timeline-time-row">
          {visibleTimeLabels.map((seconds) => (
            <span
              key={`time-label-${seconds}`}
              className="timeline-top-label is-time"
              style={{ left: `${secondsToAbsoluteX(seconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px` }}
            >
              {formatTimelineSecondLabel(seconds)}
            </span>
          ))}
        </div>

        <div className="timeline-header-row timeline-bars-row">
          {visibleBarMarkers.map((marker) => (
            <span
              key={`bar-label-${marker.seconds}`}
              className="timeline-top-label is-bar"
              style={{ left: `${secondsToAbsoluteX(marker.seconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px` }}
            >
              {marker.barNumber}
            </span>
          ))}
        </div>

        <div className="timeline-grid">
          {activeVampStyle ? <span className="timeline-vamp-range" style={activeVampStyle} /> : null}
          {visibleGridMarkers.map((marker) => (
            <span
              key={`grid-${marker.seconds}`}
              className={marker.isBarStart ? "timeline-line is-bar" : "timeline-line"}
              style={{ left: `${secondsToAbsoluteX(marker.seconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px` }}
            />
          ))}
        </div>

        {pendingJumpX !== null ? (
          <>
            <span
              className="pending-jump-playhead"
              style={{ left: `${pendingJumpX}px` }}
            />
            <span
              className="pending-jump-label"
              style={{ left: `${pendingJumpX}px` }}
            >
              {STRINGS.jump}
            </span>
          </>
        ) : null}

        <div className="timeline-markers">
          {visibleSectionMarkers.map((chip) => (
            <span
              key={`marker-${chip.id}`}
              className={`timeline-marker timeline-marker-mini ${chip.kind === "cue" ? "is-cue" : ""} ${chip.cueNames.length > 0 ? "has-cue" : ""} ${pendingJumpTargetId === chip.id ? "is-target" : ""}`}
              style={{
                left: `${secondsToAbsoluteX(chip.startSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px`,
                // Tint the marker with its kind/custom colour so the remote
                // reads the same as the desktop timeline.
                "--marker-color": chip.color,
              } as CSSProperties}
              title={[chip.label, ...chip.cueNames].join(" · ")}
            >
              {chip.label}
              {chip.cueNames.length > 0 ? (
                <em className="timeline-marker-cue">{chip.cueNames.join(" · ")}</em>
              ) : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});

function TransportControlButtons() {
  const settings = useRemoteSyncStore((state) => state.settings);
  const metronomeEnabled = settings?.metronomeEnabled ?? false;
  const voiceGuideEnabled = settings?.voiceGuideEnabled ?? false;

  return (
    <div className="transport-controls transport-controls-inline">
      <button className="pill-button" onClick={() => sendCommand({ cmd: "play" })}>
        {STRINGS.play}
      </button>
      <button className="pill-button" onClick={() => sendCommand({ cmd: "pause" })}>
        {STRINGS.pause}
      </button>
      <button className="pill-button" onClick={() => sendCommand({ cmd: "stop" })}>
        {STRINGS.stop}
      </button>
      {/* Keep Click + Voice guide grouped while giving each a full action slot. */}
      <div className="pill-button-split">
        <button
          className={`pill-button ${metronomeEnabled ? "is-active" : ""}`}
          onClick={() => sendMetronomePatch({ enabled: !metronomeEnabled })}
        >
          {STRINGS.click}
        </button>
        <button
          className={`pill-button ${voiceGuideEnabled ? "is-active" : ""}`}
          disabled={!settings}
          onClick={() => {
            if (!settings) {
              return;
            }
            sendSettingsUpdate({
              ...settings,
              voiceGuideEnabled: !voiceGuideEnabled,
            });
          }}
        >
          {STRINGS.guide}
        </button>
      </div>
    </div>
  );
}

/** Individual transport buttons, so each can be placed as its own widget. */
function PlayButtonWidget() {
  return (
    <div className="transport-controls transport-controls-inline transport-controls-solo">
      <button className="pill-button" onClick={() => sendCommand({ cmd: "play" })}>
        {STRINGS.play}
      </button>
    </div>
  );
}
function PauseButtonWidget() {
  return (
    <div className="transport-controls transport-controls-inline transport-controls-solo">
      <button className="pill-button" onClick={() => sendCommand({ cmd: "pause" })}>
        {STRINGS.pause}
      </button>
    </div>
  );
}
function StopButtonWidget() {
  return (
    <div className="transport-controls transport-controls-inline transport-controls-solo">
      <button className="pill-button" onClick={() => sendCommand({ cmd: "stop" })}>
        {STRINGS.stop}
      </button>
    </div>
  );
}
function ClickButtonWidget() {
  const settings = useRemoteSyncStore((state) => state.settings);
  const metronomeEnabled = settings?.metronomeEnabled ?? false;
  return (
    <div className="transport-controls transport-controls-inline transport-controls-solo">
      <button
        className={`pill-button ${metronomeEnabled ? "is-active" : ""}`}
        onClick={() => sendMetronomePatch({ enabled: !metronomeEnabled })}
      >
        {STRINGS.click}
      </button>
    </div>
  );
}
function GuideButtonWidget() {
  const settings = useRemoteSyncStore((state) => state.settings);
  const voiceGuideEnabled = settings?.voiceGuideEnabled ?? false;
  return (
    <div className="transport-controls transport-controls-inline transport-controls-solo">
      <button
        className={`pill-button ${voiceGuideEnabled ? "is-active" : ""}`}
        disabled={!settings}
        onClick={() => {
          if (!settings) return;
          sendSettingsUpdate({ ...settings, voiceGuideEnabled: !voiceGuideEnabled });
        }}
      >
        {STRINGS.guide}
      </button>
    </div>
  );
}

/** Which slice of the control deck to render. Undefined = the whole deck. */
type ControlDeckSection = "vamp" | "jump" | "song" | "region";

function RemoteFloatingPanel({
  anchor,
  onClose,
  children,
}: {
  anchor: RemotePanelAnchor;
  onClose: () => void;
  children: ReactElement;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const narrow = window.innerWidth <= 600;
  const panelWidth = Math.min(640, window.innerWidth - 24);
  const left = Math.max(12, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - 12));
  const spaceBelow = window.innerHeight - anchor.bottom - 12;
  const openAbove = !narrow && spaceBelow < Math.min(280, window.innerHeight * 0.45);
  const style: CSSProperties | undefined = narrow
    ? undefined
    : {
        left,
        width: panelWidth,
        maxHeight: Math.max(160, openAbove ? anchor.top - 20 : spaceBelow),
        ...(openAbove
          ? { bottom: window.innerHeight - anchor.top + 8 }
          : { top: anchor.bottom + 8 }),
      };

  return createPortal(
    <div className="remote-floating-panel-layer" onPointerDown={onClose}>
      <div
        className="remote-inline-panel is-floating"
        role="dialog"
        aria-label={STRINGS.settings}
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The control deck: Vamp/Loop, Jump config, Song transition, the region
 * carousel with transpose, and floating settings sheets. Reads its shared UI
 * state (selected region, open panel) from `useRemoteUiStore` and its jump
 * config from `useRemoteJumpStore`. With no `section` it renders the whole deck
 * (the composite widget); with a `section` it renders just that card + its
 * floating settings sheet, so each slice can be placed as its own widget. The
 * shared sync effects/handlers run either way, so behaviour is identical.
 */
function ControlDeck({ section }: { section?: ControlDeckSection } = {}) {
  const panelOwnerId = useId();
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const settings = useRemoteSyncStore((state) => state.settings);
  const jumpMode = useRemoteJumpStore((state) => state.mode);
  const jumpBars = useRemoteJumpStore((state) => state.bars);
  const songTrigger = useRemoteJumpStore((state) => state.songTrigger);
  const songBars = useRemoteJumpStore((state) => state.songBars);
  const songTransition = useRemoteJumpStore((state) => state.songTransition);
  const vampMode = useRemoteJumpStore((state) => state.vampMode);
  const vampBars = useRemoteJumpStore((state) => state.vampBars);
  const setJumpMode = useRemoteJumpStore((state) => state.setMode);
  const setJumpBars = useRemoteJumpStore((state) => state.setBars);
  const setSongTrigger = useRemoteJumpStore((state) => state.setSongTrigger);
  const setSongBars = useRemoteJumpStore((state) => state.setSongBars);
  const setSongTransition = useRemoteJumpStore((state) => state.setSongTransition);
  const setVampMode = useRemoteJumpStore((state) => state.setVampMode);
  const setVampBars = useRemoteJumpStore((state) => state.setVampBars);
  const selectedRegionId = useRemoteUiStore((state) => state.selectedRegionId);
  const setSelectedRegionId = useRemoteUiStore((state) => state.setSelectedRegionId);
  const activePanel = useRemoteUiStore((state) => state.activePanel);
  const activePanelOwnerId = useRemoteUiStore((state) => state.activePanelOwnerId);
  const activePanelAnchor = useRemoteUiStore((state) => state.activePanelAnchor);
  const toggleActivePanel = useRemoteUiStore((state) => state.toggleActivePanel);
  const closeActivePanel = useRemoteUiStore((state) => state.closeActivePanel);
  const ownedPanel = activePanelOwnerId === panelOwnerId ? activePanel : null;

  const togglePanel = (panel: RemotePanelKey, event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    toggleActivePanel(panel, panelOwnerId, {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    });
  };

  useEffect(() => () => {
    const ui = useRemoteUiStore.getState();
    if (ui.activePanelOwnerId === panelOwnerId) ui.closeActivePanel();
  }, [panelOwnerId]);

  const regions = songView?.regions ?? [];
  const pendingJump = snapshot?.pendingMarkerJump ?? null;
  const activeVamp = snapshot?.activeVamp ?? null;

  const patchRemoteSettings = (patch: Partial<AppSettings>) => {
    if (!settings) {
      return;
    }

    const jumpState = useRemoteJumpStore.getState();
    sendSettingsUpdate({
      ...settings,
      globalJumpMode: jumpState.mode,
      globalJumpBars: jumpState.bars,
      songJumpTrigger: jumpState.songTrigger,
      songJumpBars: jumpState.songBars,
      songTransitionMode: jumpState.songTransition,
      vampMode: jumpState.vampMode,
      vampBars: jumpState.vampBars,
      ...patch,
    });
  };

  useEffect(() => {
    if (!regions.length) {
      setSelectedRegionId(null);
      return;
    }

    if (!selectedRegionId || !regions.some((region) => region.id === selectedRegionId)) {
      setSelectedRegionId(regions[0]?.id ?? null);
    }
  }, [regions, selectedRegionId]);

  useEffect(() => {
    if (!settings) {
      return;
    }

    const jumpStore = useRemoteJumpStore.getState();
    jumpStore.setMode(settings.globalJumpMode);
    jumpStore.setBars(settings.globalJumpBars);
    jumpStore.setSongTrigger(settings.songJumpTrigger);
    jumpStore.setSongBars(settings.songJumpBars);
    jumpStore.setSongTransition(settings.songTransitionMode);
    jumpStore.setVampMode(settings.vampMode);
    jumpStore.setVampBars(settings.vampBars);
  }, [settings]);

  const selectedRegion =
    regions.find((region) => region.id === selectedRegionId) ??
    regions[0] ??
    null;
  const pendingJumpMode = parsePendingJumpMode(pendingJump?.trigger);

  const cancelJump = () => {
    useOptimisticStore.getState().setPendingJumpTarget(null);
    sendCommand({ cmd: "cancelMarkerJump" });
  };

  const updateSelectedRegionTranspose = (delta: number) => {
    if (!selectedRegion) {
      return;
    }

    const nextTransposeSemitones = Math.max(-12, Math.min(12, selectedRegion.transposeSemitones + delta));
    if (nextTransposeSemitones === selectedRegion.transposeSemitones) {
      return;
    }

    sendCommand({
      cmd: "updateRegionTranspose",
      regionId: selectedRegion.id,
      transposeSemitones: nextTransposeSemitones,
    });
  };

  const toggleVamp = () => {
    sendCommand({
      cmd: "toggleVamp",
      mode: vampMode,
      bars: vampMode === "bars" ? vampBars : undefined,
    });
  };

  const jumpModeSummary =
    jumpMode === "after_bars"
      ? `${jumpBars} ${STRINGS.bars.toLowerCase()}`
      : jumpMode === "next_marker"
        ? STRINGS.nextMarker
        : STRINGS.immediate;

  const vampSummary =
    vampMode === "bars" ? `${vampBars} ${STRINGS.bars.toLowerCase()}` : STRINGS.section;

  const songJumpSummary = formatSongTriggerLabel(songTrigger, songBars);
  const songTransitionSummary = songTransition === "fade_out" ? STRINGS.fadeOut : STRINGS.cleanCut;
  const songSummary = `${songJumpSummary} / ${songTransitionSummary}`;

  const renderJumpControls = () => (
    <div className="jump-toolbar jump-toolbar-sheet">
      <div className="jump-mode-group" role="group" aria-label={STRINGS.jump}>
        <button
          className={jumpMode === "immediate" ? "is-active" : ""}
          onClick={() => {
            setJumpMode("immediate");
            patchRemoteSettings({ globalJumpMode: "immediate" });
          }}
        >
          {STRINGS.immediate}
        </button>
        <button
          className={jumpMode === "after_bars" ? "is-active" : ""}
          onClick={() => {
            setJumpMode("after_bars");
            patchRemoteSettings({ globalJumpMode: "after_bars" });
          }}
        >
          {STRINGS.bars}
        </button>
        <button
          className={jumpMode === "next_marker" ? "is-active" : ""}
          onClick={() => {
            setJumpMode("next_marker");
            patchRemoteSettings({ globalJumpMode: "next_marker" });
          }}
        >
          {STRINGS.next}
        </button>
      </div>

      {jumpMode === "after_bars" ? (
        <StepperField
          label={STRINGS.bars}
          value={jumpBars}
          onChange={(nextValue) => {
            setJumpBars(nextValue);
            patchRemoteSettings({ globalJumpBars: Math.max(1, Math.floor(nextValue) || 1) });
          }}
        />
      ) : null}

      {pendingJump ? (
        <div className="pending-jump-card">
          <span>{STRINGS.pending}</span>
          <strong>{pendingJump.targetMarkerName}</strong>
          <small>{formatJumpModeLabel(pendingJumpMode.mode, pendingJumpMode.bars ?? jumpBars)}</small>
        </div>
      ) : null}
    </div>
  );

  const renderVampControls = () => (
    <div className="jump-toolbar jump-toolbar-sheet">
      <div className="jump-mode-group" role="group" aria-label={STRINGS.vampMode}>
        <button
          className={vampMode === "section" ? "is-active" : ""}
          onClick={() => {
            setVampMode("section");
            patchRemoteSettings({ vampMode: "section" });
          }}
        >
          {STRINGS.section}
        </button>
        <button
          className={vampMode === "bars" ? "is-active" : ""}
          onClick={() => {
            setVampMode("bars");
            patchRemoteSettings({ vampMode: "bars" });
          }}
        >
          {STRINGS.bars}
        </button>
      </div>

      {vampMode === "bars" ? (
        <StepperField
          label={STRINGS.vampBars}
          value={vampBars}
          onChange={(nextValue) => {
            setVampBars(nextValue);
            patchRemoteSettings({ vampBars: Math.max(1, Math.floor(nextValue) || 1) });
          }}
        />
      ) : null}

      <button
        className={`jump-cancel-button vamp-toggle-button ${activeVamp ? "is-active" : ""}`}
        onClick={toggleVamp}
      >
        {STRINGS.vamp}
      </button>

      {activeVamp ? (
        <div className="pending-jump-card pending-vamp-card">
          <span>{STRINGS.vamp}</span>
          <strong>
            {formatTimecode(activeVamp.startSeconds)} - {formatTimecode(activeVamp.endSeconds)}
          </strong>
          <small>{vampSummary}</small>
        </div>
      ) : null}
    </div>
  );

  const renderSongControls = () => (
    <div className="jump-toolbar jump-toolbar-sheet">
      <div className="jump-field-group">
        <span className="jump-field-label">{STRINGS.songTrigger}</span>
        <div className="jump-mode-group" role="group" aria-label={STRINGS.songTrigger}>
          <button
            className={songTrigger === "immediate" ? "is-active" : ""}
            onClick={() => {
              setSongTrigger("immediate");
              patchRemoteSettings({ songJumpTrigger: "immediate" });
            }}
          >
            {STRINGS.immediate}
          </button>
          <button
            className={songTrigger === "region_end" ? "is-active" : ""}
            onClick={() => {
              setSongTrigger("region_end");
              patchRemoteSettings({ songJumpTrigger: "region_end" });
            }}
          >
            {STRINGS.songEnd}
          </button>
          <button
            className={songTrigger === "after_bars" ? "is-active" : ""}
            onClick={() => {
              setSongTrigger("after_bars");
              patchRemoteSettings({ songJumpTrigger: "after_bars" });
            }}
          >
            {STRINGS.bars}
          </button>
          <button
            className={songTrigger === "next_marker" ? "is-active" : ""}
            onClick={() => {
              setSongTrigger("next_marker");
              patchRemoteSettings({ songJumpTrigger: "next_marker" });
            }}
          >
            {STRINGS.nextMarker}
          </button>
        </div>
      </div>

      {songTrigger === "after_bars" ? (
        <StepperField
          label={STRINGS.bars}
          value={songBars}
          onChange={(nextValue) => {
            setSongBars(nextValue);
            patchRemoteSettings({ songJumpBars: Math.max(1, Math.floor(nextValue) || 1) });
          }}
        />
      ) : null}

      <div className="jump-field-group">
        <span className="jump-field-label">{STRINGS.songTransition}</span>
        <div className="jump-mode-group" role="group" aria-label={STRINGS.songTransition}>
          <button
            className={songTransition === "instant" ? "is-active" : ""}
            onClick={() => {
              setSongTransition("instant");
              patchRemoteSettings({ songTransitionMode: "instant" });
            }}
          >
            {STRINGS.cleanCut}
          </button>
          <button
            className={songTransition === "fade_out" ? "is-active" : ""}
            onClick={() => {
              setSongTransition("fade_out");
              patchRemoteSettings({ songTransitionMode: "fade_out" });
            }}
          >
            {STRINGS.fadeOut}
          </button>
        </div>
      </div>
    </div>
  );

  // Which cards to render: a single section (atomic widget) or all (composite).
  const show = (candidate: ControlDeckSection) => !section || section === candidate;
  // The inline settings sheet belongs to the section it configures; only render
  // it when that section's card is visible in this instance.
  const showPanel =
    ownedPanel !== null && activePanelAnchor !== null && (!section || section === ownedPanel);

  return (
    <div className={`transport-control-deck ${section ? "is-section" : ""}`}>
        {show("vamp") ? (
        <article className="transport-control-card transport-control-card-group remote-control-card">
          <div className="remote-control-card-head">
            <div>
              <small>Vamp / Loop</small>
              <strong>{vampSummary}</strong>
            </div>
            <button
              type="button"
              className={`group-settings-button ${ownedPanel === "vamp" ? "is-active" : ""}`}
              aria-expanded={ownedPanel === "vamp"}
              onClick={(event) => togglePanel("vamp", event)}
            >
              {STRINGS.settings}
            </button>
          </div>
          <button
            className={`remote-strip-action vamp-toggle-button ${activeVamp ? "is-active" : ""}`}
            onClick={toggleVamp}
          >
            {activeVamp ? STRINGS.on : STRINGS.vamp}
          </button>
        </article>
        ) : null}

        {show("jump") ? (
        <article className="transport-control-card transport-control-card-group remote-control-card">
          <div className="remote-control-card-head">
            <div>
              <small>Jump Config</small>
              <strong>{jumpModeSummary}</strong>
            </div>
            <button
              type="button"
              className={`group-settings-button ${ownedPanel === "jump" ? "is-active" : ""}`}
              aria-expanded={ownedPanel === "jump"}
              onClick={(event) => togglePanel("jump", event)}
            >
              {STRINGS.settings}
            </button>
          </div>
          {pendingJump ? (
            <div className="remote-strip-status">
              <span>{STRINGS.pending}</span>
              <strong>{pendingJump.targetMarkerName}</strong>
            </div>
          ) : null}
        </article>
        ) : null}

        {show("song") ? (
        <article className="transport-control-card transport-control-card-song transport-control-card-group remote-control-card">
          <div className="remote-control-card-head">
            <div>
              <small>Song Transition</small>
              <strong>{songSummary}</strong>
            </div>
            <button
              type="button"
              className={`group-settings-button ${ownedPanel === "song" ? "is-active" : ""}`}
              aria-expanded={ownedPanel === "song"}
              onClick={(event) => togglePanel("song", event)}
            >
              {STRINGS.settings}
            </button>
          </div>
        </article>
        ) : null}

        {show("jump") ? (
        <button
          type="button"
          className={`transport-control-card remote-global-cancel-button ${pendingJump ? "is-warning" : ""}`}
          disabled={!pendingJump}
          onClick={() => {
            if (pendingJump) {
              cancelJump();
            }
          }}
        >
          <span>{STRINGS.cancelJump}</span>
        </button>
        ) : null}

        {show("region") ? (
        <div className="transport-control-card transport-control-card-region">
          <div className="region-actions-row">
            <div className="region-carousel">
              {regions.map((region) => (
                <button
                  key={region.id}
                  className={`region-chip ${selectedRegionId === region.id ? "is-active" : ""}`}
                  onClick={() => {
                    setSelectedRegionId(region.id);
                  }}
                >
                  <span>{region.name}</span>
                  {regionEffectiveKey(region) ? (
                    <em className="region-chip-key">
                      {regionEffectiveKey(region)}
                    </em>
                  ) : null}
                  {region.transposeSemitones !== 0 ? (
                    <em>{formatTransposeSemitones(region.transposeSemitones)} st</em>
                  ) : null}
                </button>
              ))}
            </div>
            {/* "Saltar a canción" used to sit here, at the end of this row.
                It is now its own `jumpToSongButton` widget so it can be placed
                (and sized) where the player can actually reach it. */}
            {selectedRegion ? (
              <div className="selected-region-actions">
                <div className="selected-region-transpose">
                  <span>{STRINGS.transpose}</span>
                  <div className="selected-region-transpose-controls">
                    <button type="button" onClick={() => updateSelectedRegionTranspose(-1)}>-</button>
                    <strong>{formatTransposeSemitones(selectedRegion.transposeSemitones)} st</strong>
                    <button type="button" onClick={() => updateSelectedRegionTranspose(1)}>+</button>
                  </div>
                  {regionEffectiveKey(selectedRegion) ? (
                    <span className="selected-region-key">
                      {regionEffectiveKey(selectedRegion)}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        ) : null}

        {showPanel && activePanelAnchor ? (
          <RemoteFloatingPanel anchor={activePanelAnchor} onClose={closeActivePanel}>
            <>
            <button
              type="button"
              className="remote-inline-panel-close"
              aria-label={STRINGS.close}
              onClick={closeActivePanel}
            >
              ×
            </button>
            {ownedPanel === "jump" ? renderJumpControls() : null}
            {ownedPanel === "vamp" ? renderVampControls() : null}
            {ownedPanel === "song" ? renderSongControls() : null}
            </>
          </RemoteFloatingPanel>
        ) : null}
      </div>
  );
}

/** How long a manual scroll of the marker grid suppresses the auto-scroll. Long
 * enough to read ahead a few rows, short enough that the grid is following the
 * song again by the next section. */
const MARKER_MANUAL_SCROLL_GRACE_MS = 6000;

/** Window in which scroll events are attributed to our own smooth scroll
 * rather than to the player's thumb. */
const MARKER_AUTO_SCROLL_SETTLE_MS = 700;

/** A position change larger than this between two snapshots is a SEEK (a marker
 * jump, a tap on the timeline), not the playhead advancing. Snapshots arrive
 * several times a second, so ordinary playback moves far less than this even
 * with a stalled connection; a jump between sections moves many seconds. */
const MARKER_SEEK_DETECTION_SECONDS = 1.5;

/**
 * The jump grid: one card per section marker in the selected region, plus the
 * "show hidden" affordance. Schedules/cancels marker jumps and toggles
 * per-marker visibility. Reads selected region and hidden-marker state from
 * `useRemoteUiStore`, so it's an autonomous layout widget. Behaviour is
 * unchanged from the former inline TransportView block.
 */
function MarkerGrid() {
  const liveContext = useSharedLiveContext();
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
  const jumpMode = useRemoteJumpStore((state) => state.mode);
  const jumpBars = useRemoteJumpStore((state) => state.bars);
  const selectedRegionId = useRemoteUiStore((state) => state.selectedRegionId);
  const hiddenMarkerIds = useRemoteUiStore((state) => state.hiddenMarkerIds);
  const revealHiddenMarkers = useRemoteUiStore((state) => state.revealHiddenMarkers);
  const toggleMarkerHidden = useRemoteUiStore((state) => state.toggleMarkerHidden);
  const setRevealHiddenMarkers = useRemoteUiStore((state) => state.setRevealHiddenMarkers);

  // Every marker, sections and cues alike: buildMarkerCards folds a cue that
  // shares a section's position into that section's card and gives a lone cue
  // its own card. Both kinds are jump targets; the kind only drives the style.
  const markers = useMemo(
    () => buildMarkerCards(songView?.sectionMarkers ?? []),
    [songView?.sectionMarkers],
  );
  const regions = songView?.regions ?? [];
  const pendingJump = snapshot?.pendingMarkerJump ?? null;

  const selectedRegion =
    regions.find((region) => region.id === selectedRegionId) ??
    regions[0] ??
    null;
  const visibleMarkers = selectedRegion
    ? markers.filter(
        (entry) =>
          entry.marker.startSeconds >= selectedRegion.startSeconds &&
          entry.marker.startSeconds <= selectedRegion.endSeconds,
      )
    : markers;
  // The markers hidden by the user within the current region — drives the
  // "show hidden (N)" affordance. When revealing, hidden cards render dimmed
  // with a restore button; otherwise they're filtered out entirely.
  const hiddenVisibleMarkers = visibleMarkers.filter((entry) =>
    hiddenMarkerIds.has(entry.id),
  );
  const shownMarkers = revealHiddenMarkers
    ? visibleMarkers
    : visibleMarkers.filter((entry) => !hiddenMarkerIds.has(entry.id));

  // Keep the row holding the NEXT marker on screen. On a phone the grid shows
  // barely two rows, so without this the upcoming jump target scrolls out of
  // sight mid-song and has to be hunted for by hand.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const nextCardRef = useRef<HTMLDivElement | null>(null);
  const nextMarkerId = liveContext.nextMarkerId;
  // A manual scroll wins for a few seconds: the player may be looking ahead at
  // the end of the song, and yanking the grid back under their thumb is worse
  // than a momentarily off-screen "next".
  //
  // Only a real DRAG or wheel counts. A tap must not arm the grace period:
  // tapping a card IS a jump, and after a jump following the new "next" is
  // exactly what the player wants — that tap used to suppress the very scroll
  // it should have triggered.
  const manualScrollUntilRef = useRef(0);
  const autoScrollingRef = useRef(false);

  const noteManualScroll = () => {
    if (autoScrollingRef.current) {
      return;
    }
    manualScrollUntilRef.current =
      performance.now() + MARKER_MANUAL_SCROLL_GRACE_MS;
  };

  const noteManualDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // `buttons` is non-zero only while the pointer is down, so this fires for a
    // finger dragging the list but never for a hover or a stationary tap.
    if (event.buttons !== 0) {
      noteManualScroll();
    }
  };

  // A seek — a marker jump landing, a tap on the timeline ribbon — clears the
  // manual-scroll grace. The player just told the transport where to go, so the
  // grid should follow them there immediately instead of sitting out the rest
  // of a grace period armed by an earlier scroll.
  const livePosition = snapshot?.positionSeconds ?? 0;
  const lastPositionRef = useRef(livePosition);
  // Bumped on every detected seek, and used as an effect dependency so the
  // scroll re-runs even when the seek lands somewhere with the SAME next marker
  // (jumping backwards inside the current section, say) — the row can still be
  // off screen, and "next did not change" must not mean "do not follow".
  const [seekTick, setSeekTick] = useState(0);
  useEffect(() => {
    const previous = lastPositionRef.current;
    lastPositionRef.current = livePosition;
    if (Math.abs(livePosition - previous) >= MARKER_SEEK_DETECTION_SECONDS) {
      manualScrollUntilRef.current = 0;
      setSeekTick((tick) => tick + 1);
    }
  }, [livePosition]);

  useEffect(() => {
    const grid = gridRef.current;
    const card = nextCardRef.current;
    if (!grid || !card || !nextMarkerId) {
      return;
    }
    if (performance.now() < manualScrollUntilRef.current) {
      return;
    }

    // Measured with rects rather than offsetTop: the grid is not a positioned
    // element, so the card's offsetParent is some ancestor and its offsetTop
    // would not be relative to the scroller. Adding scrollTop converts the
    // viewport-relative rect back into a content-relative offset.
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const target = resolveMarkerAutoScrollTop({
      scrollTop: grid.scrollTop,
      viewportHeight: grid.clientHeight,
      contentHeight: grid.scrollHeight,
      cardTop: cardRect.top - gridRect.top + grid.scrollTop,
      cardHeight: cardRect.height,
    });
    if (target === null) {
      return;
    }

    // The programmatic scroll fires `onScroll` too; flag it so it is not
    // mistaken for the player dragging the grid.
    autoScrollingRef.current = true;
    grid.scrollTo({ top: target, behavior: "smooth" });
    const release = window.setTimeout(() => {
      autoScrollingRef.current = false;
    }, MARKER_AUTO_SCROLL_SETTLE_MS);
    return () => {
      window.clearTimeout(release);
      autoScrollingRef.current = false;
    };
    // Re-runs when the next marker changes, after every seek, and when the set
    // of rendered cards changes underneath it (hiding a marker or switching
    // region reflows the grid, so offsets from the previous run are stale).
  }, [nextMarkerId, seekTick, shownMarkers.length, selectedRegion?.id]);

  const scheduleJump = (markerId: string) => {
    useOptimisticStore.getState().setPendingJumpTarget(markerId);
    sendCommand({
      cmd: "scheduleMarkerJump",
      targetMarkerId: markerId,
      trigger: jumpMode,
      bars: jumpMode === "after_bars" ? jumpBars : undefined,
    });
  };

  const cancelJump = () => {
    useOptimisticStore.getState().setPendingJumpTarget(null);
    sendCommand({ cmd: "cancelMarkerJump" });
  };

  return (
    <div className="marker-grid-shell">
      {hiddenVisibleMarkers.length > 0 ? (
        <div className="marker-grid-header">
          <button
            type="button"
            className={`marker-grid-toggle ${revealHiddenMarkers ? "is-on" : ""}`}
            aria-pressed={revealHiddenMarkers}
            onClick={() => setRevealHiddenMarkers(!revealHiddenMarkers)}
          >
            {revealHiddenMarkers
              ? STRINGS.hideHiddenMarkers
              : `${STRINGS.showHiddenMarkers} (${hiddenVisibleMarkers.length})`}
          </button>
        </div>
      ) : null}

      <div
        className="marker-grid"
        ref={gridRef}
        onPointerMove={noteManualDrag}
        onWheel={noteManualScroll}
      >
        {shownMarkers.map((entry) => {
          const marker = entry.marker;
          const isHidden = hiddenMarkerIds.has(entry.id);
          const isNext = liveContext.nextMarkerId === entry.id;
          // A cue is a jump destination like any section; it only READS
          // differently (dashed frame, "cue" badge) so the player can tell the
          // two apart at a glance on stage.
          const isCue = entry.kind === "cue";
          return (
            <div
              key={entry.id}
              ref={isNext ? nextCardRef : undefined}
              className={`marker-card ${isCue ? "is-cue-card" : ""} ${isNext ? "is-next" : ""} ${pendingJumpTargetId === entry.id ? "is-pending" : ""} ${isHidden ? "is-hidden-marker" : ""}`}
              style={{ "--marker-color": markerColor(marker) } as CSSProperties}
            >
              <button
                type="button"
                className="marker-card-jump"
                onClick={() => {
                  if (pendingJump?.targetMarkerId === entry.id) {
                    cancelJump();
                    return;
                  }

                  scheduleJump(entry.id);
                }}
              >
                {isNext ? (
                  <small className="marker-card-next">{STRINGS.next}</small>
                ) : null}
                {isCue ? (
                  <small className="marker-card-cue-badge">{STRINGS.cue}</small>
                ) : null}
                <strong>{marker.name}</strong>
                <span>{formatTimecode(marker.startSeconds)}</span>
                {entry.cues.length > 0 ? (
                  <span className="marker-card-cues">
                    {entry.cues.map((cue) => (
                      <em
                        key={cue.id}
                        className="marker-card-cue-chip"
                        style={{ "--cue-color": markerColor(cue) } as CSSProperties}
                      >
                        {cue.name}
                      </em>
                    ))}
                  </span>
                ) : null}
                <em>{formatJumpModeLabel(jumpMode, jumpBars)}</em>
              </button>
              <button
                type="button"
                className="marker-card-hide"
                aria-label={
                  isHidden ? STRINGS.showMarker : STRINGS.hideMarker
                }
                title={isHidden ? STRINGS.showMarker : STRINGS.hideMarker}
                onClick={() => toggleMarkerHidden(entry.id)}
              >
                {isHidden ? "+" : "×"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MeterBar({ trackId }: { trackId: string }) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frameId = 0;
    let lastFrameAt = 0;
    let currentDb = peakToMeterDb(0);
    let targetDb = peakToMeterDb(0);
    let clipHoldUntil = 0;
    let peakHoldDb = METER_MIN_DB;
    let peakHoldUntil = 0;

    const applyMeter = () => {
      const now = performance.now();
      if (fillRef.current) {
        const meterStyle = meterStyleFromDb(currentDb);
        fillRef.current.style.clipPath = meterStyle.clipPath;
        fillRef.current.style.opacity = meterStyle.opacity;
      }
      if (clipRef.current) {
        const clipping = now <= clipHoldUntil;
        clipRef.current.style.opacity = clipping ? "1" : "0";
        clipRef.current.style.transform = clipping ? "scaleY(1)" : "scaleY(0)";
      }
      if (peakRef.current) {
        const peakStyle = peakHoldStyleFromDb(peakHoldDb);
        peakRef.current.style.transform = peakStyle.transform;
        peakRef.current.style.opacity =
          peakHoldDb > METER_MIN_DB + METER_ACTIVE_EPSILON_DB ? peakStyle.opacity : "0";
      }
    };

    const render = (now: number) => {
      const elapsedMs = lastFrameAt > 0 ? now - lastFrameAt : 16.67;
      lastFrameAt = now;
      currentDb = stepMeterDb(currentDb, targetDb, elapsedMs, DEFAULT_METER_FALLOFF_DB_PER_SECOND);

      if (currentDb >= peakHoldDb) {
        peakHoldDb = currentDb;
        peakHoldUntil = now + METER_PEAK_HOLD_MS;
      } else if (now > peakHoldUntil) {
        peakHoldDb = stepMeterDb(
          peakHoldDb,
          currentDb,
          elapsedMs,
          METER_PEAK_DECAY_DB_PER_SECOND,
        );
      }

      applyMeter();
      const shouldContinue =
        Math.abs(currentDb - targetDb) > METER_ACTIVE_EPSILON_DB ||
        peakHoldDb > currentDb + METER_ACTIVE_EPSILON_DB ||
        now <= clipHoldUntil ||
        now <= peakHoldUntil;

      if (!shouldContinue) {
        currentDb = targetDb;
        peakHoldDb = currentDb;
        applyMeter();
        frameId = 0;
        return;
      }

      frameId = window.requestAnimationFrame(render);
    };

    const unsubscribe = useRemoteSyncStore.subscribe(
      (state) => state.meters[trackId],
      (meter) => {
        const rawPeak = Math.max(meter?.leftPeak ?? 0, meter?.rightPeak ?? 0);
        targetDb = peakToMeterDb(rawPeak);
        if (rawPeak >= METER_CLIP_THRESHOLD) {
          clipHoldUntil = performance.now() + METER_CLIP_HOLD_MS;
        }
        if (targetDb >= peakHoldDb) {
          peakHoldDb = targetDb;
          peakHoldUntil = performance.now() + METER_PEAK_HOLD_MS;
        }
        if (!frameId) {
          frameId = window.requestAnimationFrame(render);
        }
      },
    );

    const initialMeter = useRemoteSyncStore.getState().meters[trackId];
    const initialPeak = Math.max(initialMeter?.leftPeak ?? 0, initialMeter?.rightPeak ?? 0);
    currentDb = peakToMeterDb(initialPeak);
    targetDb = currentDb;
    peakHoldDb = currentDb;
    if (initialPeak >= METER_CLIP_THRESHOLD) {
      clipHoldUntil = performance.now() + METER_CLIP_HOLD_MS;
    }
    applyMeter();

    frameId = window.requestAnimationFrame(render);
    return () => {
      unsubscribe();
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [trackId]);

  return (
    <div className="mixer-meter">
      <div ref={fillRef} className="mixer-meter-fill" />
      <div ref={peakRef} className="mixer-meter-peak" />
      <div ref={clipRef} className="mixer-meter-clip" />
    </div>
  );
}

function MixerStrip({
  track,
  palette,
  inheritsParentPalette,
}: {
  track: TrackSummary;
  palette: FolderPalette | null;
  inheritsParentPalette: boolean;
}) {
  const optimisticTrack = useOptimisticStore((state) => state.tracks[track.id]);
  const effectiveTrack = resolveEffectiveTrack(track, optimisticTrack);
  const [draftPan, setDraftPan] = useState(effectiveTrack.pan);
  const [draftVolume, setDraftVolume] = useState(effectiveTrack.volume);
  const panInteractionRef = useRef(false);
  const volumeInteractionRef = useRef(false);
  // Shift state, tracked globally: a range input's change event doesn't carry
  // shiftKey, so we can't read the modifier off the event itself.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = false;
    };
    const onBlur = () => {
      shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const stripStyle = palette
    ? ({
        "--folder-strip-bg": palette.background,
        "--folder-strip-border": palette.border,
        "--folder-strip-accent": palette.accent,
      } as CSSProperties)
    : undefined;

  useEffect(() => {
    if (!panInteractionRef.current) {
      setDraftPan(effectiveTrack.pan);
    }
  }, [effectiveTrack.pan]);

  useEffect(() => {
    if (!volumeInteractionRef.current) {
      setDraftVolume(effectiveTrack.volume);
    }
  }, [effectiveTrack.volume]);

  const pushMixUpdate = (patch: TrackOptimisticState) => {
    useOptimisticStore.getState().setTrackState(track.id, patch);
    sendCommand({
      cmd: "updateTrackMixLive",
      trackId: track.id,
      volume: patch.volume,
      pan: patch.pan,
      muted: patch.muted,
      solo: patch.solo,
    });
  };

  const commitTrackUpdate = (patch: TrackOptimisticState) => {
    useOptimisticStore.getState().setTrackState(track.id, patch);
    sendCommand({
      cmd: "updateTrack",
      trackId: track.id,
      volume: patch.volume,
      pan: patch.pan,
      muted: patch.muted,
      solo: patch.solo,
    });
  };

  const toggleTranspose = () => {
    sendCommand({
      cmd: "updateTrackTransposeEnabled",
      trackId: track.id,
      transposeEnabled: !effectiveTrack.transposeEnabled,
    });
  };

  const updateDraftPan = (value: number) => {
    const nextPan = magnetizePanValue(value);
    panInteractionRef.current = true;
    setDraftPan(nextPan);
    pushMixUpdate({ pan: nextPan });
  };

  const commitDraftPan = (value: number) => {
    const nextPan = magnetizePanValue(value);
    panInteractionRef.current = false;
    setDraftPan(nextPan);
    commitTrackUpdate({ pan: nextPan });
  };

  // The fader input runs in *position* space [0,1] with the Ableton-style dB
  // curve; convert to linear gain (what we store/send) before dispatching.
  const updateDraftVolume = (position: number) => {
    const nextVolume = positionToGain(position, TRACK_FADER_SCALE);
    volumeInteractionRef.current = true;
    setDraftVolume(nextVolume);
    pushMixUpdate({ volume: nextVolume });
  };

  const commitDraftVolume = (position: number) => {
    const nextVolume = positionToGain(position, TRACK_FADER_SCALE);
    volumeInteractionRef.current = false;
    setDraftVolume(nextVolume);
    commitTrackUpdate({ volume: nextVolume });
  };

  // Double-click resets the fader to unity (0 dB), the way Reaper does.
  const resetVolumeToUnity = () => {
    volumeInteractionRef.current = false;
    setDraftVolume(1.0);
    commitTrackUpdate({ volume: 1.0 });
  };

  // Hold Shift to fine-drag the volume fader. A native range input snaps to the
  // absolute pointer position, and its change event carries no shiftKey, so we
  // read Shift from the global ref above and work *with* onChange: while Shift
  // is held we apply only a fraction of the increment the input reports since
  // the last event (Reaper-style crawl). `lastNativeVolumeRef` tracks the raw
  // native value between events; null = no fine-drag baseline yet.
  const lastNativeVolumeRef = useRef<number | null>(null);
  const handleVolumeChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const nativeValue = Number(event.currentTarget.value); // position [0,1]
    if (!shiftPressedRef.current) {
      lastNativeVolumeRef.current = null;
      updateDraftVolume(nativeValue);
      return;
    }
    // First Shift change: anchor here, no jump.
    if (lastNativeVolumeRef.current == null) {
      lastNativeVolumeRef.current = nativeValue;
      volumeInteractionRef.current = true;
      return;
    }
    const nativeDelta = nativeValue - lastNativeVolumeRef.current;
    lastNativeVolumeRef.current = nativeValue;
    const currentPosition = gainToPosition(draftVolume, TRACK_FADER_SCALE);
    const next = currentPosition + nativeDelta * FINE_DRAG_FACTOR;
    updateDraftVolume(Math.max(0, Math.min(1, next)));
  };
  const commitVolumeDrag = (position: number) => {
    lastNativeVolumeRef.current = null;
    commitDraftVolume(position);
  };

  return (
    <article
      className={`mixer-strip ${track.kind === "folder" ? "is-folder" : ""} ${palette ? "is-colored" : ""} ${inheritsParentPalette ? "is-folder-child" : ""}`}
      style={stripStyle}
    >
      <header className="mixer-strip-header">
        <small>{track.kind === "folder" ? STRINGS.folder : STRINGS.audio}</small>
        <strong title={track.name}>{track.name}</strong>
      </header>

      <div className="pan-section">
        <div className="pan-section-head">
          <button className="mini-action" onClick={() => commitTrackUpdate({ pan: 0 })}>
            {STRINGS.center}
          </button>
          <span className="pan-value">{formatRemotePan(draftPan)}</span>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={draftPan}
          onChange={(event) => updateDraftPan(Number(event.currentTarget.value))}
          onInput={(event) => updateDraftPan(Number(event.currentTarget.value))}
          onPointerDown={() => {
            panInteractionRef.current = true;
          }}
          onPointerUp={(event) => commitDraftPan(Number(event.currentTarget.value))}
          onPointerCancel={(event) => commitDraftPan(Number(event.currentTarget.value))}
          onLostPointerCapture={(event) => commitDraftPan(Number(event.currentTarget.value))}
        />
        <div className="pan-scale" aria-hidden="true">
          <span>L</span>
          <span>C</span>
          <span>R</span>
        </div>
      </div>

      <div className="volume-section">
        <div className="volume-value" aria-hidden="true">
          {formatRemoteVolume(draftVolume)}
        </div>
        <div className="volume-fader-area">
          <div className="volume-scale" aria-hidden="true">
            {TRACK_FADER_TICKS.map((tick) => (
              <span
                key={tick.label}
                style={{ top: `${(tick.offsetFromTop * 100).toFixed(2)}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <MeterBar trackId={track.id} />
          <input
            className="volume-fader"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={gainToPosition(draftVolume, TRACK_FADER_SCALE)}
            onChange={handleVolumeChange}
            onDoubleClick={resetVolumeToUnity}
            onPointerDown={() => {
              volumeInteractionRef.current = true;
              lastNativeVolumeRef.current = null;
            }}
            onPointerUp={(event) =>
              commitVolumeDrag(Number(event.currentTarget.value))
            }
            onPointerCancel={(event) =>
              commitVolumeDrag(Number(event.currentTarget.value))
            }
            onLostPointerCapture={(event) =>
              commitVolumeDrag(Number(event.currentTarget.value))
            }
          />
        </div>
      </div>

      <div className="toggle-row">
        <button
          className={effectiveTrack.muted ? "is-active is-mute" : ""}
          onClick={() => commitTrackUpdate({ muted: !effectiveTrack.muted })}
        >
          M
        </button>
        <button
          className={effectiveTrack.solo ? "is-active is-solo" : ""}
          onClick={() => commitTrackUpdate({ solo: !effectiveTrack.solo })}
        >
          S
        </button>
        <button
          type="button"
          aria-label={`${STRINGS.transposeTrack} ${
            effectiveTrack.transposeEnabled ? STRINGS.transposeOn : STRINGS.transposeOff
          }`}
          className={effectiveTrack.transposeEnabled ? "is-active is-transpose" : "is-transpose"}
          onClick={toggleTranspose}
        >
          T
        </button>
      </div>
    </article>
  );
}

/**
 * Tracks which song region the live playhead is inside, re-rendering only
 * when that crosses a region boundary (not on every animation frame). Used
 * by the mixer's "active song only" filter so toggling between songs
 * updates the visible strips without spinning a per-frame React render.
 */
function useActiveRegionId(): string | null {
  const songView = useRemoteSyncStore((state) => state.songView);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const songViewRef = useRef(songView);

  useEffect(() => {
    songViewRef.current = songView;
  }, [songView]);

  useEffect(() => {
    let frameId = 0;
    const tick = () => {
      const currentSongView = songViewRef.current;
      const positionSeconds = resolveLivePosition(
        useRemoteSyncStore.getState().visualAnchor,
      );
      const region = currentSongView?.regions.find(
        (candidate) =>
          positionSeconds >= candidate.startSeconds &&
          positionSeconds < candidate.endSeconds,
      );
      const nextId = region?.id ?? null;
      setActiveRegionId((current) => (current === nextId ? current : nextId));
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return activeRegionId;
}

/**
 * Master fader for the song the playhead is currently inside. Controls the
 * active region's `master.gain` (linear 0..2), mirroring the desktop's
 * per-song master fader. When the playhead is between songs there is no
 * active region, so the fader is disabled. The thumb tracks the pointer via
 * an optimistic draft and only commits (persists + undo entry) on release.
 */
function SongMasterFader({ region }: { region: SongRegionSummary | null }) {
  const regionGain = region?.master?.gain ?? MASTER_SNAP_TARGET;
  const [draftGain, setDraftGain] = useState(regionGain);
  const interactionRef = useRef(false);
  const disabled = region === null;

  useEffect(() => {
    if (!interactionRef.current) {
      setDraftGain(regionGain);
    }
  }, [regionGain]);

  const streamGain = (value: number) => {
    if (!region) {
      return;
    }
    const nextGain = snapMasterGain(value);
    interactionRef.current = true;
    setDraftGain(nextGain);
    sendCommand({
      cmd: "updateRegionMasterGainLive",
      regionId: region.id,
      masterGain: nextGain,
    });
  };

  const commitGain = (value: number) => {
    if (!region) {
      return;
    }
    const nextGain = snapMasterGain(value);
    interactionRef.current = false;
    setDraftGain(nextGain);
    sendCommand({
      cmd: "updateRegionMasterGain",
      regionId: region.id,
      masterGain: nextGain,
    });
  };

  return (
    <div className={`song-master ${disabled ? "is-disabled" : ""}`}>
      <div className="song-master-label">
        <small>{STRINGS.songMaster}</small>
        <strong>{region ? formatMasterGainSummary(draftGain) : STRINGS.songMasterNoSong}</strong>
      </div>
      <div className="song-master-fader-area">
        <input
          className="song-master-fader"
          type="range"
          min={MASTER_GAIN_MIN}
          max={MASTER_GAIN_MAX}
          step={0.01}
          value={draftGain}
          disabled={disabled}
          onChange={(event) => streamGain(Number(event.currentTarget.value))}
          onInput={(event) => streamGain(Number(event.currentTarget.value))}
          onPointerDown={() => {
            interactionRef.current = true;
          }}
          onPointerUp={(event) => commitGain(Number(event.currentTarget.value))}
          onPointerCancel={(event) => commitGain(Number(event.currentTarget.value))}
          onLostPointerCapture={(event) => commitGain(Number(event.currentTarget.value))}
        />
        <div className="song-master-scale" aria-hidden="true">
          <span>-∞</span>
          <span>0dB</span>
          <span>+6</span>
        </div>
      </div>
      <button
        type="button"
        className="song-master-reset"
        disabled={disabled}
        onClick={() => commitGain(MASTER_SNAP_TARGET)}
      >
        0 dB
      </button>
    </div>
  );
}

function useMixerWidgetModel() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const tracks = songView?.tracks ?? [];
  const folderPaletteMap = useMemo(() => buildFolderPaletteMap(tracks), [tracks]);
  const filterActiveSong = useMixerUiStore((state) => state.filterActiveSong);
  const activeRegionId = useActiveRegionId();
  const activeRegion = useMemo(
    () => songView?.regions.find((region) => region.id === activeRegionId) ?? null,
    [songView, activeRegionId],
  );

  // Recomputed whenever the active region changes (a boundary crossing) or
  // the song view updates. The active region drives which clips count, so
  // we key off its start/end via the resolved region id.
  const activeSongTrackIds = useMemo(() => {
    if (!songView || !activeRegionId) {
      return null;
    }
    const region = songView.regions.find((candidate) => candidate.id === activeRegionId);
    if (!region) {
      return null;
    }
    const midpoint = (region.startSeconds + region.endSeconds) / 2;
    return computeActiveSongTrackIds(songView, midpoint);
  }, [songView, activeRegionId]);

  const visibleTracks = useMemo(
    () =>
      filterActiveSong ? filterTracksToActiveSong(tracks, activeSongTrackIds) : tracks,
    [filterActiveSong, tracks, activeSongTrackIds],
  );

  // The filter is only meaningful while the playhead is inside a song. When
  // it isn't, leave the toggle visible but inert so the user understands it
  // has no target right now (matches the desktop compact-view behaviour).
  const filterAvailable = activeSongTrackIds !== null;

  return { activeRegion, filterActiveSong, filterAvailable, folderPaletteMap, visibleTracks };
}

/** Match Desktop's compact view: while playing, honour the configured song
 * transition; otherwise seek to the song start and start playback. WebSocket
 * commands are consumed in order by the Desktop bridge. */
function playCompactSong(region: SongRegionSummary) {
  const playbackState = useRemoteSyncStore.getState().snapshot?.playbackState;
  const intent = compactSongPlayIntent(playbackState, region);
  if (intent.kind === "schedule") {
    scheduleRegionJumpFromStore(region.id);
    return;
  }
  sendCommand({ cmd: "seek", positionSeconds: intent.positionSeconds });
  sendCommand({ cmd: "play" });
}

function currentLayoutPresetProfile(): LayoutPresetProfile {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const touchCapable =
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches === true;

  // Using only viewport width classifies a landscape tablet as desktop and a
  // landscape phone as tablet. The short side plus touch capability describes
  // the physical family much more reliably across both orientations.
  if (shortSide <= 520 || (!touchCapable && width <= 600)) {
    return "phone";
  }
  if (touchCapable && shortSide <= 1024 && longSide <= 1600) {
    return "tablet";
  }
  return "standard";
}

function MixerSongFilterWidget() {
  const { filterActiveSong, filterAvailable } = useMixerWidgetModel();
  const setFilterActiveSong = useMixerUiStore((state) => state.setFilterActiveSong);
  return (
    <div className="mixer-filter-widget">
      <button
        type="button"
        className={`mixer-filter-toggle ${filterActiveSong ? "is-active" : ""}`}
        aria-pressed={filterActiveSong}
        disabled={!filterAvailable && !filterActiveSong}
        title={filterActiveSong ? STRINGS.activeSongFilterOn : STRINGS.activeSongFilterOff}
        onClick={() => setFilterActiveSong(!filterActiveSong)}
      >
        {STRINGS.activeSongOnly}
      </button>
    </div>
  );
}

function MixerSongMasterWidget() {
  const { activeRegion } = useMixerWidgetModel();
  return <div className="mixer-master-widget"><SongMasterFader region={activeRegion} /></div>;
}

function MixerFadersWidget() {
  const { folderPaletteMap, visibleTracks } = useMixerWidgetModel();
  return (
    <div className="mixer-scroll mixer-scroll-widget">
      {visibleTracks.map((track) => {
        const directPalette = paletteFromTrackColor(track.color);
        const inheritedPalette = directPalette ? null : (folderPaletteMap.get(track.id) ?? null);
        return <MixerStrip key={track.id} track={track} palette={directPalette ?? inheritedPalette} inheritsParentPalette={inheritedPalette !== null} />;
      })}
    </div>
  );
}

function MixerView() {

  return (
    <section className="remote-panel remote-panel-mixer">
      <div className="mixer-filter-bar">
        <MixerSongFilterWidget />
        <MixerSongMasterWidget />
      </div>
      <MixerFadersWidget />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Song widgets: the remote's projection of the desktop compact (Ableton) view.
// Two pieces the user asked for — the song header (play + name + master fader +
// BPM + key) and the clip list — each toggleable between "active song" and
// "all songs" (all songs = Ableton-style columns, the whole set at once).
// ---------------------------------------------------------------------------

type SongWidgetScope = "active" | "all";

/** Per-device persisted Active/All toggle for the song widgets. */
function useSongScope(storageKey: string): [SongWidgetScope, (scope: SongWidgetScope) => void] {
  const [scope, setScope] = useState<SongWidgetScope>(() => {
    if (typeof window === "undefined") return "active";
    return window.localStorage.getItem(storageKey) === "all" ? "all" : "active";
  });
  const update = useCallback(
    (next: SongWidgetScope) => {
      setScope(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Storage blocked — keep the in-memory choice only.
      }
    },
    [storageKey],
  );
  return [scope, update];
}

/** Active/All segmented toggle shared by both song widgets. */
function SongScopeToggle({
  scope,
  onChange,
}: {
  scope: SongWidgetScope;
  onChange: (scope: SongWidgetScope) => void;
}) {
  return (
    <div className="song-scope-toggle" role="group" aria-label={STRINGS.songScope}>
      <button
        type="button"
        className={scope === "active" ? "is-active" : ""}
        onClick={() => onChange("active")}
      >
        {STRINGS.scopeActive}
      </button>
      <button
        type="button"
        className={scope === "all" ? "is-active" : ""}
        onClick={() => onChange("all")}
      >
        {STRINGS.scopeAll}
      </button>
    </div>
  );
}

/** The header row for one song: play + name + BPM + key + master fader. */
function SongHeaderColumn({
  region,
  bpm,
  isActive,
  clips,
}: {
  region: SongRegionSummary;
  bpm: number;
  isActive: boolean;
  clips: SongClipEntry[];
}) {
  const key = keyForRegion(region);
  return (
    <div className={`song-header-column ${isActive ? "is-active" : ""}`}>
      <div className="song-header-name-row">
        <button
          type="button"
          className="song-header-play"
          aria-label={`${STRINGS.play} ${region.name}`}
          title={`${STRINGS.play} ${region.name}`}
          onClick={() => playCompactSong(region)}
        >
          ▶
        </button>
        <div className="song-header-name" title={region.name}>
          {region.name}
        </div>
        <div className="song-header-bpm">{formatBpm(bpm)} BPM</div>
        {key ? <div className="song-header-key">{key}</div> : null}
      </div>
      <SongMasterFader region={region} />
      <div className="song-compact-clips">
        <ClipStack clips={clips} />
      </div>
    </div>
  );
}

/**
 * Song header widget: play + name + master fader + BPM + key. In "active" mode
 * it shows the song under the playhead; in "all" mode, an Ableton-style row of
 * columns, one per song (horizontal scroll).
 */
function SongHeaderWidget() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const [scope, setScope] = useSongScope("libretracks.remote.songCompactScope");
  const activeRegionId = useActiveRegionId();
  const regions = songView?.regions ?? [];
  const activeReg = regions.find((region) => region.id === activeRegionId) ?? null;

  const shown = scope === "all" ? regions : activeReg ? [activeReg] : [];

  return (
    <div className="song-header-widget song-compact-widget">
      <div className="song-widget-head">
        <span className="song-widget-title">{STRINGS.widgetSongHeader}</span>
        <SongScopeToggle scope={scope} onChange={setScope} />
      </div>
      {shown.length === 0 ? (
        <div className="song-widget-empty">{STRINGS.songNoActive}</div>
      ) : (
        <div className={`song-header-columns song-compact-columns ${scope === "all" ? "is-all" : ""}`}>
          {shown.map((region) => (
            <SongHeaderColumn
              key={region.id}
              region={region}
              bpm={bpmForRegion(songView, region)}
              isActive={region.id === activeRegionId}
              clips={clipsForRegion(songView, region)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A vertical stack of clip cards for one region (name + track, tinted). */
function ClipStack({ clips }: { clips: SongClipEntry[] }) {
  if (clips.length === 0) {
    return <div className="clip-stack-empty">{STRINGS.songNoClips}</div>;
  }
  return (
    <div className="clip-stack">
      {clips.map((clip) => (
        <div
          key={clip.id}
          className={`clip-entry ${clip.trackColor ? "is-coloured" : ""}`}
          style={
            clip.trackColor
              ? ({ "--lt-track-color": clip.trackColor } as CSSProperties)
              : undefined
          }
        >
          <span className="clip-entry-name" title={clip.clipName}>
            {clip.clipName}
          </span>
          <span className="clip-entry-track" title={`${STRINGS.clipTrackLabel} ${clip.trackName}`}>
            <span className="clip-entry-track-label">{STRINGS.clipTrackLabel}</span>{" "}
            {clip.trackName}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Clip list widget: the clips inside a song. In "active" mode, the song under
 * the playhead; in "all" mode, every song's full clip set grouped by song (the
 * whole set at once, no per-song selection).
 */
function ClipListWidget() {
  return <SongHeaderWidget />;
}

const PAD_KEY_LABELS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

function remoteOutputOptions(settings: AppSettings, includeMonitor = false) {
  const options: Array<{ value: string; label: string }> = [
    { value: "master", label: STRINGS.outputMaster },
  ];
  if (includeMonitor) {
    options.push({ value: "monitor", label: STRINGS.outputMonitor });
  }
  const channels = Array.from(new Set(settings.enabledOutputChannels)).sort((a, b) => a - b);
  for (let index = 0; index < channels.length; index += 2) {
    const left = channels[index];
    const right = channels[index + 1];
    if (right === left + 1) {
      options.push({ value: `ext:${left}-${right}`, label: `${STRINGS.outputExternal} ${left + 1}/${right + 1}` });
    }
  }
  for (const channel of channels) {
    options.push({ value: `ext:${channel}`, label: `${STRINGS.outputExternal} ${channel + 1}` });
  }
  return options;
}

function SettingsRange({
  label,
  gain,
  onChange,
}: {
  label: string;
  gain: number;
  onChange: (gain: number) => void;
}) {
  return (
    <label className="performance-setting-field is-range">
      <span>{label}<strong>{formatGainDb(gain)}</strong></span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={gainToPosition(gain, AUX_FADER_SCALE)}
        onChange={(event) => onChange(positionToGain(Number(event.currentTarget.value), AUX_FADER_SCALE))}
      />
    </label>
  );
}

function SettingsPitchRange({
  label,
  pitch,
  onChange,
}: {
  label: string;
  pitch: number;
  onChange: (pitch: number) => void;
}) {
  return (
    <label className="performance-setting-field is-range">
      <span>{label}<strong>{pitch > 0 ? "+" : ""}{pitch} st</strong></span>
      <input
        type="range"
        min={-24}
        max={24}
        step={1}
        value={pitch}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function PerformanceSettingsWidget({ mode = "combined" }: { mode?: "combined" | "metronome" | "guide" }) {
  const settings = useRemoteSyncStore((state) => state.settings);
  if (!settings) return <div className="song-widget-empty">{STRINGS.settingsLoading}</div>;
  const patch = (next: Partial<AppSettings>) => sendSettingsUpdate({ ...settings, ...next });
  const metronomeOutputs = remoteOutputOptions(settings);
  const voiceOutputs = remoteOutputOptions(settings, true);

  return (
    <div className={`performance-settings-widget performance-settings-widget-${mode}`}>
      {mode !== "guide" ? (
      <section className="performance-settings-section">
        <header>
          <strong>{STRINGS.metronomeSettings}</strong>
          <label className="performance-switch">
            <input type="checkbox" checked={settings.metronomeEnabled} onChange={(event) => patch({ metronomeEnabled: event.currentTarget.checked })} />
            <span>{settings.metronomeEnabled ? STRINGS.on : STRINGS.off}</span>
          </label>
        </header>
        <SettingsRange label={STRINGS.volume} gain={settings.metronomeVolume} onChange={(metronomeVolume) => patch({ metronomeVolume })} />
        <label className="performance-setting-field">
          <span>{STRINGS.routing}</span>
          <select value={settings.metronomeOutput} onChange={(event) => patch({ metronomeOutput: event.currentTarget.value })}>
            {metronomeOutputs.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="performance-switch is-row"><input type="checkbox" checked={settings.metronomeAccentEnabled} onChange={(event) => patch({ metronomeAccentEnabled: event.currentTarget.checked })} /><span>{STRINGS.accentEnabled}</span></label>
        <div className="performance-setting-grid">
          <label className="performance-setting-field">
            <span>{STRINGS.accentSound}</span>
            <select value={settings.metronomeAccentPreset} onChange={(event) => patch({ metronomeAccentPreset: Number(event.currentTarget.value) })}>
              {METRONOME_SOUND_PRESETS.map((preset, index) => <option key={preset} value={index}>{preset}</option>)}
            </select>
          </label>
          <SettingsPitchRange label={STRINGS.accentPitch} pitch={settings.metronomeAccentPitch} onChange={(metronomeAccentPitch) => patch({ metronomeAccentPitch })} />
        </div>
        <div className="performance-setting-grid">
          <label className="performance-setting-field">
            <span>{STRINGS.beatSound}</span>
            <select value={settings.metronomeBeatPreset} onChange={(event) => patch({ metronomeBeatPreset: Number(event.currentTarget.value) })}>
              {METRONOME_SOUND_PRESETS.map((preset, index) => <option key={preset} value={index}>{preset}</option>)}
            </select>
          </label>
          <SettingsPitchRange label={STRINGS.beatPitch} pitch={settings.metronomeBeatPitch} onChange={(metronomeBeatPitch) => patch({ metronomeBeatPitch })} />
        </div>
        <div className="performance-setting-grid">
          <label className="performance-setting-field">
            <span>{STRINGS.subdivision}</span>
            <select value={settings.metronomeSubdivision} onChange={(event) => patch({ metronomeSubdivision: Number(event.currentTarget.value) })}>
              <option value={1}>{STRINGS.subdivisionOff}</option><option value={2}>1/8</option><option value={3}>{STRINGS.triplet}</option><option value={4}>1/16</option>
            </select>
          </label>
          {settings.metronomeSubdivision > 1 ? (
            <label className="performance-setting-field">
              <span>{STRINGS.subdivisionSound}</span>
              <select value={settings.metronomeSubdivisionPreset} onChange={(event) => patch({ metronomeSubdivisionPreset: Number(event.currentTarget.value) })}>
                {METRONOME_SOUND_PRESETS.map((preset, index) => <option key={preset} value={index}>{preset}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        {settings.metronomeSubdivision > 1 ? (
          <div className="performance-setting-grid">
            <SettingsPitchRange label={STRINGS.subdivisionPitch} pitch={settings.metronomeSubdivisionPitch} onChange={(metronomeSubdivisionPitch) => patch({ metronomeSubdivisionPitch })} />
            <SettingsRange label={STRINGS.subdivisionVolume} gain={settings.metronomeSubdivisionGain} onChange={(metronomeSubdivisionGain) => patch({ metronomeSubdivisionGain })} />
          </div>
        ) : null}
      </section>
      ) : null}

      {mode !== "metronome" ? (
      <section className="performance-settings-section">
        <header>
          <strong>{STRINGS.voiceGuideSettings}</strong>
          <label className="performance-switch">
            <input type="checkbox" checked={settings.voiceGuideEnabled} onChange={(event) => patch({ voiceGuideEnabled: event.currentTarget.checked })} />
            <span>{settings.voiceGuideEnabled ? STRINGS.on : STRINGS.off}</span>
          </label>
        </header>
        <SettingsRange label={STRINGS.volume} gain={settings.voiceGuideVolume} onChange={(voiceGuideVolume) => patch({ voiceGuideVolume })} />
        <label className="performance-setting-field"><span>{STRINGS.routing}</span><select value={settings.voiceGuideOutput} onChange={(event) => patch({ voiceGuideOutput: event.currentTarget.value })}>{voiceOutputs.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <div className="performance-setting-grid">
          <label className="performance-setting-field"><span>{STRINGS.guideLanguage}</span><select value={settings.voiceGuideLanguage} onChange={(event) => patch({ voiceGuideLanguage: event.currentTarget.value })}><option value="es">Español</option><option value="en">English</option></select></label>
          <label className="performance-setting-field"><span>{STRINGS.guideLeadBars}</span><select value={settings.voiceGuideLeadBars} onChange={(event) => patch({ voiceGuideLeadBars: Number(event.currentTarget.value) })}>{[1, 2, 3, 4].map((bars) => <option key={bars} value={bars}>{bars}</option>)}</select></label>
        </div>
        <label className="performance-switch is-row"><input type="checkbox" checked={settings.voiceGuideCountInEnabled} onChange={(event) => patch({ voiceGuideCountInEnabled: event.currentTarget.checked })} /><span>{STRINGS.guideCountIn}</span></label>
      </section>
      ) : null}
    </div>
  );
}

function MetronomeSettingsWidget() {
  return <PerformanceSettingsWidget mode="metronome" />;
}

function VoiceGuideSettingsWidget() {
  return <PerformanceSettingsWidget mode="guide" />;
}

/** Purely visual layout aid. Its line follows the widget aspect ratio and the
 * host keeps it inert outside edit mode, so it never blocks live controls. */
type DesignWidgetProps = { placement: WidgetPlacement };

function LayoutTitleWidget({ placement }: DesignWidgetProps) {
  const text = placement.config?.text?.trim() || STRINGS.layoutTitleDefault;
  const align = placement.config?.align ?? "left";
  return <div className={`layout-design-title is-${align}`}>{text}</div>;
}

function LayoutNoteWidget({ placement }: DesignWidgetProps) {
  const text = placement.config?.text?.trim() || STRINGS.layoutNoteDefault;
  const align = placement.config?.align ?? "left";
  return <div className={`layout-design-note is-${align}`}>{text}</div>;
}

function LayoutGroupWidget({ placement }: DesignWidgetProps) {
  const text = placement.config?.text?.trim() || STRINGS.layoutGroupDefault;
  const align = placement.config?.align ?? "left";
  return (
    <div className="layout-design-group" aria-label={text}>
      <span className={`is-${align}`}>{text}</span>
    </div>
  );
}

function SpacerWidget() {
  return <div className="layout-spacer" aria-hidden="true" />;
}

function SeparatorWidget({ placement }: DesignWidgetProps) {
  const style = placement.config?.separatorStyle ?? "line";
  return <div className={`layout-separator is-${style}`} aria-hidden="true" />;
}

function LegacyPerformanceSettingsWidget() {
  return <PerformanceSettingsWidget />;
}

function PadsWidget() {
  const settings = useRemoteSyncStore((state) => state.settings);
  const catalog = useRemoteSyncStore((state) => state.padsCatalog);
  if (!settings) return <div className="song-widget-empty">{STRINGS.settingsLoading}</div>;
  const patch = (next: Partial<AppSettings>) => sendPadSettingsUpdate({ ...settings, ...next });
  // A pad is usable once it has at least one key; user pads may be partial, and
  // the key grid then disables the tonalities they lack.
  const installedPads = catalog?.pads.filter((pad) => pad.keysPresent > 0) ?? [];
  const currentPad = installedPads.find((pad) => pad.id === settings.padId);
  const keyPresent = (index: number) => currentPad?.keysPresentMask?.[index] ?? true;
  const padOutputs = remoteOutputOptions(settings, true);
  return (
    <div className="pads-widget">
      <header>
        <div><strong>{STRINGS.padsTitle}</strong><small>{currentPad?.name || settings.padId || STRINGS.padsNoPack}</small></div>
        <label className="performance-switch"><input type="checkbox" checked={settings.padEnabled} disabled={!settings.padId} onChange={(event) => patch({ padEnabled: event.currentTarget.checked })} /><span>{settings.padEnabled ? STRINGS.on : STRINGS.off}</span></label>
      </header>
      <label className="performance-setting-field">
        <span>{STRINGS.padPack}</span>
        <select
          value={settings.padId}
          disabled={catalog === null || installedPads.length === 0}
          onChange={(event) => patch({ padId: event.currentTarget.value })}
        >
          <option value="">{catalog === null ? STRINGS.padsCatalogLoading : STRINGS.padsNoPack}</option>
          {settings.padId && !currentPad ? <option value={settings.padId}>{settings.padId}</option> : null}
          {installedPads.map((pad) => <option key={pad.id} value={pad.id}>{pad.name}</option>)}
        </select>
      </label>
      <label className="performance-setting-field">
        <span>{STRINGS.routing}</span>
        <select value={settings.padOutput} onChange={(event) => patch({ padOutput: event.currentTarget.value })}>
          {padOutputs.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {catalog !== null && installedPads.length === 0 ? <p className="pads-empty-hint">{STRINGS.padsNoInstalled} {STRINGS.padsDesktopHint}</p> : null}
      <label className="performance-switch pads-follow-switch">
        <input type="checkbox" checked={settings.padFollowSongKey} disabled={!settings.padId} onChange={(event) => patch({ padFollowSongKey: event.currentTarget.checked })} />
        <span>{STRINGS.padFollowSongKey}</span>
      </label>
      <div className="pads-key-grid" role="group" aria-label={STRINGS.padKey}>
        {/* While following the song key the grid reflects the current tonic but
            is read-only (the desktop drives padKey from the song). */}
        {PAD_KEY_LABELS.map((label, index) => { const present = keyPresent(index); return <button key={label} type="button" className={settings.padKey === index ? "is-active" : present ? "" : "is-missing"} disabled={!settings.padId || settings.padFollowSongKey || !present} aria-pressed={settings.padKey === index} title={present ? undefined : STRINGS.padKeyMissing} onClick={() => patch({ padKey: index })}>{label}</button>; })}
      </div>
      <SettingsRange label={STRINGS.volume} gain={settings.padVolume} onChange={(padVolume) => patch({ padVolume })} />
      <PadFadeControl label={STRINGS.padFadeIn} seconds={settings.padFadeInSeconds} onChange={(padFadeInSeconds) => patch({ padFadeInSeconds })} />
      <PadFadeControl label={STRINGS.padFadeOut} seconds={settings.padFadeOutSeconds} onChange={(padFadeOutSeconds) => patch({ padFadeOutSeconds })} />
      {/* Off by default: pads are deliberately decoupled from the transport
          and keep sounding between songs. When on, the pad goes quiet on
          stop/pause and returns on play — the switch above stays on. */}
      <label className="performance-switch pads-follow-switch">
        <input type="checkbox" checked={settings.padStopWithTransport} disabled={!settings.padId} onChange={(event) => patch({ padStopWithTransport: event.currentTarget.checked })} />
        <span>{STRINGS.padStopWithTransport}</span>
      </label>
    </div>
  );
}

// Soft entrance/exit control for the remote pad widget: a checkbox arming the
// fade (default 2 s) plus a seconds slider. `seconds === 0` = no fade. Mirrors
// the desktop PadFadeField; range 0.5–8 s.
const PAD_FADE_DEFAULT_SECONDS = 2;

function PadFadeControl({
  label,
  seconds,
  onChange,
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const enabled = seconds > 0;
  return (
    <div className="pads-fade-control">
      <label className="performance-switch">
        <input type="checkbox" checked={enabled} onChange={(event) => onChange(event.currentTarget.checked ? PAD_FADE_DEFAULT_SECONDS : 0)} />
        <span>{label}{enabled ? ` · ${seconds.toFixed(1)} s` : ""}</span>
      </label>
      {enabled ? (
        <input
          type="range"
          min={0.5}
          max={8}
          step={0.1}
          value={seconds}
          aria-label={label}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout widgets: thin, prop-free wrappers so every block can be placed on the
// layout canvas the same way. Each pulls what it needs from the stores.
// ---------------------------------------------------------------------------

/** Transport readouts (time / bar / bpm / signature / song) as a widget. */
function ReadoutsWidget() {
  const readout = useTransportReadout();
  return (
    <div className="transport-readouts transport-readouts-inline">
      <div className="readout-card">
        <span>{STRINGS.time}</span>
        <strong>{readout.timecode}</strong>
      </div>
      <div className="readout-card readout-card-compact">
        <span>{STRINGS.barBeat}</span>
        <strong>{readout.musicalDisplay}</strong>
      </div>
      <div className="readout-card readout-card-compact">
        <span>{STRINGS.bpm}</span>
        <strong>{readout.bpm.toFixed(2)}</strong>
      </div>
      <div className="readout-card readout-card-compact">
        <span>{STRINGS.meter}</span>
        <strong>{readout.timeSignature}</strong>
      </div>
      <div className="readout-card readout-card-song">
        <span>{STRINGS.region}</span>
        <strong title={readout.regionName}>{readout.regionName}</strong>
      </div>
    </div>
  );
}

/** A single readout tile — the atomic building block for the split readouts. */
function ReadoutTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="transport-readouts transport-readouts-inline readout-solo">
      <div className="readout-card readout-card-song">
        <span>{label}</span>
        <strong title={title ?? value}>{value}</strong>
      </div>
    </div>
  );
}

function ReadoutTimeWidget() {
  const readout = useTransportReadout();
  return <ReadoutTile label={STRINGS.time} value={readout.timecode} />;
}
function ReadoutBarWidget() {
  const readout = useTransportReadout();
  return <ReadoutTile label={STRINGS.barBeat} value={readout.musicalDisplay} />;
}
function ReadoutBpmWidget() {
  const readout = useTransportReadout();
  return <ReadoutTile label={STRINGS.bpm} value={readout.bpm.toFixed(2)} />;
}
function ReadoutSignatureWidget() {
  const readout = useTransportReadout();
  return <ReadoutTile label={STRINGS.meter} value={readout.timeSignature} />;
}
function ReadoutSongWidget() {
  const readout = useTransportReadout();
  return <ReadoutTile label={STRINGS.region} value={readout.regionName} />;
}
/** Name of the loaded project — the session folder, not the song under the
 * playhead (that is ReadoutSongWidget). Older desktops don't send it. */
function ReadoutSessionWidget() {
  const sessionName = useRemoteSyncStore((state) => state.songView?.sessionName);
  const trimmed = sessionName?.trim();
  return <ReadoutTile label={STRINGS.session} value={trimmed || "--"} />;
}

/** The whole control deck as a widget (registry needs a zero-arg component). */
function DeckWidget() {
  return <ControlDeck />;
}

// Individual control-deck sections as widgets (the deck renders just one slice
// when given a `section`). The shared sync effects run in each, converging on
// the same store state.
function VampSectionWidget() {
  return <ControlDeck section="vamp" />;
}
function JumpSectionWidget() {
  return <ControlDeck section="jump" />;
}
function SongSectionWidget() {
  return <ControlDeck section="song" />;
}
function RegionSectionWidget() {
  return <ControlDeck section="region" />;
}

/**
 * "Saltar a canción" on its own — it used to be pinned to the right of the
 * region carousel inside the region deck, where it could not be enlarged or
 * moved near the player's hand. It jumps to the song selected in the region
 * carousel, honouring the configured song trigger + transition, and is disabled
 * while no song is selected.
 */
function JumpToSongButtonWidget() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const selectedRegionId = useRemoteUiStore((state) => state.selectedRegionId);
  const regions = songView?.regions ?? [];
  const selectedRegion =
    regions.find((region) => region.id === selectedRegionId) ?? regions[0] ?? null;

  return (
    // Deliberately NOT a `pill-button`: that is the transport family (Play,
    // Pause, Stop) and this action is not transport. It keeps the flat,
    // uppercase `jump-cancel-button` look it had inside the region deck.
    <div className="jump-to-song-host">
      <button
        className="jump-cancel-button jump-to-song-button"
        disabled={!selectedRegion}
        title={selectedRegion?.name}
        onClick={() => {
          if (selectedRegion) {
            scheduleRegionJumpFromStore(selectedRegion.id);
          }
        }}
      >
        {STRINGS.jumpToSong}
        {selectedRegion ? (
          <em className="jump-to-song-target">{selectedRegion.name}</em>
        ) : null}
      </button>
    </div>
  );
}

/** The scrolling timeline (cinta) as a standalone widget. */
function TimelineWidget() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const visualAnchor = useRemoteSyncStore((state) => state.visualAnchor);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
  return (
    <div className="timeline-widget-host">
      <SharedTimeline
        songView={songView}
        snapshot={snapshot}
        visualAnchor={visualAnchor}
        pendingJumpTargetId={pendingJumpTargetId}
      />
    </div>
  );
}

// The live widgets need the derived musical context; each wrapper reads it from
// the shared rAF hook so they stay drop-in placeable. Cheap: the hook only
// re-renders when a displayed value changes.
function useSharedLiveContext() {
  return useLiveMusicalContext(() => {
    const { songView, visualAnchor } = useRemoteSyncStore.getState();
    return { songView, visualAnchor };
  });
}

function NextMarkerWidgetHost() {
  return <NextMarkerWidget context={useSharedLiveContext()} />;
}
function NextSongWidgetHost() {
  return <NextSongWidget context={useSharedLiveContext()} />;
}
function CurrentKeyWidgetHost() {
  return <CurrentKeyWidget context={useSharedLiveContext()} />;
}
function ProgressToMarkerWidgetHost() {
  return <ProgressToMarkerWidget context={useSharedLiveContext()} />;
}
function ProgressToSongWidgetHost() {
  return <ProgressToSongWidget context={useSharedLiveContext()} />;
}
function CountdownMarkerBarsHost() {
  return <CountdownWidget context={useSharedLiveContext()} target="marker" unit="bars" />;
}
function CountdownSongTimeHost() {
  return <CountdownWidget context={useSharedLiveContext()} target="song" unit="seconds" />;
}

type WidgetDefinition = {
  /** i18n label shown in the editor palette. */
  labelKey: keyof typeof STRINGS;
  Component: (props: DesignWidgetProps) => ReactElement;
  /** Default column span when added from the palette. */
  defaultW: number;
  defaultH: number;
  /** Legacy widget types may render existing layouts without appearing here. */
  palette?: boolean;
};

type WidgetCategory = "information" | "transport" | "live" | "songs" | "mixer" | "tools" | "layout";

const WIDGET_CATEGORIES: readonly {
  id: WidgetCategory;
  labelKey: keyof typeof STRINGS;
}[] = [
  { id: "information", labelKey: "widgetCategoryInformation" },
  { id: "transport", labelKey: "widgetCategoryTransport" },
  { id: "live", labelKey: "widgetCategoryLive" },
  { id: "songs", labelKey: "widgetCategorySongs" },
  { id: "mixer", labelKey: "widgetCategoryMixer" },
  { id: "tools", labelKey: "widgetCategoryTools" },
  { id: "layout", labelKey: "widgetCategoryLayout" },
];

// Binds every WidgetType to its component + palette metadata. The single source
// of truth the canvas and the (Fase 2c) editor palette both read.
const WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition> = {
  readouts: { labelKey: "widgetReadouts", Component: ReadoutsWidget, defaultW: LAYOUT_COLUMNS, defaultH: 4 },
  readoutTime: { labelKey: "widgetReadoutTime", Component: ReadoutTimeWidget, defaultW: 8, defaultH: 4 },
  readoutBar: { labelKey: "widgetReadoutBar", Component: ReadoutBarWidget, defaultW: 8, defaultH: 4 },
  readoutBpm: { labelKey: "widgetReadoutBpm", Component: ReadoutBpmWidget, defaultW: 8, defaultH: 4 },
  readoutSignature: { labelKey: "widgetReadoutSignature", Component: ReadoutSignatureWidget, defaultW: 8, defaultH: 4 },
  readoutSong: { labelKey: "widgetReadoutSong", Component: ReadoutSongWidget, defaultW: 8, defaultH: 4 },
  readoutSession: { labelKey: "widgetReadoutSession", Component: ReadoutSessionWidget, defaultW: 8, defaultH: 4 },
  transportButtons: { labelKey: "widgetTransport", Component: TransportControlButtons, defaultW: LAYOUT_COLUMNS, defaultH: 5 },
  playButton: { labelKey: "play", Component: PlayButtonWidget, defaultW: 4, defaultH: 4 },
  pauseButton: { labelKey: "pause", Component: PauseButtonWidget, defaultW: 4, defaultH: 4 },
  stopButton: { labelKey: "stop", Component: StopButtonWidget, defaultW: 4, defaultH: 4 },
  clickButton: { labelKey: "click", Component: ClickButtonWidget, defaultW: 4, defaultH: 4 },
  guideButton: { labelKey: "guide", Component: GuideButtonWidget, defaultW: 4, defaultH: 4 },
  timeline: { labelKey: "widgetTimeline", Component: TimelineWidget, defaultW: LAYOUT_COLUMNS, defaultH: 7 },
  controlDeck: { labelKey: "widgetDeck", Component: DeckWidget, defaultW: LAYOUT_COLUMNS, defaultH: 9 },
  deckVamp: { labelKey: "widgetDeckVamp", Component: VampSectionWidget, defaultW: 8, defaultH: 4 },
  deckJump: { labelKey: "widgetDeckJump", Component: JumpSectionWidget, defaultW: 8, defaultH: 4 },
  deckSong: { labelKey: "widgetDeckSong", Component: SongSectionWidget, defaultW: 8, defaultH: 4 },
  deckRegion: { labelKey: "widgetDeckRegion", Component: RegionSectionWidget, defaultW: LAYOUT_COLUMNS, defaultH: 4 },
  jumpToSongButton: { labelKey: "widgetJumpToSong", Component: JumpToSongButtonWidget, defaultW: 6, defaultH: 4 },
  markerGrid: { labelKey: "widgetMarkers", Component: MarkerGrid, defaultW: LAYOUT_COLUMNS, defaultH: 12 },
  mixer: { labelKey: "widgetMixer", Component: MixerView, defaultW: LAYOUT_COLUMNS, defaultH: 28 },
  mixerSongFilter: { labelKey: "widgetMixerSongFilter", Component: MixerSongFilterWidget, defaultW: 8, defaultH: 4 },
  mixerSongMaster: { labelKey: "widgetMixerSongMaster", Component: MixerSongMasterWidget, defaultW: 16, defaultH: 4 },
  mixerFaders: { labelKey: "widgetMixerFaders", Component: MixerFadersWidget, defaultW: LAYOUT_COLUMNS, defaultH: 24 },
  songHeader: { labelKey: "widgetSongHeader", Component: SongHeaderWidget, defaultW: LAYOUT_COLUMNS, defaultH: 12 },
  clipList: { labelKey: "widgetSongHeader", Component: ClipListWidget, defaultW: LAYOUT_COLUMNS, defaultH: 12, palette: false },
  pads: { labelKey: "widgetPads", Component: PadsWidget, defaultW: 12, defaultH: DEFAULT_PADS_WIDGET_HEIGHT },
  metronomeSettings: { labelKey: "widgetMetronomeSettings", Component: MetronomeSettingsWidget, defaultW: 8, defaultH: DEFAULT_METRONOME_WIDGET_HEIGHT },
  voiceGuideSettings: { labelKey: "widgetVoiceGuideSettings", Component: VoiceGuideSettingsWidget, defaultW: 8, defaultH: 20 },
  layoutTitle: { labelKey: "widgetLayoutTitle", Component: LayoutTitleWidget, defaultW: LAYOUT_COLUMNS, defaultH: 3 },
  layoutNote: { labelKey: "widgetLayoutNote", Component: LayoutNoteWidget, defaultW: 12, defaultH: 6 },
  layoutGroup: { labelKey: "widgetLayoutGroup", Component: LayoutGroupWidget, defaultW: 12, defaultH: 12 },
  spacer: { labelKey: "widgetSpacer", Component: SpacerWidget, defaultW: 6, defaultH: 4 },
  separator: { labelKey: "widgetSeparator", Component: SeparatorWidget, defaultW: LAYOUT_COLUMNS, defaultH: 2 },
  performanceSettings: { labelKey: "widgetPerformanceSettings", Component: LegacyPerformanceSettingsWidget, defaultW: 12, defaultH: 20, palette: false },
  nextMarker: { labelKey: "widgetNextMarker", Component: NextMarkerWidgetHost, defaultW: 4, defaultH: 4 },
  nextSong: { labelKey: "widgetNextSong", Component: NextSongWidgetHost, defaultW: 4, defaultH: 4 },
  currentKey: { labelKey: "widgetKey", Component: CurrentKeyWidgetHost, defaultW: 4, defaultH: 4 },
  progressMarker: { labelKey: "widgetProgressMarker", Component: ProgressToMarkerWidgetHost, defaultW: 4, defaultH: 4 },
  progressSong: { labelKey: "widgetProgressSong", Component: ProgressToSongWidgetHost, defaultW: 4, defaultH: 4 },
  countdownMarkerBars: { labelKey: "widgetCountdownMarker", Component: CountdownMarkerBarsHost, defaultW: 4, defaultH: 4 },
  countdownSongTime: { labelKey: "widgetCountdownSong", Component: CountdownSongTimeHost, defaultW: 4, defaultH: 4 },
};

// Kept exhaustive on purpose: adding a WidgetType also requires deciding where
// it belongs in the editor instead of silently appending it to an unsorted list.
const WIDGET_CATEGORY: Record<WidgetType, WidgetCategory> = {
  readouts: "information",
  readoutTime: "information",
  readoutBar: "information",
  readoutBpm: "information",
  readoutSignature: "information",
  readoutSong: "information",
  readoutSession: "information",
  transportButtons: "transport",
  playButton: "transport",
  pauseButton: "transport",
  stopButton: "transport",
  clickButton: "transport",
  guideButton: "transport",
  timeline: "transport",
  controlDeck: "live",
  deckVamp: "live",
  deckJump: "live",
  deckSong: "live",
  deckRegion: "live",
  jumpToSongButton: "live",
  markerGrid: "live",
  nextMarker: "live",
  nextSong: "live",
  currentKey: "live",
  progressMarker: "live",
  progressSong: "live",
  countdownMarkerBars: "live",
  countdownSongTime: "live",
  songHeader: "songs",
  clipList: "songs",
  mixer: "mixer",
  mixerSongFilter: "mixer",
  mixerSongMaster: "mixer",
  mixerFaders: "mixer",
  pads: "tools",
  metronomeSettings: "tools",
  voiceGuideSettings: "tools",
  layoutTitle: "layout",
  layoutNote: "layout",
  layoutGroup: "layout",
  spacer: "layout",
  separator: "layout",
  performanceSettings: "tools",
};

type WidgetDefaultSize = { w: number; h: number };

/** Device-aware starting rectangles. The 24-column grid remains identical on
 * every device; only the initial span changes so a newly added widget is useful
 * before the user touches a resize handle. */
function widgetDefaultSize(type: WidgetType, canvasWidth: number): WidgetDefaultSize {
  const definition = WIDGET_REGISTRY[type];
  const desktop = { w: definition.defaultW, h: definition.defaultH };
  if (canvasWidth > 1024) return desktop;

  const isPhone = canvasWidth <= 600;
  if (!isPhone) {
    switch (type) {
      case "readoutTime": case "readoutBar": case "readoutBpm":
      case "readoutSignature": case "readoutSong": case "readoutSession":
      case "nextMarker": case "nextSong": case "currentKey":
      case "progressMarker": case "progressSong":
      case "countdownMarkerBars": case "countdownSongTime":
        return { w: 8, h: 5 };
      case "deckVamp": case "deckJump": case "deckSong":
        return { w: 12, h: 7 };
      case "jumpToSongButton":
        return { w: 10, h: 5 };
      case "mixerSongFilter":
        return { w: 8, h: 4 };
      case "mixerSongMaster":
        return { w: 16, h: 5 };
      default:
        return desktop;
    }
  }

  switch (type) {
    case "readouts": return { w: 24, h: 8 };
    case "readoutTime": case "readoutBar": case "readoutBpm":
    case "readoutSignature": case "readoutSong": case "readoutSession":
      return { w: 12, h: 5 };
    case "transportButtons": return { w: 24, h: 6 };
    case "playButton": case "pauseButton": case "stopButton":
    case "clickButton": case "guideButton":
      return { w: 8, h: 5 };
    case "timeline": return { w: 24, h: 4 };
    case "controlDeck": return { w: 24, h: 10 };
    case "deckVamp": case "deckJump": case "deckSong":
      return { w: 24, h: 7 };
    case "deckRegion": return { w: 24, h: 6 };
    case "jumpToSongButton": return { w: 24, h: 5 };
    case "markerGrid": return { w: 24, h: 14 };
    case "mixer": return { w: 24, h: 30 };
    case "mixerSongFilter": return { w: 24, h: 4 };
    case "mixerSongMaster": return { w: 24, h: 5 };
    case "mixerFaders": return { w: 24, h: 26 };
    case "songHeader": case "clipList": return { w: 24, h: 14 };
    case "pads": return { w: 24, h: DEFAULT_PADS_WIDGET_HEIGHT };
    case "metronomeSettings": return { w: 24, h: DEFAULT_METRONOME_WIDGET_HEIGHT };
    case "voiceGuideSettings": return { w: 24, h: 14 };
    case "layoutTitle": return { w: 24, h: 3 };
    case "layoutNote": return { w: 24, h: 6 };
    case "layoutGroup": return { w: 24, h: 12 };
    case "spacer": return { w: 12, h: 4 };
    case "separator": return { w: 24, h: 2 };
    case "performanceSettings": return { w: 24, h: 20 };
    case "nextMarker": case "nextSong": case "currentKey":
    case "progressMarker": case "progressSong":
    case "countdownMarkerBars": case "countdownSongTime":
      return { w: 12, h: 6 };
    default:
      return desktop;
  }
}

/** Fixed pixel height of one grid row in the absolute (X/Y) layout. The grid
 * uses fixed-height rows so a widget's row-span maps to a predictable size and
 * drag math stays simple. */
const ROW_HEIGHT_PX = 18;
const GRID_GAP_PX = 2;

/** Id of the phantom placement used to compute a push preview for a widget
 * being dragged in from the palette. Never committed to the layout. */
const ADD_PREVIEW_ID = "layout-add-preview";

function isConfigurableDesignWidget(type: WidgetType): boolean {
  return type === "layoutTitle" || type === "layoutNote" || type === "layoutGroup" || type === "separator";
}

function DesignWidgetConfigDialog({
  placement,
  onChange,
  onClose,
}: {
  placement: WidgetPlacement;
  onChange: (config: WidgetConfig) => void;
  onClose: () => void;
}) {
  const config = placement.config ?? {};
  const isText = placement.type === "layoutTitle" || placement.type === "layoutNote" || placement.type === "layoutGroup";
  const label = STRINGS[WIDGET_REGISTRY[placement.type].labelKey];
  return (
    <div className="layout-config-backdrop" role="presentation" onPointerDown={onClose}>
      <section
        className="layout-config-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${STRINGS.configureWidget}: ${label}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{label}</strong>
          <button type="button" onClick={onClose} aria-label={STRINGS.close}>×</button>
        </header>
        {isText ? (
          <>
            <label className="layout-config-field">
              <span>{STRINGS.widgetText}</span>
              {placement.type === "layoutNote" ? (
                <textarea
                  value={config.text ?? ""}
                  maxLength={1000}
                  placeholder={STRINGS.layoutNoteDefault}
                  onChange={(event) => onChange({ ...config, text: event.currentTarget.value })}
                />
              ) : (
                <input
                  value={config.text ?? ""}
                  maxLength={120}
                  placeholder={placement.type === "layoutGroup" ? STRINGS.layoutGroupDefault : STRINGS.layoutTitleDefault}
                  onChange={(event) => onChange({ ...config, text: event.currentTarget.value })}
                />
              )}
            </label>
            <label className="layout-config-field">
              <span>{STRINGS.textAlignment}</span>
              <select
                value={config.align ?? "left"}
                onChange={(event) => onChange({
                  ...config,
                  align: event.currentTarget.value as NonNullable<WidgetConfig["align"]>,
                })}
              >
                <option value="left">{STRINGS.alignLeft}</option>
                <option value="center">{STRINGS.alignCenter}</option>
                <option value="right">{STRINGS.alignRight}</option>
              </select>
            </label>
          </>
        ) : (
          <label className="layout-config-field">
            <span>{STRINGS.separatorStyle}</span>
            <select
              value={config.separatorStyle ?? "line"}
              onChange={(event) => onChange({
                ...config,
                separatorStyle: event.currentTarget.value as NonNullable<WidgetConfig["separatorStyle"]>,
              })}
            >
              <option value="line">{STRINGS.separatorLine}</option>
              <option value="dashed">{STRINGS.separatorDashed}</option>
              <option value="space">{STRINGS.separatorSpace}</option>
            </select>
          </label>
        )}
      </section>
    </div>
  );
}

/** Which side(s) a resize gesture grows. The corner grip keeps the classic
 * both-axes behaviour; the dedicated edge grips constrain to one axis, which is
 * what makes resizing usable with a fingertip on a tablet. */
export type ResizeEdge = "corner" | "right" | "bottom";

/**
 * Renders one placed widget at its absolute grid cell (x/y, w/h). In edit mode
 * the whole top chrome is the move handle; resizing is available three ways —
 * the corner grip (both axes), a right/bottom edge grip (single axis) and the
 * ± steppers in the chrome. The steppers exist because dragging a small grip
 * on a touch screen is the part users struggle with most; they change the same
 * w/h by exactly one cell per tap. All grips only emit pointer-down — the
 * canvas owns the drag math (it knows the grid geometry).
 */
function LayoutWidgetHost({
  placement,
  editing,
  onRemove,
  onMovePointerDown,
  onResizePointerDown,
  onNudgeSize,
  onConfigure,
  isDragging,
  isGroupDropTarget,
}: {
  placement: WidgetPlacement;
  editing: boolean;
  onRemove: () => void;
  onMovePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge) => void;
  onNudgeSize: (axis: "w" | "h", delta: 1 | -1) => void;
  onConfigure: () => void;
  isDragging: boolean;
  isGroupDropTarget: boolean;
}) {
  const definition = WIDGET_REGISTRY[placement.type];
  if (!definition) {
    return null;
  }
  const { Component } = definition;
  const label = STRINGS[definition.labelKey];

  return (
    <div
      className={`layout-widget layout-widget-type-${placement.type} ${editing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""} ${isGroupDropTarget ? "is-group-drop-target" : ""}`}
      style={{
        gridColumn: `${placement.x + 1} / span ${Math.min(LAYOUT_COLUMNS, placement.w)}`,
        gridRow: `${placement.y + 1} / span ${placement.h}`,
      }}
    >
      {editing ? (
        <div className="layout-widget-chrome">
          {/* The whole chrome bar is the move handle. */}
          <div
            className="layout-widget-drag"
            role="button"
            aria-label={`${STRINGS.moveWidget}: ${label}`}
            onPointerDown={onMovePointerDown}
          >
            <span className="layout-widget-title">⠿ {label}</span>
          </div>
          <div className="layout-widget-sizers">
            {/* Tap-to-resize: one grid cell per tap, on each axis. Reliable
                where dragging a corner grip on glass is not. */}
            <div className="layout-widget-stepper" role="group" aria-label={`${STRINGS.widgetWidth}: ${label}`}>
              <span aria-hidden="true">↔</span>
              <button
                type="button"
                aria-label={`${STRINGS.narrower}: ${label}`}
                disabled={placement.w <= 1}
                onClick={() => onNudgeSize("w", -1)}
              >
                −
              </button>
              <button
                type="button"
                aria-label={`${STRINGS.wider}: ${label}`}
                disabled={placement.w >= LAYOUT_COLUMNS}
                onClick={() => onNudgeSize("w", 1)}
              >
                +
              </button>
            </div>
            <div className="layout-widget-stepper" role="group" aria-label={`${STRINGS.widgetHeight}: ${label}`}>
              <span aria-hidden="true">↕</span>
              <button
                type="button"
                aria-label={`${STRINGS.shorter}: ${label}`}
                disabled={placement.h <= 1}
                onClick={() => onNudgeSize("h", -1)}
              >
                −
              </button>
              <button
                type="button"
                aria-label={`${STRINGS.taller}: ${label}`}
                disabled={placement.h >= LAYOUT_MAX_ROWS}
                onClick={() => onNudgeSize("h", 1)}
              >
                +
              </button>
            </div>
            {isConfigurableDesignWidget(placement.type) ? (
              <button type="button" className="layout-widget-configure" onClick={onConfigure}>
                {STRINGS.configureWidget}
              </button>
            ) : null}
            <button type="button" className="layout-widget-remove" onClick={onRemove}>
              {STRINGS.removeWidget}
            </button>
          </div>
        </div>
      ) : null}
      <div className={`layout-widget-body ${editing ? "is-inert" : ""}`}>
        <Component placement={placement} />
      </div>
      {editing ? (
        <>
          {/* Full-length edge grips: a much larger target than the corner and
              constrained to one axis, so a drag can't skew both dimensions. */}
          <div
            className="layout-widget-resize-edge is-right"
            role="button"
            aria-label={`${STRINGS.resizeWidgetWidth}: ${label}`}
            onPointerDown={(event) => onResizePointerDown(event, "right")}
          />
          <div
            className="layout-widget-resize-edge is-bottom"
            role="button"
            aria-label={`${STRINGS.resizeWidgetHeight}: ${label}`}
            onPointerDown={(event) => onResizePointerDown(event, "bottom")}
          />
          <div
            className="layout-widget-resize"
            role="button"
            aria-label={`${STRINGS.resizeWidget}: ${label}`}
            onPointerDown={(event) => onResizePointerDown(event, "corner")}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The palette shown in edit mode. A pointer-down on an item starts an add-drag
 * so it can be dropped at a chosen position on the grid (Mixing-Station style);
 * a plain tap (no drag) still adds it — endDrag inserts at the drop position or
 * appends when none was hovered. onClick is a keyboard/no-pointer fallback.
 */
function WidgetPalette({
  onAdd,
  onDragAdd,
  onDragMove,
  onDragEnd,
  onClose,
}: {
  onAdd: (type: WidgetType) => void;
  onDragAdd: (type: WidgetType, event: ReactPointerEvent<HTMLElement>) => void;
  onDragMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  return (
    <div className="layout-palette" role="group" aria-label={STRINGS.addWidget}>
      <button type="button" className="layout-palette-close" onClick={onClose}>
        × {STRINGS.hideWidgetPalette}
      </button>
      <div className="layout-palette-categories">
        {WIDGET_CATEGORIES.map((category) => {
          const widgetTypes = (Object.keys(WIDGET_REGISTRY) as WidgetType[])
            .filter((type) => WIDGET_REGISTRY[type].palette !== false)
            .filter((type) => WIDGET_CATEGORY[type] === category.id);
          if (widgetTypes.length === 0) return null;

          return (
            <section className="layout-palette-category" key={category.id}>
              <h3>{STRINGS[category.labelKey]}</h3>
              <div className="layout-palette-category-items">
                {widgetTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="layout-palette-item"
                    onPointerDown={(event) => onDragAdd(type, event)}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragEnd}
                    onPointerCancel={onDragEnd}
                    // Fallback for keyboard activation (Enter/Space) where there is no
                    // pointer sequence; guarded so a pointer tap doesn't double-add.
                    onClick={(event) => {
                      if (event.detail === 0) {
                        onAdd(type);
                      }
                    }}
                  >
                    + {STRINGS[WIDGET_REGISTRY[type].labelKey]}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The tab bar shown above the canvas. Always lets you switch tabs; in edit mode
 * it also lets you add, rename (double-click / edit button) and delete tabs.
 * Deleting the last tab is disallowed so the layout always has one.
 */
function LayoutTabBar({
  tabs,
  activeTabId,
  editing,
  heightRem,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
}: {
  tabs: LayoutTab[];
  activeTabId: string;
  editing: boolean;
  /** Height of the tab strip in rem; drives the tab min-height and font size
   * through a CSS variable so one number makes the whole strip taller. */
  heightRem: number;
  onSelect: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, name: string) => void;
  onDelete: (tabId: string) => void;
  onMove: (tabId: string, direction: -1 | 1) => void;
}) {
  const renameTab = (tab: LayoutTab) => {
    const next = window.prompt(STRINGS.renameTabPrompt, tab.name);
    if (next !== null && next.trim()) {
      onRename(tab.id, next.trim());
    }
  };

  return (
    <div
      className="layout-tabbar"
      role="tablist"
      aria-label={STRINGS.tabs}
      style={{ "--tab-height": `${heightRem}rem` } as CSSProperties}
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={`layout-tab ${tab.id === activeTabId ? "is-active" : ""}`}
        >
          {editing ? (
            <button
              type="button"
              className="layout-tab-move"
              aria-label={STRINGS.moveTabLeft}
              title={STRINGS.moveTabLeft}
              disabled={index === 0}
              onClick={() => onMove(tab.id, -1)}
            >
              ‹
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className="layout-tab-select"
            onClick={() => onSelect(tab.id)}
            onDoubleClick={editing ? () => renameTab(tab) : undefined}
          >
            {tab.name}
          </button>
          {editing ? (
            <>
              <button
                type="button"
                className="layout-tab-move"
                aria-label={STRINGS.moveTabRight}
                title={STRINGS.moveTabRight}
                disabled={index === tabs.length - 1}
                onClick={() => onMove(tab.id, 1)}
              >
                ›
              </button>
              <button
                type="button"
                className="layout-tab-rename"
                aria-label={`${STRINGS.renameTab}: ${tab.name}`}
                title={STRINGS.renameTab}
                onClick={() => renameTab(tab)}
              >
                ✎
              </button>
              <button
                type="button"
                className="layout-tab-delete"
                aria-label={`${STRINGS.deleteTab}: ${tab.name}`}
                title={STRINGS.deleteTab}
                disabled={tabs.length <= 1}
                onClick={() => onDelete(tab.id)}
              >
                ×
              </button>
            </>
          ) : null}
        </div>
      ))}
      {editing ? (
        <button type="button" className="layout-tab-add" onClick={onAdd}>
          + {STRINGS.addTab}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The editable canvas: a tab bar plus the grid of the active tab's widgets.
 * In edit mode (Mixing-Station-style, on the current dense-flow grid) widgets
 * can be moved by dragging their chrome (with a drop-target indicator), resized
 * by dragging the corner grip, removed, and
 * dropped in from the palette at a chosen position. Tabs can be added, renamed,
 * deleted, reordered and switched. All changes persist via onChange.
 */
function LayoutCanvas({
  layout,
  editing,
  onChange,
}: {
  layout: RemoteLayout;
  editing: boolean;
  onChange: (next: RemoteLayout) => void;
}) {
  // Active pointer gesture: moving an existing widget, resizing it, or dragging
  // a new one in from the palette. All share the same pointer-move/up handlers
  // on the grid, which convert client coordinates to a grid cell (x/y).
  type Gesture =
    | { kind: "move"; id: string; grabDX: number; grabDY: number }
    | {
        kind: "resize";
        id: string;
        edge: ResizeEdge;
        startX: number;
        startY: number;
        startW: number;
        startH: number;
      }
    | { kind: "add"; type: WidgetType; startX: number; startY: number; moved: boolean };
  const gestureRef = useRef<Gesture | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingAddType, setPendingAddType] = useState<WidgetType | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [configWidgetId, setConfigWidgetId] = useState<string | null>(null);
  const [groupDropId, setGroupDropId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<{
    x: number; y: number; w: number; h: number; label: string;
  } | null>(null);
  // True while the pointer is over the trash zone during a drag. Dropping there
  // removes an existing widget, or abandons a palette add.
  const [overTrash, setOverTrash] = useState(false);
  const trashRef = useRef<HTMLDivElement | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellWidthRef = useRef(0);
  const rowHeightRef = useRef(ROW_HEIGHT_PX + GRID_GAP_PX);
  // Grid row where the device viewport ends: everything from here down needs
  // scrolling to reach. Null when the layout fits on one screen. Editing only —
  // it is what tells the user, while placing, what falls below the fold.
  const [foldRow, setFoldRow] = useState<number | null>(null);

  const placementMode: LayoutPlacementMode = layout.placementMode ?? "free";
  const tabHeightRem = clampTabHeight(layout.tabHeightRem);

  const activeTab =
    layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0];
  const widgets = activeTab?.widgets ?? [];
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  /** Rows the layout actually occupies: the bottom edge of its lowest widget. */
  const usedRows = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
  // Read inside the ResizeObserver callback, which outlives the render that
  // created it, so a captured value would go stale mid-drag.
  const usedRowsRef = useRef(usedRows);
  usedRowsRef.current = usedRows;

  // Measure the column width from the grid so pointer coordinates map to cells,
  // and the row at which the visible viewport ends (the scroll fold).
  useEffect(() => {
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      cellWidthRef.current = Math.max(1, (el.clientWidth + GRID_GAP_PX) / LAYOUT_COLUMNS);

      // Where the device screen ends, in grid rows.
      //
      // This must describe the layout as the PLAYER sees it, so every piece of
      // chrome that exists ONLY while editing has to be added back. Measuring the
      // scroller's clientHeight directly is wrong on a phone: the edit toolbar is
      // injected into the header, the header is a flex sibling of .remote-content,
      // and .remote-content is `flex: 1` — so a toolbar that wraps onto several
      // lines shrinks the scroller and the fold creeps upward, claiming a fold
      // where the real view has no scroll.
      //
      // Reconstruct the real height instead: the shell minus the chrome that
      // survives leaving edit mode (the header WITHOUT the toolbar, and the tab
      // strip, which the player does see).
      const scroller = el.closest(".layout-canvas-wrap") as HTMLElement | null;
      const shell = el.closest(".remote-shell") as HTMLElement | null;
      if (!scroller || !shell) {
        setFoldRow(null);
        return;
      }

      const header = shell.querySelector(".remote-header") as HTMLElement | null;
      const toolbar = header?.querySelector(".layout-edit-toolbar") as HTMLElement | null;
      // The tab strip IS part of the real view, so it costs the grid height. The
      // palette is editor-only and excluded by measuring from the shell rather
      // than from the grid.
      const tabbar = scroller.querySelector(".layout-tabbar") as HTMLElement | null;
      const scrollerStyle = getComputedStyle(scroller);

      setFoldRow(
        computeFoldRow(
          {
            shellHeight: shell.getBoundingClientRect().height,
            headerHeight: header?.getBoundingClientRect().height ?? 0,
            toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
            otherHeaderHeight: Array.from(header?.children ?? [])
              .filter((child) => child !== toolbar)
              .reduce(
                (max, child) => Math.max(max, child.getBoundingClientRect().height),
                0,
              ),
            tabbarHeight: tabbar?.getBoundingClientRect().height ?? 0,
            scrollerPadding:
              parseFloat(scrollerStyle.paddingTop || "0") +
              parseFloat(scrollerStyle.paddingBottom || "0"),
            rowHeight: rowHeightRef.current,
          },
          usedRowsRef.current,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !gridRef.current) {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(gridRef.current);
    const scroller = gridRef.current.closest(".layout-canvas-wrap");
    if (scroller) observer.observe(scroller);
    // The header changes height when the edit toolbar wraps to another line, and
    // the shell when the browser chrome (Safari's URL bar) grows or collapses.
    // Both feed the reconstructed height, so both must retrigger the measure.
    const shell = gridRef.current.closest(".remote-shell");
    const header = shell?.querySelector(".remote-header");
    if (header) observer.observe(header);
    if (shell) observer.observe(shell);
    const tabbar = scroller?.querySelector(".layout-tabbar");
    if (tabbar) observer.observe(tabbar);
    return () => observer.disconnect();
    // `usedRows` (not the widget array) is what the fold depends on: dragging a
    // widget within the rows that already exist leaves the grid's height — and
    // so the ResizeObserver — untouched, but it does change whether anything
    // reaches past the screen.
  }, [activeTab?.id, editing, usedRows]);

  // Replace the active tab's widgets, keeping every other tab untouched.
  const commit = (nextWidgets: WidgetPlacement[]) => {
    if (!activeTab) return;
    // Pointer move/up events can arrive before React has rendered the previous
    // geometry update. Keep the latest committed array available synchronously
    // so dropping into a group always uses the visible final rectangle.
    widgetsRef.current = nextWidgets;
    onChange({
      ...layout,
      customized: true,
      tabs: layout.tabs.map((tab) =>
        tab.id === activeTab.id ? { ...tab, widgets: nextWidgets } : tab,
      ),
    });
  };

  const selectTab = (tabId: string) => onChange({ ...layout, activeTabId: tabId });

  const addTab = () => {
    const tab = makeEmptyTab(STRINGS.newTabName);
    onChange({ ...layout, tabs: [...layout.tabs, tab], activeTabId: tab.id });
  };

  const renameTab = (tabId: string, name: string) => {
    onChange({
      ...layout,
      tabs: layout.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab)),
    });
  };

  const deleteTab = (tabId: string) => {
    if (layout.tabs.length <= 1) return;
    const remaining = layout.tabs.filter((tab) => tab.id !== tabId);
    const nextActive = layout.activeTabId === tabId ? remaining[0].id : layout.activeTabId;
    onChange({ ...layout, tabs: remaining, activeTabId: nextActive });
  };

  const moveTab = (tabId: string, direction: -1 | 1) => {
    const index = layout.tabs.findIndex((tab) => tab.id === tabId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= layout.tabs.length) return;
    const tabs = [...layout.tabs];
    [tabs[index], tabs[target]] = [tabs[target], tabs[index]];
    onChange({ ...layout, tabs });
  };

  const removeWidget = (id: string) => {
    if (configWidgetId === id) setConfigWidgetId(null);
    // Read through the ref: a trash drop commits the gesture baseline first,
    // and React has not re-rendered `widgets` by the time this runs.
    commit(widgetsRef.current
      .filter((widget) => widget.id !== id)
      .map((widget) => {
        if (widget.groupId !== id) return widget;
        const { groupId: _groupId, ...withoutGroup } = widget;
        return withoutGroup;
      }));
  };

  const updateWidgetConfig = (id: string, config: WidgetConfig) => {
    commit(widgets.map((widget) => widget.id === id ? { ...widget, config } : widget));
  };

  const resizeWidget = (id: string, patch: { w?: number; h?: number }) => {
    const currentWidgets = widgetsRef.current;
    commit(
      currentWidgets.map((widget) =>
        widget.id === id
          ? {
              ...widget,
              w: patch.w !== undefined ? Math.max(1, Math.min(LAYOUT_COLUMNS, patch.w)) : widget.w,
              h: patch.h !== undefined ? Math.max(1, Math.min(LAYOUT_MAX_ROWS, patch.h)) : widget.h,
            }
          : widget,
      ),
    );
  };

  const updatePos = (id: string, x: number, y: number): WidgetPlacement[] => {
    const nextWidgets = moveWidgetWithGroup(widgetsRef.current, id, x, y);
    commit(nextWidgets);
    return nextWidgets;
  };

  /**
   * Final step of any geometry change: re-evaluate group membership and, in
   * "push" mode, shift whatever the widget now overlaps downwards. Group
   * membership is reconciled first so a group carries the right contents when
   * the push moves it as one body.
   */
  const settlePlacement = (
    nextWidgets: WidgetPlacement[],
    id: string,
  ): WidgetPlacement[] => {
    const grouped = reconcileWidgetGroup(nextWidgets, id);
    return placementMode === "push" ? pushWidgetsDown(grouped, id) : grouped;
  };

  /**
   * Live push preview while a gesture is in flight. The push must be computed
   * from the layout as it was when the gesture STARTED, not from the last
   * previewed frame — otherwise every pointer-move would push the already
   * displaced widgets again and they would run down the grid. So we re-apply the
   * dragged widget's current rectangle onto the baseline, then push once.
   *
   * Only used in "push" mode; free mode has nothing to preview.
   */
  const gestureBaselineRef = useRef<WidgetPlacement[] | null>(null);

  const previewPush = (id: string, rect: Partial<WidgetPlacement>) => {
    const baseline = gestureBaselineRef.current;
    if (placementMode !== "push" || !baseline) return;
    const rebased = baseline.map((widget) =>
      widget.id === id ? { ...widget, ...rect } : widget,
    );
    // Group contents follow their group's delta on the baseline too.
    const target = baseline.find((widget) => widget.id === id);
    const withGroup =
      target?.type === "layoutGroup" && rect.x !== undefined && rect.y !== undefined
        ? moveWidgetWithGroup(rebased, id, rect.x, rect.y)
        : rebased;
    commit(pushWidgetsDown(withGroup, id));
  };

  /** Is the pointer inside the trash zone? Hit-tested against the live rect so
   * it works with pointer capture, where the event target stays the grid. */
  const isOverTrash = (clientX: number, clientY: number): boolean =>
    rectContainsPoint(trashRef.current?.getBoundingClientRect(), clientX, clientY);

  // Client coords → grid cell (col, row), clamped to the grid.
  const cellFromClient = (clientX: number, clientY: number) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return { col: 0, row: 0 };
    const col = Math.max(
      0,
      Math.min(LAYOUT_COLUMNS - 1, Math.floor((clientX - rect.left) / cellWidthRef.current)),
    );
    const row = Math.max(
      0,
      Math.min(LAYOUT_MAX_ROWS - 1, Math.floor((clientY - rect.top) / rowHeightRef.current)),
    );
    return { col, row };
  };

  // --- Gesture starts (from the widget host / palette) -------------------
  const beginMove = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    const widget = widgetsRef.current.find((w) => w.id === id);
    if (!widget) return;
    const rect = gridRef.current?.getBoundingClientRect();
    // Remember where inside the widget the finger grabbed, so the widget
    // doesn't jump its top-left corner to the pointer.
    const originX = rect ? rect.left + widget.x * cellWidthRef.current : event.clientX;
    const originY = rect ? rect.top + widget.y * rowHeightRef.current : event.clientY;
    gestureRef.current = {
      kind: "move",
      id,
      grabDX: event.clientX - originX,
      grabDY: event.clientY - originY,
    };
    gestureBaselineRef.current = widgetsRef.current;
    setDragId(id);
    setGroupDropId(widget.type === "layoutGroup" ? null : widget.groupId ?? null);
    setDropPreview({ x: widget.x, y: widget.y, w: widget.w, h: widget.h, label: STRINGS[WIDGET_REGISTRY[widget.type].labelKey] });
    gridRef.current?.setPointerCapture?.(event.pointerId);
  };

  const beginResize = (
    id: string,
    event: ReactPointerEvent<HTMLElement>,
    edge: ResizeEdge,
  ) => {
    const widget = widgetsRef.current.find((w) => w.id === id);
    if (!widget) return;
    event.stopPropagation();
    gestureRef.current = {
      kind: "resize",
      id,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startW: widget.w,
      startH: widget.h,
    };
    gestureBaselineRef.current = widgetsRef.current;
    setDragId(id);
    setGroupDropId(null);
    gridRef.current?.setPointerCapture?.(event.pointerId);
  };

  // Tap-to-resize from the chrome steppers: one grid cell per tap. Runs the
  // same commit path as a drag so push mode and group membership stay correct.
  const nudgeSize = (id: string, axis: "w" | "h", delta: 1 | -1) => {
    const widget = widgetsRef.current.find((w) => w.id === id);
    if (!widget) return;
    const max = axis === "w" ? LAYOUT_COLUMNS : LAYOUT_MAX_ROWS;
    const next = Math.max(1, Math.min(max, widget[axis] + delta));
    if (next === widget[axis]) return;
    // Growing the width must not push the widget past the right edge.
    const patch =
      axis === "w"
        ? { w: Math.min(next, LAYOUT_COLUMNS - widget.x) }
        : { h: next };
    resizeWidget(id, patch);
    commit(settlePlacement(widgetsRef.current, id));
  };

  const beginAdd = (type: WidgetType, event: ReactPointerEvent<HTMLElement>) => {
    gestureRef.current = {
      kind: "add",
      type,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    gestureBaselineRef.current = widgetsRef.current;
    setPendingAddType(type);
    setGroupDropId(null);
    const definition = WIDGET_REGISTRY[type];
    const size = widgetDefaultSize(type, gridRef.current?.clientWidth ?? window.innerWidth);
    setDropPreview({ x: 0, y: 0, ...size, label: STRINGS[definition.labelKey] });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  // --- Shared move/up on the grid ----------------------------------------
  const onGridPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    // Over the trash the drag is "parked": stop moving geometry so the widget
    // doesn't also get repositioned on the way out, and highlight the zone.
    const trashed = gesture.kind !== "resize" && isOverTrash(event.clientX, event.clientY);
    if (trashed !== overTrash) setOverTrash(trashed);
    if (trashed) {
      if (gesture.kind === "add") gesture.moved = true;
      setDropPreview(null);
      setGroupDropId(null);
      return;
    }

    if (gesture.kind === "move") {
      const { col, row } = cellFromClient(event.clientX - gesture.grabDX, event.clientY - gesture.grabDY);
      const widget = widgetsRef.current.find((w) => w.id === gesture.id);
      if (!widget) return;
      const x = Math.min(col, Math.max(0, LAYOUT_COLUMNS - widget.w));
      // Skip only when the target cell is unchanged. The comparison must use the
      // CLAMPED x, and in push mode the widget's live position is the previewed
      // one, so it is compared against the baseline instead — otherwise the
      // guard sees "already there", stops following the pointer, and leaves the
      // pushed neighbours stranded on top of the dragged widget.
      const reference =
        placementMode === "push"
          ? gestureBaselineRef.current?.find((w) => w.id === gesture.id) ?? widget
          : widget;
      const settledHere =
        reference.x === x && reference.y === row && placementMode !== "push";
      if (!settledHere) {
        setDropPreview({ x, y: row, w: widget.w, h: widget.h, label: STRINGS[WIDGET_REGISTRY[widget.type].labelKey] });
        // In push mode the displaced widgets move out of the way live, so the
        // drop is a confirmation of what is already on screen.
        const nextWidgets =
          placementMode === "push"
            ? (previewPush(gesture.id, { x, y: row }), widgetsRef.current)
            : updatePos(gesture.id, x, row);
        const moved = nextWidgets.find((candidate) => candidate.id === gesture.id);
        setGroupDropId(
          moved && moved.type !== "layoutGroup"
            ? containingGroupId(nextWidgets, moved)
            : null,
        );
      }
    } else if (gesture.kind === "resize") {
      // Edge grips constrain to one axis so a slightly diagonal finger drag
      // can't change the dimension the user isn't aiming at.
      const patch: { w?: number; h?: number } = {};
      if (gesture.edge === "corner" || gesture.edge === "right") {
        const dw = Math.round((event.clientX - gesture.startX) / cellWidthRef.current);
        patch.w = Math.max(1, Math.min(LAYOUT_COLUMNS, gesture.startW + dw));
      }
      if (gesture.edge === "corner" || gesture.edge === "bottom") {
        const dh = Math.round((event.clientY - gesture.startY) / rowHeightRef.current);
        patch.h = Math.max(1, Math.min(LAYOUT_MAX_ROWS, gesture.startH + dh));
      }
      // Growing a widget also makes room live, so the neighbours below reflow
      // while the grip is still held.
      if (placementMode === "push") {
        previewPush(gesture.id, patch);
      } else {
        resizeWidget(gesture.id, patch);
      }
    } else if (gesture.kind === "add") {
      if (
        !gesture.moved &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 6
      ) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      const definition = WIDGET_REGISTRY[gesture.type];
      const size = widgetDefaultSize(gesture.type, gridRef.current?.clientWidth ?? window.innerWidth);
      const { col, row } = cellFromClient(event.clientX, event.clientY);
      const x = Math.min(col, Math.max(0, LAYOUT_COLUMNS - size.w));
      setDropPreview({ x, y: row, ...size, label: STRINGS[definition.labelKey] });
      const candidate: WidgetPlacement = {
        id: ADD_PREVIEW_ID,
        type: gesture.type,
        x,
        y: row,
        ...size,
      };
      // Push preview for a palette drag: insert a phantom placement at the
      // hovered cell so the existing widgets move aside before the drop. The
      // phantom is dropped again on pointer-up and replaced by the real one.
      if (placementMode === "push") {
        const baseline = gestureBaselineRef.current ?? widgetsRef.current;
        commit(
          pushWidgetsDown([...baseline, candidate], ADD_PREVIEW_ID)
            .filter((widget) => widget.id !== ADD_PREVIEW_ID),
        );
        setGroupDropId(containingGroupId(widgetsRef.current, candidate));
        return;
      }
      setGroupDropId(containingGroupId(widgetsRef.current, candidate));
    }
  };

  const onGridPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    const baseline = gestureBaselineRef.current;
    gestureRef.current = null;
    gestureBaselineRef.current = null;
    const droppedOnTrash = overTrash;
    setOverTrash(false);
    setDragId(null);
    setPendingAddType(null);
    setDropPreview(null);
    setGroupDropId(null);
    if (!gesture) return;

    // Trash drop: an existing widget is removed, a palette drag is abandoned.
    // Either way the live push preview is undone by restoring the baseline, so
    // the widgets that moved aside during the drag snap back.
    if (droppedOnTrash && gesture.kind !== "resize") {
      if (baseline) commit(baseline);
      if (gesture.kind === "move") removeWidget(gesture.id);
      return;
    }

    if (gesture.kind === "add") {
      const size = widgetDefaultSize(gesture.type, gridRef.current?.clientWidth ?? window.innerWidth);
      // In push mode the live preview already displaced the other widgets, so
      // the insert has to start from the untouched baseline; otherwise the drop
      // would push them a second time.
      const source = placementMode === "push" && baseline ? baseline : widgetsRef.current;
      const cell = gesture.moved
        ? cellFromClient(event.clientX, event.clientY)
        : { col: 0, row: source.reduce((max, widget) => Math.max(max, widget.y + widget.h), 0) };
      const x = Math.min(cell.col, Math.max(0, LAYOUT_COLUMNS - size.w));
      const added = [
        ...source,
        { id: newWidgetId(gesture.type), type: gesture.type, x, y: cell.row, ...size },
      ];
      commit(settlePlacement(added, added[added.length - 1].id));
    } else if (gesture.kind === "move" || gesture.kind === "resize") {
      // Same reasoning: re-apply the dragged widget's final rectangle onto the
      // baseline and push exactly once.
      if (placementMode === "push" && baseline) {
        const settled = widgetsRef.current.find((widget) => widget.id === gesture.id);
        const rebased = settled
          ? baseline.map((widget) => (widget.id === gesture.id ? settled : widget))
          : baseline;
        commit(settlePlacement(rebased, gesture.id));
        return;
      }
      commit(settlePlacement(widgetsRef.current, gesture.id));
    }
  };

  // Keyboard/no-pointer fallback: append the widget in the first free-ish row.
  const appendWidget = (type: WidgetType) => {
    const size = widgetDefaultSize(type, gridRef.current?.clientWidth ?? window.innerWidth);
    const y = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
    const added = [
      ...widgets,
      { id: newWidgetId(type), type, x: 0, y, ...size },
    ];
    commit(settlePlacement(added, added[added.length - 1].id));
  };

  // The grid needs enough rows to show every widget + a little slack to drop into.
  const gridRows = Math.max(
    6,
    usedRows + 2,
    dropPreview ? dropPreview.y + dropPreview.h + 2 : 0,
  );
  const singleFullHeightMixer = widgets.length === 1 && widgets[0]?.type === "mixer";

  return (
    <div className={`layout-canvas-wrap ${editing ? "is-editing" : ""}`}>
      <LayoutTabBar
        tabs={layout.tabs}
        activeTabId={activeTab?.id ?? layout.activeTabId}
        editing={editing}
        heightRem={tabHeightRem}
        onSelect={selectTab}
        onAdd={addTab}
        onRename={renameTab}
        onDelete={deleteTab}
        onMove={moveTab}
      />
      {editing && paletteOpen ? (
        <WidgetPalette
          onAdd={appendWidget}
          onDragAdd={beginAdd}
          onDragMove={onGridPointerMove}
          onDragEnd={onGridPointerUp}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {editing && !paletteOpen ? (
        <button
          type="button"
          className="layout-palette-open"
          onClick={() => setPaletteOpen(true)}
        >
          + {STRINGS.showWidgetPalette}
        </button>
      ) : null}
      {widgets.length === 0 && !editing ? (
        <div className="layout-canvas-empty">{STRINGS.emptyTab}</div>
      ) : (
        <div
          ref={gridRef}
          className={`layout-canvas ${editing ? "is-editing" : ""} ${pendingAddType ? "is-adding" : ""} ${singleFullHeightMixer ? "is-single-full-height-mixer" : ""}`}
          style={{
            gridTemplateColumns: `repeat(${LAYOUT_COLUMNS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${gridRows}, ${ROW_HEIGHT_PX}px)`,
          }}
          onPointerMove={editing ? onGridPointerMove : undefined}
          onPointerUp={editing ? onGridPointerUp : undefined}
          onPointerCancel={editing ? onGridPointerUp : undefined}
        >
          {widgets.length === 0 && editing ? (
            <div className="layout-canvas-empty layout-canvas-empty-inline">
              {pendingAddType ? STRINGS.dropHere : STRINGS.emptyTab}
            </div>
          ) : null}
          {/* The fold: anything placed below this line needs scrolling on the
              device. Editing-only, and drawn behind the widgets so it never
              intercepts a drag. */}
          {editing && foldRow !== null && foldRow < gridRows ? (
            <div
              className="layout-fold-marker"
              style={{ gridRow: `${foldRow + 1}`, gridColumn: "1 / -1" }}
              aria-hidden="true"
            >
              <span>{STRINGS.foldMarker}</span>
            </div>
          ) : null}
          {editing && dropPreview ? (
            <div
              className="layout-drop-preview"
              style={{
                gridColumn: `${dropPreview.x + 1} / span ${dropPreview.w}`,
                gridRow: `${dropPreview.y + 1} / span ${dropPreview.h}`,
              }}
            >
              <span>{dropPreview.label}</span>
            </div>
          ) : null}
          {[...widgets]
            .sort((a, b) => Number(a.type !== "layoutGroup") - Number(b.type !== "layoutGroup"))
            .map((placement) => (
            <LayoutWidgetHost
              key={placement.id}
              placement={placement}
              editing={editing}
              isDragging={dragId === placement.id}
              isGroupDropTarget={groupDropId === placement.id}
              onRemove={() => removeWidget(placement.id)}
              onConfigure={() => setConfigWidgetId(placement.id)}
              onMovePointerDown={(event) => beginMove(placement.id, event)}
              onResizePointerDown={(event, edge) => beginResize(placement.id, event, edge)}
              onNudgeSize={(axis, delta) => nudgeSize(placement.id, axis, delta)}
            />
          ))}
        </div>
      )}
      {/* Trash zone: only mounted while a move/add drag is in flight, so it
          never covers the canvas at rest. Dropping a placed widget here deletes
          it; dropping a palette drag here abandons the add. Resize drags are
          excluded — there is nothing to cancel, only a size to keep. */}
      {editing && (dragId || pendingAddType) ? (
        <div
          ref={trashRef}
          className={`layout-trash ${overTrash ? "is-armed" : ""}`}
          role="button"
          aria-label={pendingAddType ? STRINGS.cancelDrag : STRINGS.dropToRemove}
        >
          <span className="layout-trash-icon" aria-hidden="true">🗑</span>
          <span>{pendingAddType ? STRINGS.cancelDrag : STRINGS.dropToRemove}</span>
        </div>
      ) : null}
      {editing && configWidgetId ? (() => {
        const placement = widgets.find((widget) => widget.id === configWidgetId);
        return placement ? (
          <DesignWidgetConfigDialog
            placement={placement}
            onChange={(config) => updateWidgetConfig(placement.id, config)}
            onClose={() => setConfigWidgetId(null)}
          />
        ) : null;
      })() : null}
    </div>
  );
}

export function App() {
  useRemoteBridge();
  const [sizeLevel, setSizeLevel] = useState(readRemoteSizeLevel);
  const presetProfile = currentLayoutPresetProfile();
  const [layout, setLayout] = useState<RemoteLayout>(() => {
    const stored = readStoredLayout();
    const controls = stored.tabs.find((tab) => tab.name === "Controles") ?? stored.tabs[0];
    // Both the current preset and the previous one (which had no standalone
    // jumpToSongButton row) count as "untouched", so a user who never edited
    // their layout regenerates onto the new shape instead of silently losing
    // the "Saltar a canción" button that used to live inside the region deck.
    const controlsPresetShapes = [
      ["readouts", "transportButtons", "timeline", "controlDeck", "jumpToSongButton", "markerGrid"],
      ["readouts", "transportButtons", "timeline", "controlDeck", "markerGrid"],
    ] as const;
    const isUntouchedControlsPreset =
      stored.customized !== true &&
      controlsPresetShapes.some(
        (shape) =>
          controls?.widgets.length === shape.length &&
          shape.every((type, index) => controls.widgets[index]?.type === type),
      );
    // Not just "is it there" but "is it where this preset puts it": an earlier
    // build gave the button a full-width row of its own on every profile, and
    // an untouched layout from that build should regenerate onto the current
    // shape (beside the deck on roomy screens) rather than keep the old row.
    const expectedJump = defaultLayout(presetProfile).tabs[0].widgets.find(
      (widget) => widget.type === "jumpToSongButton",
    );
    const storedJump = (controls?.widgets ?? []).find(
      (widget) => widget.type === "jumpToSongButton",
    );
    const hasJumpToSongPreset =
      storedJump !== undefined &&
      expectedJump !== undefined &&
      storedJump.x === expectedJump.x &&
      storedJump.w === expectedJump.w;
    const presetWidgetTypes = new Set(stored.tabs.flatMap((tab) => tab.widgets.map((widget) => widget.type)));
    const storedMetronome = stored.tabs
      .flatMap((tab) => tab.widgets)
      .find((widget) => widget.type === "metronomeSettings");
    const storedPads = stored.tabs
      .flatMap((tab) => tab.widgets)
      .find((widget) => widget.type === "pads");
    // The height checks make an untouched preset that predates a widget
    // growing (new control added) regenerate instead of clipping its content.
    const hasToolsPreset =
      presetWidgetTypes.has("pads") &&
      presetWidgetTypes.has("metronomeSettings") &&
      presetWidgetTypes.has("voiceGuideSettings") &&
      storedMetronome?.h === DEFAULT_METRONOME_WIDGET_HEIGHT &&
      storedPads?.h === DEFAULT_PADS_WIDGET_HEIGHT;
    if (
      isUntouchedControlsPreset &&
      (stored.presetProfile !== presetProfile || !hasToolsPreset || !hasJumpToSongPreset)
    ) {
      return defaultLayout(presetProfile);
    }
    return stored;
  });
  const [editing, setEditing] = useState(false);
  // Snapshot of the layout taken when edit mode opens, so "Cancel" can revert
  // every change made during the session. null when not editing.
  const editBaselineRef = useRef<RemoteLayout | null>(null);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  // Both editor preferences are rendered by the header toolbar but consumed by
  // the canvas, so they are read from the layout here as well.
  const placementMode: LayoutPlacementMode = layout.placementMode ?? "free";
  const tabHeightRem = clampTabHeight(layout.tabHeightRem);

  useEffect(() => {
    window.localStorage.setItem(REMOTE_SIZE_STORAGE_KEY, String(sizeLevel));
  }, [sizeLevel]);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const updateLayout = useCallback((next: RemoteLayout) => {
    setLayout(next);
    writeStoredLayout(next);
  }, []);

  const startEditing = useCallback(() => {
    editBaselineRef.current = layout;
    setEditing(true);
  }, [layout]);

  const finishEditing = useCallback(() => {
    editBaselineRef.current = null;
    setEditing(false);
  }, []);

  // Cancel: restore the layout as it was when editing started, persist that,
  // and leave edit mode. Discards every move/resize/add/tab change since.
  const cancelEditing = useCallback(() => {
    const baseline = editBaselineRef.current;
    if (baseline) {
      setLayout(baseline);
      writeStoredLayout(baseline);
    }
    editBaselineRef.current = null;
    setEditing(false);
  }, []);

  const resetLayout = useCallback(() => {
    const fresh = defaultLayout(currentLayoutPresetProfile());
    clearStoredLayout();
    setLayout(fresh);
  }, []);

  // Export the current layout as a JSON file so it can be carried to another
  // device (AirDrop / email / USB) and imported there. Uses a Blob + object
  // URL download, which works in any tablet/phone browser without native APIs.
  const exportLayout = useCallback(() => {
    try {
      const blob = new Blob([serializeLayoutFile(layout)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = layoutExportFilename();
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Download blocked — nothing else we can do from the browser sandbox.
    }
  }, [layout]);

  const onImportFileChosen = useCallback(
    async (event: ReactChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      // Reset the input so choosing the same file again re-fires change.
      event.currentTarget.value = "";
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const imported = parseLayoutFile(text);
        setLayout(imported);
        writeStoredLayout(imported);
      } catch {
        window.alert(STRINGS.importFailed);
      }
    },
    [],
  );

  return (
    <main
      className={`remote-shell remote-profile-${presetProfile} remote-size-${sizeLevel} ${sizeLevel > 0 ? "is-large-controls" : ""} ${editing ? "is-editing-layout" : ""}`}
    >
      {/* Phones in landscape are too short to fit the transport view; the CSS
          media query (orientation:landscape + short height) reveals this
          overlay and hides the shell content, prompting a rotate to portrait.
          Tablets (taller in landscape) are unaffected. */}
      <div className="rotate-guard" role="alertdialog" aria-label={STRINGS.rotateTitle}>
        <div className="rotate-guard-icon" aria-hidden="true">↻</div>
        <strong>{STRINGS.rotateTitle}</strong>
        <span>{STRINGS.rotateBody}</span>
      </div>

      <header className="remote-header">
        <div className="remote-header-brand">
          <small>LibreTracks</small>
          <h1>{STRINGS.appTitle}</h1>
        </div>
        {/* Edit actions live in the header's centre gap. Previously they sat in
            their own bar below, which overlapped the tab strip on a tablet. */}
        {editing ? (
          <div className="layout-edit-toolbar">
            <button type="button" className="layout-edit-done" onClick={finishEditing}>
              ✓ {STRINGS.doneEditing}
            </button>
            <button type="button" className="layout-edit-cancel" onClick={cancelEditing}>
              {STRINGS.cancelEditing}
            </button>
            <button
              type="button"
              className={`layout-placement-toggle ${placementMode === "push" ? "is-active" : ""}`}
              role="switch"
              aria-checked={placementMode === "push"}
              title={placementMode === "push" ? STRINGS.placementPushHint : STRINGS.placementFreeHint}
              onClick={() =>
                updateLayout({
                  ...layout,
                  placementMode: placementMode === "push" ? "free" : "push",
                })
              }
            >
              <span aria-hidden="true">{placementMode === "push" ? "⇵" : "✥"}</span>
              {placementMode === "push" ? STRINGS.placementPush : STRINGS.placementFree}
            </button>
            {/* Tab strip height: the tabs are the one piece of chrome the widget
                grid can't resize, and the default is a small target on glass. */}
            <div className="layout-tab-height" role="group" aria-label={STRINGS.tabHeight}>
              <span aria-hidden="true">⇕</span>
              <button
                type="button"
                aria-label={STRINGS.shorterTabs}
                disabled={tabHeightRem <= TAB_HEIGHT_MIN_REM}
                onClick={() => updateLayout({ ...layout, tabHeightRem: clampTabHeight(tabHeightRem - 0.3) })}
              >
                −
              </button>
              <button
                type="button"
                aria-label={STRINGS.tallerTabs}
                disabled={tabHeightRem >= TAB_HEIGHT_MAX_REM}
                onClick={() => updateLayout({ ...layout, tabHeightRem: clampTabHeight(tabHeightRem + 0.3) })}
              >
                +
              </button>
            </div>
            <div className="layout-edit-toolbar-actions">
              <button type="button" className="layout-reset-button" onClick={exportLayout}>
                {STRINGS.exportLayout}
              </button>
              <button
                type="button"
                className="layout-reset-button"
                onClick={() => importInputRef.current?.click()}
              >
                {STRINGS.importLayout}
              </button>
              <button type="button" className="layout-reset-button" onClick={resetLayout}>
                {STRINGS.resetLayout}
              </button>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="layout-import-input"
              onChange={onImportFileChosen}
            />
          </div>
        ) : null}
        <div className="status-pill">
          {snapshot?.playbackState ? STRINGS[snapshot.playbackState] : STRINGS.idle}
        </div>
        {/* Only the entry point lives here. While editing, the toolbar's own
            "Done" is the single way out — two of them read as two actions. */}
        {editing ? null : (
          <button
            type="button"
            className="layout-edit-button"
            aria-pressed={false}
            onClick={startEditing}
          >
            {STRINGS.editLayout}
          </button>
        )}
        <div className="remote-size-stepper" role="group" aria-label={STRINGS.size}>
          <button
            type="button"
            aria-label={STRINGS.compact}
            disabled={sizeLevel === 0}
            onClick={() => setSizeLevel((current) => Math.max(0, current - 1))}
          >
            -
          </button>
          <span>{sizeLevel + 1}</span>
          <button
            type="button"
            className={sizeLevel > 0 ? "is-active" : ""}
            aria-label={STRINGS.large}
            disabled={sizeLevel === MAX_REMOTE_SIZE_LEVEL}
            onClick={() => setSizeLevel((current) => Math.min(MAX_REMOTE_SIZE_LEVEL, current + 1))}
          >
            +
          </button>
        </div>
      </header>

      <div className="remote-content">
        <LayoutCanvas layout={layout} editing={editing} onChange={updateLayout} />
      </div>
    </main>
  );
}
