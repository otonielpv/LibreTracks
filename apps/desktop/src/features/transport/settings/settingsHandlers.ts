import {
  normalizeAppSettings,
  type AppSettings,
  type AudioBackendKind,
  type AudioDeviceDescriptor,
} from "@libretracks/shared/models";

import {
  filterOutputChannelsForOutputCount,
  normalizeEnabledOutputChannelsForOutputCount,
} from "../helpers";

/**
 * Dependencies the settings handlers need from the host component. They are
 * passed in explicitly (rather than captured from a render closure) so the
 * factory has no hidden coupling to TransportPanelContent and can be unit
 * tested in isolation.
 *
 * IMPORTANT: `appSettingsRef` is a ref, not a snapshot. Every handler reads
 * `appSettingsRef.current` at call time, matching the monolith's original
 * behaviour — this is what keeps the handlers stable across renders and is the
 * reason extracting them does not change what re-renders.
 */
export type SettingsHandlerDeps = {
  appSettingsRef: { readonly current: AppSettings };
  /** Persist + push to the engine, then surface a success message. */
  persistAudioSettings: (
    nextSettings: AppSettings,
    successMessage: string | ((savedSettings: AppSettings) => string),
  ) => void;
  /** The currently selected output device's channel count. */
  getSelectedOutputChannelCount: () => number;
  /**
   * The live, in-progress channel selection the user is editing in the
   * settings modal (read at commit time). Distinct from the persisted
   * `appSettingsRef.current.enabledOutputChannels`.
   */
  getEnabledOutputChannelsDraft: () => number[];
  /** The current list of audio output device descriptors (read at call time). */
  getAudioDeviceDescriptors: () => AudioDeviceDescriptor[];
  /** Clears the MIDI-learn feedback toast when mappings are reset. */
  setMidiLearnFeedback: (feedback: null) => void;
  setEnabledOutputChannelsDraft: (
    next: number[] | ((previous: number[]) => number[]),
  ) => void;
  /** i18n: `t` for transport.* keys; `i18n.t` for the locale-change message. */
  t: (key: string, options?: Record<string, unknown>) => string;
  translateLocaleMessage: (savedSettings: AppSettings) => string;
};

/**
 * Pure-ish settings handlers extracted from TransportPanelContent. Each one is
 * a thin transform over `appSettingsRef.current` that delegates the actual
 * persistence to `persistAudioSettings`. No React state lives here.
 */
export function createSettingsHandlers(deps: SettingsHandlerDeps) {
  const {
    appSettingsRef,
    persistAudioSettings,
    getSelectedOutputChannelCount,
    getEnabledOutputChannelsDraft,
    getAudioDeviceDescriptors,
    setMidiLearnFeedback,
    setEnabledOutputChannelsDraft,
    t,
    translateLocaleMessage,
  } = deps;

  const audioRoutingUpdated = () =>
    t("transport.status.audioRoutingUpdated", {
      defaultValue: "Audio routing updated.",
    });

  const persistAudioPatch = (
    patch: Partial<AppSettings>,
    successMessage: string | ((savedSettings: AppSettings) => string),
  ) =>
    persistAudioSettings(
      normalizeAppSettings({ ...appSettingsRef.current, ...patch }),
      successMessage,
    );

  return {
    handleAudioBackendChange(nextValue: string) {
      const nextBackend = (nextValue || null) as AudioBackendKind | null;
      persistAudioPatch(
        {
          selectedAudioBackend: nextBackend,
          selectedOutputDevice: null,
          selectedOutputDeviceId: null,
          selectedOutputDeviceName: null,
        },
        audioRoutingUpdated(),
      );
    },

    handleOutputSampleRateChange(nextValue: string) {
      persistAudioPatch(
        { outputSampleRate: nextValue ? Number(nextValue) : null },
        audioRoutingUpdated(),
      );
    },

    handleOutputBufferSizeChange(nextValue: string) {
      persistAudioPatch(
        {
          outputBufferSize: nextValue
            ? { fixed: Number(nextValue) }
            : "default",
        },
        audioRoutingUpdated(),
      );
    },

    handleAudioSafeModeChange(enabled: boolean) {
      persistAudioPatch({ audioSafeMode: enabled }, audioRoutingUpdated());
    },

    handleEnabledOutputChannelChange(channelIndex: number, enabled: boolean) {
      setEnabledOutputChannelsDraft((previous) => {
        const next = new Set(
          filterOutputChannelsForOutputCount(
            previous,
            getSelectedOutputChannelCount(),
          ),
        );
        if (enabled) {
          next.add(channelIndex);
        } else {
          next.delete(channelIndex);
        }
        return Array.from(next).sort((left, right) => left - right);
      });
    },

    handleDiscardEnabledOutputChannels() {
      setEnabledOutputChannelsDraft(appSettingsRef.current.enabledOutputChannels);
    },

    handleSelectAllOutputChannels() {
      setEnabledOutputChannelsDraft(
        Array.from({ length: getSelectedOutputChannelCount() }, (_, i) => i),
      );
    },

    handleClearOutputChannels() {
      setEnabledOutputChannelsDraft([]);
    },

    handleCommitEnabledOutputChannels() {
      // Commit the draft the user just edited — NOT the previously-persisted
      // value. Reading appSettingsRef here silently discarded multichannel
      // selections and reverted them to stereo on save.
      const nextChannels = normalizeEnabledOutputChannelsForOutputCount(
        getEnabledOutputChannelsDraft(),
        getSelectedOutputChannelCount(),
      );
      persistAudioPatch(
        { enabledOutputChannels: nextChannels },
        audioRoutingUpdated(),
      );
    },

    handleMetronomeOutputChange(nextValue: string) {
      persistAudioPatch({ metronomeOutput: nextValue }, audioRoutingUpdated());
    },

    handleAudioOutputDeviceChange(nextValue: string) {
      const descriptor = getAudioDeviceDescriptors().find(
        (device) => device.stableId === nextValue,
      );
      const nextOutputChannelCount =
        descriptor?.maxOutputChannels ?? getSelectedOutputChannelCount();
      const currentSampleRate = appSettingsRef.current.outputSampleRate;
      const sampleRateSupported =
        currentSampleRate === null ||
        Boolean(descriptor?.supportedSampleRates.includes(currentSampleRate));
      const nextOutputSampleRate = sampleRateSupported
        ? currentSampleRate
        : null;
      persistAudioPatch(
        {
          selectedOutputDevice: descriptor?.name ?? null,
          selectedOutputDeviceId: descriptor?.stableId ?? null,
          selectedOutputDeviceName: descriptor?.name ?? null,
          outputSampleRate: nextOutputSampleRate,
          enabledOutputChannels: normalizeEnabledOutputChannelsForOutputCount(
            appSettingsRef.current.enabledOutputChannels,
            nextOutputChannelCount,
          ),
        },
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

    handleResetMidiMappings() {
      persistAudioPatch({ midiMappings: {} }, t("transport.status.midiMappingsReset"));
      setMidiLearnFeedback(null);
    },

    handleGlobalJumpModeChange(nextValue: AppSettings["globalJumpMode"]) {
      persistAudioPatch({ globalJumpMode: nextValue }, "Jump settings updated.");
    },

    handleGlobalJumpBarsChange(nextValue: number) {
      persistAudioPatch(
        { globalJumpBars: Math.max(1, Math.floor(nextValue) || 1) },
        "Jump settings updated.",
      );
    },

    handleSongJumpTriggerChange(nextValue: AppSettings["songJumpTrigger"]) {
      persistAudioPatch(
        { songJumpTrigger: nextValue },
        "Song jump settings updated.",
      );
    },

    handleSongJumpBarsChange(nextValue: number) {
      persistAudioPatch(
        { songJumpBars: Math.max(1, Math.floor(nextValue) || 1) },
        "Song jump settings updated.",
      );
    },

    handleSongTransitionModeChange(
      nextValue: AppSettings["songTransitionMode"],
    ) {
      persistAudioPatch(
        { songTransitionMode: nextValue },
        "Song transition updated.",
      );
    },

    handleVampModeChange(nextValue: AppSettings["vampMode"]) {
      persistAudioPatch({ vampMode: nextValue }, "Vamp settings updated.");
    },

    handleVampBarsChange(nextValue: number) {
      persistAudioPatch(
        { vampBars: Math.max(1, Math.floor(nextValue) || 1) },
        "Vamp settings updated.",
      );
    },

    handleTimelineNavigationSchemeChange(
      nextValue: "ableton" | "libretracks",
    ) {
      persistAudioPatch(
        { timelineNavigationScheme: nextValue },
        t("transport.status.timelineNavigationSchemeUpdated", {
          defaultValue: "Timeline navigation scheme updated.",
        }),
      );
    },

    handleTimelinePlayheadFollowModeChange(
      nextValue: AppSettings["timelinePlayheadFollowMode"],
    ) {
      persistAudioPatch(
        { timelinePlayheadFollowMode: nextValue },
        t("transport.status.timelinePlayheadFollowModeUpdated", {
          defaultValue: "Playhead follow mode updated.",
        }),
      );
    },

    handleLocaleChange(nextValue: string) {
      // Locale uses a raw merge (not normalizeAppSettings) to mirror the
      // monolith, and a function message that reads the *saved* locale.
      persistAudioSettings(
        { ...appSettingsRef.current, locale: nextValue || null },
        translateLocaleMessage,
      );
    },
  };
}

export type SettingsHandlers = ReturnType<typeof createSettingsHandlers>;
