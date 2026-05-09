import { useCallback, useRef } from "react";
import type { MutableRefObject } from "react";
import type { i18n as I18n } from "i18next";
import type { TFunction } from "i18next";
import {
  normalizeAppSettings,
  type AppSettings,
  type AudioBackendKind,
  type AudioDeviceDescriptor,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import {
  getAudioOutputDevices,
  getMidiInputs,
  isTauriApp,
  updateAudioSettings,
  updateTrack,
} from "../desktopApi";
import type { MidiLearnFeedback } from "../types";

type UseSettingsPanelHandlersProps = {
  t: TFunction;
  i18n: I18n;
  midiLearnMode: string | null;
  appSettings: AppSettings;
  appSettingsRef: MutableRefObject<AppSettings>;
  audioDeviceDescriptors: AudioDeviceDescriptor[];
  isMidiInputRefreshing: boolean;
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  setStatus: (status: string) => void;
  formatErrorStatus: (error: unknown) => string;
  persistAudioSettings: (
    nextSettings: AppSettings,
    successMessage: string | ((savedSettings: AppSettings) => string),
  ) => void;
  setMidiLearnMode: (mode: string | null) => void;
  setMidiLearnFeedback: (feedback: MidiLearnFeedback | null) => void;
  setMissingMidiDeviceWarning: (warning: string | null) => void;
  setIsSettingsModalOpen: (
    open: boolean | ((current: boolean) => boolean),
  ) => void;
  setIsRemoteModalOpen: (
    open: boolean | ((current: boolean) => boolean),
  ) => void;
  setAppSettings: (settings: AppSettings) => void;
  setMetronomeVolumeDraft: (volume: number) => void;
  setAudioDeviceDescriptors: (desc: AudioDeviceDescriptor[]) => void;
  setAudioOutputChannelCounts: (counts: Record<string, number>) => void;
  setDefaultAudioOutputDevice: (device: string | null) => void;
  setIsSettingsLoading: (loading: boolean) => void;
  setMidiInputDevices: (devices: string[]) => void;
  setIsMidiInputRefreshing: (refreshing: boolean) => void;
};

export function useSettingsPanelHandlers({
  t,
  i18n,
  midiLearnMode,
  appSettings,
  appSettingsRef,
  audioDeviceDescriptors,
  isMidiInputRefreshing,
  runAction,
  applyPlaybackSnapshot,
  setStatus,
  formatErrorStatus,
  persistAudioSettings,
  setMidiLearnMode,
  setMidiLearnFeedback,
  setMissingMidiDeviceWarning,
  setIsSettingsModalOpen,
  setIsRemoteModalOpen,
  setAppSettings,
  setMetronomeVolumeDraft,
  setAudioDeviceDescriptors,
  setAudioOutputChannelCounts,
  setDefaultAudioOutputDevice,
  setIsSettingsLoading,
  setMidiInputDevices,
  setIsMidiInputRefreshing,
}: UseSettingsPanelHandlersProps) {
  const metronomeLiveRequestIdRef = useRef(0);

  const handleMidiLearnToggle = useCallback(
    (options?: { closePanels?: boolean }) => {
      if (options?.closePanels) {
        setIsSettingsModalOpen(false);
        setIsRemoteModalOpen(false);
      }
      setMidiLearnMode(midiLearnMode === null ? "" : null);
    },
    [midiLearnMode, setIsSettingsModalOpen, setIsRemoteModalOpen, setMidiLearnMode],
  );

  const handleMidiLearnTarget = useCallback(
    (controlKey: string, options?: { arm?: boolean }) => {
      if (midiLearnMode === null && !options?.arm) {
        return false;
      }
      setMidiLearnMode(controlKey);
      return true;
    },
    [midiLearnMode, setMidiLearnMode],
  );

  const handleMidiLearnCommandRelearn = useCallback(
    (controlKey: string) => {
      setMidiLearnMode(controlKey);
    },
    [setMidiLearnMode],
  );

  const handleDynamicMidiLearnJump = useCallback(
    (kind: "marker" | "song") => {
      const maxIndex = kind === "marker" ? 100 : 20;
      const rawValue = window.prompt(
        kind === "marker"
          ? t("transport.settingsModal.midiLearnMapMarkerPrompt")
          : t("transport.settingsModal.midiLearnMapSongPrompt"),
      );
      if (rawValue === null) {
        return;
      }

      const index = Number(rawValue.trim());
      if (!Number.isInteger(index) || index < 1 || index > maxIndex) {
        return;
      }

      handleMidiLearnTarget(
        kind === "marker"
          ? `action:jump_marker_${index}`
          : `action:jump_song_${index}`,
        { arm: true },
      );
    },
    [t, handleMidiLearnTarget],
  );

  const handleResetMidiMappings = useCallback(() => {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        midiMappings: {},
      }),
      t("transport.status.midiMappingsReset"),
    );
    setMidiLearnFeedback(null);
  }, [appSettingsRef, persistAudioSettings, setMidiLearnFeedback, t]);

  const handleAudioOutputDeviceChange = useCallback(
    (nextValue: string) => {
      const descriptor = audioDeviceDescriptors.find(
        (device) => device.stableId === nextValue,
      );
      const currentSampleRate = appSettingsRef.current.outputSampleRate;
      const sampleRateSupported =
        currentSampleRate === null ||
        Boolean(descriptor?.supportedSampleRates.includes(currentSampleRate));
      const nextOutputSampleRate = sampleRateSupported
        ? currentSampleRate
        : null;
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          selectedOutputDevice: descriptor?.name ?? null,
          selectedOutputDeviceId: descriptor?.stableId ?? null,
          selectedOutputDeviceName: descriptor?.name ?? null,
          outputSampleRate: nextOutputSampleRate,
        }),
        !sampleRateSupported && currentSampleRate !== null
          ? t("transport.status.outputSampleRateResetUnsupported", {
              sampleRate: currentSampleRate,
              defaultValue:
                "The selected device does not support {{sampleRate}} Hz. Output sample rate was changed to Auto.",
            })
          : descriptor
            ? t("transport.status.audioDeviceUpdated", {
                name: descriptor.name,
              })
            : t("transport.status.audioDeviceSystemDefault"),
      );
    },
    [appSettingsRef, audioDeviceDescriptors, persistAudioSettings, t],
  );

  const handleAudioBackendChange = useCallback(
    (nextValue: string) => {
      const nextBackend = (nextValue || null) as AudioBackendKind | null;
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          selectedAudioBackend: nextBackend,
          selectedOutputDevice: null,
          selectedOutputDeviceId: null,
          selectedOutputDeviceName: null,
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleOutputSampleRateChange = useCallback(
    (nextValue: string) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          outputSampleRate: nextValue ? Number(nextValue) : null,
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleOutputBufferSizeChange = useCallback(
    (nextValue: string) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          outputBufferSize: nextValue
            ? { fixed: Number(nextValue) }
            : "default",
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleAudioSafeModeChange = useCallback(
    (enabled: boolean) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          audioSafeMode: enabled,
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleRefreshAudioDevices = useCallback(() => {
    setIsSettingsLoading(true);
    void runAction(async () => {
      try {
        const nextAudioDevices = await getAudioOutputDevices();
        setAudioDeviceDescriptors(nextAudioDevices.deviceDescriptors ?? []);
        setAudioOutputChannelCounts(nextAudioDevices.channelCounts ?? {});
        setDefaultAudioOutputDevice(nextAudioDevices.defaultDevice ?? null);
        setStatus(
          t("transport.status.audioDevicesRefreshed", {
            defaultValue: "Audio device list refreshed.",
          }),
        );
      } finally {
        setIsSettingsLoading(false);
      }
    });
  }, [
    runAction,
    setAudioDeviceDescriptors,
    setAudioOutputChannelCounts,
    setDefaultAudioOutputDevice,
    setIsSettingsLoading,
    setStatus,
    t,
  ]);

  const handleEnabledOutputChannelChange = useCallback(
    (channelIndex: number, enabled: boolean) => {
      const currentChannels = new Set(
        appSettingsRef.current.enabledOutputChannels,
      );
      if (enabled) {
        currentChannels.add(channelIndex);
      } else {
        currentChannels.delete(channelIndex);
      }

      const nextChannels = Array.from(currentChannels).sort(
        (left, right) => left - right,
      );
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          enabledOutputChannels: nextChannels.length ? nextChannels : [0, 1],
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleMetronomeOutputChange = useCallback(
    (nextValue: string) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          metronomeOutput: nextValue,
        }),
        t("transport.status.audioRoutingUpdated", {
          defaultValue: "Audio routing updated.",
        }),
      );
    },
    [appSettingsRef, persistAudioSettings, t],
  );

  const handleTrackAudioToChange = useCallback(
    (trackId: string, nextAudioTo: string) => {
      void runAction(async () => {
        const nextSnapshot = await updateTrack({
          trackId,
          audioTo: nextAudioTo,
        });
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.trackRoutingUpdated", {
            defaultValue: "Track routing updated.",
          }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus, t],
  );

  const handleMetronomeEnabledChange = useCallback(
    (nextValue: boolean) => {
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        metronomeEnabled: nextValue,
      });

      appSettingsRef.current = nextSettings;
      setAppSettings(nextSettings);

      void runAction(async () => {
        const liveSettings = normalizeAppSettings(
          await updateAudioSettings(nextSettings),
        );
        appSettingsRef.current = liveSettings;
        setAppSettings(liveSettings);
        setStatus(
          nextValue
            ? t("transport.status.metronomeEnabled")
            : t("transport.status.metronomeDisabled"),
        );
      });
    },
    [appSettingsRef, runAction, setAppSettings, setStatus, t],
  );

  const handleMetronomeVolumeDraftChange = useCallback(
    (nextValue: number) => {
      const normalizedValue = Math.max(0, Math.min(1, nextValue));
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        metronomeVolume: normalizedValue,
      });
      const requestId = metronomeLiveRequestIdRef.current + 1;

      metronomeLiveRequestIdRef.current = requestId;
      appSettingsRef.current = nextSettings;
      setMetronomeVolumeDraft(normalizedValue);
      setAppSettings(nextSettings);

      void updateAudioSettings(nextSettings)
        .then((liveSettings) => {
          if (metronomeLiveRequestIdRef.current !== requestId) {
            return;
          }

          const normalizedLiveSettings = normalizeAppSettings(liveSettings);
          appSettingsRef.current = normalizedLiveSettings;
          setAppSettings(normalizedLiveSettings);
        })
        .catch((error) => {
          if (metronomeLiveRequestIdRef.current !== requestId) {
            return;
          }

          setStatus(formatErrorStatus(error));
        });
    },
    [
      appSettingsRef,
      formatErrorStatus,
      setAppSettings,
      setMetronomeVolumeDraft,
      setStatus,
    ],
  );

  const commitMetronomeVolumeDraft = useCallback(
    (nextValue: number) => {
      const normalizedValue = Math.max(0, Math.min(1, nextValue));
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        metronomeVolume: normalizedValue,
      });

      appSettingsRef.current = nextSettings;
      setMetronomeVolumeDraft(normalizedValue);
      setAppSettings(nextSettings);

      void runAction(async () => {
        try {
          const liveSettings = normalizeAppSettings(
            await updateAudioSettings(nextSettings),
          );
          appSettingsRef.current = liveSettings;
          setAppSettings(liveSettings);
          setStatus(
            t("transport.status.metronomeVolumeUpdated", {
              volume: Math.round(liveSettings.metronomeVolume * 100),
            }),
          );
        } catch (error) {
          setStatus(formatErrorStatus(error));
        }
      });
    },
    [
      appSettingsRef,
      formatErrorStatus,
      runAction,
      setAppSettings,
      setMetronomeVolumeDraft,
      setStatus,
      t,
    ],
  );

  const handleGlobalJumpModeChange = useCallback(
    (nextValue: AppSettings["globalJumpMode"]) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          globalJumpMode: nextValue,
        }),
        "Jump settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleGlobalJumpBarsChange = useCallback(
    (nextValue: number) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          globalJumpBars: Math.max(1, Math.floor(nextValue) || 1),
        }),
        "Jump settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleSongJumpTriggerChange = useCallback(
    (nextValue: AppSettings["songJumpTrigger"]) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          songJumpTrigger: nextValue,
        }),
        "Song jump settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleSongJumpBarsChange = useCallback(
    (nextValue: number) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          songJumpBars: Math.max(1, Math.floor(nextValue) || 1),
        }),
        "Song jump settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleSongTransitionModeChange = useCallback(
    (nextValue: AppSettings["songTransitionMode"]) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          songTransitionMode: nextValue,
        }),
        "Song transition updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleVampModeChange = useCallback(
    (nextValue: AppSettings["vampMode"]) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          vampMode: nextValue,
        }),
        "Vamp settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleVampBarsChange = useCallback(
    (nextValue: number) => {
      persistAudioSettings(
        normalizeAppSettings({
          ...appSettingsRef.current,
          vampBars: Math.max(1, Math.floor(nextValue) || 1),
        }),
        "Vamp settings updated.",
      );
    },
    [appSettingsRef, persistAudioSettings],
  );

  const handleMidiInputDeviceChange = useCallback(
    (nextValue: string) => {
      persistAudioSettings(
        {
          ...appSettings,
          selectedMidiDevice: nextValue || null,
        },
        nextValue
          ? t("transport.status.midiDeviceUpdated", { name: nextValue })
          : t("transport.status.midiDeviceDisabled"),
      );
    },
    [appSettings, persistAudioSettings, t],
  );

  const handleRefreshMidiInputDevices = useCallback(async () => {
    if (!isTauriApp || isMidiInputRefreshing) {
      return;
    }

    setIsMidiInputRefreshing(true);
    try {
      const nextMidiInputs = await getMidiInputs();
      setMidiInputDevices(nextMidiInputs);
      setStatus(t("transport.status.midiDevicesRefreshed"));
    } catch (error) {
      setStatus(formatErrorStatus(error));
    } finally {
      setIsMidiInputRefreshing(false);
    }
  }, [
    formatErrorStatus,
    isMidiInputRefreshing,
    setIsMidiInputRefreshing,
    setMidiInputDevices,
    setStatus,
    t,
  ]);

  const handleDismissMissingMidiDeviceWarning = useCallback(() => {
    setMissingMidiDeviceWarning(null);
  }, [setMissingMidiDeviceWarning]);

  const handleHideMissingMidiDeviceWarning = useCallback(() => {
    setMissingMidiDeviceWarning(null);
    persistAudioSettings(
      {
        ...appSettings,
        suppressMissingMidiDeviceWarning: true,
      },
      t("transport.status.midiWarningHidden"),
    );
  }, [appSettings, persistAudioSettings, setMissingMidiDeviceWarning, t]);

  const handleLocaleChange = useCallback(
    (nextValue: string) => {
      persistAudioSettings(
        {
          ...appSettings,
          locale: nextValue || null,
        },
        (savedSettings) =>
          savedSettings.locale
            ? i18n.t("transport.status.settingsLanguageUpdated", {
                name: i18n.t(
                  savedSettings.locale === "es"
                    ? "transport.settingsModal.languageSpanish"
                    : "transport.settingsModal.languageEnglish",
                ),
              })
            : i18n.t("transport.status.settingsLanguageSystem"),
      );
    },
    [appSettings, i18n, persistAudioSettings],
  );

  return {
    handleMidiLearnToggle,
    handleMidiLearnTarget,
    handleMidiLearnCommandRelearn,
    handleDynamicMidiLearnJump,
    handleResetMidiMappings,
    handleAudioOutputDeviceChange,
    handleAudioBackendChange,
    handleOutputSampleRateChange,
    handleOutputBufferSizeChange,
    handleAudioSafeModeChange,
    handleRefreshAudioDevices,
    handleEnabledOutputChannelChange,
    handleMetronomeOutputChange,
    handleTrackAudioToChange,
    handleMetronomeEnabledChange,
    handleMetronomeVolumeDraftChange,
    commitMetronomeVolumeDraft,
    handleGlobalJumpModeChange,
    handleGlobalJumpBarsChange,
    handleSongJumpTriggerChange,
    handleSongJumpBarsChange,
    handleSongTransitionModeChange,
    handleVampModeChange,
    handleVampBarsChange,
    handleMidiInputDeviceChange,
    handleRefreshMidiInputDevices,
    handleDismissMissingMidiDeviceWarning,
    handleHideMissingMidiDeviceWarning,
    handleLocaleChange,
  };
}

