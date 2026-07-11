import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import {
  buildSongTempoRegions,
  getSongRegionAtPosition,
  getSongTempoRegionAtPosition,
  formatTransposeSemitones,
  markerColor,
  markerKindCategory,
  regionEffectiveKey,
  type AppSettings,
  type AudioMeterLevel,
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
  TRACK_FADER_SCALE,
  faderTicks,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";
import { getRemoteStrings } from "./i18n";
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
  LAYOUT_COLUMNS,
  LAYOUT_MAX_ROWS,
  clearStoredLayout,
  defaultLayout,
  layoutExportFilename,
  makeEmptyTab,
  newWidgetId,
  parseLayoutFile,
  readStoredLayout,
  serializeLayoutFile,
  writeStoredLayout,
  type LayoutTab,
  type RemoteLayout,
  type WidgetPlacement,
  type WidgetType,
} from "./remoteLayout";
import {
  bpmForRegion,
  clipsForRegion,
  formatBpm,
  keyForRegion,
  type SongClipEntry,
} from "./songWidgets";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type JumpMode = "immediate" | "next_marker" | "after_bars";
type SongJumpTrigger = "immediate" | "region_end" | "after_bars";
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
  meters: Record<string, AudioMeterLevel>;
  snapshotReceivedAtMs: number;
  setSnapshot: (snapshot: TransportSnapshot) => void;
  setSongView: (songView: SongView | null) => void;
  setSettings: (settings: AppSettings) => void;
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
    meters: {},
    snapshotReceivedAtMs: performance.now(),
    setSnapshot: (snapshot) => {
      set({ snapshot, snapshotReceivedAtMs: performance.now() });
    },
    setSongView: (songView) => {
      set({ songView });
    },
    setSettings: (settings) => {
      set({ settings });
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
  /** Marker ids hidden from the jump grid, mirrored to localStorage. */
  hiddenMarkerIds: Set<string>;
  /** Whether hidden markers are temporarily revealed (dimmed) for restoring. */
  revealHiddenMarkers: boolean;
  setSelectedRegionId: (regionId: string | null) => void;
  setActivePanel: (panel: RemotePanelKey | null) => void;
  toggleActivePanel: (panel: RemotePanelKey) => void;
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
  hiddenMarkerIds: readHiddenMarkerIds(),
  revealHiddenMarkers: false,
  setSelectedRegionId: (selectedRegionId) => {
    set({ selectedRegionId });
  },
  setActivePanel: (activePanel) => {
    set({ activePanel });
  },
  toggleActivePanel: (panel) => {
    set((state) => ({ activePanel: state.activePanel === panel ? null : panel }));
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
  sendCommand({
    cmd: "updateSettings",
    settings,
  });
}

/**
 * Schedule a jump to a song region honouring the project's global song-jump
 * config (trigger + transition), read from the jump store. Shared by the
 * control deck and the song-header widget so "play this song" behaves the same
 * everywhere — same path the desktop compact view's per-song play uses.
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

function resolveLivePosition(snapshot: TransportSnapshot | null, receivedAtMs: number) {
  if (!snapshot) {
    return 0;
  }

  const transportClock = snapshot.transportClock;
  if (snapshot.playbackState === "playing" && transportClock?.running) {
    const playbackRate =
      Number.isFinite(transportClock.playbackRate) && transportClock.playbackRate !== undefined
        ? Math.max(0, transportClock.playbackRate)
        : 1;
    return Math.max(
      0,
      transportClock.anchorPositionSeconds + ((performance.now() - receivedAtMs) / 1000) * playbackRate,
    );
  }

  return Math.max(0, snapshot.positionSeconds);
}

function useTransportReadout(): TransportReadout {
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshotReceivedAtMs = useRemoteSyncStore((state) => state.snapshotReceivedAtMs);
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
  const snapshotReceivedAtMsRef = useRef(snapshotReceivedAtMs);
  const lastReadoutCommitAtRef = useRef(0);

  useEffect(() => {
    snapshotRef.current = snapshot;
    songViewRef.current = songView;
    timelineRegionsRef.current = timelineRegions;
    snapshotReceivedAtMsRef.current = snapshotReceivedAtMs;
  }, [snapshot, songView, snapshotReceivedAtMs, timelineRegions]);

  useEffect(() => {
    let frameId = 0;

    const render = () => {
      const currentSnapshot = snapshotRef.current;
      const currentSongView = songViewRef.current;
      const currentTimelineRegions = timelineRegionsRef.current;
      const currentSnapshotReceivedAtMs = snapshotReceivedAtMsRef.current;
      const positionSeconds = resolveLivePosition(currentSnapshot, currentSnapshotReceivedAtMs);
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

      const isPlaying = currentSnapshot?.playbackState === "playing" && currentSnapshot.transportClock?.running === true;
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
  snapshotReceivedAtMs,
  pendingJumpTargetId,
}: {
  songView: SongView | null;
  snapshot: TransportSnapshot | null;
  snapshotReceivedAtMs: number;
  pendingJumpTargetId: string | null;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef(snapshot);
  const snapshotReceivedAtMsRef = useRef(snapshotReceivedAtMs);
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
    manualCenterSeconds ?? resolveLivePosition(snapshot, snapshotReceivedAtMs);
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
  const visibleSectionMarkers = useMemo(
    () =>
      markers.filter(
        (marker) =>
          // Dynamic cues (Build, All In, ...) are not navigation targets; the
          // remote only shows sections, so the cinta stays uncluttered on stage.
          markerKindCategory(marker.kind) === "section" &&
          marker.startSeconds >= renderWindowStartSeconds - viewportDurationSeconds * 0.25 &&
          marker.startSeconds <= renderWindowEndSeconds + viewportDurationSeconds * 0.25,
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
    snapshotReceivedAtMsRef.current = snapshotReceivedAtMs;

    if (timelineDebugEnabled && snapshot) {
      debugStatsRef.current.snapshotCount += 1;
    }
  }, [snapshot, snapshotReceivedAtMs]);

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
      const currentSnapshot = snapshotRef.current;
      const repositionToken = getTransportRepositionToken(currentSnapshot);
      const explicitTransportReposition = repositionToken !== lastTransportRepositionTokenRef.current;
      const rawPositionSeconds = resolveLivePosition(currentSnapshot, snapshotReceivedAtMsRef.current);
      const isPlaying = currentSnapshot?.playbackState === "playing" && currentSnapshot.transportClock?.running === true;
      const lastFrameAtMs = lastFrameAtMsRef.current;
      const deltaSeconds = lastFrameAtMs === null ? 0 : Math.min(0.05, Math.max(0, frameAtMs - lastFrameAtMs) / 1000);
      lastFrameAtMsRef.current = frameAtMs;

      if (explicitTransportReposition) {
        lastTransportRepositionTokenRef.current = repositionToken;
      }

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
    lastManualInteractionAtRef.current = performance.now();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragLastClientXRef.current;
    dragLastClientXRef.current = event.clientX;
    // Dragging right reveals earlier content (offset grows), left reveals the
    // future. The rAF loop clamps the final translate to the content bounds.
    manualOffsetRef.current += deltaX;
    lastManualInteractionAtRef.current = performance.now();
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }
    dragPointerIdRef.current = null;
    // Start the hold countdown from release so the peeked view lingers.
    lastManualInteractionAtRef.current = performance.now();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      ref={shellRef}
      className="timeline-shell timeline-shell-shared"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
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
          {visibleSectionMarkers.map((marker) => (
            <span
              key={`marker-${marker.id}`}
              className={`timeline-marker timeline-marker-mini ${pendingJumpTargetId === marker.id ? "is-target" : ""}`}
              style={{
                left: `${secondsToAbsoluteX(marker.startSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px`,
                // Tint the marker with its kind/custom colour so the remote
                // reads the same as the desktop timeline.
                "--marker-color": markerColor(marker),
              } as CSSProperties}
            >
              {marker.name}
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
      {/* Click + Voice guide share the last transport slot as a split control. */}
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

/**
 * Section markers navigable from the remote — dynamic cues (Build, All In, ...)
 * are spoken by the voice guide, not jump destinations, so they're excluded.
 */
function useSectionMarkers() {
  const songView = useRemoteSyncStore((state) => state.songView);
  return (songView?.sectionMarkers ?? []).filter(
    (marker) => markerKindCategory(marker.kind) === "section",
  );
}

/** Which slice of the control deck to render. Undefined = the whole deck. */
type ControlDeckSection = "vamp" | "jump" | "song" | "region";

/**
 * The control deck: Vamp/Loop, Jump config, Song transition, the region
 * carousel with transpose, and the inline settings sheets. Reads its shared UI
 * state (selected region, open panel) from `useRemoteUiStore` and its jump
 * config from `useRemoteJumpStore`. With no `section` it renders the whole deck
 * (the composite widget); with a `section` it renders just that card + its
 * inline settings sheet, so each slice can be placed as its own widget. The
 * shared sync effects/handlers run either way, so behaviour is identical.
 */
function ControlDeck({ section }: { section?: ControlDeckSection } = {}) {
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
  const setActivePanel = useRemoteUiStore((state) => state.setActivePanel);
  const toggleActivePanel = useRemoteUiStore((state) => state.toggleActivePanel);

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

  const scheduleRegionJump = scheduleRegionJumpFromStore;

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
    activePanel !== null && (!section || section === activePanel);

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
              className={`group-settings-button ${activePanel === "vamp" ? "is-active" : ""}`}
              aria-expanded={activePanel === "vamp"}
              onClick={() => toggleActivePanel("vamp")}
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
              className={`group-settings-button ${activePanel === "jump" ? "is-active" : ""}`}
              aria-expanded={activePanel === "jump"}
              onClick={() => toggleActivePanel("jump")}
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
              className={`group-settings-button ${activePanel === "song" ? "is-active" : ""}`}
              aria-expanded={activePanel === "song"}
              onClick={() => toggleActivePanel("song")}
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
                <button
                  className="jump-cancel-button region-jump-button"
                  onClick={() => scheduleRegionJump(selectedRegion.id)}
                >
                  {STRINGS.jumpToSong}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        ) : null}

        {showPanel ? (
          <div
            className="remote-inline-panel"
            role="dialog"
            aria-label={STRINGS.settings}
          >
            {/* Close button — only visible when the panel is presented as a
                bottom sheet (phone / short-height); on wider screens it stays
                an in-flow panel and the CSS hides this affordance. */}
            <button
              type="button"
              className="remote-inline-panel-close"
              aria-label={STRINGS.close}
              onClick={() => setActivePanel(null)}
            >
              ×
            </button>
            {activePanel === "jump" ? renderJumpControls() : null}
            {activePanel === "vamp" ? renderVampControls() : null}
            {activePanel === "song" ? renderSongControls() : null}
          </div>
        ) : null}
      </div>
  );
}

/**
 * The jump grid: one card per section marker in the selected region, plus the
 * "show hidden" affordance. Schedules/cancels marker jumps and toggles
 * per-marker visibility. Reads selected region and hidden-marker state from
 * `useRemoteUiStore`, so it's an autonomous layout widget. Behaviour is
 * unchanged from the former inline TransportView block.
 */
function MarkerGrid() {
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

  const markers = useSectionMarkers();
  const regions = songView?.regions ?? [];
  const pendingJump = snapshot?.pendingMarkerJump ?? null;

  const selectedRegion =
    regions.find((region) => region.id === selectedRegionId) ??
    regions[0] ??
    null;
  const visibleMarkers = selectedRegion
    ? markers.filter(
        (marker) =>
          marker.startSeconds >= selectedRegion.startSeconds &&
          marker.startSeconds <= selectedRegion.endSeconds,
      )
    : markers;
  // The markers hidden by the user within the current region — drives the
  // "show hidden (N)" affordance. When revealing, hidden cards render dimmed
  // with a restore button; otherwise they're filtered out entirely.
  const hiddenVisibleMarkers = visibleMarkers.filter((marker) =>
    hiddenMarkerIds.has(marker.id),
  );
  const shownMarkers = revealHiddenMarkers
    ? visibleMarkers
    : visibleMarkers.filter((marker) => !hiddenMarkerIds.has(marker.id));

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

      <div className="marker-grid">
        {shownMarkers.map((marker) => {
          const isHidden = hiddenMarkerIds.has(marker.id);
          return (
            <div
              key={marker.id}
              className={`marker-card ${pendingJumpTargetId === marker.id ? "is-pending" : ""} ${isHidden ? "is-hidden-marker" : ""}`}
              style={{ "--marker-color": markerColor(marker) } as CSSProperties}
            >
              <button
                type="button"
                className="marker-card-jump"
                onClick={() => {
                  if (pendingJump?.targetMarkerId === marker.id) {
                    cancelJump();
                    return;
                  }

                  scheduleJump(marker.id);
                }}
              >
                <strong>{marker.name}</strong>
                <span>{formatTimecode(marker.startSeconds)}</span>
                <em>{formatJumpModeLabel(jumpMode, jumpBars)}</em>
              </button>
              <button
                type="button"
                className="marker-card-hide"
                aria-label={
                  isHidden ? STRINGS.showMarker : STRINGS.hideMarker
                }
                title={isHidden ? STRINGS.showMarker : STRINGS.hideMarker}
                onClick={() => toggleMarkerHidden(marker.id)}
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
        <strong>{track.name}</strong>
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
      const { snapshot, snapshotReceivedAtMs } = useRemoteSyncStore.getState();
      const positionSeconds = resolveLivePosition(snapshot, snapshotReceivedAtMs);
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
}: {
  region: SongRegionSummary;
  bpm: number;
  isActive: boolean;
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
          onClick={() => scheduleRegionJumpFromStore(region.id)}
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
  const [scope, setScope] = useSongScope("libretracks.remote.songHeaderScope");
  const activeRegionId = useActiveRegionId();
  const regions = songView?.regions ?? [];
  const activeReg = regions.find((region) => region.id === activeRegionId) ?? null;

  const shown = scope === "all" ? regions : activeReg ? [activeReg] : [];

  return (
    <div className="song-header-widget">
      <div className="song-widget-head">
        <span className="song-widget-title">{STRINGS.widgetSongHeader}</span>
        <SongScopeToggle scope={scope} onChange={setScope} />
      </div>
      {shown.length === 0 ? (
        <div className="song-widget-empty">{STRINGS.songNoActive}</div>
      ) : (
        <div className={`song-header-columns ${scope === "all" ? "is-all" : ""}`}>
          {shown.map((region) => (
            <SongHeaderColumn
              key={region.id}
              region={region}
              bpm={bpmForRegion(songView, region)}
              isActive={region.id === activeRegionId}
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
          <span className="clip-entry-track" title={clip.trackName}>
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
  const songView = useRemoteSyncStore((state) => state.songView);
  const [scope, setScope] = useSongScope("libretracks.remote.clipListScope");
  const activeRegionId = useActiveRegionId();
  const regions = songView?.regions ?? [];
  const activeReg = regions.find((region) => region.id === activeRegionId) ?? null;

  const shown = scope === "all" ? regions : activeReg ? [activeReg] : [];

  return (
    <div className="clip-list-widget">
      <div className="song-widget-head">
        <span className="song-widget-title">{STRINGS.widgetClipList}</span>
        <SongScopeToggle scope={scope} onChange={setScope} />
      </div>
      {shown.length === 0 ? (
        <div className="song-widget-empty">{STRINGS.songNoActive}</div>
      ) : (
        <div className={`clip-list-groups ${scope === "all" ? "is-all" : ""}`}>
          {shown.map((region) => (
            <div key={region.id} className="clip-list-group">
              {scope === "all" ? (
                <div className="clip-list-group-title" title={region.name}>
                  {region.name}
                </div>
              ) : null}
              <ClipStack clips={clipsForRegion(songView, region)} />
            </div>
          ))}
        </div>
      )}
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

/** The scrolling timeline (cinta) as a standalone widget. */
function TimelineWidget() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const snapshotReceivedAtMs = useRemoteSyncStore((state) => state.snapshotReceivedAtMs);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
  return (
    <div className="timeline-widget-host">
      <SharedTimeline
        songView={songView}
        snapshot={snapshot}
        snapshotReceivedAtMs={snapshotReceivedAtMs}
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
    const { snapshot, songView, snapshotReceivedAtMs } = useRemoteSyncStore.getState();
    return { snapshot, songView, snapshotReceivedAtMs };
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
  Component: () => ReactElement;
  /** Default column span when added from the palette. */
  defaultW: number;
  defaultH: number;
};

// Binds every WidgetType to its component + palette metadata. The single source
// of truth the canvas and the (Fase 2c) editor palette both read.
const WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition> = {
  readouts: { labelKey: "widgetReadouts", Component: ReadoutsWidget, defaultW: LAYOUT_COLUMNS, defaultH: 4 },
  readoutTime: { labelKey: "widgetReadoutTime", Component: ReadoutTimeWidget, defaultW: 8, defaultH: 4 },
  readoutBar: { labelKey: "widgetReadoutBar", Component: ReadoutBarWidget, defaultW: 8, defaultH: 4 },
  readoutBpm: { labelKey: "widgetReadoutBpm", Component: ReadoutBpmWidget, defaultW: 8, defaultH: 4 },
  readoutSignature: { labelKey: "widgetReadoutSignature", Component: ReadoutSignatureWidget, defaultW: 8, defaultH: 4 },
  readoutSong: { labelKey: "widgetReadoutSong", Component: ReadoutSongWidget, defaultW: 8, defaultH: 4 },
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
  markerGrid: { labelKey: "widgetMarkers", Component: MarkerGrid, defaultW: LAYOUT_COLUMNS, defaultH: 12 },
  mixer: { labelKey: "widgetMixer", Component: MixerView, defaultW: LAYOUT_COLUMNS, defaultH: 28 },
  mixerSongFilter: { labelKey: "widgetMixerSongFilter", Component: MixerSongFilterWidget, defaultW: 8, defaultH: 4 },
  mixerSongMaster: { labelKey: "widgetMixerSongMaster", Component: MixerSongMasterWidget, defaultW: 16, defaultH: 4 },
  mixerFaders: { labelKey: "widgetMixerFaders", Component: MixerFadersWidget, defaultW: LAYOUT_COLUMNS, defaultH: 24 },
  songHeader: { labelKey: "widgetSongHeader", Component: SongHeaderWidget, defaultW: LAYOUT_COLUMNS, defaultH: 4 },
  clipList: { labelKey: "widgetClipList", Component: ClipListWidget, defaultW: LAYOUT_COLUMNS, defaultH: 8 },
  nextMarker: { labelKey: "widgetNextMarker", Component: NextMarkerWidgetHost, defaultW: 4, defaultH: 4 },
  nextSong: { labelKey: "widgetNextSong", Component: NextSongWidgetHost, defaultW: 4, defaultH: 4 },
  currentKey: { labelKey: "widgetKey", Component: CurrentKeyWidgetHost, defaultW: 4, defaultH: 4 },
  progressMarker: { labelKey: "widgetProgressMarker", Component: ProgressToMarkerWidgetHost, defaultW: 4, defaultH: 4 },
  progressSong: { labelKey: "widgetProgressSong", Component: ProgressToSongWidgetHost, defaultW: 4, defaultH: 4 },
  countdownMarkerBars: { labelKey: "widgetCountdownMarker", Component: CountdownMarkerBarsHost, defaultW: 4, defaultH: 4 },
  countdownSongTime: { labelKey: "widgetCountdownSong", Component: CountdownSongTimeHost, defaultW: 4, defaultH: 4 },
};

/** Fixed pixel height of one grid row in the absolute (X/Y) layout. The grid
 * uses fixed-height rows so a widget's row-span maps to a predictable size and
 * drag math stays simple. */
const ROW_HEIGHT_PX = 18;
const GRID_GAP_PX = 2;

/**
 * Renders one placed widget at its absolute grid cell (x/y, w/h). In edit mode
 * the whole top chrome is the move handle and a corner grip resizes it; both
 * only emit pointer-down — the canvas owns the move/resize math (it knows the
 * grid geometry). The chrome only contains move/remove actions: dimensions are
 * changed directly with the corner grip.
 */
function LayoutWidgetHost({
  placement,
  editing,
  onRemove,
  onMovePointerDown,
  onResizePointerDown,
  isDragging,
}: {
  placement: WidgetPlacement;
  editing: boolean;
  onRemove: () => void;
  onMovePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  isDragging: boolean;
}) {
  const definition = WIDGET_REGISTRY[placement.type];
  if (!definition) {
    return null;
  }
  const { Component } = definition;

  return (
    <div
      className={`layout-widget layout-widget-type-${placement.type} ${editing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""}`}
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
            aria-label={`${STRINGS.moveWidget}: ${STRINGS[definition.labelKey]}`}
            onPointerDown={onMovePointerDown}
          >
            <span className="layout-widget-title">⠿ {STRINGS[definition.labelKey]}</span>
          </div>
          <div className="layout-widget-sizers">
            <button type="button" className="layout-widget-remove" onClick={onRemove}>
              {STRINGS.removeWidget}
            </button>
          </div>
        </div>
      ) : null}
      <div className={`layout-widget-body ${editing ? "is-inert" : ""}`}>
        <Component />
      </div>
      {editing ? (
        <div
          className="layout-widget-resize"
          role="button"
          aria-label={`${STRINGS.resizeWidget}: ${STRINGS[definition.labelKey]}`}
          onPointerDown={onResizePointerDown}
        />
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
  onClose,
}: {
  onAdd: (type: WidgetType) => void;
  onDragAdd: (type: WidgetType, event: ReactPointerEvent<HTMLElement>) => void;
  onClose: () => void;
}) {
  return (
    <div className="layout-palette" role="group" aria-label={STRINGS.addWidget}>
      <button type="button" className="layout-palette-close" onClick={onClose}>
        × {STRINGS.hideWidgetPalette}
      </button>
      {(Object.keys(WIDGET_REGISTRY) as WidgetType[]).map((type) => (
        <button
          key={type}
          type="button"
          className="layout-palette-item"
          onPointerDown={(event) => onDragAdd(type, event)}
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
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
}: {
  tabs: LayoutTab[];
  activeTabId: string;
  editing: boolean;
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
    <div className="layout-tabbar" role="tablist" aria-label={STRINGS.tabs}>
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
    | { kind: "resize"; id: string; startX: number; startY: number; startW: number; startH: number }
    | { kind: "add"; type: WidgetType };
  const gestureRef = useRef<Gesture | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingAddType, setPendingAddType] = useState<WidgetType | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [dropPreview, setDropPreview] = useState<{
    x: number; y: number; w: number; h: number; label: string;
  } | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellWidthRef = useRef(0);
  const rowHeightRef = useRef(ROW_HEIGHT_PX + GRID_GAP_PX);

  const activeTab =
    layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0];
  const widgets = activeTab?.widgets ?? [];

  // Measure the column width from the grid so pointer coordinates map to cells.
  useEffect(() => {
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      cellWidthRef.current = Math.max(1, (el.clientWidth + GRID_GAP_PX) / LAYOUT_COLUMNS);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !gridRef.current) {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, [activeTab?.id]);

  // Replace the active tab's widgets, keeping every other tab untouched.
  const commit = (nextWidgets: WidgetPlacement[]) => {
    if (!activeTab) return;
    onChange({
      ...layout,
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
    commit(widgets.filter((widget) => widget.id !== id));
  };

  const resizeWidget = (id: string, patch: { w?: number; h?: number }) => {
    commit(
      widgets.map((widget) =>
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

  const updatePos = (id: string, x: number, y: number) => {
    commit(
      widgets.map((widget) => (widget.id === id ? { ...widget, x, y } : widget)),
    );
  };

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
    const widget = widgets.find((w) => w.id === id);
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
    setDragId(id);
    setDropPreview({ x: widget.x, y: widget.y, w: widget.w, h: widget.h, label: STRINGS[WIDGET_REGISTRY[widget.type].labelKey] });
    gridRef.current?.setPointerCapture?.(event.pointerId);
  };

  const beginResize = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    const widget = widgets.find((w) => w.id === id);
    if (!widget) return;
    event.stopPropagation();
    gestureRef.current = {
      kind: "resize",
      id,
      startX: event.clientX,
      startY: event.clientY,
      startW: widget.w,
      startH: widget.h,
    };
    setDragId(id);
    gridRef.current?.setPointerCapture?.(event.pointerId);
  };

  const beginAdd = (type: WidgetType, event: ReactPointerEvent<HTMLElement>) => {
    gestureRef.current = { kind: "add", type };
    setPendingAddType(type);
    const definition = WIDGET_REGISTRY[type];
    setDropPreview({ x: 0, y: 0, w: definition.defaultW, h: definition.defaultH, label: STRINGS[definition.labelKey] });
    gridRef.current?.setPointerCapture?.(event.pointerId);
  };

  // --- Shared move/up on the grid ----------------------------------------
  const onGridPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.kind === "move") {
      const { col, row } = cellFromClient(event.clientX - gesture.grabDX, event.clientY - gesture.grabDY);
      const widget = widgets.find((w) => w.id === gesture.id);
      if (widget && (widget.x !== col || widget.y !== row)) {
        const maxX = LAYOUT_COLUMNS - widget.w;
        const x = Math.min(col, Math.max(0, maxX));
        setDropPreview({ x, y: row, w: widget.w, h: widget.h, label: STRINGS[WIDGET_REGISTRY[widget.type].labelKey] });
        updatePos(gesture.id, x, row);
      }
    } else if (gesture.kind === "resize") {
      const dw = Math.round((event.clientX - gesture.startX) / cellWidthRef.current);
      const dh = Math.round((event.clientY - gesture.startY) / rowHeightRef.current);
      const nextW = Math.max(1, Math.min(LAYOUT_COLUMNS, gesture.startW + dw));
      const nextH = Math.max(1, Math.min(LAYOUT_MAX_ROWS, gesture.startH + dh));
      resizeWidget(gesture.id, { w: nextW, h: nextH });
    } else if (gesture.kind === "add") {
      const definition = WIDGET_REGISTRY[gesture.type];
      const { col, row } = cellFromClient(event.clientX, event.clientY);
      const x = Math.min(col, Math.max(0, LAYOUT_COLUMNS - definition.defaultW));
      setDropPreview({ x, y: row, w: definition.defaultW, h: definition.defaultH, label: STRINGS[definition.labelKey] });
    }
  };

  const onGridPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragId(null);
    setPendingAddType(null);
    setDropPreview(null);
    if (!gesture) return;
    if (gesture.kind === "add") {
      const definition = WIDGET_REGISTRY[gesture.type];
      const { col, row } = cellFromClient(event.clientX, event.clientY);
      const x = Math.min(col, Math.max(0, LAYOUT_COLUMNS - definition.defaultW));
      commit([
        ...widgets,
        { id: newWidgetId(gesture.type), type: gesture.type, x, y: row, w: definition.defaultW, h: definition.defaultH },
      ]);
    }
  };

  // Keyboard/no-pointer fallback: append the widget in the first free-ish row.
  const appendWidget = (type: WidgetType) => {
    const definition = WIDGET_REGISTRY[type];
    const y = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
    commit([
      ...widgets,
      { id: newWidgetId(type), type, x: 0, y, w: definition.defaultW, h: definition.defaultH },
    ]);
  };

  // The grid needs enough rows to show every widget + a little slack to drop into.
  const gridRows = Math.max(
    6,
    widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0) + 2,
    dropPreview ? dropPreview.y + dropPreview.h + 2 : 0,
  );
  const singleFullHeightMixer = widgets.length === 1 && widgets[0]?.type === "mixer";
  const classicMobileControls =
    widgets.length === 5 &&
    (["readouts", "transportButtons", "timeline", "controlDeck", "markerGrid"] as const)
      .every((type, index) => widgets[index]?.type === type);

  return (
    <div className={`layout-canvas-wrap ${editing ? "is-editing" : ""}`}>
      <LayoutTabBar
        tabs={layout.tabs}
        activeTabId={activeTab?.id ?? layout.activeTabId}
        editing={editing}
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
          className={`layout-canvas ${editing ? "is-editing" : ""} ${pendingAddType ? "is-adding" : ""} ${singleFullHeightMixer ? "is-single-full-height-mixer" : ""} ${classicMobileControls ? "is-classic-mobile-controls" : ""}`}
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
          {widgets.map((placement) => (
            <LayoutWidgetHost
              key={placement.id}
              placement={placement}
              editing={editing}
              isDragging={dragId === placement.id}
              onRemove={() => removeWidget(placement.id)}
              onMovePointerDown={(event) => beginMove(placement.id, event)}
              onResizePointerDown={(event) => beginResize(placement.id, event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  useRemoteBridge();
  const [sizeLevel, setSizeLevel] = useState(readRemoteSizeLevel);
  const [layout, setLayout] = useState<RemoteLayout>(readStoredLayout);
  const [editing, setEditing] = useState(false);
  // Snapshot of the layout taken when edit mode opens, so "Cancel" can revert
  // every change made during the session. null when not editing.
  const editBaselineRef = useRef<RemoteLayout | null>(null);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);

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
    const fresh = defaultLayout();
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
      className={`remote-shell remote-size-${sizeLevel} ${sizeLevel > 0 ? "is-large-controls" : ""} ${editing ? "is-editing-layout" : ""}`}
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
        <div className="status-pill">
          {snapshot?.playbackState ? STRINGS[snapshot.playbackState] : STRINGS.idle}
        </div>
        <button
          type="button"
          className={`layout-edit-button ${editing ? "is-active" : ""}`}
          aria-pressed={editing}
          onClick={() => (editing ? finishEditing() : startEditing())}
        >
          {editing ? STRINGS.doneEditing : STRINGS.editLayout}
        </button>
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

      {/* Dedicated edit toolbar so the layout actions never crowd the header
          (the tight phone header was pushing "Done" under the size stepper).
          Only shown while editing; "Done" is the prominent primary action. */}
      {editing ? (
        <div className="layout-edit-toolbar">
          <button type="button" className="layout-edit-done" onClick={finishEditing}>
            ✓ {STRINGS.doneEditing}
          </button>
          <button type="button" className="layout-edit-cancel" onClick={cancelEditing}>
            {STRINGS.cancelEditing}
          </button>
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

      <div className="remote-content">
        <LayoutCanvas layout={layout} editing={editing} onChange={updateLayout} />
      </div>
    </main>
  );
}
