import type { MouseEvent as ReactMouseEvent } from "react";
import {
  getEffectiveBpmAt,
  type AppSettings,
  type AutomationActionSummary,
  type AutomationCueSummary,
  type AutomationJumpTargetSummary,
  type ClipSummary,
  type MarkerKind,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
  type TempoMarkerSummary,
  type TimeSignatureMarkerSummary,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import {
  confirmDialog,
  promptDialog,
} from "../../../shared/dialog/dialogService";
import { clientToZoomedCoords } from "../../../shared/uiZoom";
import {
  addAutomationTrack,
  createSectionMarker,
  createSongRegion,
  deleteAutomationCue,
  deleteClip,
  deleteSectionMarker,
  deleteSongRegion,
  deleteSongTempoMarker,
  deleteSongTimeSignatureMarker,
  deleteTrack,
  moveTrack,
  removeAutomationTrack,
  scheduleMarkerJump,
  setSectionMarkerColor,
  setSectionMarkerKind,
  splitClip,
  splitClips,
  updateSectionMarker,
  updateSongRegion,
  updateSongRegionKey,
  updateSongRegionWarp,
  updateSongTempo,
  updateSongTimeSignature,
  updateTrack,
  upsertAutomationCue,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
  SONG_KEY_OPTIONS,
} from "../desktopApi";
import {
  MARKER_KINDS as SECTION_KINDS,
  availableCueKinds,
  markerColor,
  markerKindCategory,
  markerKindColor,
  markerKindLabel,
  markerKindVariants,
} from "../markerKinds";
import { AUTOMATION_TRACK_ID } from "../library/pendingAudioImports";
import { useTimelineUIStore } from "../uiStore";
import {
  clipDisplayName,
  findPreviousFolderTrack,
  findTrack,
  formatBpmDraft,
  formatClock,
} from "../helpers";
import {
  TIMELINE_COLOR_PRESETS,
  normalizeTimelineColorInput,
  resolveSharedTimelineColor,
} from "../colors/timelineColors";
import type {
  ContextMenuAction,
  ContextMenuState,
  TimelineRangeSelection,
} from "../types";
import type { AutomationCueDraft } from "../panels/AutomationCueModal";
import type { ExportSongTarget } from "../panels/ExportSongModal";
import type { ShortcutActionId } from "../keyboard/actions";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ColorPickerPopoverState = {
  x: number;
  y: number;
  title: string;
  initialColor: string;
  onApply: (color: string) => Promise<void>;
};

export function createAutomationCueId() {
  return `automation_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function automationTargetLabel(
  currentSong: SongView,
  target: AutomationJumpTargetSummary,
  t: Translate,
) {
  if (target.kind === "region") {
    return (
      currentSong.regions.find((region) => region.id === target.regionId)
        ?.name ?? t("transport.automation.defaultRegionTarget")
    );
  }

  if (target.kind === "marker") {
    return (
      currentSong.sectionMarkers.find(
        (marker) => marker.id === target.markerId,
      )?.name ?? t("transport.automation.defaultMarkerTarget")
    );
  }

  return formatClock(target.seconds);
}

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
    .filter((marker) => markerKindCategory(marker.kind) === "section")
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
    (marker) => markerKindCategory(marker.kind) === "section",
  );
  if (firstMarker) {
    return { kind: "marker", markerId: firstMarker.id };
  }

  return null;
}

/**
 * Dependencies for the timeline context-menu builders extracted from
 * TransportPanelContent. The factory is instantiated once (useMemo with [])
 * and reads a fresh deps snapshot through `getDeps` on every invocation, so
 * the returned functions are referentially stable while never seeing stale
 * state — the same ref-mirror pattern as the other create*Handlers slices.
 */
export type TimelineMenuDeps = {
  t: Translate;
  shortcutHint: (actionId: ShortcutActionId) => string;
  song: SongView | null;
  songBaseBpm: number;
  displayedTimeSignature: string;
  appSettings: AppSettings;
  selectedClipIds: string[];
  selectedClipSummaries: ClipSummary[];
  songRef: { current: SongView | null };
  displayPositionSecondsRef: { current: number };
  contextMenuPositionRef: { current: { x: number; y: number } };
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  tempoDraftDirtyRef: { current: boolean };
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<unknown>;
  setStatus: (message: string) => void;
  setContextMenu: (next: ContextMenuState) => void;
  setColorPickerPopover: (next: ColorPickerPopoverState | null) => void;
  setTempoDraft: (next: string) => void;
  setTimeSignatureDraft: (next: string) => void;
  setSelectedRegionId: (next: string | null) => void;
  setSelectedTimelineRange: (next: TimelineRangeSelection | null) => void;
  setSelectedClipId: (next: string | null) => void;
  setSelectedSectionId: (next: string | null) => void;
  setExportSongTarget: (next: ExportSongTarget | null) => void;
  setAutomationCueDraft: (next: AutomationCueDraft | null) => void;
  setIsMixSceneModalOpen: (next: boolean) => void;
  clearSelection: () => void;
  selectTrack: (trackIds: string[]) => void;
  recordRecentColor: (color: string | null) => void;
  splitSongRegionAtCursor: (
    regionId: string,
    regionStart: number,
    regionEnd: number,
  ) => Promise<unknown>;
  duplicateClipGroup: (
    sourceClips: ClipSummary[],
    targetStartSeconds?: number,
  ) => Promise<unknown>;
  syncSongLibraryFolderAfterRename: (
    oldSongName: string,
    newSongName: string,
  ) => Promise<unknown>;
  clearLibraryDragPreview: () => void;
  handleCreateTrack: (
    kind: TrackKind,
    anchorTrack: TrackSummary | null,
    parentTrackId?: string | null,
  ) => Promise<void>;
  handleSetTrackColor: (
    track: TrackSummary,
    color: string | null,
  ) => Promise<unknown>;
  handleSetTrackColors: (
    tracks: TrackSummary[],
    color: string | null,
  ) => Promise<unknown>;
  handleSetClipColor: (
    clip: ClipSummary,
    color: string | null,
  ) => Promise<unknown>;
};

export function createTimelineMenus(getDeps: () => TimelineMenuDeps) {
  function openMenu(
    event: ReactMouseEvent,
    title: string,
    actions: ContextMenuAction[],
  ) {
    const d = getDeps();
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = clientToZoomedCoords(event.clientX, event.clientY);
    d.contextMenuPositionRef.current = { x, y };
    d.setColorPickerPopover(null);
    d.setContextMenu({
      x,
      y,
      title,
      actions,
    });
  }

  function bumpContextMenuPosition() {
    const d = getDeps();
    const position = d.contextMenuPositionRef.current;
    const next = { x: position.x + 12, y: position.y + 12 };
    d.contextMenuPositionRef.current = next;
    return next;
  }

  function openCustomColorPopover(
    title: string,
    initialColor: string | null | undefined,
    onColor: (color: string) => Promise<void>,
  ) {
    const d = getDeps();
    const position = d.contextMenuPositionRef.current;
    d.setColorPickerPopover({
      x: position.x + 12,
      y: position.y + 12,
      title,
      initialColor: normalizeTimelineColorInput(initialColor) ?? "#3CDDC7",
      onApply: onColor,
    });
  }

  function colorPickerActions(args: {
    title: string;
    currentColor?: string | null;
    onColor: (color: string | null) => Promise<void>;
  }): ContextMenuAction[] {
    const d = getDeps();
    // Single funnel: record every applied non-null colour as "recent" so the
    // popover's Recientes row stays in sync regardless of entry point (preset,
    // custom popover, or recent swatch).
    const applyColor = async (color: string | null) => {
      d.recordRecentColor(color);
      await args.onColor(color);
    };
    return [
      ...TIMELINE_COLOR_PRESETS.map((preset) => ({
        label: `${preset.label}${args.currentColor === preset.value ? " (actual)" : ""}`,
        swatch: preset.value,
        onSelect: () => applyColor(preset.value),
      })),
      {
        label: "Personalizado...",
        swatch: args.currentColor ?? "#3CDDC7",
        onSelect: () =>
          openCustomColorPopover(args.title, args.currentColor, (color) =>
            applyColor(color),
          ),
      },
      {
        label: "Quitar color",
        disabled: !args.currentColor,
        onSelect: () => args.onColor(null),
      },
    ];
  }

  function openColorMenu(
    title: string,
    currentColor: string | null | undefined,
    onColor: (color: string | null) => Promise<void>,
  ) {
    const d = getDeps();
    const position = d.contextMenuPositionRef.current;
    const nextPosition = {
      x: position.x + 12,
      y: position.y + 12,
    };
    d.contextMenuPositionRef.current = nextPosition;
    d.setContextMenu({
      x: nextPosition.x,
      y: nextPosition.y,
      title,
      actions: colorPickerActions({ title, currentColor, onColor }),
    });
  }

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
    // (if any). The user can then add/remove/reorder actions in the modal.
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

  function rulerContextMenu(
    positionSeconds: number,
    timelineRange: TimelineRangeSelection | null,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t, song } = d;
    const createMarkerAction: ContextMenuAction = timelineRange
      ? {
          label: t("transport.menu.createSongRegionFromSelection"),
          onSelect: async () => {
            await d.runAction(async () => {
              const nextSnapshot = await createSongRegion(
                timelineRange.startSeconds,
                timelineRange.endSeconds,
              );
              d.applyPlaybackSnapshot(nextSnapshot);
              d.clearSelection();
              d.setSelectedRegionId(null);
              d.setSelectedTimelineRange(null);
              d.setStatus(
                t("transport.status.songCreatedInRange", {
                  start: formatClock(timelineRange.startSeconds),
                  end: formatClock(timelineRange.endSeconds),
                }),
              );
            });
          },
        }
      : {
          // Creating a marker opens a Section / Cue / Custom chooser so the
          // marker is born already typed and named — a cue lands in the cue
          // lane instead of stacking on a section at the same position.
          label: t("transport.menu.createMarker"),
          onSelect: () => openCreateMarkerKindMenu(positionSeconds),
        };

    return [
      createMarkerAction,
      {
        label: t("transport.menu.changeTimelineBpm"),
        disabled: !song,
        onSelect: async () => {
          const nextBpm = Number(
            await promptDialog(
              t("transport.prompt.timelineBpm"),
              d.songBaseBpm.toFixed(2),
            ),
          );
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot =
              positionSeconds <= 0.0001
                ? await updateSongTempo(nextBpm)
                : await upsertSongTempoMarker(positionSeconds, nextBpm);
            d.optimisticallyAppliedRevisionsRef.current.add(
              nextSnapshot.projectRevision,
            );
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.applyPlaybackSnapshot(nextSnapshot);
            d.tempoDraftDirtyRef.current = false;
            d.setTempoDraft(formatBpmDraft(nextBpm));
            d.setStatus(
              positionSeconds <= 0.0001
                ? t("transport.status.baseTimelineBpmUpdated", {
                    bpm: nextBpm.toFixed(2),
                  })
                : t("transport.status.tempoMarkerCreated", {
                    time: formatClock(positionSeconds),
                    bpm: nextBpm.toFixed(2),
                  }),
            );
          });
        },
      },
      {
        label: "Crear marca de metrica",
        disabled: !song,
        onSelect: async () => {
          const nextSignature = (
            await promptDialog("Compas", d.displayedTimeSignature)
          )?.trim();
          if (!nextSignature) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot =
              positionSeconds <= 0.0001
                ? await updateSongTimeSignature(nextSignature)
                : await upsertSongTimeSignatureMarker(
                    positionSeconds,
                    nextSignature,
                  );
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setTimeSignatureDraft(nextSignature);
            d.setStatus(
              `Compas ${nextSignature} en ${formatClock(positionSeconds)}`,
            );
          });
        },
      },
      {
        label: t("transport.automation.createCue"),
        disabled:
          !song ||
          ((song?.regions.length ?? 0) === 0 &&
            (song?.sectionMarkers.length ?? 0) === 0),
        onSelect: () => createAutomationCueAt(positionSeconds),
      },
      {
        label: t("transport.menu.clearTimelineSelection"),
        disabled: !timelineRange,
        onSelect: () => {
          d.setSelectedTimelineRange(null);
          d.setStatus(t("transport.status.timelineSelectionCleared"));
        },
      },
    ];
  }

  // Split a specific song region at the current playhead. Shared by the song
  function songRegionContextMenu(
    region: SongRegionSummary,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const cursorSeconds = d.displayPositionSecondsRef.current;
    // Splitting needs the playhead strictly inside this song.
    const canSplitSong =
      cursorSeconds > region.startSeconds && cursorSeconds < region.endSeconds;
    return [
      {
        label: t("transport.menu.renameSong"),
        shortcut: d.shortcutHint("edit.rename"),
        onSelect: async () => {
          const nextName = (
            await promptDialog(t("transport.prompt.songRename"), region.name)
          )?.trim();
          if (!nextName) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot = await updateSongRegion(
              region.id,
              nextName,
              region.startSeconds,
              region.endSeconds,
            );
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.syncSongLibraryFolderAfterRename(region.name, nextName);
            d.setStatus(t("transport.status.songRenamed", { name: nextName }));
          });
        },
      },
      {
        label: `${t("transport.menu.songKey", { defaultValue: "Nota de la canción" })} ▸`,
        onSelect: () => openSongRegionKeyMenu(region),
      },
      {
        label: t("transport.menu.splitSongAtCursor", {
          defaultValue: "Partir canción en el cursor",
        }),
        shortcut: d.shortcutHint("edit.splitSong"),
        disabled: !canSplitSong,
        onSelect: async () => {
          await d.splitSongRegionAtCursor(
            region.id,
            region.startSeconds,
            region.endSeconds,
          );
        },
      },
      {
        label: t("transport.menu.changeRegionWarpSourceBpm"),
        onSelect: async () => {
          const currentSourceBpm =
            region.warpSourceBpm ??
            getEffectiveBpmAt(d.song, region.startSeconds);
          const input = (
            await promptDialog(
              t("transport.prompt.regionWarpSourceBpm"),
              currentSourceBpm.toFixed(2),
            )
          )?.trim();
          if (!input) {
            return;
          }
          const nextSourceBpm = Number(input.replace(",", "."));
          if (!Number.isFinite(nextSourceBpm) || nextSourceBpm <= 0) {
            return;
          }
          await d.runAction(async () => {
            const nextSnapshot = await updateSongRegionWarp(
              region.id,
              region.warpEnabled,
              nextSourceBpm,
            );
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              t("transport.status.regionWarpSourceBpmUpdated", {
                bpm: nextSourceBpm.toFixed(2),
                name: region.name,
              }),
            );
          });
        },
      },
      {
        label: t("transport.menu.exportSong", {
          defaultValue: "Exportar Cancion",
        }),
        onSelect: () => {
          d.setExportSongTarget({
            regionId: region.id,
            regionName: region.name,
          });
        },
      },
      {
        label: t("transport.menu.deleteSong"),
        shortcut: d.shortcutHint("edit.delete"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteSongRegion(region.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setSelectedRegionId(null);
            d.setStatus(
              t("transport.status.songDeleted", { name: region.name }),
            );
          });
        },
      },
    ];
  }

  // Applies a new original key to a region (song) and refreshes the snapshot so
  // the timeline/remote badges recompute from region.key + transpose.
  async function setSongRegionKey(
    region: SongRegionSummary,
    key: string | null,
  ) {
    const d = getDeps();
    const { t } = d;
    await d.runAction(async () => {
      const nextSnapshot = await updateSongRegionKey(region.id, key);
      d.applyPlaybackSnapshot(nextSnapshot);
      d.setStatus(
        key
          ? t("transport.status.songKeyUpdated", {
              defaultValue: `Nota de «{{name}}» → {{key}}`,
              name: region.name,
              key,
            })
          : t("transport.status.songKeyCleared", {
              defaultValue: `Nota de «{{name}}» eliminada`,
              name: region.name,
            }),
      );
    });
  }

  // Submenu listing the 24 keys (plus "no key") for the region's original key.
  // The region's current key is marked with a swatch dot so it reads as
  // selected, mirroring the marker-kind picker's reopen-the-menu pattern.
  function openSongRegionKeyMenu(region: SongRegionSummary) {
    const d = getDeps();
    const next = bumpContextMenuPosition();
    const currentKey = region.key ?? null;
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: d.t("transport.menu.songKey", {
        defaultValue: "Nota de la canción",
      }),
      actions: [
        {
          label: d.t("transport.menu.songKeyNone", { defaultValue: "Sin nota" }),
          swatch: currentKey === null ? "#3CDDC7" : undefined,
          onSelect: () => setSongRegionKey(region, null),
        },
        ...SONG_KEY_OPTIONS.map((key) => ({
          label: key,
          swatch: currentKey === key ? "#3CDDC7" : undefined,
          onSelect: () => setSongRegionKey(region, key),
        })),
      ],
    });
  }

  function tempoMarkerContextMenu(
    marker: TempoMarkerSummary,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    return [
      {
        label: t("transport.menu.changeBpm"),
        onSelect: async () => {
          const nextBpm = Number(
            await promptDialog(
              t("transport.prompt.tempoMarkerBpm"),
              marker.bpm.toFixed(2),
            ),
          );
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot = await upsertSongTempoMarker(
              marker.sourceStartSeconds ?? marker.startSeconds,
              nextBpm,
            );
            d.optimisticallyAppliedRevisionsRef.current.add(
              nextSnapshot.projectRevision,
            );
            await d.refreshSongView({ includeWaveforms: false, sync: true });
            d.applyPlaybackSnapshot(nextSnapshot);
            d.tempoDraftDirtyRef.current = false;
            d.setTempoDraft(formatBpmDraft(nextBpm));
            d.setStatus(
              t("transport.status.tempoMarkerUpdated", {
                bpm: nextBpm.toFixed(2),
              }),
            );
          });
        },
      },
      {
        label: t("transport.menu.deleteMarker"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteSongTempoMarker(marker.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              t("transport.status.tempoMarkerDeleted", {
                time: formatClock(marker.startSeconds),
              }),
            );
          });
        },
      },
    ];
  }

  function timeSignatureMarkerContextMenu(
    marker: TimeSignatureMarkerSummary,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    return [
      {
        label: "Cambiar compas",
        onSelect: async () => {
          const nextSignature = (
            await promptDialog("Compas", marker.signature)
          )?.trim();
          if (!nextSignature) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot = await upsertSongTimeSignatureMarker(
              marker.startSeconds,
              nextSignature,
            );
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setTimeSignatureDraft(nextSignature);
            d.setStatus(`Compas actualizado a ${nextSignature}`);
          });
        },
      },
      {
        label: t("transport.menu.deleteMarker"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteSongTimeSignatureMarker(marker.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              `Marca de compas eliminada en ${formatClock(marker.startSeconds)}`,
            );
          });
        },
      },
    ];
  }

  function applyMarkerKind(
    section: SectionMarkerSummary,
    kind: MarkerKind,
    variant: number | null,
  ) {
    const d = getDeps();
    const { t } = d;
    void d.runAction(async () => {
      const nextSnapshot = await setSectionMarkerKind(section.id, kind, variant);
      d.applyPlaybackSnapshot(nextSnapshot);
      const kindLabel = markerKindLabel(kind, t);
      d.setStatus(
        t("transport.status.markerKindSet", {
          name: section.name,
          kind: variant ? `${kindLabel} ${variant}` : kindLabel,
        }),
      );
    });
  }

  // Create a new marker already typed and named after its kind. A null kind
  // creates an untyped (Custom) marker with the backend's generic name.
  function createTypedMarker(
    positionSeconds: number,
    kind: MarkerKind | null,
    variant: number | null,
  ) {
    const d = getDeps();
    const { t } = d;
    void d.runAction(async () => {
      const name =
        kind && kind !== "custom"
          ? variant
            ? `${markerKindLabel(kind, t)} ${variant}`
            : markerKindLabel(kind, t)
          : undefined;
      const nextSnapshot = await createSectionMarker(positionSeconds, {
        kind: kind ?? undefined,
        variant,
        name,
      });
      d.applyPlaybackSnapshot(nextSnapshot);
      d.clearSelection();
      d.setSelectedRegionId(null);
      d.setSelectedTimelineRange(null);
      d.setStatus(
        t("transport.status.markerCreatedAt", {
          time: formatClock(positionSeconds),
        }),
      );
    });
  }

  // Variant chooser used when creating a numbered section (Verse 1-6, ...).
  function openCreateMarkerVariantMenu(
    positionSeconds: number,
    kind: MarkerKind,
  ) {
    const d = getDeps();
    const variants = markerKindVariants(kind);
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: markerKindLabel(kind, d.t),
      actions: [
        {
          label: markerKindLabel(kind, d.t),
          swatch: markerKindColor(kind),
          onSelect: () => createTypedMarker(positionSeconds, kind, null),
        },
        ...variants.map((n) => ({
          label: `${markerKindLabel(kind, d.t)} ${n}`,
          swatch: markerKindColor(kind),
          onSelect: () => createTypedMarker(positionSeconds, kind, n),
        })),
      ],
    });
  }

  // Submenu listing section or cue kinds to create a new marker of that type.
  function openCreateMarkerKindList(
    positionSeconds: number,
    kinds: readonly MarkerKind[],
    title: string,
  ) {
    const d = getDeps();
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title,
      actions: kinds.map((kind) => {
        const hasVariants = markerKindVariants(kind).length > 0;
        return {
          label: `${markerKindLabel(kind, d.t)}${hasVariants ? " ▸" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () =>
            hasVariants
              ? openCreateMarkerVariantMenu(positionSeconds, kind)
              : createTypedMarker(positionSeconds, kind, null),
        };
      }),
    });
  }

  // Top-level chooser shown when creating a marker: Section / Cue / Custom.
  function openCreateMarkerKindMenu(positionSeconds: number) {
    const d = getDeps();
    const { t } = d;
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: t("transport.menu.createMarker"),
      actions: [
        {
          label: `${t("transport.menu.markerKindSectionsGroup")} ▸`,
          onSelect: () =>
            openCreateMarkerKindList(
              positionSeconds,
              SECTION_KINDS.filter((kind) => kind !== "custom"),
              t("transport.menu.markerKindSectionsGroup"),
            ),
        },
        {
          label: `${t("transport.menu.markerKindCuesGroup")} ▸`,
          onSelect: () =>
            openCreateMarkerKindList(
              positionSeconds,
              availableCueKinds(d.appSettings.voiceGuideLanguage),
              t("transport.menu.markerKindCuesGroup"),
            ),
        },
        {
          label: markerKindLabel("custom", t),
          swatch: markerKindColor("custom"),
          onSelect: () => createTypedMarker(positionSeconds, null, null),
        },
      ],
    });
  }

  // Variant chooser for kinds that ship numbered recordings (Verse 1-6, ...).
  function openMarkerVariantMenu(
    section: SectionMarkerSummary,
    kind: MarkerKind,
  ) {
    const d = getDeps();
    const variants = markerKindVariants(kind);
    const current = section.kind === kind ? (section.variant ?? null) : null;
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: markerKindLabel(kind, d.t),
      actions: [
        {
          label: `${markerKindLabel(kind, d.t)}${current == null ? " ✓" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () => applyMarkerKind(section, kind, null),
        },
        ...variants.map((n) => ({
          label: `${markerKindLabel(kind, d.t)} ${n}${current === n ? " ✓" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () => applyMarkerKind(section, kind, n),
        })),
      ],
    });
  }

  // Submenu listing a set of kinds (sections or cues). Sections may open a
  // further variant submenu; cues apply directly (no numbered variants).
  function openMarkerKindList(
    section: SectionMarkerSummary,
    kinds: readonly MarkerKind[],
    title: string,
  ) {
    const d = getDeps();
    const currentKind = section.kind ?? "custom";
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title,
      actions: kinds.map((kind) => {
        const hasVariants = markerKindVariants(kind).length > 0;
        return {
          label: `${markerKindLabel(kind, d.t)}${hasVariants ? " ▸" : ""}${
            kind === currentKind ? " ✓" : ""
          }`,
          swatch: markerKindColor(kind),
          onSelect: () =>
            hasVariants
              ? openMarkerVariantMenu(section, kind)
              : applyMarkerKind(section, kind, null),
        };
      }),
    });
  }

  function openMarkerKindMenu(section: SectionMarkerSummary) {
    const d = getDeps();
    const { t } = d;
    const currentKind = section.kind ?? "custom";
    const currentIsCue = markerKindCategory(currentKind) === "cue";
    const next = bumpContextMenuPosition();
    // Top level splits the long vocabulary into Sections vs Cues (Playback-style
    // "dynamic cues"), each opening its own list. A ✓ marks which group the
    // marker currently belongs to.
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: t("transport.menu.markerKind"),
      actions: [
        {
          label: `${t("transport.menu.markerKindSectionsGroup")} ▸${
            currentIsCue ? "" : " ✓"
          }`,
          onSelect: () =>
            openMarkerKindList(
              section,
              SECTION_KINDS,
              t("transport.menu.markerKindSectionsGroup"),
            ),
        },
        {
          label: `${t("transport.menu.markerKindCuesGroup")} ▸${
            currentIsCue ? " ✓" : ""
          }`,
          onSelect: () =>
            openMarkerKindList(
              section,
              availableCueKinds(d.appSettings.voiceGuideLanguage),
              t("transport.menu.markerKindCuesGroup"),
            ),
        },
      ],
    });
  }

  function sectionContextMenu(
    section: SectionMarkerSummary,
  ): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const canEditMarker = Boolean(section);

    return [
      {
        label: t("transport.menu.jumpToMarker"),
        disabled: !canEditMarker,
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await scheduleMarkerJump(section.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              t("transport.status.markerCursorSent", { name: section.name }),
            );
          });
        },
      },
      {
        label: t("common.rename"),
        shortcut: d.shortcutHint("edit.rename"),
        disabled: !canEditMarker,
        onSelect: async () => {
          const nextName = (
            await promptDialog(t("transport.prompt.markerRename"), section.name)
          )?.trim();
          if (!nextName) {
            return;
          }
          await d.runAction(async () => {
            const nextSnapshot = await updateSectionMarker(
              section.id,
              nextName,
              section.startSeconds,
            );
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              t("transport.status.markerRenamed", { name: nextName }),
            );
          });
        },
      },
      {
        label: t("transport.menu.markerKind"),
        swatch: markerColor(section),
        disabled: !canEditMarker,
        onSelect: () => openMarkerKindMenu(section),
      },
      // Colour is only user-editable for Custom markers — typed sections/cues
      // take their colour from the kind palette.
      ...(markerKindCategory(section.kind) === "section" &&
      (section.kind ?? "custom") === "custom"
        ? [
            {
              label: t("transport.menu.markerColor"),
              swatch: markerColor(section),
              disabled: !canEditMarker,
              onSelect: () =>
                openColorMenu(
                  t("transport.menu.markerColor"),
                  section.color,
                  (color) =>
                    d.runAction(async () => {
                      const nextSnapshot = await setSectionMarkerColor(
                        section.id,
                        color,
                      );
                      d.applyPlaybackSnapshot(nextSnapshot);
                    }),
                ),
            },
          ]
        : []),
      {
        label: t("common.delete"),
        disabled: !canEditMarker,
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteSectionMarker(section.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setSelectedSectionId(null);
            d.setStatus(
              t("transport.status.markerDeleted", { name: section.name }),
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

  function trackContextMenu(track: TrackSummary): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const currentSong = d.songRef.current;
    if (!currentSong) {
      return [];
    }

    const previousFolder = findPreviousFolderTrack(currentSong, track.id);
    const parentTrack = findTrack(currentSong, track.parentTrackId ?? null);
    const parentOfParent = parentTrack?.parentTrackId ?? null;

    // Right-clicking a folder should create the new track *inside* it (as its
    // first child); right-clicking a regular track inserts a sibling after it.
    const isFolder = track.kind === "folder";
    const createAnchor = isFolder ? null : track;
    const createParentId = isFolder ? track.id : track.parentTrackId ?? null;

    const actions: ContextMenuAction[] = [
      {
        label: t("transport.menu.insertTrack"),
        onSelect: () =>
          d.handleCreateTrack("audio", createAnchor, createParentId),
      },
      {
        label: t("transport.menu.insertFolderTrack"),
        onSelect: () =>
          d.handleCreateTrack("folder", createAnchor, createParentId),
      },
      {
        label: t("common.rename"),
        shortcut: d.shortcutHint("edit.rename"),
        onSelect: async () => {
          const nextName = (
            await promptDialog(t("transport.prompt.trackRename"), track.name)
          )?.trim();
          if (!nextName) {
            return;
          }
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
          const clipCount = currentSong.clips.filter(
            (clip) => clip.trackId === track.id,
          ).length;
          if (
            track.kind === "audio" &&
            clipCount > 0 &&
            !(await confirmDialog(t("transport.confirm.deleteTrackWithClips")))
          ) {
            return;
          }

          await d.runAction(async () => {
            const nextSnapshot = await deleteTrack(track.id);
            d.optimisticallyAppliedRevisionsRef.current.add(
              nextSnapshot.projectRevision,
            );
            d.applyPlaybackSnapshot(nextSnapshot);
            d.clearLibraryDragPreview();
            // Deleting a track removes its clips but the surviving clips
            // still reference the same waveformKeys, and orphaned cache
            // entries are harmless until the next full reload. Skip the
            // ~27 MB waveform payload to keep the UI responsive.
            await d.refreshSongView({ includeWaveforms: false });
            d.setStatus(
              t("transport.status.trackDeleted", { name: track.name }),
            );
          });
        },
      },
      {
        label: t("transport.menu.indentIntoPreviousFolder"),
        disabled: !previousFolder,
        onSelect: async () => {
          if (!previousFolder) {
            return;
          }
          await d.runAction(async () => {
            const nextSnapshot = await moveTrack({
              trackId: track.id,
              parentTrackId: previousFolder.id,
            });
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView();
            d.setStatus(
              t("transport.status.trackMovedIntoFolder", {
                name: previousFolder.name,
              }),
            );
          });
        },
      },
      {
        label: t("transport.menu.removeFromFolder"),
        disabled: !track.parentTrackId,
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await moveTrack({
              trackId: track.id,
              insertAfterTrackId: track.parentTrackId ?? null,
              parentTrackId: parentOfParent,
            });
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView();
            d.setStatus(
              t("transport.status.trackRemovedFromFolder", {
                name: track.name,
              }),
            );
          });
        },
      },
    ];

    // Offer the automation lane here too, anchored after this track, so the
    // user can add it from a track's own menu (not only the empty area).
    if (!currentSong.automationTrack) {
      actions.push({
        label: t("transport.automation.addTrack"),
        onSelect: () => handleAddAutomationTrack(track.id),
      });
    }

    return actions;
  }

  function multiTrackContextMenu(tracks: TrackSummary[]): ContextMenuAction[] {
    const d = getDeps();
    const currentColor = resolveSharedTimelineColor(tracks);
    return [
      {
        label: "Seleccionar color...",
        swatch: currentColor ?? undefined,
        onSelect: () =>
          openColorMenu(
            `Color: ${tracks.length} tracks`,
            currentColor,
            (color) => d.handleSetTrackColors(tracks, color).then(() => undefined),
          ),
      },
    ];
  }

  function globalTrackListContextMenu(): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const actions: ContextMenuAction[] = [
      {
        label: t("transport.menu.addAudioTrack"),
        onSelect: () => d.handleCreateTrack("audio", null, null),
      },
      {
        label: t("transport.menu.addFolderTrack"),
        onSelect: () => d.handleCreateTrack("folder", null, null),
      },
    ];

    // Offer the automation lane only when it isn't already present. From the
    // empty area below the tracks, anchor it after the last real track.
    if (!d.songRef.current?.automationTrack) {
      const realTracks = d.songRef.current?.tracks ?? [];
      const lastTrackId = realTracks.at(-1)?.id ?? null;
      actions.push({
        label: t("transport.automation.addTrack"),
        onSelect: () => handleAddAutomationTrack(lastTrackId),
      });
    }

    return actions;
  }

  function handleTrackHeaderContextMenu(
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) {
    const d = getDeps();
    // The synthetic automation lane is not a real song track, so it has its
    // own reduced menu (create cue / remove track).
    if (trackId === AUTOMATION_TRACK_ID) {
      openMenu(
        event,
        d.t("transport.automation.menuTitle"),
        automationTrackContextMenu(),
      );
      return;
    }

    const track = findTrack(d.songRef.current, trackId);
    if (!track) {
      return;
    }

    const currentSelection = useTimelineUIStore.getState().selectedTrackIds;
    const selectedTracks = currentSelection
      .map((selectedTrackId) => findTrack(d.songRef.current, selectedTrackId))
      .filter((candidate): candidate is TrackSummary => candidate !== null);

    if (currentSelection.includes(track.id) && selectedTracks.length > 1) {
      openMenu(
        event,
        `${selectedTracks.length} tracks`,
        multiTrackContextMenu(selectedTracks),
      );
      return;
    }

    d.selectTrack([track.id]);
    openMenu(event, track.name, trackContextMenu(track));
  }

  function clipContextMenu(clip: ClipSummary): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const currentCursorSeconds = d.displayPositionSecondsRef.current;
    const clipName = clipDisplayName(clip);
    // If the right-clicked clip is part of a multi-selection, the split
    // is offered when *any* selected clip contains the cursor, and we
    // batch all qualifying ones into a single command. Otherwise we
    // fall back to the single-clip behaviour.
    const isMultiSelection =
      d.selectedClipIds.includes(clip.id) &&
      d.selectedClipSummaries.length > 1;
    const splitCandidates = isMultiSelection ? d.selectedClipSummaries : [clip];
    const splittableClips = splitCandidates.filter(
      (candidate) =>
        currentCursorSeconds > candidate.timelineStartSeconds &&
        currentCursorSeconds <
          candidate.timelineStartSeconds + candidate.durationSeconds,
    );
    const canSplit = splittableClips.length > 0;

    return [
      {
        label: t("transport.menu.splitClipAtCursor"),
        shortcut: d.shortcutHint("edit.splitClip"),
        disabled: !canSplit,
        onSelect: async () => {
          await d.runAction(async () => {
            const ids = splittableClips.map((entry) => entry.id);
            const nextSnapshot =
              ids.length > 1
                ? await splitClips(ids, currentCursorSeconds)
                : await splitClip(ids[0], currentCursorSeconds);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setStatus(
              ids.length > 1
                ? t("transport.status.clipsSplitAt", {
                    count: ids.length,
                    time: formatClock(currentCursorSeconds),
                    defaultValue: "Split {{count}} clips at {{time}}.",
                  })
                : t("transport.status.clipSplitAt", {
                    time: formatClock(currentCursorSeconds),
                  }),
            );
          });
        },
      },
      {
        label: t("transport.menu.duplicateClip"),
        shortcut: d.shortcutHint("edit.duplicate"),
        onSelect: async () => {
          await d.runAction(async () => {
            const sourceClips =
              d.selectedClipIds.includes(clip.id) &&
              d.selectedClipSummaries.length
                ? d.selectedClipSummaries
                : [clip];
            const sourceEndSeconds = Math.max(
              ...sourceClips.map(
                (sourceClip) =>
                  sourceClip.timelineStartSeconds + sourceClip.durationSeconds,
              ),
            );
            await d.duplicateClipGroup(sourceClips, sourceEndSeconds);
            d.setStatus(
              t("transport.status.clipDuplicated", { name: clipName }),
            );
          });
        },
      },
      {
        label: "Seleccionar color...",
        swatch: clip.color ?? undefined,
        onSelect: () =>
          openColorMenu(`Color: ${clipName}`, clip.color, (color) =>
            d.handleSetClipColor(clip, color).then(() => undefined),
          ),
      },
      {
        label: t("common.delete"),
        shortcut: d.shortcutHint("edit.delete"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteClip(clip.id);
            d.applyPlaybackSnapshot(nextSnapshot);
            d.setSelectedClipId(null);
            d.setStatus(t("transport.status.clipDeleted", { name: clipName }));
          });
        },
      },
    ];
  }

  return {
    openMenu,
    openColorMenu,
    createAutomationCueAt,
    editAutomationCue,
    automationCueContextMenu,
    rulerContextMenu,
    songRegionContextMenu,
    tempoMarkerContextMenu,
    timeSignatureMarkerContextMenu,
    sectionContextMenu,
    automationTrackContextMenu,
    trackContextMenu,
    multiTrackContextMenu,
    globalTrackListContextMenu,
    handleTrackHeaderContextMenu,
    handleAddAutomationTrack,
    clipContextMenu,
  };
}

export type TimelineMenus = ReturnType<typeof createTimelineMenus>;
