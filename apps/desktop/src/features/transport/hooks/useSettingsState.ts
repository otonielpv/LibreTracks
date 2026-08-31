import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
  type AudioDeviceDescriptor,
} from "@libretracks/shared/models";

import {
  getAudioOutputDevices,
  getMidiInputs,
  getMidiOutputs,
  getSettings,
} from "../desktopApi";
import type { MidiLearnFeedback, SettingsTab } from "../types";

type UseSettingsStateProps = {
  /** Pushes the saved locale into i18n; returns once the language is applied. */
  syncSettingsLanguage: (settings: AppSettings) => Promise<void>;
};

/**
 * Owns the Settings/Audio/MIDI configuration state that used to live inline in
 * TransportPanelContent. `appSettings` is the source of truth; `appSettingsRef`
 * mirrors it (kept in sync by an effect here) so the various extracted handler
 * factories can read the latest settings synchronously at call time without
 * stale closures.
 */
export function useSettingsState({
  syncSettingsLanguage,
}: UseSettingsStateProps) {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isRemoteModalOpen, setIsRemoteModalOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>("audio");
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [appSettings, setAppSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [midiLearnFeedback, setMidiLearnFeedback] =
    useState<MidiLearnFeedback | null>(null);
  const [midiLearnView, setMidiLearnView] = useState<
    "core" | "markers" | "songs"
  >("core");
  const [metronomeVolumeDraft, setMetronomeVolumeDraft] = useState(
    DEFAULT_APP_SETTINGS.metronomeVolume,
  );
  // Draft for the Settings → Hardware Outputs checkbox grid. Each tick stays
  // local until the user hits Apply, so picking N channels does not trigger
  // N device reopens.
  const [enabledOutputChannelsDraft, setEnabledOutputChannelsDraft] = useState<
    number[]
  >(DEFAULT_APP_SETTINGS.enabledOutputChannels);
  const [audioDeviceDescriptors, setAudioDeviceDescriptors] = useState<
    AudioDeviceDescriptor[]
  >([]);
  const [audioOutputChannelCounts, setAudioOutputChannelCounts] = useState<
    Record<string, number>
  >({});
  const [defaultAudioOutputDevice, setDefaultAudioOutputDevice] = useState<
    string | null
  >(null);
  const [midiInputDevices, setMidiInputDevices] = useState<string[]>([]);
  const [midiOutputDevices, setMidiOutputDevices] = useState<string[]>([]);
  const [isMidiInputRefreshing, setIsMidiInputRefreshing] = useState(false);
  const [isAudioRefreshing, setIsAudioRefreshing] = useState(false);

  const appSettingsRef = useRef(appSettings);
  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  /**
   * Load persisted settings first, independently from hardware discovery.
   *
   * The native audio engine already starts from those persisted settings. If
   * device/MIDI enumeration is slow or unavailable (notably in a mobile
   * WebView), holding the React state behind the same Promise.all leaves the
   * toolbar on DEFAULT_APP_SETTINGS while the engine is already playing with
   * the real configuration — e.g. an audible click whose button looks off.
   */
  const refreshAudioSettings = useCallback(async () => {
    const nextSettings = await getSettings();
    const normalizedSettings = normalizeAppSettings(nextSettings);
    setAppSettings(normalizedSettings);
    await syncSettingsLanguage(normalizedSettings);

    const [audioDevices, midiInputs, midiOutputs] = await Promise.allSettled([
      getAudioOutputDevices(),
      getMidiInputs(),
      getMidiOutputs(),
    ] as const);
    if (audioDevices.status === "fulfilled") {
      setAudioDeviceDescriptors(audioDevices.value.deviceDescriptors ?? []);
      setAudioOutputChannelCounts(audioDevices.value.channelCounts ?? {});
      setDefaultAudioOutputDevice(audioDevices.value.defaultDevice ?? null);
    }
    if (midiInputs.status === "fulfilled") {
      setMidiInputDevices(midiInputs.value);
    }
    if (midiOutputs.status === "fulfilled") {
      setMidiOutputDevices(midiOutputs.value);
    }
    return normalizedSettings;
  }, [syncSettingsLanguage]);

  return {
    isSettingsModalOpen,
    setIsSettingsModalOpen,
    isRemoteModalOpen,
    setIsRemoteModalOpen,
    activeSettingsTab,
    setActiveSettingsTab,
    isSettingsLoading,
    setIsSettingsLoading,
    isSettingsSaving,
    setIsSettingsSaving,
    appSettings,
    setAppSettings,
    appSettingsRef,
    midiLearnFeedback,
    setMidiLearnFeedback,
    midiLearnView,
    setMidiLearnView,
    metronomeVolumeDraft,
    setMetronomeVolumeDraft,
    enabledOutputChannelsDraft,
    setEnabledOutputChannelsDraft,
    audioDeviceDescriptors,
    setAudioDeviceDescriptors,
    audioOutputChannelCounts,
    setAudioOutputChannelCounts,
    defaultAudioOutputDevice,
    setDefaultAudioOutputDevice,
    midiInputDevices,
    setMidiInputDevices,
    midiOutputDevices,
    setMidiOutputDevices,
    isMidiInputRefreshing,
    setIsMidiInputRefreshing,
    isAudioRefreshing,
    setIsAudioRefreshing,
    refreshAudioSettings,
  };
}
