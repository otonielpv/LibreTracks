import type { TrackSummary } from "@libretracks/shared/models";

import type { ContextMenuAction } from "../types";

/** Mix edits that apply to a whole set of tracks at once. */
export type MultiTrackMixActions = {
  nudgeVolumeDb: (trackIds: string[], deltaDb: number) => void;
  setVolume: (trackIds: string[], volume: number) => void;
  nudgePan: (trackIds: string[], deltaPan: number) => void;
  setPan: (trackIds: string[], pan: number) => void;
  setAudioTo: (trackIds: string[], audioTo: string) => void;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type MultiTrackMixMenuArgs = {
  tracks: TrackSummary[];
  t: Translate;
  routingOptions: Array<{ value: string; label: string }>;
  mix: MultiTrackMixActions;
  /** Opens a nested menu, offset from the current one. */
  openSubMenu: (title: string, actions: ContextMenuAction[]) => void;
};

/** dB steps offered for a selection, loudest boost first. */
const VOLUME_STEPS_DB = [6, 3, 1, -1, -3, -6];

/** Pan steps, in the [-1, 1] space the model already uses. */
const PAN_STEPS = [-0.25, -0.1, 0.1, 0.25];

/**
 * Volume, pan and routing for a multi-selection of tracks.
 *
 * Dragging one fader of a selection already fans out to the rest, but on a
 * phone the track headers collapse to a name and the mute/solo pair, so there
 * was no fader to drag and no other way in.
 *
 * Steps rather than a slider: they fit the menu the selection bar already
 * opens, and — more importantly — they carry the same RELATIVE semantics as
 * the drag, so the group keeps its internal balance instead of every track
 * being flattened to one value. The three "reset" entries are the deliberate
 * exception, where making every track equal is the whole point.
 */
export function multiTrackMixActions({
  tracks,
  t,
  routingOptions,
  mix,
  openSubMenu,
}: MultiTrackMixMenuArgs): ContextMenuAction[] {
  const trackIds = tracks.map((track) => track.id);
  const count = tracks.length;

  const volumeStep = (deltaDb: number): ContextMenuAction => ({
    label: t("transport.menu.volumeStep", {
      sign: deltaDb > 0 ? "+" : "−",
      db: Math.abs(deltaDb),
    }),
    onSelect: () => mix.nudgeVolumeDb(trackIds, deltaDb),
  });

  const panStep = (deltaPan: number): ContextMenuAction => ({
    label: t("transport.menu.panStep", {
      sign: deltaPan > 0 ? "→" : "←",
      amount: Math.round(Math.abs(deltaPan) * 100),
    }),
    onSelect: () => mix.nudgePan(trackIds, deltaPan),
  });

  const volumeTitle = t("transport.menu.volumeOfTracks", { count });
  const panTitle = t("transport.menu.panOfTracks", { count });
  const routingTitle = t("transport.menu.routingOfTracks", { count });

  return [
    {
      label: volumeTitle,
      onSelect: () =>
        openSubMenu(volumeTitle, [
          ...VOLUME_STEPS_DB.map(volumeStep),
          {
            label: t("transport.menu.volumeReset"),
            onSelect: () => mix.setVolume(trackIds, 1),
          },
        ]),
    },
    {
      label: panTitle,
      onSelect: () =>
        openSubMenu(panTitle, [
          ...PAN_STEPS.map(panStep),
          {
            label: t("transport.menu.panCenter"),
            onSelect: () => mix.setPan(trackIds, 0),
          },
          {
            label: t("transport.menu.panHardLeft"),
            onSelect: () => mix.setPan(trackIds, -1),
          },
          {
            label: t("transport.menu.panHardRight"),
            onSelect: () => mix.setPan(trackIds, 1),
          },
        ]),
    },
    {
      label: routingTitle,
      // With no outputs to choose from the entry would open an empty menu.
      disabled: routingOptions.length === 0,
      onSelect: () =>
        openSubMenu(
          routingTitle,
          routingOptions.map((option) => ({
            label: option.label,
            onSelect: () => mix.setAudioTo(trackIds, option.value),
          })),
        ),
    },
  ];
}
