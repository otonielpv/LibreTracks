/**
 * Network sessions between LibreTracks apps (docs/plans/network-sessions):
 * one device hosts, others join with a role. Not the remote.
 *
 * Mirrors `apps/desktop/src-tauri/src/link/`. Every call here is behind
 * `FEATURE_FLAGS.networkSessions` in the UI.
 */

import type { SongView, TransportSnapshot } from "./models";
import { invokeCommand } from "./desktopApi";

import type { NetworkRole } from "./networkRoles";

export { roleAllows, type NetworkRole } from "./networkRoles";

export type NetworkSessionSettings = {
  deviceName: string;
  /** Empty = role disabled. */
  controlPin: string;
  editPin: string;
  keepHostingAfterRestart: boolean;
};

export type NetworkGuestSummary = {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  grants: { role: NetworkRole };
  connectedAtMs: number;
  rttMs: number | null;
  trusted: boolean;
};

export type NetworkTrustedDevice = {
  deviceId: string;
  deviceName: string;
  role: NetworkRole;
};

export type NetworkHostStatus = {
  hosting: boolean;
  hostName: string;
  port: number;
  addresses: string[];
  joinUrl: string | null;
  guests: NetworkGuestSummary[];
  trusted: NetworkTrustedDevice[];
};

export type NetworkPeer = {
  deviceId: string;
  deviceName: string;
  platform: string;
  grants: { role: NetworkRole };
};

export type NetworkGuestConnectionState =
  | "connecting"
  | "connected"
  | "lost"
  | "rejected"
  | "closed";

export type NetworkGuestStatus = {
  joined: boolean;
  address: string;
  state: NetworkGuestConnectionState | "";
  /** For `rejected`: badPin, rateLimited, incompatibleVersion, kicked, hostFull, badHello. */
  reason: string | null;
  expectedProtocol: number | null;
  hostName: string;
  role: NetworkRole | null;
  rttMs: number | null;
  peers: NetworkPeer[];
};

/** Same shape as the local transport lifecycle event. */
export type NetworkGuestTransport = {
  snapshot: TransportSnapshot;
  anchorPositionSeconds: number;
  emittedAtUnixMs: number;
};

/** The host's jump settings, as its live view uses them, plus the metronome
 * for editors' mix panel. */
export type NetworkLiveSettings = {
  globalJumpMode: string;
  globalJumpBars: number;
  songJumpTrigger: string;
  songJumpBars: number;
  songTransitionMode: string;
  vampMode: string;
  vampBars: number;
  metronomeEnabled?: boolean;
  /** Linear gain on the aux fader scale. */
  metronomeVolume?: number;
};

export type NetworkGuestSnapshot = {
  status: NetworkGuestStatus;
  song: SongView | null;
  transport: NetworkGuestTransport | null;
  liveSettings: NetworkLiveSettings | null;
};

/** Commands a guest can send; the host checks the role again. */
export type NetworkCommand =
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "stop" }
  | { cmd: "fadeOutStop" }
  | { cmd: "seek"; positionSeconds: number }
  | { cmd: "jumpToMarker"; markerId: string; trigger: string; bars?: number }
  | {
      cmd: "jumpToSong";
      regionId: string;
      trigger: string;
      bars?: number;
      transition?: string;
      durationSeconds?: number;
    }
  | { cmd: "toggleVamp"; mode: string; bars?: number }
  | { cmd: "cancelJump" }
  | ({ cmd: "setJumpSettings" } & Partial<
      Omit<NetworkLiveSettings, "metronomeEnabled" | "metronomeVolume">
    >)
  | { cmd: "reorderSong"; regionId: string; targetIndex: number }
  | { cmd: "setSongChart"; regionId: string; chart: unknown | null }
  | { cmd: "setSongTranspose"; regionId: string; semitones: number }
  | {
      cmd: "setTrackMix";
      trackId: string;
      volume?: number;
      pan?: number;
      muted?: boolean;
      solo?: boolean;
      live: boolean;
    }
  | { cmd: "setSongMasterGain"; regionId: string; masterGain: number; live: boolean }
  | { cmd: "setMetronome"; enabled?: boolean; volume?: number };

/** Error codes from `link_guest_command` / `link_join`. */
export type NetworkCommandError =
  | "notConnected"
  | "disconnected"
  | "timedOut"
  | "forbidden"
  | "stale"
  | "invalid"
  | "invalidAddress"
  | "hosting";

export const DEFAULT_LINK_PORT = 3040;

export function getNetworkSessionSettings() {
  return invokeCommand<NetworkSessionSettings>("link_get_settings");
}

export function saveNetworkSessionSettings(settings: NetworkSessionSettings) {
  return invokeCommand<NetworkSessionSettings>("link_save_settings", { settings });
}

export function startHosting() {
  return invokeCommand<NetworkHostStatus>("link_start_hosting");
}

export function stopHosting() {
  return invokeCommand<void>("link_stop_hosting");
}

export function getHostStatus() {
  return invokeCommand<NetworkHostStatus>("link_host_status");
}

export function setGuestRole(deviceId: string, role: NetworkRole) {
  return invokeCommand<boolean>("link_set_guest_role", { deviceId, role });
}

export function kickGuest(deviceId: string) {
  return invokeCommand<boolean>("link_kick_guest", { deviceId });
}

export function revokeTrustedDevice(deviceId: string) {
  return invokeCommand<boolean>("link_revoke_trusted", { deviceId });
}

export function joinHost(target: string, pin: string | null, remember: boolean) {
  return invokeCommand<NetworkGuestStatus>("link_join", { target, pin, remember });
}

export function leaveHost() {
  return invokeCommand<void>("link_leave");
}

export function getGuestSnapshot() {
  return invokeCommand<NetworkGuestSnapshot>("link_guest_snapshot");
}

export function sendGuestCommand(command: NetworkCommand, baseRevision?: number) {
  return invokeCommand<void>("link_guest_command", {
    command,
    baseRevision: baseRevision ?? null,
  });
}

async function listenTo<T>(event: string, handler: (payload: T) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => handler(message.payload));
}

export function listenToHostStatus(handler: (status: NetworkHostStatus) => void) {
  return listenTo("link://host", handler);
}

export function listenToGuestStatus(handler: (status: NetworkGuestStatus) => void) {
  return listenTo("link://guest", handler);
}

export function listenToGuestSong(handler: (song: SongView | null) => void) {
  return listenTo("link://guest-song", handler);
}

export function listenToGuestTransport(handler: (transport: NetworkGuestTransport) => void) {
  return listenTo("link://guest-transport", handler);
}

export function listenToGuestLiveSettings(handler: (settings: NetworkLiveSettings) => void) {
  return listenTo("link://guest-live-settings", handler);
}
