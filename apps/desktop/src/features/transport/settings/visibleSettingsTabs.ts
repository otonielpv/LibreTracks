import type { SettingsTab } from "../types";

/**
 * Tabs a phone or tablet never shows: no physical keyboard by default for
 * shortcuts. (Video is shown since plan video-mobile: a phone drives a
 * projector by cable or AirPlay.)
 */
export const MOBILE_HIDDEN_SETTINGS_TABS: readonly SettingsTab[] = ["shortcuts"];

/** Tabs that only make sense when the platform has MIDI. */
export const MIDI_SETTINGS_TABS: readonly SettingsTab[] = ["midi", "midiLearn"];

/**
 * The Settings tabs to show. Desktop shows everything. On mobile the MIDI
 * tabs depend on the platform actually having MIDI (`get_midi_capabilities`),
 * not on being a phone: iOS and Android both have a MIDI transport now.
 */
export function visibleSettingsTabs<T extends { id: SettingsTab }>(
  tabs: T[],
  { isMobile, midiAvailable }: { isMobile: boolean; midiAvailable: boolean },
): T[] {
  if (!isMobile) {
    return tabs;
  }
  return tabs.filter(
    (tab) =>
      !MOBILE_HIDDEN_SETTINGS_TABS.includes(tab.id) &&
      (midiAvailable || !MIDI_SETTINGS_TABS.includes(tab.id)),
  );
}
