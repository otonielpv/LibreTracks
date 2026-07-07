import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
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
import { getRemoteStrings } from "./i18n";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type RemoteView = "transport" | "mixer";
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
// Song master fader: linear gain 0..2, snapping to unity (1.0) within ±3% of
// the range. Mirrors the desktop master fader (TimelineToolbar) so the remote
// and desktop feel identical.
const MASTER_GAIN_MIN = 0;
const MASTER_GAIN_MAX = 2;
const MASTER_SNAP_TARGET = 1.0;
const MASTER_SNAP_THRESHOLD = MASTER_GAIN_MAX * 0.03;
const REMOTE_SIZE_STORAGE_KEY = "libretracks.remote.uiSize";
const MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY = "libretracks.remote.mixerFilterActiveSong";
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

/** Volume readout: linear amplitude [0,1] shown as a percentage. */
function formatRemoteVolume(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return `${Math.round(clamped * 100)}%`;
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

function TransportTopline() {
  const readout = useTransportReadout();

  return (
    <div className="transport-topline">
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
        <div className="readout-card readout-card-song">
          <span>{STRINGS.region}</span>
          <strong title={readout.regionName}>{readout.regionName}</strong>
        </div>
      </div>

      <TransportControlButtons />
    </div>
  );
}

function TransportChrome() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const snapshotReceivedAtMs = useRemoteSyncStore((state) => state.snapshotReceivedAtMs);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
  const readout = useTransportReadout();

  return (
    <section className="transport-chrome">
      <div className="transport-topline transport-topline-mobile-only">
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

        <TransportControlButtons />
      </div>

      <SharedTimeline
        songView={songView}
        snapshot={snapshot}
        snapshotReceivedAtMs={snapshotReceivedAtMs}
        pendingJumpTargetId={pendingJumpTargetId}
      />
    </section>
  );
}

function HeaderTransportTopline() {
  const readout = useTransportReadout();

  return (
    <section className="transport-chrome transport-chrome-inline-shell">
      <div className="transport-topline">
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

        <TransportControlButtons />
      </div>
    </section>
  );
}

function TransportView() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const settings = useRemoteSyncStore((state) => state.settings);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
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
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  // Per-marker visibility: users hide individual jump buttons they never use.
  // Persisted as a set of marker ids in localStorage.
  const [hiddenMarkerIds, setHiddenMarkerIds] = useState<Set<string>>(
    readHiddenMarkerIds,
  );
  const [revealHiddenMarkers, setRevealHiddenMarkers] = useState(false);

  const toggleMarkerHidden = useCallback((markerId: string) => {
    setHiddenMarkerIds((current) => {
      const next = new Set(current);
      if (next.has(markerId)) {
        next.delete(markerId);
      } else {
        next.add(markerId);
      }
      writeHiddenMarkerIds(next);
      return next;
    });
  }, []);
  // Only section markers are navigable from the remote — dynamic cues (Build,
  // All In, ...) are spoken by the voice guide, not jump destinations.
  const markers = (songView?.sectionMarkers ?? []).filter(
    (marker) => markerKindCategory(marker.kind) === "section",
  );
  const regions = songView?.regions ?? [];
  const pendingJump = snapshot?.pendingMarkerJump ?? null;
  const activeVamp = snapshot?.activeVamp ?? null;
  const [activePanel, setActivePanel] = useState<RemotePanelKey | null>(null);

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
  const pendingJumpMode = parsePendingJumpMode(pendingJump?.trigger);

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

  const scheduleRegionJump = (regionId: string) => {
    sendCommand({
      cmd: "scheduleRegionJump",
      targetRegionId: regionId,
      trigger: songTrigger,
      bars: songTrigger === "after_bars" ? songBars : undefined,
      transition: songTransition,
      durationSeconds: songTransition === "fade_out" ? 0.35 : undefined,
    });
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

  return (
    <section className="remote-panel">
      <div className="transport-control-deck">
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
              onClick={() => setActivePanel((current) => (current === "vamp" ? null : "vamp"))}
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
              onClick={() => setActivePanel((current) => (current === "jump" ? null : "jump"))}
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
              onClick={() => setActivePanel((current) => (current === "song" ? null : "song"))}
            >
              {STRINGS.settings}
            </button>
          </div>
        </article>

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

        {activePanel ? (
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

      {hiddenVisibleMarkers.length > 0 ? (
        <div className="marker-grid-header">
          <button
            type="button"
            className={`marker-grid-toggle ${revealHiddenMarkers ? "is-on" : ""}`}
            aria-pressed={revealHiddenMarkers}
            onClick={() => setRevealHiddenMarkers((current) => !current)}
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

    </section>
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

  const updateDraftVolume = (value: number) => {
    const nextVolume = Math.max(0, Math.min(1, value));
    volumeInteractionRef.current = true;
    setDraftVolume(nextVolume);
    pushMixUpdate({ volume: nextVolume });
  };

  const commitDraftVolume = (value: number) => {
    const nextVolume = Math.max(0, Math.min(1, value));
    volumeInteractionRef.current = false;
    setDraftVolume(nextVolume);
    commitTrackUpdate({ volume: nextVolume });
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
            <span>100</span>
            <span>50</span>
            <span>0</span>
          </div>
          <MeterBar trackId={track.id} />
          <input
            className="volume-fader"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={draftVolume}
            onChange={(event) => updateDraftVolume(Number(event.currentTarget.value))}
            onInput={(event) => updateDraftVolume(Number(event.currentTarget.value))}
            onPointerDown={() => {
              volumeInteractionRef.current = true;
            }}
            onPointerUp={(event) => commitDraftVolume(Number(event.currentTarget.value))}
            onPointerCancel={(event) => commitDraftVolume(Number(event.currentTarget.value))}
            onLostPointerCapture={(event) => commitDraftVolume(Number(event.currentTarget.value))}
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

function readMixerFilterActiveSong() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY) === "1";
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

function MixerView() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const tracks = songView?.tracks ?? [];
  const folderPaletteMap = useMemo(() => buildFolderPaletteMap(tracks), [tracks]);

  const [filterActiveSong, setFilterActiveSong] = useState(readMixerFilterActiveSong);
  const activeRegionId = useActiveRegionId();
  const activeRegion = useMemo(
    () => songView?.regions.find((region) => region.id === activeRegionId) ?? null,
    [songView, activeRegionId],
  );

  useEffect(() => {
    window.localStorage.setItem(
      MIXER_FILTER_ACTIVE_SONG_STORAGE_KEY,
      filterActiveSong ? "1" : "0",
    );
  }, [filterActiveSong]);

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

  return (
    <section className="remote-panel remote-panel-mixer">
      <div className="mixer-filter-bar">
        <button
          type="button"
          className={`mixer-filter-toggle ${filterActiveSong ? "is-active" : ""}`}
          aria-pressed={filterActiveSong}
          disabled={!filterAvailable && !filterActiveSong}
          title={
            filterActiveSong
              ? STRINGS.activeSongFilterOn
              : STRINGS.activeSongFilterOff
          }
          onClick={() => setFilterActiveSong((current) => !current)}
        >
          {STRINGS.activeSongOnly}
        </button>
        <SongMasterFader region={activeRegion} />
      </div>
      <div className="mixer-scroll">
        {visibleTracks.map((track) => {
          const directPalette = paletteFromTrackColor(track.color);
          const inheritedPalette = directPalette ? null : (folderPaletteMap.get(track.id) ?? null);

          return (
            <MixerStrip
              key={track.id}
              track={track}
              palette={directPalette ?? inheritedPalette}
              inheritsParentPalette={inheritedPalette !== null}
            />
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  useRemoteBridge();
  const [view, setView] = useState<RemoteView>("transport");
  const [sizeLevel, setSizeLevel] = useState(readRemoteSizeLevel);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);

  useEffect(() => {
    window.localStorage.setItem(REMOTE_SIZE_STORAGE_KEY, String(sizeLevel));
  }, [sizeLevel]);

  return (
    <main
      className={`remote-shell remote-size-${sizeLevel} ${sizeLevel > 0 ? "is-large-controls" : ""}`}
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
        <nav className="remote-view-tabs" aria-label={STRINGS.transport}>
          <button
            className={view === "transport" ? "is-active" : ""}
            onClick={() => setView("transport")}
          >
            {STRINGS.transport}
          </button>
          <button
            className={view === "mixer" ? "is-active" : ""}
            onClick={() => setView("mixer")}
          >
            {STRINGS.mixer}
          </button>
        </nav>
        <div className="status-pill">
          {snapshot?.playbackState ? STRINGS[snapshot.playbackState] : STRINGS.idle}
        </div>
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

      <TransportChrome />

      <div className="remote-content">
        {view === "transport" ? <TransportView /> : <MixerView />}
      </div>
    </main>
  );
}
