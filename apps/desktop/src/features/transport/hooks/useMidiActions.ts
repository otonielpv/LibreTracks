import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { TFunction } from "i18next";
import type { AppSettings, SectionMarkerSummary, SongView, TransportSnapshot } from "@libretracks/shared/models";
import { normalizeAppSettings } from "@libretracks/shared/models";
import {
  cancelMarkerJump,
  isTauriApp,
  listenToMidiRawMessage,
  saveSettings,
  updateAudioSettings,
} from "../desktopApi";
import {
  findMidiMappingKeyForMessage,
  formatMidiBinding,
} from "../helpers";
import { useTimelineUIStore } from "../uiStore";
import type { MidiLearnFeedback } from "../types";

type UseMidiActionsProps = {
  songRef: MutableRefObject<SongView | null>;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
  appSettingsRef: MutableRefObject<AppSettings>;
  selectedRegionId: string | null;
  formatMidiLearnCommandLabel: (key: string) => string;
  runAction: (work: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setAppSettings: (settings: AppSettings) => void;
  setMidiLearnMode: (mode: string | null) => void;
  setMidiLearnFeedback: (feedback: MidiLearnFeedback | null) => void;
  setSelectedRegionId: (id: string | null) => void;
  setContextMenu: (menu: null) => void;
  setStatus: (status: string) => void;
  selectSection: (id: string) => void;
  handleSelectedRegionTransposeChange: (semitones: number) => void;
  scheduleMarkerJumpWithGlobalMode: (markerId: string, markerName: string) => Promise<unknown>;
  t: TFunction;
};

export function useMidiActions({
  songRef,
  snapshotRef,
  appSettingsRef,
  selectedRegionId,
  formatMidiLearnCommandLabel,
  runAction,
  applyPlaybackSnapshot,
  setAppSettings,
  setMidiLearnMode,
  setMidiLearnFeedback,
  setSelectedRegionId,
  setContextMenu,
  setStatus,
  selectSection,
  handleSelectedRegionTransposeChange,
  scheduleMarkerJumpWithGlobalMode,
  t,
}: UseMidiActionsProps) {
  function handleSelectRegionFromMidi(direction: -1 | 1) {
    const effectSong = songRef.current;
    if (!effectSong || effectSong.regions.length === 0) {
      return;
    }

    const orderedRegions = [...effectSong.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const currentIndex = orderedRegions.findIndex(
      (region) => region.id === selectedRegionId,
    );
    const nextIndex =
      currentIndex === -1
        ? 0
        : Math.max(
            0,
            Math.min(orderedRegions.length - 1, currentIndex + direction),
          );
    const nextRegion = orderedRegions[nextIndex] ?? null;

    if (!nextRegion) {
      return;
    }

    setSelectedRegionId(nextRegion.id);
    setStatus(t("transport.status.regionSelected", { name: nextRegion.name }));
  }

  function handleRegionTransposeFromMidi(
    commandKey:
      | "action:region_transpose_up"
      | "action:region_transpose_down"
      | "action:region_transpose_reset",
  ) {
    const effectSong = songRef.current;
    if (!effectSong || !selectedRegionId) {
      return;
    }

    const currentRegion =
      effectSong.regions.find((region) => region.id === selectedRegionId) ??
      null;
    if (!currentRegion) {
      return;
    }

    const nextTransposeSemitones =
      commandKey === "action:region_transpose_reset"
        ? 0
        : currentRegion.transposeSemitones +
          (commandKey === "action:region_transpose_up" ? 1 : -1);

    handleSelectedRegionTransposeChange(nextTransposeSemitones);
  }

  async function handleMarkerPrimaryAction(section: SectionMarkerSummary) {
    selectSection(section.id);
    setSelectedRegionId(null);
    setContextMenu(null);

    if (snapshotRef.current?.pendingMarkerJump?.targetMarkerId === section.id) {
      const nextSnapshot = await cancelMarkerJump();
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.jumpCancelledSection", { name: section.name }),
      );
      return;
    }

    await scheduleMarkerJumpWithGlobalMode(section.id, section.name);
  }

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
          handleSelectRegionFromMidi(-1);
        } else if (mappedKey === "action:select_next_region") {
          handleSelectRegionFromMidi(1);
        } else if (
          mappedKey === "action:region_transpose_up" ||
          mappedKey === "action:region_transpose_down" ||
          mappedKey === "action:region_transpose_reset"
        ) {
          handleRegionTransposeFromMidi(mappedKey);
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
  }, [formatMidiLearnCommandLabel, runAction, setMidiLearnMode, t]);

  return {
    handleSelectRegionFromMidi,
    handleRegionTransposeFromMidi,
    handleMarkerPrimaryAction,
  };
}
