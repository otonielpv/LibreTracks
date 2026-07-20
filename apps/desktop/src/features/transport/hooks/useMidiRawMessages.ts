import { useEffect } from "react";

import {
  normalizeAppSettings,
  type AppSettings,
} from "@libretracks/shared/models";

import {
  isTauriApp,
  listenToMidiRawMessage,
  saveSettings,
  updateAudioSettings,
} from "../desktopApi";
import { findMidiMappingKeyForMessage, formatMidiBinding } from "../helpers";
import { useTimelineUIStore } from "../uiStore";

type MidiBinding = { status: number; data1: number; isCc: boolean };

/** The mapped MIDI commands that nudge the selected region's transpose. */
type RegionTransposeCommandKey =
  | "action:region_transpose_up"
  | "action:region_transpose_down"
  | "action:region_transpose_reset";

export type UseMidiRawMessagesOptions = {
  /** Live settings mirror; read at call time, never captured. */
  appSettingsRef: { current: AppSettings };
  setAppSettings: (settings: AppSettings) => void;
  setMidiLearnMode: (mode: string | null) => void;
  setMidiLearnFeedback: (
    feedback: { key: string; binding: MidiBinding } | null,
  ) => void;
  setStatus: (message: string) => void;
  runAction: (action: () => Promise<void>) => Promise<void>;
  formatMidiLearnCommandLabel: (key: string) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
  /**
   * Region actions triggered by mapped MIDI. Passed through refs because the
   * originals are function declarations further down the component body —
   * reading them directly here would capture them before they exist.
   */
  onSelectRegionRef: { current: ((direction: -1 | 1) => void) | null };
  onRegionTransposeRef: {
    current: ((mappedKey: RegionTransposeCommandKey) => void) | null;
  };
};

/**
 * Raw MIDI input listener. Two modes:
 *
 * - Learn armed: bind the next message to the pending target. The write is
 *   optimistic (settings mirror + state update happen immediately) and rolled
 *   back if persisting fails.
 * - Otherwise: resolve the message against the configured mappings and fire
 *   the matching region action.
 */
export function useMidiRawMessages({
  appSettingsRef,
  setAppSettings,
  setMidiLearnMode,
  setMidiLearnFeedback,
  setStatus,
  runAction,
  formatMidiLearnCommandLabel,
  t,
  onSelectRegionRef,
  onRegionTransposeRef,
}: UseMidiRawMessagesOptions) {
  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let unlisten: (() => void) | null = null;
    void listenToMidiRawMessage((message) => {
      const learnMode = useTimelineUIStore.getState().midiLearnMode;
      if (learnMode === null) {
        const mappedKey = findMidiMappingKeyForMessage(
          appSettingsRef.current.midiMappings,
          message,
        );

        if (mappedKey === "action:select_previous_region") {
          onSelectRegionRef.current?.(-1);
        } else if (mappedKey === "action:select_next_region") {
          onSelectRegionRef.current?.(1);
        } else if (
          mappedKey === "action:region_transpose_up" ||
          mappedKey === "action:region_transpose_down" ||
          mappedKey === "action:region_transpose_reset"
        ) {
          onRegionTransposeRef.current?.(mappedKey);
        }

        return;
      }

      if (learnMode === "") {
        return;
      }

      const nextBinding = {
        status: message.status,
        data1: message.data1,
        isCc: (message.status & 0xf0) === 0xb0,
      };
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        midiMappings: {
          ...appSettingsRef.current.midiMappings,
          [learnMode]: nextBinding,
        },
      });
      const previousSettings = appSettingsRef.current;
      const learnedCommandLabel = formatMidiLearnCommandLabel(learnMode);

      appSettingsRef.current = nextSettings;
      setAppSettings(nextSettings);
      setMidiLearnMode(null);

      void runAction(async () => {
        try {
          const liveSettings = normalizeAppSettings(
            await updateAudioSettings(nextSettings),
          );
          const savedSettings = normalizeAppSettings(
            await saveSettings(liveSettings),
          );
          appSettingsRef.current = savedSettings;
          setAppSettings(savedSettings);
          setMidiLearnFeedback({ key: learnMode, binding: nextBinding });
          setStatus(
            t("transport.status.midiBindingLearned", {
              key: learnedCommandLabel,
              binding: formatMidiBinding(nextBinding),
            }),
          );
        } catch (error) {
          appSettingsRef.current = previousSettings;
          setAppSettings(previousSettings);
          setMidiLearnMode(learnMode);
          throw error;
        }
      });
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatMidiLearnCommandLabel, runAction, setMidiLearnMode, t]);
}
