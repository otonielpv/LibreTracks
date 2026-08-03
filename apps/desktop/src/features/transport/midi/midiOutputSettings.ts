import type { AppSettings } from "@libretracks/shared/models";
import type { MidiOutputSettings } from "../panels/MidiSettingsTab";

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
  },
): MidiOutputSettings {
  const selected = appSettings.selectedMidiOutputDevice ?? "";
  return {
    devices,
    selected,
    selectedMissing: Boolean(selected) && !devices.includes(selected),
    ...handlers,
  };
}
