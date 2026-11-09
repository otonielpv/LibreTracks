/**
 * The redundancy commands and events (docs/plans/redundancy). Settings live
 * in `redundancy.json` through their own commands, never in AppSettings
 * (which the remote receives): the backup PIN included.
 */
import { invokeCommand } from "@libretracks/shared/desktopApi";

export type RedundancyRole = "off" | "main" | "backup";

export type FingerprintDiff =
  | { kind: "algorithmVersion" }
  | { kind: "setlistOrder" }
  | { kind: "songMissing"; title: string }
  | { kind: "songExtra"; title: string }
  | { kind: "timelineDiffers"; title: string }
  | { kind: "audioDiffers"; title: string }
  | { kind: "mixDiffers"; title: string }
  | { kind: "timingSettingsDiffer"; which: string };

/** Backup: off, pairing, checkingSession, sessionMismatch, following, armed,
 * mainLost, standalone, diverged. Main: noBackup, backupConnected,
 * backupArmed, backupMismatch, backupLost. "" right after a role change. */
export type RedundancyState = string;

export type RedundancyStatus = {
  role: RedundancyRole;
  state: RedundancyState;
  offsetMs: number | null;
  corrections: number;
  otherName: string | null;
  diffs: FingerprintDiff[];
  reason: string;
  roleOffer: string | null;
  uncleanExitWarning: boolean;
  sampleRateDiffers: boolean;
  pilotToneOn: boolean;
  /** Main side: the backup took over (lost main or planned handover). */
  handoverBy: string | null;
  /** Backup side: copying the main's session. */
  copy?: { doneBytes: number; totalBytes: number } | null;
  copyError?: string | null;
};

export type RedundancySettings = {
  role: RedundancyRole;
  backupPin: string;
  backupTrusted: Array<{ deviceId: string; deviceName: string }>;
  backupMayForward: boolean;
  mainAddress: string;
  forwardLocalInputsToMain: boolean;
  correctionThresholdMs: number;
  heartbeatTimeoutMs: number;
  manualOffsetMs: number;
  pilotToneEnabled: boolean;
  pilotToneChannel: number;
  pilotToneFrequencyHz: number;
  pilotToneLevelDb: number;
  pilotToneOnBackup: boolean;
  onMainLostMidi: number[];
};

export type RedundancySettingsPatch = Partial<Omit<RedundancySettings, "role" | "backupTrusted">>;

export const REDUNDANCY_STATUS_EVENT = "redundancy:status";

export function getRedundancyStatus() {
  return invokeCommand<RedundancyStatus>("get_redundancy_status");
}

export function setRedundancyRole(role: RedundancyRole, mainAddress?: string, pin?: string) {
  return invokeCommand<RedundancyRole>("set_redundancy_role", {
    role,
    mainAddress: mainAddress ?? null,
    pin: pin ?? null,
  });
}

export function getRedundancySettings() {
  return invokeCommand<RedundancySettings>("get_redundancy_settings");
}

export function saveRedundancySettings(patch: RedundancySettingsPatch) {
  return invokeCommand<RedundancySettings>("save_redundancy_settings", { patch });
}

export function regenerateBackupPin() {
  return invokeCommand<RedundancySettings>("regenerate_backup_pin");
}

export function revokeTrustedBackup(deviceId: string) {
  return invokeCommand<RedundancySettings>("revoke_trusted_backup", { deviceId });
}

/** Rejects with "confirmPlaying" while this machine plays, unless `force`. */
export function copySession(force: boolean) {
  return invokeCommand<void>("redundancy_copy_session", { force });
}

export function cancelCopy() {
  return invokeCommand<void>("redundancy_cancel_copy");
}

export function takeCommand() {
  return invokeCommand<void>("redundancy_take_command");
}

export function followAgain() {
  return invokeCommand<void>("redundancy_follow_again");
}

export function becomeMain() {
  return invokeCommand<RedundancyRole>("redundancy_become_main");
}

export function acceptRoleChange() {
  return invokeCommand<RedundancyRole>("accept_redundancy_role_change");
}

export function dismissRoleChange() {
  return invokeCommand<void>("dismiss_redundancy_role_change");
}

export function rearmPilotTone() {
  return invokeCommand<void>("rearm_pilot_tone");
}

export function setPilotToneArmed(armed: boolean) {
  return invokeCommand<void>("set_pilot_tone_armed", { armed });
}

export function cutPilotToneForTest() {
  return invokeCommand<void>("cut_pilot_tone_for_test");
}

export async function listenToRedundancyStatus(handler: (status: RedundancyStatus) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<RedundancyStatus>(REDUNDANCY_STATUS_EVENT, (message) => handler(message.payload));
}
