import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import {
  buildSongTempoRegions,
  getSongRegionAtPosition,
  getSongTempoRegionAtPosition,
  type AudioMeterLevel,
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
  meterStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "@libretracks/shared/meterBallistics";
import { getRemoteStrings } from "./i18n";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type RemoteView = "transport" | "mixer";
type JumpMode = "immediate" | "next_marker" | "after_bars";

type RemoteConnectionState = {
  status: ConnectionStatus;
  error: string | null;
  socket: WebSocket | null;
  setConnection: (socket: WebSocket | null, status: ConnectionStatus, error?: string | null) => void;
};

type RemoteSyncState = {
  snapshot: TransportSnapshot | null;
  songView: SongView | null;
  meters: Record<string, AudioMeterLevel>;
  receivedAtMs: number;
  setSnapshot: (snapshot: TransportSnapshot) => void;
  setSongView: (songView: SongView | null) => void;
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
  regionName: string;
};

type RemoteJumpState = {
  mode: JumpMode;
  bars: number;
  setMode: (mode: JumpMode) => void;
  setBars: (bars: number) => void;
};

type FolderPalette = {
  background: string;
  border: string;
  accent: string;
};

const CHROME_TIMELINE_PIXELS_PER_SECOND = BASE_PIXELS_PER_SECOND * 2.35;
const PAN_CENTER_MAGNET = 0.08;
const STRINGS = getRemoteStrings();

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
    meters: {},
    receivedAtMs: performance.now(),
    setSnapshot: (snapshot) => {
      set({ snapshot, receivedAtMs: performance.now() });
    },
    setSongView: (songView) => {
      set({ songView, receivedAtMs: performance.now() });
    },
    setMeters: (meters) => {
      set({
        meters: Object.fromEntries(meters.map((meter) => [meter.trackId, meter])),
        receivedAtMs: performance.now(),
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
  setMode: (mode) => {
    set({ mode });
  },
  setBars: (bars) => {
    set({ bars: Math.max(1, Math.floor(bars) || 1) });
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

function magnetizePanValue(value: number) {
  return Math.abs(value) <= PAN_CENTER_MAGNET ? 0 : value;
}

function hashTrackId(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function folderPaletteFromId(trackId: string): FolderPalette {
  const hue = hashTrackId(trackId) % 360;
  return {
    background: `linear-gradient(180deg, hsl(${hue} 56% 20% / 0.95), hsl(${hue} 48% 12% / 0.96))`,
    border: `hsl(${hue} 58% 40% / 0.32)`,
    accent: `hsl(${hue} 72% 66%)`,
  };
}

function buildFolderPaletteMap(tracks: TrackSummary[]) {
  const paletteByTrackId = new Map<string, FolderPalette>();
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  for (const track of tracks) {
    if (track.kind === "folder") {
      paletteByTrackId.set(track.id, folderPaletteFromId(track.id));
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
    return Math.max(
      0,
      transportClock.anchorPositionSeconds + (performance.now() - receivedAtMs) / 1000,
    );
  }

  return Math.max(0, snapshot.positionSeconds);
}

function useTransportReadout(): TransportReadout {
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const songView = useRemoteSyncStore((state) => state.songView);
  const receivedAtMs = useRemoteSyncStore((state) => state.receivedAtMs);
  const [readout, setReadout] = useState<TransportReadout>({
    positionSeconds: 0,
    timecode: "00:00.00",
    musicalDisplay: "1.1.00",
    bpm: 120,
    regionName: "--",
  });

  const timelineRegions = useMemo(() => buildSongTempoRegions(songView), [songView]);

  useEffect(() => {
    let frameId = 0;

    const render = () => {
      const positionSeconds = resolveLivePosition(snapshot, receivedAtMs);
      const currentRegion = getSongRegionAtPosition(songView, positionSeconds);
      const tempoRegion =
        getSongTempoRegionAtPosition(songView, positionSeconds) ??
        timelineRegions[0] ?? {
          bpm: songView?.bpm ?? 120,
          timeSignature: songView?.timeSignature ?? "4/4",
        };

      const musicalPosition = currentRegion
        ? getCumulativeMusicalPosition(
            positionSeconds,
            timelineRegions,
            tempoRegion.bpm,
            tempoRegion.timeSignature,
          )
        : {
            display: "1.1.00",
            barNumber: 1,
            beatInBar: 1,
            subBeat: 0,
          };

      setReadout({
        positionSeconds,
        timecode: formatTimecode(positionSeconds),
        musicalDisplay: musicalPosition.display,
        bpm: tempoRegion.bpm,
        regionName: currentRegion?.name ?? "--",
      });

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, [receivedAtMs, snapshot, songView, timelineRegions]);

  return readout;
}

function SharedTimeline({
  songView,
  positionSeconds,
  pendingJumpTargetId,
  pendingJump,
}: {
  songView: SongView | null;
  positionSeconds: number;
  pendingJumpTargetId: string | null;
  pendingJump: TransportSnapshot["pendingMarkerJump"];
}) {
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth - 32 : 1200;
  const durationSeconds = Math.max(songView?.durationSeconds ?? 0, 8);
  const regions = useMemo(() => buildSongTempoRegions(songView), [songView]);
  const viewportStartSeconds = Math.max(0, positionSeconds - viewportWidth / CHROME_TIMELINE_PIXELS_PER_SECOND / 2);
  const viewportEndSeconds = viewportStartSeconds + viewportWidth / CHROME_TIMELINE_PIXELS_PER_SECOND;
  const grid = buildVisibleTimelineGrid({
    durationSeconds,
    bpm: songView?.bpm ?? 120,
    timeSignature: songView?.timeSignature ?? "4/4",
    regions,
    zoomLevel: 8,
    pixelsPerSecond: CHROME_TIMELINE_PIXELS_PER_SECOND,
    viewportStartSeconds,
    viewportEndSeconds,
  });
  const contentWidth = Math.max(
    viewportWidth * 1.5,
    (Math.max(durationSeconds, viewportEndSeconds + 8) + 4) * CHROME_TIMELINE_PIXELS_PER_SECOND,
  );
  const markers = songView?.sectionMarkers ?? [];
  const timeLabelStepSeconds = durationSeconds > 300 ? 30 : durationSeconds > 120 ? 15 : 10;
  const pendingJumpX =
    pendingJump && Number.isFinite(pendingJump.executeAtSeconds)
      ? secondsToAbsoluteX(pendingJump.executeAtSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)
      : null;

  useEffect(() => {
    const currentX = secondsToAbsoluteX(positionSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND);
    const centeredX = currentX - viewportWidth / 2;

    if (rulerRef.current) {
      rulerRef.current.style.transform = `translate3d(${-centeredX}px, 0, 0)`;
    }
  }, [positionSeconds, viewportWidth]);

  return (
    <div className="timeline-shell timeline-shell-shared">
      <div className="fixed-playhead" aria-hidden="true" />
      <div ref={rulerRef} className="timeline-ruler" style={{ width: contentWidth }}>
        <div className="timeline-header-row timeline-time-row">
          {Array.from({ length: Math.ceil((durationSeconds + timeLabelStepSeconds) / timeLabelStepSeconds) }).map(
            (_, index) => {
              const seconds = index * timeLabelStepSeconds;
              return (
                <span
                  key={`time-label-${seconds}`}
                  className="timeline-top-label is-time"
                  style={{ left: `${secondsToAbsoluteX(seconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px` }}
                >
                  {formatTimelineSecondLabel(seconds)}
                </span>
              );
            },
          )}
        </div>

        <div className="timeline-header-row timeline-bars-row">
          {grid.markers
            .filter((marker) => marker.isBarStart)
            .map((marker) => (
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
          {grid.markers.map((marker) => (
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
          {markers.map((marker) => (
            <span
              key={`marker-${marker.id}`}
              className={`timeline-marker timeline-marker-mini ${pendingJumpTargetId === marker.id ? "is-target" : ""}`}
              style={{
                left: `${secondsToAbsoluteX(marker.startSeconds, CHROME_TIMELINE_PIXELS_PER_SECOND)}px`,
              }}
            >
              {marker.name}
            </span>
          ))}
        </div>
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
        <div className="readout-card">
          <span>{STRINGS.barBeat}</span>
          <strong>{readout.musicalDisplay}</strong>
        </div>
        <div className="readout-card">
          <span>{STRINGS.bpm}</span>
          <strong>{readout.bpm.toFixed(2)}</strong>
        </div>
        <div className="readout-card">
          <span>{STRINGS.region}</span>
          <strong>{readout.regionName}</strong>
        </div>
      </div>

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
      </div>
    </div>
  );
}

function TransportChrome() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
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
          <div className="readout-card">
            <span>{STRINGS.barBeat}</span>
            <strong>{readout.musicalDisplay}</strong>
          </div>
          <div className="readout-card">
            <span>{STRINGS.bpm}</span>
            <strong>{readout.bpm.toFixed(2)}</strong>
          </div>
          <div className="readout-card">
            <span>{STRINGS.region}</span>
            <strong>{readout.regionName}</strong>
          </div>
        </div>

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
        </div>
      </div>

      <SharedTimeline
        songView={songView}
        positionSeconds={readout.positionSeconds}
        pendingJumpTargetId={pendingJumpTargetId}
        pendingJump={snapshot?.pendingMarkerJump ?? null}
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
          <div className="readout-card">
            <span>{STRINGS.barBeat}</span>
            <strong>{readout.musicalDisplay}</strong>
          </div>
          <div className="readout-card">
            <span>{STRINGS.bpm}</span>
            <strong>{readout.bpm.toFixed(2)}</strong>
          </div>
          <div className="readout-card">
            <span>{STRINGS.region}</span>
            <strong>{readout.regionName}</strong>
          </div>
        </div>

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
        </div>
      </div>
    </section>
  );
}

function TransportView() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const snapshot = useRemoteSyncStore((state) => state.snapshot);
  const pendingJumpTargetId = useOptimisticStore((state) => state.pendingJumpTargetId);
  const jumpMode = useRemoteJumpStore((state) => state.mode);
  const jumpBars = useRemoteJumpStore((state) => state.bars);
  const setJumpMode = useRemoteJumpStore((state) => state.setMode);
  const setJumpBars = useRemoteJumpStore((state) => state.setBars);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const markers = songView?.sectionMarkers ?? [];
  const regions = songView?.regions ?? [];
  const pendingJump = snapshot?.pendingMarkerJump ?? null;

  useEffect(() => {
    if (!regions.length) {
      setSelectedRegionId(null);
      return;
    }

    if (!selectedRegionId || !regions.some((region) => region.id === selectedRegionId)) {
      setSelectedRegionId(regions[0]?.id ?? null);
    }
  }, [regions, selectedRegionId]);

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

  return (
    <section className="remote-panel">
      <div className="jump-toolbar">
        <div className="jump-mode-group" role="group" aria-label={STRINGS.jump}>
          <button
            className={jumpMode === "immediate" ? "is-active" : ""}
            onClick={() => setJumpMode("immediate")}
          >
            {STRINGS.immediate}
          </button>
          <button
            className={jumpMode === "after_bars" ? "is-active" : ""}
            onClick={() => setJumpMode("after_bars")}
          >
            {STRINGS.bars}
          </button>
          <button
            className={jumpMode === "next_marker" ? "is-active" : ""}
            onClick={() => setJumpMode("next_marker")}
          >
            {STRINGS.next}
          </button>
        </div>

        {jumpMode === "after_bars" ? (
          <label className="jump-bars-field">
            <span>{STRINGS.bars}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={jumpBars}
              onChange={(event) => setJumpBars(Number(event.currentTarget.value))}
            />
          </label>
        ) : null}

        <button
          className="jump-cancel-button"
          disabled={!pendingJump}
          onClick={() => {
            if (pendingJump) {
              cancelJump();
            }
          }}
        >
          {STRINGS.cancelJump}
        </button>

        {pendingJump ? (
          <div className="pending-jump-card">
            <span>{STRINGS.pending}</span>
            <strong>{pendingJump.targetMarkerName}</strong>
            <small>{formatJumpModeLabel(pendingJumpMode.mode, pendingJumpMode.bars ?? jumpBars)}</small>
          </div>
        ) : null}
      </div>

      <div className="region-actions-row">
        <div className="region-carousel">
          {regions.map((region) => (
            <button
              key={region.id}
              className={`region-chip ${selectedRegionId === region.id ? "is-active" : ""}`}
              onClick={() => {
                setSelectedRegionId(region.id);
                sendCommand({
                  cmd: "seek",
                  positionSeconds: region.startSeconds,
                });
              }}
            >
              {region.name}
            </button>
          ))}
        </div>
      </div>

      <div className="marker-grid">
        {visibleMarkers.map((marker) => (
          <button
            key={marker.id}
            className={`marker-card ${pendingJumpTargetId === marker.id ? "is-pending" : ""}`}
            onClick={() => {
              if (pendingJump?.targetMarkerId === marker.id) {
                cancelJump();
                return;
              }

              scheduleJump(marker.id);
            }}
          >
            <small>{marker.digit ?? "."}</small>
            <strong>{marker.name}</strong>
            <span>{formatTimecode(marker.startSeconds)}</span>
            <em>{formatJumpModeLabel(jumpMode, jumpBars)}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

function MeterBar({ trackId }: { trackId: string }) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frameId = 0;
    let lastFrameAt = 0;
    let currentDb = peakToMeterDb(0);
    let targetDb = peakToMeterDb(0);
    let clipHoldUntil = 0;

    const applyMeter = () => {
      if (fillRef.current) {
        const meterStyle = meterStyleFromDb(currentDb);
        fillRef.current.style.clipPath = meterStyle.clipPath;
        fillRef.current.style.opacity = meterStyle.opacity;
      }
      if (clipRef.current) {
        const clipping = performance.now() <= clipHoldUntil;
        clipRef.current.style.opacity = clipping ? "1" : "0";
        clipRef.current.style.transform = clipping ? "scaleY(1)" : "scaleY(0)";
      }
    };

    const render = (now: number) => {
      const elapsedMs = lastFrameAt > 0 ? now - lastFrameAt : 16.67;
      lastFrameAt = now;
      currentDb = stepMeterDb(currentDb, targetDb, elapsedMs, DEFAULT_METER_FALLOFF_DB_PER_SECOND);

      applyMeter();
      const shouldContinue =
        Math.abs(currentDb - targetDb) > METER_ACTIVE_EPSILON_DB ||
        performance.now() <= clipHoldUntil;

      if (!shouldContinue) {
        currentDb = targetDb;
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
        if (!frameId) {
          frameId = window.requestAnimationFrame(render);
        }
      },
    );

    const initialMeter = useRemoteSyncStore.getState().meters[trackId];
    const initialPeak = Math.max(initialMeter?.leftPeak ?? 0, initialMeter?.rightPeak ?? 0);
    currentDb = peakToMeterDb(initialPeak);
    targetDb = currentDb;
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
      <div ref={clipRef} className="mixer-meter-clip" />
    </div>
  );
}

function MixerStrip({
  track,
  palette,
}: {
  track: TrackSummary;
  palette: FolderPalette | null;
}) {
  const optimisticTrack = useOptimisticStore((state) => state.tracks[track.id]);
  const effectiveTrack = resolveEffectiveTrack(track, optimisticTrack);
  const stripStyle = palette
    ? ({
        "--folder-strip-bg": palette.background,
        "--folder-strip-border": palette.border,
        "--folder-strip-accent": palette.accent,
      } as CSSProperties)
    : undefined;

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

  return (
    <article
      className={`mixer-strip ${track.kind === "folder" ? "is-folder" : ""} ${palette ? "is-folder-child" : ""}`}
      style={stripStyle}
    >
      <header className="mixer-strip-header">
        <small>{track.kind === "folder" ? STRINGS.folder : STRINGS.audio}</small>
        <strong>{track.name}</strong>
      </header>

      <div className="pan-section">
        <button className="mini-action" onClick={() => commitTrackUpdate({ pan: 0 })}>
          {STRINGS.center}
        </button>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={effectiveTrack.pan}
          onInput={(event) => pushMixUpdate({ pan: magnetizePanValue(Number(event.currentTarget.value)) })}
          onPointerUp={(event) => commitTrackUpdate({ pan: magnetizePanValue(Number(event.currentTarget.value)) })}
        />
      </div>

      <div className="volume-section">
        <MeterBar trackId={track.id} />
        <input
          className="volume-fader"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={effectiveTrack.volume}
          onInput={(event) => pushMixUpdate({ volume: Number(event.currentTarget.value) })}
          onPointerUp={(event) => commitTrackUpdate({ volume: Number(event.currentTarget.value) })}
        />
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
      </div>
    </article>
  );
}

function MixerView() {
  const songView = useRemoteSyncStore((state) => state.songView);
  const tracks = songView?.tracks ?? [];
  const folderPaletteMap = useMemo(() => buildFolderPaletteMap(tracks), [tracks]);

  return (
    <section className="remote-panel remote-panel-mixer">
      <div className="mixer-scroll">
        {tracks.map((track) => (
          <MixerStrip key={track.id} track={track} palette={folderPaletteMap.get(track.id) ?? null} />
        ))}
      </div>
    </section>
  );
}

export function App() {
  useRemoteBridge();
  const [view, setView] = useState<RemoteView>("transport");
  const snapshot = useRemoteSyncStore((state) => state.snapshot);

  return (
    <main className="remote-shell">
      <header className="remote-header">
        <div className="remote-header-brand">
          <small>LibreTracks</small>
          <h1>{STRINGS.appTitle}</h1>
        </div>
        <div className="remote-header-transport">
          <HeaderTransportTopline />
        </div>
        <div className="status-pill">
          {snapshot?.playbackState ? STRINGS[snapshot.playbackState] : STRINGS.idle}
        </div>
      </header>

      <TransportChrome />

      <div className="remote-content">
        {view === "transport" ? <TransportView /> : <MixerView />}
      </div>

      <nav className="bottom-nav">
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
    </main>
  );
}
