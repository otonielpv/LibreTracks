export type PlaybackState = "empty" | "stopped" | "playing" | "paused";

export type GroupSummary = {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
};

export type TrackSummary = {
  id: string;
  name: string;
  groupName?: string | null;
  volume: number;
  muted: boolean;
};

export type SongSummary = {
  id: string;
  title: string;
  artist?: string | null;
  bpm: number;
  key?: string | null;
  timeSignature: string;
  durationSeconds: number;
  tracks: TrackSummary[];
  groups: GroupSummary[];
};

export type TransportSnapshot = {
  playbackState: PlaybackState;
  positionSeconds: number;
  song?: SongSummary | null;
  songDir?: string | null;
  isNativeRuntime: boolean;
};

const tauriWindow = window as Window & {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriApp = Boolean(tauriWindow.__TAURI_INTERNALS__);

const fallbackSnapshot: TransportSnapshot = {
  playbackState: "stopped",
  positionSeconds: 0,
  isNativeRuntime: false,
  song: {
    id: "demo-song",
    title: "Demo Song",
    artist: "LibreTracks",
    bpm: 72,
    key: "D",
    timeSignature: "4/4",
    durationSeconds: 240,
    groups: [
      { id: "group-monitor", name: "Click + Guide", volume: 1, muted: false },
      { id: "group-rhythm", name: "Drums + Bass", volume: 0.92, muted: false },
      { id: "group-keys", name: "Keys + Pads", volume: 0.78, muted: true },
    ],
    tracks: [
      { id: "track-click", name: "Click", groupName: "Click + Guide", volume: 1, muted: false },
      { id: "track-guide", name: "Guide", groupName: "Click + Guide", volume: 0.86, muted: false },
      { id: "track-drums", name: "Drums", groupName: "Drums + Bass", volume: 0.94, muted: false },
      { id: "track-bass", name: "Bass", groupName: "Drums + Bass", volume: 0.88, muted: false },
      { id: "track-keys", name: "Keys", groupName: "Keys + Pads", volume: 0.72, muted: true },
    ],
  },
  songDir: null,
};

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return fallbackSnapshot;
  }

  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  if (!isTauriApp) {
    return fallbackSnapshot;
  }

  return invokeCommand<TransportSnapshot | null>("pick_and_import_song_from_dialog");
}

export async function playTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return { ...fallbackSnapshot, playbackState: "playing" };
  }

  return invokeCommand<TransportSnapshot>("play_transport");
}

export async function pauseTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return { ...fallbackSnapshot, playbackState: "paused" };
  }

  return invokeCommand<TransportSnapshot>("pause_transport");
}

export async function stopTransport(): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return fallbackSnapshot;
  }

  return invokeCommand<TransportSnapshot>("stop_transport");
}

export async function seekTransport(positionSeconds: number): Promise<TransportSnapshot> {
  if (!isTauriApp) {
    return { ...fallbackSnapshot, positionSeconds };
  }

  return invokeCommand<TransportSnapshot>("seek_transport", { positionSeconds });
}
