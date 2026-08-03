import { promptDialog } from "../../../shared/dialog/dialogService";
import { deleteTrack, updateTrack } from "../desktopApi";
import type { MidiClipSummary, TrackSummary } from "@libretracks/shared/models";
import type { ContextMenuAction } from "../types";
import type { TimelineMenuDeps, ColorPickerPopoverState } from "./timelineMenus";

/**
 * Context menus and dialog openers for the MIDI feature.
 *
 * Split out of timelineMenus.ts, which is under a size budget: a MIDI track's
 * menu shares nothing with an audio track's (no clips to warn about on delete,
 * no folder nesting) so it was never going to fold into the audio builder.
 */
export function createMidiMenus(
  getDeps: () => TimelineMenuDeps,
  openColorMenu: (
    title: string,
    initialColor: string | null | undefined,
    onApply: (color: string | null) => Promise<void>,
  ) => void,
) {
/** Open the editor for a brand-new MIDI clip on `trackId` at `atSeconds`. */
function createMidiClipAt(trackId: string, atSeconds: number) {
  const d = getDeps();
  d.setMidiClipDraft({
    clipId: null,
    trackId,
    timelineStartSeconds: Math.max(0, atSeconds),
    name: d.t("transport.midi.trackDefaultName"),
    events: [],
  });
}

/** Open the editor for an existing MIDI clip. */
function editMidiClip(clip: MidiClipSummary) {
  getDeps().setMidiClipDraft({
    clipId: clip.id,
    trackId: clip.trackId,
    timelineStartSeconds: clip.timelineStartSeconds,
    name: clip.name,
    events: clip.events,
  });
}

function midiClipContextMenu(clip: MidiClipSummary): ContextMenuAction[] {
  const d = getDeps();
  const { t } = d;
  return [
    {
      label: t("transport.midi.editClip"),
      onSelect: () => editMidiClip(clip),
    },
    {
      label: t("transport.midi.deleteClip"),
      onSelect: () => {
        void d.deleteMidiClip(clip.id);
      },
    },
  ];
}

/** Right-click on empty space of a MIDI lane: offer to add a clip there. */
function midiLaneContextMenu(
  trackId: string,
  atSeconds: number,
): ContextMenuAction[] {
  const d = getDeps();
  return [
    {
      label: d.t("transport.midi.addClip"),
      onSelect: () => createMidiClipAt(trackId, atSeconds),
    },
  ];
}

/**
 * Menu for a MIDI track. Deliberately NOT the audio menu: a MIDI track has
 * no clips to worry about when deleting, no folder nesting, and its useful
 * actions (add a message bundle, point it at a port) don't exist for audio.
 */
function midiTrackContextMenu(track: TrackSummary): ContextMenuAction[] {
  const d = getDeps();
  const { t } = d;
  return [
    {
      label: t("transport.midi.addClip"),
      onSelect: () =>
        createMidiClipAt(track.id, d.displayPositionSecondsRef.current),
    },
    {
      label: t("transport.midi.routeModalTitle"),
      onSelect: () => d.openMidiRouteEditor(track.id),
    },
    {
      label: track.midiEnabled === false
        ? t("transport.midi.enableTrack")
        : t("transport.midi.disableTrack"),
      onSelect: () => d.toggleMidiTrackEnabled(track.id),
    },
    {
      label: t("common.rename"),
      shortcut: d.shortcutHint("edit.rename"),
      onSelect: async () => {
        const nextName = (
          await promptDialog(t("transport.prompt.trackRename"), track.name)
        )?.trim();
        if (!nextName) return;
        await d.runAction(async () => {
          const nextSnapshot = await updateTrack({
            trackId: track.id,
            name: nextName,
          });
          d.applyPlaybackSnapshot(nextSnapshot);
          d.setStatus(t("transport.status.trackRenamed", { name: nextName }));
        });
      },
    },
    {
      label: "Seleccionar color...",
      swatch: track.color ?? undefined,
      onSelect: () =>
        openColorMenu(`Color: ${track.name}`, track.color, (color) =>
          d.handleSetTrackColor(track, color).then(() => undefined),
        ),
    },
    {
      label: t("common.delete"),
      onSelect: async () => {
        await d.runAction(async () => {
          const nextSnapshot = await deleteTrack(track.id);
          d.optimisticallyAppliedRevisionsRef.current.add(
            nextSnapshot.projectRevision,
          );
          d.applyPlaybackSnapshot(nextSnapshot);
          await d.refreshSongView({ includeWaveforms: false });
          d.setStatus(
            t("transport.status.trackDeleted", { name: track.name }),
          );
        });
      },
    },
  ];
}


  return {
    createMidiClipAt,
    editMidiClip,
    midiClipContextMenu,
    midiLaneContextMenu,
    midiTrackContextMenu,
  };
}
