import type { TFunction } from "i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { SettingsTab, SettingsTabGroup } from "../types";

/**
 * Every Settings tab, in sidebar order. App-wide preferences fold under
 * "General" and the two MIDI tabs under "MIDI" (see SettingsTabNav), so the
 * sidebar has seven rows and fits a phone in landscape.
 */
export function allSettingsTabs(
  t: TFunction,
): Array<{ id: SettingsTab; label: string; group?: SettingsTabGroup }> {
  return [
    { id: "general", group: "general", label: t("transport.settingsModal.tabInterface", { defaultValue: "Interface" }) },
    { id: "timeline", group: "general", label: t("transport.settingsModal.tabTimeline", { defaultValue: "Timeline" }) },
    { id: "playback", group: "general", label: t("transport.settingsModal.tabPlayback", { defaultValue: "Playback" }) },
    { id: "editing", group: "general", label: t("transport.settingsModal.tabEditing", { defaultValue: "Editing" }) },
    { id: "storage", group: "general", label: t("transport.settingsModal.tabStorage", { defaultValue: "Storage" }) },
    { id: "system", group: "general", label: t("transport.settingsModal.tabSystem", { defaultValue: "System" }) },
    { id: "audio", label: t("transport.settingsModal.tabAudio", { defaultValue: "Audio" }) },
    { id: "midi", group: "midi", label: t("transport.settingsModal.tabMidiDevices", { defaultValue: "Devices" }) },
    { id: "midiLearn", group: "midi", label: t("transport.settingsModal.tabMidiLearn", { defaultValue: "MIDI Learn" }) },
    { id: "video", label: t("transport.video.settings.tab") },
    ...(FEATURE_FLAGS.redundancy
      ? [{ id: "redundancy" as const, label: t("redundancy.settings.tab") }]
      : []),
    { id: "shortcuts", label: t("transport.settingsModal.tabShortcuts", { defaultValue: "Atajos" }) },
    { id: "diagnostics", label: t("transport.settingsModal.tabDiagnostics", { defaultValue: "Diagnostics" }) },
  ];
}

/**
 * Tabs a phone or tablet never shows: no physical keyboard by default for
 * shortcuts; redundancy is desktop-first (docs/plans/redundancy, R7). (Video
 * is shown since plan video-mobile: a phone drives a projector by cable or
 * AirPlay.)
 */
export const MOBILE_HIDDEN_SETTINGS_TABS: readonly SettingsTab[] = ["shortcuts", "redundancy"];

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
