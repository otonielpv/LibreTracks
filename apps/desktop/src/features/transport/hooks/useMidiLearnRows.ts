import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@libretracks/shared/models";
import { MIDI_LEARN_COMMANDS } from "../constants";
import { describeMidiTarget } from "../midi/controllerTargets";
import type { MidiLearnView } from "../panels/MidiLearnSettingsTab";
import { useSongStore } from "../songStore";
import type { MidiLearnCommandRow, MidiLearnFeedback } from "../types";

/** The rows of Settings › MIDI Learn and the label of any learnable key:
 * the fixed commands plus the jump-to-marker/song keys already learned. */
export function useMidiLearnRows({
  midiMappings,
  midiLearnView,
  midiLearnFeedback,
  midiLearnMode,
}: {
  midiMappings: AppSettings["midiMappings"];
  midiLearnView: MidiLearnView;
  midiLearnFeedback: MidiLearnFeedback | null;
  midiLearnMode: string | null;
}) {
  const { t } = useTranslation();
  const midiLearnCommandRows = useMemo(
    () =>
      MIDI_LEARN_COMMANDS.map((command) => ({
        ...command,
        label: t(command.labelKey),
        binding: midiMappings[command.key] ?? null,
      })) satisfies MidiLearnCommandRow[],
    [midiMappings, t],
  );
  const dynamicMidiLearnJumpRows = useMemo(
    () =>
      Object.entries(midiMappings)
        .filter(([key]) => {
          if (key.startsWith("action:jump_marker_")) {
            const index = Number(key.slice("action:jump_marker_".length));
            return Number.isInteger(index) && index >= 1 && index <= 100;
          }

          if (key.startsWith("action:jump_song_")) {
            const index = Number(key.slice("action:jump_song_".length));
            return Number.isInteger(index) && index >= 1 && index <= 20;
          }

          return false;
        })
        .map(([key, binding]) => {
          const markerIndex = key.startsWith("action:jump_marker_")
            ? Number(key.slice("action:jump_marker_".length))
            : null;
          const songIndex = key.startsWith("action:jump_song_")
            ? Number(key.slice("action:jump_song_".length))
            : null;
          return {
            key,
            label:
              markerIndex !== null && Number.isInteger(markerIndex)
                ? t("transport.settingsModal.midiLearnJumpMarker", {
                    index: markerIndex,
                  })
                : t("transport.settingsModal.midiLearnJumpSong", {
                    index: songIndex,
                  }),
            binding,
          };
        })
        .sort((left, right) =>
          left.key.localeCompare(right.key, undefined, { numeric: true }),
        ),
    [midiMappings, t],
  );
  const midiLearnRows = useMemo(
    () => [...midiLearnCommandRows, ...dynamicMidiLearnJumpRows],
    [dynamicMidiLearnJumpRows, midiLearnCommandRows],
  );
  const midiLearnMarkerRows = useMemo(
    () =>
      dynamicMidiLearnJumpRows.filter((command) =>
        command.key.startsWith("action:jump_marker_"),
      ),
    [dynamicMidiLearnJumpRows],
  );
  const midiLearnSongRows = useMemo(
    () =>
      dynamicMidiLearnJumpRows.filter((command) =>
        command.key.startsWith("action:jump_song_"),
      ),
    [dynamicMidiLearnJumpRows],
  );
  const visibleMidiLearnRows = useMemo(() => {
    if (midiLearnView === "markers") {
      return midiLearnMarkerRows;
    }

    if (midiLearnView === "songs") {
      return midiLearnSongRows;
    }

    return midiLearnCommandRows;
  }, [
    midiLearnCommandRows,
    midiLearnMarkerRows,
    midiLearnSongRows,
    midiLearnView,
  ]);
  const midiLearnFeedbackCommand = useMemo(
    () =>
      midiLearnRows.find((command) => command.key === midiLearnFeedback?.key) ??
      null,
    [midiLearnRows, midiLearnFeedback],
  );
  const formatMidiLearnCommandLabel = useCallback(
    (key: string) => {
      const learnedRow = midiLearnRows.find((command) => command.key === key);
      if (learnedRow) {
        return learnedRow.label;
      }

      if (key.startsWith("action:jump_marker_")) {
        const index = Number(key.slice("action:jump_marker_".length));
        if (Number.isInteger(index) && index >= 1 && index <= 100) {
          return t("transport.settingsModal.midiLearnJumpMarker", { index });
        }
      }

      if (key.startsWith("action:jump_song_")) {
        const index = Number(key.slice("action:jump_song_".length));
        if (Number.isInteger(index) && index >= 1 && index <= 20) {
          return t("transport.settingsModal.midiLearnJumpSong", { index });
        }
      }

      return describeMidiTarget(key, t, useSongStore.getState().song) ?? key;
    },
    [midiLearnRows, t],
  );
  const activeMidiLearnCommand = useMemo(
    () =>
      midiLearnMode === null
        ? null
        : {
            key: midiLearnMode,
            label: formatMidiLearnCommandLabel(midiLearnMode),
            binding: midiMappings[midiLearnMode] ?? null,
          },
    [formatMidiLearnCommandLabel, midiLearnMode, midiMappings],
  );

  return {
    midiLearnMarkerRows,
    midiLearnSongRows,
    visibleMidiLearnRows,
    midiLearnFeedbackCommand,
    formatMidiLearnCommandLabel,
    activeMidiLearnCommand,
  };
}
