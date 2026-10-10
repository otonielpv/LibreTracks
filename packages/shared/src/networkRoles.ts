/**
 * Which network-session role may send which command. Pure, so it is tested
 * without Tauri. Mirrors `crates/libretracks-link/src/permissions.rs`; the
 * host has the final word, this only decides what the guest UI enables.
 */

export type NetworkRole = "viewer" | "controller" | "editor";

export type NetworkCommandName =
  | "play"
  | "pause"
  | "stop"
  | "fadeOutStop"
  | "seek"
  | "jumpToMarker"
  | "jumpToSong"
  | "toggleVamp"
  | "cancelJump"
  | "setJumpSettings"
  | "reorderSong"
  | "setSongChart"
  | "setSongTranspose"
  | "setTrackMix"
  | "setSongMasterGain"
  | "setMetronome";

const EDITOR_ONLY: ReadonlySet<NetworkCommandName> = new Set([
  "setSongChart",
  "setSongTranspose",
  "setTrackMix",
  "setSongMasterGain",
  "setMetronome",
]);

export function roleAllows(role: NetworkRole | null, command: NetworkCommandName): boolean {
  if (!role) return false;
  if (EDITOR_ONLY.has(command)) return role === "editor";
  return role === "controller" || role === "editor";
}
