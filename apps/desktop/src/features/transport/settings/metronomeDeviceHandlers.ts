import {
  normalizeAppSettings,
  type AppSettings,
  type AudioDeviceDescriptor,
} from "@libretracks/shared/models";

/**
 * Dependencies for the metronome / audio-device / MIDI-input settings handlers.
 * These differ from the pure transform handlers in settingsHandlers.ts: they own
 * realtime engine calls (which must NOT reopen the audio device) and write React
 * state directly, so they need the relevant setters injected.
 *
 * As with settingsHandlers, every handler reads `appSettingsRef.current` at call
 * time — the host keeps that ref in sync with `appSettings` via an effect — so
 * the factory only closes over stable identities and never has to be re-created.
 */
export type MetronomeDeviceHandlerDeps = {
  appSettingsRef: { current: AppSettings };
  /** Persist + push to the engine via update_audio_settings (reopens device). */
  persistAudioSettings: (
    nextSettings: AppSettings,
    successMessage: string | ((savedSettings: AppSettings) => string),
  ) => void;
  setAppSettings: (settings: AppSettings) => void;
  setMetronomeVolumeDraft: (volume: number) => void;
  setIsSettingsLoading: (loading: boolean) => void;
  setIsMidiInputRefreshing: (refreshing: boolean) => void;
  setAudioDeviceDescriptors: (descriptors: AudioDeviceDescriptor[]) => void;
  setAudioOutputChannelCounts: (counts: Record<string, number>) => void;
  setDefaultAudioOutputDevice: (device: string | null) => void;
  setMidiInputDevices: (devices: string[]) => void;
  /** Guards against out-of-order realtime volume responses. */
  metronomeLiveRequestIdRef: { current: number };
  /** True only inside the Tauri shell; gates the MIDI refresh. */
  isTauriApp: boolean;
  /** Current value of the isMidiInputRefreshing flag, read at call time. */
  isMidiInputRefreshing: () => boolean;
  runAction: (action: () => Promise<void>) => Promise<void>;
  setStatus: (message: string) => void;
  formatErrorStatus: (error: unknown) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
  // Engine / persistence API (injected so this module stays free of the
  // desktopApi import graph and is trivially mockable in tests).
  getAudioOutputDevices: (options?: {
    force?: boolean;
  }) => Promise<AudioDeviceListLike>;
  getMidiInputs: () => Promise<string[]>;
  setMetronomeSoundRealtime: (settings: AppSettings) => Promise<AppSettings>;
  setMetronomeEnabledRealtime: (enabled: boolean) => Promise<void>;
  setMetronomeVolumeRealtime: (volume: number) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
};

type AudioDeviceListLike = {
  deviceDescriptors?: AudioDeviceDescriptor[];
  channelCounts?: Record<string, number>;
  defaultDevice?: string | null;
};

const clampVolume = (value: number) => Math.max(0, Math.min(1, value));

export function createMetronomeDeviceHandlers(
  deps: MetronomeDeviceHandlerDeps,
) {
  const {
    appSettingsRef,
    persistAudioSettings,
    setAppSettings,
    setMetronomeVolumeDraft,
    setIsSettingsLoading,
    setIsMidiInputRefreshing,
    setAudioDeviceDescriptors,
    setAudioOutputChannelCounts,
    setDefaultAudioOutputDevice,
    setMidiInputDevices,
    metronomeLiveRequestIdRef,
    isTauriApp,
    isMidiInputRefreshing,
    runAction,
    setStatus,
    formatErrorStatus,
    t,
    getAudioOutputDevices,
    getMidiInputs,
    setMetronomeSoundRealtime,
    setMetronomeEnabledRealtime,
    setMetronomeVolumeRealtime,
    saveSettings,
  } = deps;

  /** Apply a settings patch locally (state + ref) and return the normalized result. */
  const applyLocal = (patch: Partial<AppSettings>) => {
    const nextSettings = normalizeAppSettings({
      ...appSettingsRef.current,
      ...patch,
    });
    appSettingsRef.current = nextSettings;
    setAppSettings(nextSettings);
    return nextSettings;
  };

  return {
    handleRefreshAudioDevices() {
      setIsSettingsLoading(true);
      void runAction(async () => {
        try {
          const nextAudioDevices = await getAudioOutputDevices({ force: true });
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
    },

    handleMetronomeSoundChange(patch: Partial<AppSettings>) {
      // Realtime path: push the new click config straight to the engine and
      // persist it, WITHOUT going through update_audio_settings (which reopens
      // the audio device and would pause/resume playback on every tweak).
      const nextSettings = applyLocal(patch);

      void runAction(async () => {
        try {
          const savedSettings = normalizeAppSettings(
            await setMetronomeSoundRealtime(nextSettings),
          );
          appSettingsRef.current = savedSettings;
          setAppSettings(savedSettings);
          setStatus(
            t("transport.status.metronomeSoundUpdated", {
              defaultValue: "Metronome sound updated.",
            }),
          );
        } catch (error) {
          setStatus(formatErrorStatus(error));
        }
      });
    },

    handleMetronomeEnabledChange(nextValue: boolean) {
      const nextSettings = applyLocal({ metronomeEnabled: nextValue });

      void runAction(async () => {
        await setMetronomeEnabledRealtime(nextValue);
        const savedSettings = normalizeAppSettings(
          await saveSettings(nextSettings),
        );
        appSettingsRef.current = savedSettings;
        setAppSettings(savedSettings);
        setStatus(
          nextValue
            ? t("transport.status.metronomeEnabled")
            : t("transport.status.metronomeDisabled"),
        );
      });
    },

    handleMetronomeVolumeDraftChange(nextValue: number) {
      const normalizedValue = clampVolume(nextValue);
      const requestId = metronomeLiveRequestIdRef.current + 1;
      metronomeLiveRequestIdRef.current = requestId;

      applyLocal({ metronomeVolume: normalizedValue });
      setMetronomeVolumeDraft(normalizedValue);

      void setMetronomeVolumeRealtime(normalizedValue)
        .then(() => {
          if (metronomeLiveRequestIdRef.current !== requestId) {
            return;
          }
        })
        .catch((error) => {
          if (metronomeLiveRequestIdRef.current !== requestId) {
            return;
          }
          setStatus(formatErrorStatus(error));
        });
    },

    commitMetronomeVolumeDraft(nextValue: number) {
      const normalizedValue = clampVolume(nextValue);
      const nextSettings = applyLocal({ metronomeVolume: normalizedValue });
      setMetronomeVolumeDraft(normalizedValue);

      void runAction(async () => {
        try {
          await setMetronomeVolumeRealtime(normalizedValue);
          const savedSettings = normalizeAppSettings(
            await saveSettings(nextSettings),
          );
          appSettingsRef.current = savedSettings;
          setAppSettings(savedSettings);
          setStatus(
            t("transport.status.metronomeVolumeUpdated", {
              volume: Math.round(savedSettings.metronomeVolume * 100),
            }),
          );
        } catch (error) {
          setStatus(formatErrorStatus(error));
        }
      });
    },

    handleMidiInputDeviceChange(nextValue: string) {
      persistAudioSettings(
        {
          ...appSettingsRef.current,
          selectedMidiDevice: nextValue || null,
        },
        nextValue
          ? t("transport.status.midiDeviceUpdated", { name: nextValue })
          : t("transport.status.midiDeviceDisabled"),
      );
    },

    async handleRefreshMidiInputDevices() {
      if (!isTauriApp || isMidiInputRefreshing()) {
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
    },
  };
}

export type MetronomeDeviceHandlers = ReturnType<
  typeof createMetronomeDeviceHandlers
>;
