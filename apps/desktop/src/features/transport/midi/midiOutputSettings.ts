import type { AppSettings } from "@libretracks/shared/models";
import type {
  MidiOutputSettings,
  MidiPlatformPatch,
} from "../panels/MidiSettingsTab";

/**
 * Assemble the Settings modal's MIDI-output group.
 *
 * A saved port the OS no longer offers is flagged rather than dropped, so the
 * dialog can keep showing it as "(unavailable)" instead of silently resetting
 * the user's choice.
 */
export function buildMidiOutputSettings(
  appSettings: AppSettings,
  devices: string[],
  handlers: {
    onChange: (value: string) => void;
    onRefresh: () => void;
    onSendTestNote: () => void;
    onPlatformChange: (patch: MidiPlatformPatch) => void;
  },
): MidiOutputSettings {
  const selected = appSettings.selectedMidiOutputDevice ?? "";
  const { onPlatformChange, ...portHandlers } = handlers;
  return {
    devices,
    selected,
    selectedMissing: Boolean(selected) && !devices.includes(selected),
    ...portHandlers,
    platform: {
      networkSession: appSettings.midiNetworkSession,
      virtualPort: appSettings.midiVirtualPort,
      onChange: onPlatformChange,
    },
  };
}
