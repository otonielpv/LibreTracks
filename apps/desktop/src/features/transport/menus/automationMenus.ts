import type {
  AutomationActionSummary,
  AutomationCueSummary,
  AutomationJumpTargetSummary,
  SongView,
} from "@libretracks/shared/models";
import { confirmDialog, promptDialog } from "../../../shared/dialog/dialogService";
import {
  addAutomationTrack,
  deleteAutomationCue,
  removeAutomationTrack,
  setAutomationTrackEnabled,
  upsertAutomationCue,
} from "../desktopApi";
import { markerCategory } from "../markerKinds";
import type { ContextMenuAction } from "../types";
import type { TimelineMenuDeps } from "./timelineMenus";

/**
 * Automation cues and the automation lane: create/edit/move a cue, its menu,
 * the lane's menu and the mix scenes. Split out of timelineMenus.ts (under a
 * size budget) so the DAW and the Setlist lanes share one implementation.
 */

export function defaultAutomationTarget(
  currentSong: SongView,
  positionSeconds: number,
): AutomationJumpTargetSummary | null {
  const nextRegion = [...currentSong.regions]
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .find((region) => region.startSeconds > positionSeconds + 0.01);
  if (nextRegion) {
    return { kind: "region", regionId: nextRegion.id };
  }

  const nextMarker = [...currentSong.sectionMarkers]
    .filter((marker) => markerCategory(marker) === "section")
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .find((marker) => marker.startSeconds > positionSeconds + 0.01);
  if (nextMarker) {
    return { kind: "marker", markerId: nextMarker.id };
  }

  const firstRegion = currentSong.regions[0];
  if (firstRegion) {
    return { kind: "region", regionId: firstRegion.id };
  }

  const firstMarker = currentSong.sectionMarkers.find(
    (marker) => markerCategory(marker) === "section",
  );
  if (firstMarker) {
    return { kind: "marker", markerId: firstMarker.id };
  }

  return null;
}

export function createAutomationMenus(getDeps: () => TimelineMenuDeps) {
  // Shared by the ruler menu and the automation-lane menu: open the visual cue
  // editor seeded with a sensible default target. The actual upsert happens in
  // handleConfirmAutomationCue when the user confirms. Creating a cue implies
  // the automation track is present (the backend sets track_present).
  function createAutomationCueAt(positionSeconds: number) {
    const d = getDeps();
    const currentSong = d.songRef.current;
    if (!currentSong) {
      return;
    }

    // A new cue starts with a single jump action seeded to the next destination
    // (if any). The user can then add/remove/reorder actions in the modal. With
    // no regions and no markers there is nothing sensible to jump to, so the
    // cue opens empty and the user picks the action (pad, mute, exact
    // position…) — the editor requires at least one before confirming.
    const defaultTarget = defaultAutomationTarget(currentSong, positionSeconds);
    const seedActions: AutomationActionSummary[] = defaultTarget
      ? [{ type: "jump", target: defaultTarget, transition: { mode: "instant" } }]
      : [];

    d.setAutomationCueDraft({
      atSeconds: positionSeconds,
      cueId: null,
      name: null,
      maxRuns: null,
      actions: seedActions,
    });
  }

  // Open the editor for an existing cue (used by the cue's context menu).
  function editAutomationCue(cue: AutomationCueSummary) {
    getDeps().setAutomationCueDraft({
      atSeconds: cue.atSeconds,
      cueId: cue.id,
      name: cue.name,
      maxRuns: cue.maxRuns ?? null,
      actions: cue.actions,
    });
  }

  function automationCueContextMenu(
    cue: AutomationCueSummary,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    return [
      {
        label: t("transport.automation.editCue"),
        onSelect: () => editAutomationCue(cue),
      },
      {
        label: t("transport.automation.renameCue"),
        onSelect: async () => {
          const nextName = (
            await promptDialog(t("transport.automation.renameCuePrompt"), cue.name)
          )?.trim();
          if (!nextName) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot = await upsertAutomationCue({
              ...cue,
              name: nextName,
            });
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.setStatus(
              t("transport.automation.statusCueRenamed", {
                name: nextName,
              }),
            );
          });
        },
      },
      {
        label: t(
          cue.enabled
            ? "transport.automation.disableCue"
            : "transport.automation.enableCue",
        ),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await upsertAutomationCue({
              ...cue,
              enabled: !cue.enabled,
            });
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.setStatus(
              t(
                cue.enabled
                  ? "transport.automation.statusCueDisabled"
                  : "transport.automation.statusCueEnabled",
              ),
            );
          });
        },
      },
      {
        label: t("transport.automation.deleteCue"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteAutomationCue(cue.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.setStatus(
              t("transport.automation.statusCueDeleted", {
                name: cue.name,
              }),
            );
          });
        },
      },
    ];
  }

  // Reduced menu for the synthetic automation lane: it has no volume/pan/color
  // and removing it deletes every cue (no ghost jumps).
  function automationTrackContextMenu(): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    return [
      {
        label: t("transport.automation.createCueHere"),
        onSelect: () =>
          createAutomationCueAt(d.displayPositionSecondsRef.current),
      },
      {
        label: t("transport.automation.manageScenes"),
        onSelect: () => d.setIsMixSceneModalOpen(true),
      },
      {
        label: t("transport.automation.removeTrack"),
        onSelect: async () => {
          if (
            !(await confirmDialog(
              t("transport.automation.removeTrackConfirm"),
            ))
          ) {
            return;
          }
          await d.runAction(async () => {
            const nextSnapshot = await removeAutomationTrack();
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.setStatus(t("transport.automation.statusTrackRemoved"));
          });
        },
      },
    ];
  }

  // Add the synthetic automation lane after `afterTrackId` (null = first row).
  async function handleAddAutomationTrack(afterTrackId: string | null) {
    const d = getDeps();
    await d.runAction(async () => {
      const nextSnapshot = await addAutomationTrack(afterTrackId);
      d.applyPlaybackSnapshot(nextSnapshot);
      await d.refreshSongView({ includeWaveforms: false, sync: true });
      d.setStatus(d.t("transport.automation.statusTrackAdded"));
    });
  }

  // A cue dragged along its lane: re-upsert the whole cue with only its
  // position changed, so name/enabled/maxRuns/actions survive the move (the
  // DAW's ruler does the same in markerMoveHandlers).
  async function moveAutomationCue(cueId: string, atSeconds: number) {
    const d = getDeps();
    const cue = d.songRef.current?.automationCues?.find((candidate) => candidate.id === cueId);
    if (!cue || Math.abs(cue.atSeconds - atSeconds) < 1e-6) return;
    await d.runAction(async () => {
      const nextSnapshot = await upsertAutomationCue({ ...cue, atSeconds });
      d.applyPlaybackSnapshot(nextSnapshot);
      await d.refreshSongView({ includeWaveforms: false, sync: true });
    });
  }

  /** The lane's on/off switch; its cues stay authored either way. */
  async function setAutomationTrackOn(enabled: boolean) {
    const d = getDeps();
    await d.runAction(async () => {
      const nextSnapshot = await setAutomationTrackEnabled(enabled);
      d.applyPlaybackSnapshot(nextSnapshot);
      await d.refreshSongView({ includeWaveforms: false, sync: true });
      d.setStatus(
        d.t(enabled ? "transport.automation.statusTrackEnabled" : "transport.automation.statusTrackDisabled"),
      );
    });
  }

  /** The mix scenes manager (MixSceneModal). */
  function openMixScenes() {
    getDeps().setIsMixSceneModalOpen(true);
  }

  return {
    createAutomationCueAt,
    editAutomationCue,
    automationCueContextMenu,
    automationTrackContextMenu,
    handleAddAutomationTrack,
    moveAutomationCue,
    setAutomationTrackOn,
    openMixScenes,
  };
}
