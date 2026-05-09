import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { i18n as I18n } from "i18next";
import type { TFunction } from "i18next";
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
  type AudioDeviceDescriptor,
  type RemoteServerInfo,
} from "@libretracks/shared/models";
import {
  getAudioOutputDevices,
  getMidiInputs,
  getRemoteServerInfo,
  getSettings,
  isTauriApp,
  listenToSettingsUpdated,
  saveSettings,
  updateAudioSettings,
} from "../desktopApi";
import { getSystemLanguage } from "../../../shared/i18n";
import { buildAudioRoutingOptions, isAudioDeviceVisibleForBackend } from "../helpers";
import { HARDWARE_OUTPUT_CHANNEL_COUNT } from "../constants";
import type { SettingsTab } from "../types";

type UseSettingsControllerProps = {
  i18n: I18n;
  t: TFunction;
  runAction: (work: () => Promise<void>) => Promise<void>;
  setStatus: (status: string) => void;
  formatErrorStatus: (error: unknown) => string;
};

export function useSettingsController({
  i18n,
  t,
  runAction,
  setStatus,
  formatErrorStatus,
}: UseSettingsControllerProps) {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isRemoteModalOpen, setIsRemoteModalOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>("audio");
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [appSettings, setAppSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [metronomeVolumeDraft, setMetronomeVolumeDraft] = useState(
    DEFAULT_APP_SETTINGS.metronomeVolume,
  );
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
  const [isMidiInputRefreshing, setIsMidiInputRefreshing] = useState(false);
  const [remoteServerInfo, setRemoteServerInfo] =
    useState<RemoteServerInfo | null>(null);

  const appSettingsRef = useRef(appSettings);

  const syncSettingsLanguage = useCallback(
    async (settings: AppSettings) => {
      await i18n.changeLanguage(settings.locale || getSystemLanguage());
    },
    [i18n],
  );

  const refreshAudioSettings = useCallback(async () => {
    const [nextSettings, nextAudioDevices, nextMidiInputs] = await Promise.all([
      getSettings(),
      getAudioOutputDevices(),
      getMidiInputs(),
    ]);
    const normalizedSettings = normalizeAppSettings(nextSettings);
    setAppSettings(normalizedSettings);
    await syncSettingsLanguage(normalizedSettings);
    setAudioDeviceDescriptors(nextAudioDevices.deviceDescriptors ?? []);
    setAudioOutputChannelCounts(nextAudioDevices.channelCounts ?? {});
    setDefaultAudioOutputDevice(nextAudioDevices.defaultDevice ?? null);
    setMidiInputDevices(nextMidiInputs);
    return normalizedSettings;
  }, [syncSettingsLanguage]);

  const persistAudioSettings = useCallback(
    (
      nextSettings: AppSettings,
      successMessage: string | ((savedSettings: AppSettings) => string),
    ) => {
      const previousSettings = appSettingsRef.current;
      const normalizedSettings = normalizeAppSettings(nextSettings);
      setAppSettings(normalizedSettings);
      setIsSettingsSaving(true);

      void runAction(async () => {
        try {
          const liveSettings = normalizeAppSettings(
            await updateAudioSettings(normalizedSettings),
          );
          const savedSettings = normalizeAppSettings(
            await saveSettings(liveSettings),
          );
          setAppSettings(savedSettings);
          await syncSettingsLanguage(savedSettings);
          setStatus(
            typeof successMessage === "function"
              ? successMessage(savedSettings)
              : successMessage,
          );
        } catch (error) {
          appSettingsRef.current = previousSettings;
          setAppSettings(previousSettings);
          throw error;
        } finally {
          setIsSettingsSaving(false);
        }
      });
    },
    [appSettings, runAction, syncSettingsLanguage, setStatus],
  );

  useEffect(() => {
    if (isSettingsModalOpen) {
      setActiveSettingsTab("audio");
    }
  }, [isSettingsModalOpen]);

  useEffect(() => {
    setMetronomeVolumeDraft(appSettings.metronomeVolume);
  }, [appSettings.metronomeVolume]);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    void getRemoteServerInfo()
      .then((info) => {
        setRemoteServerInfo(info);
      })
      .catch(() => {
        setRemoteServerInfo(null);
      });
  }, []);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let unlisten: (() => void) | null = null;
    void listenToSettingsUpdated((nextSettings) => {
      const normalizedSettings = normalizeAppSettings(nextSettings);
      appSettingsRef.current = normalizedSettings;
      setAppSettings(normalizedSettings);
      setMetronomeVolumeDraft(normalizedSettings.metronomeVolume);
      void syncSettingsLanguage(normalizedSettings);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [syncSettingsLanguage]);

  useEffect(() => {
    let active = true;

    void refreshAudioSettings()
      .catch((error) => {
        if (!active) {
          return;
        }
        setStatus(formatErrorStatus(error));
      })
      .finally(() => {
        if (active) {
          setIsSettingsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [refreshAudioSettings, formatErrorStatus, setStatus]);

  useEffect(() => {
    if (!isSettingsModalOpen && !isRemoteModalOpen) {
      return () => {};
    }

    let active = true;
    void Promise.all([getAudioOutputDevices(), getMidiInputs()])
      .then(([nextAudioDevices, nextMidiInputs]) => {
        if (!active) {
          return;
        }
        setAudioDeviceDescriptors(nextAudioDevices.deviceDescriptors ?? []);
        setAudioOutputChannelCounts(nextAudioDevices.channelCounts ?? {});
        setDefaultAudioOutputDevice(nextAudioDevices.defaultDevice ?? null);
        setMidiInputDevices(nextMidiInputs);
      })
      .catch((error) => {
        if (active) {
          setStatus(formatErrorStatus(error));
        }
      });

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsModalOpen(false);
        setIsRemoteModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      active = false;
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isRemoteModalOpen, isSettingsModalOpen, formatErrorStatus, setStatus]);

  // Derived audio/MIDI settings values
  const audioBackendOptions = useMemo(
    () =>
      Array.from(
        new Set(audioDeviceDescriptors.map((device) => device.backend)),
      ).sort((left, right) => left.localeCompare(right)),
    [audioDeviceDescriptors],
  );
  const selectedAudioBackend = appSettings.selectedAudioBackend ?? null;
  const audioDevicesForSelectedBackend = useMemo(
    () =>
      audioDeviceDescriptors.filter(
        (device) => isAudioDeviceVisibleForBackend(device, selectedAudioBackend),
      ),
    [audioDeviceDescriptors, selectedAudioBackend],
  );
  const selectedAudioOutputDevice = appSettings.selectedOutputDeviceId ?? "";
  const selectedAudioOutputDescriptor =
    audioDeviceDescriptors.find(
      (device) => device.stableId === appSettings.selectedOutputDeviceId,
    ) ??
    audioDeviceDescriptors.find(
      (device) =>
        device.backend === selectedAudioBackend &&
        device.name === appSettings.selectedOutputDevice,
    ) ??
    null;
  const previewAudioOutputDescriptor =
    selectedAudioOutputDescriptor ??
    audioDevicesForSelectedBackend.find((device) => device.isDefault) ??
    audioDevicesForSelectedBackend[0] ??
    null;
  const selectedMidiInputDevice = appSettings.selectedMidiDevice ?? "";
  const selectedLocale = appSettings.locale ?? "";
  const audioRoutingOptions = useMemo(
    () => buildAudioRoutingOptions(appSettings.enabledOutputChannels, t),
    [appSettings.enabledOutputChannels, t],
  );
  const selectedOutputChannelCount = Math.max(
    1,
    Math.min(
      64,
      (previewAudioOutputDescriptor
        ? audioOutputChannelCounts[previewAudioOutputDescriptor.stableId]
        : undefined) ??
        audioOutputChannelCounts[appSettings.selectedOutputDevice ?? ""] ??
        (defaultAudioOutputDevice
          ? audioOutputChannelCounts[defaultAudioOutputDevice]
          : undefined) ??
        HARDWARE_OUTPUT_CHANNEL_COUNT,
    ),
  );
  const selectedAudioOutputDeviceMissing = Boolean(
    appSettings.selectedOutputDeviceId &&
    !audioDeviceDescriptors.some(
      (device) => device.stableId === appSettings.selectedOutputDeviceId,
    ),
  );
  const outputSampleRates = previewAudioOutputDescriptor?.supportedSampleRates ?? [];
  const outputSampleRateOptions = outputSampleRates.filter(
    (sampleRate, index, values) => values.indexOf(sampleRate) === index,
  );
  const autoOutputSampleRateLabel = previewAudioOutputDescriptor?.defaultSampleRate
    ? t("transport.settingsModal.sampleRateAutoWithDefault", {
        sampleRate: previewAudioOutputDescriptor.defaultSampleRate,
        defaultValue: "Auto - device default: {{sampleRate}} Hz",
      })
    : t("transport.settingsModal.sampleRateAuto", {
        defaultValue: "Auto - device default",
      });
  const outputBufferSizes = previewAudioOutputDescriptor?.supportedBufferSizes ?? [];
  const selectedMidiInputDeviceMissing = Boolean(
    appSettings.selectedMidiDevice &&
    !midiInputDevices.includes(appSettings.selectedMidiDevice),
  );
  const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "audio", label: t("transport.settingsModal.tabAudio", { defaultValue: "Audio" }) },
    { id: "metronome", label: t("transport.settingsModal.tabMetronome", { defaultValue: "Metronome" }) },
    { id: "general", label: t("transport.settingsModal.tabGeneral", { defaultValue: "General" }) },
    { id: "midi", label: t("transport.settingsModal.tabMidi", { defaultValue: "MIDI" }) },
    { id: "midiLearn", label: t("transport.settingsModal.tabMidiLearn", { defaultValue: "MIDI Learn" }) },
  ];

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
    appSettings,
    setAppSettings,
    metronomeVolumeDraft,
    setMetronomeVolumeDraft,
    audioDeviceDescriptors,
    setAudioDeviceDescriptors,
    audioOutputChannelCounts,
    setAudioOutputChannelCounts,
    defaultAudioOutputDevice,
    setDefaultAudioOutputDevice,
    midiInputDevices,
    setMidiInputDevices,
    isMidiInputRefreshing,
    setIsMidiInputRefreshing,
    remoteServerInfo,
    appSettingsRef,
    syncSettingsLanguage,
    refreshAudioSettings,
    persistAudioSettings,
    audioBackendOptions,
    selectedAudioBackend,
    audioDevicesForSelectedBackend,
    selectedAudioOutputDevice,
    selectedAudioOutputDescriptor,
    previewAudioOutputDescriptor,
    selectedMidiInputDevice,
    selectedLocale,
    audioRoutingOptions,
    selectedOutputChannelCount,
    selectedAudioOutputDeviceMissing,
    outputSampleRates,
    outputSampleRateOptions,
    autoOutputSampleRateLabel,
    outputBufferSizes,
    selectedMidiInputDeviceMissing,
    settingsTabs,
  };
}
