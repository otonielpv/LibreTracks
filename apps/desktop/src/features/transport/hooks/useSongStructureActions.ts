import { useCallback } from "react";
import type { TFunction } from "i18next";
import type {
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
  TempoMarkerSummary,
  TimeSignatureMarkerSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";
import {
  createSectionMarker,
  createSongRegion,
  deleteSectionMarker,
  deleteSongRegion,
  deleteSongTempoMarker,
  deleteSongTimeSignatureMarker,
  exportRegionAsPackage,
  scheduleMarkerJump,
  updateSectionMarker,
  updateSongRegion,
  updateSongTempo,
  updateSongTimeSignature,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
} from "../desktopApi";
import type { ContextMenuAction, TimelineRangeSelection } from "../types";

type UseSongStructureActionsProps = {
  t: TFunction;
  song: SongView | null;
  songBaseBpm: number;
  displayedTimeSignature: string;
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  setStatus: (status: string) => void;
  formatClock: (seconds: number) => string;
  clearSelection: () => void;
  setSelectedRegionId: (id: string | null) => void;
  setSelectedTimelineRange: (range: TimelineRangeSelection | null) => void;
  setSelectedSectionId: (id: string | null) => void;
  setTempoDraft: (bpm: string) => void;
  setTimeSignatureDraft: (sig: string) => void;
};

export function useSongStructureActions({
  t,
  song,
  songBaseBpm,
  displayedTimeSignature,
  runAction,
  applyPlaybackSnapshot,
  setStatus,
  formatClock,
  clearSelection,
  setSelectedRegionId,
  setSelectedTimelineRange,
  setSelectedSectionId,
  setTempoDraft,
  setTimeSignatureDraft,
}: UseSongStructureActionsProps) {
  const rulerContextMenu = useCallback(
    (
      positionSeconds: number,
      timelineRange: TimelineRangeSelection | null,
    ): ContextMenuAction[] => {
      return [
        {
          label: timelineRange
            ? t("transport.menu.createSongRegionFromSelection")
            : t("transport.menu.createMarker"),
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = timelineRange
                ? await createSongRegion(
                    timelineRange.startSeconds,
                    timelineRange.endSeconds,
                  )
                : await createSectionMarker(positionSeconds);
              applyPlaybackSnapshot(nextSnapshot);
              clearSelection();
              setSelectedRegionId(null);
              setSelectedTimelineRange(null);
              setStatus(
                timelineRange
                  ? t("transport.status.songCreatedInRange", {
                      start: formatClock(timelineRange.startSeconds),
                      end: formatClock(timelineRange.endSeconds),
                    })
                  : t("transport.status.markerCreatedAt", {
                      time: formatClock(positionSeconds),
                    }),
              );
            });
          },
        },
        {
          label: t("transport.menu.changeTimelineBpm"),
          disabled: !song,
          onSelect: async () => {
            const nextBpm = Number(
              window.prompt(
                t("transport.prompt.timelineBpm"),
                songBaseBpm.toFixed(2),
              ),
            );
            if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot =
                positionSeconds <= 0.0001
                  ? await updateSongTempo(nextBpm)
                  : await upsertSongTempoMarker(positionSeconds, nextBpm);
              applyPlaybackSnapshot(nextSnapshot);
              setTempoDraft(String(nextBpm));
              setStatus(
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
            const nextSignature = window
              .prompt("Compas", displayedTimeSignature)
              ?.trim();
            if (!nextSignature) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot =
                positionSeconds <= 0.0001
                  ? await updateSongTimeSignature(nextSignature)
                  : await upsertSongTimeSignatureMarker(
                      positionSeconds,
                      nextSignature,
                    );
              applyPlaybackSnapshot(nextSnapshot);
              setTimeSignatureDraft(nextSignature);
              setStatus(
                `Compas ${nextSignature} en ${formatClock(positionSeconds)}`,
              );
            });
          },
        },
        {
          label: t("transport.menu.clearTimelineSelection"),
          disabled: !timelineRange,
          onSelect: () => {
            setSelectedTimelineRange(null);
            setStatus(t("transport.status.timelineSelectionCleared"));
          },
        },
      ];
    },
    [
      t,
      song,
      songBaseBpm,
      displayedTimeSignature,
      runAction,
      applyPlaybackSnapshot,
      setStatus,
      formatClock,
      clearSelection,
      setSelectedRegionId,
      setSelectedTimelineRange,
      setTempoDraft,
      setTimeSignatureDraft,
    ],
  );

  const songRegionContextMenu = useCallback(
    (region: SongRegionSummary): ContextMenuAction[] => {
      return [
        {
          label: t("transport.menu.renameSong"),
          onSelect: async () => {
            const nextName = window
              .prompt(t("transport.prompt.songRename"), region.name)
              ?.trim();
            if (!nextName) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot = await updateSongRegion(
                region.id,
                nextName,
                region.startSeconds,
                region.endSeconds,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(t("transport.status.songRenamed", { name: nextName }));
            });
          },
        },
        {
          label: t("transport.menu.changeBpm"),
          disabled: true,
          onSelect: () => {},
        },
        {
          label: "Exportar Cancion",
          onSelect: async () => {
            await runAction(
              async () => {
                await exportRegionAsPackage(region.id);
                setStatus(`Paquete exportado para ${region.name}`);
              },
              { busy: true },
            );
          },
        },
        {
          label: t("transport.menu.deleteSong"),
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await deleteSongRegion(region.id);
              applyPlaybackSnapshot(nextSnapshot);
              setSelectedRegionId(null);
              setStatus(
                t("transport.status.songDeleted", { name: region.name }),
              );
            });
          },
        },
      ];
    },
    [t, runAction, applyPlaybackSnapshot, setStatus, setSelectedRegionId],
  );

  const tempoMarkerContextMenu = useCallback(
    (marker: TempoMarkerSummary): ContextMenuAction[] => {
      return [
        {
          label: t("transport.menu.changeBpm"),
          onSelect: async () => {
            const nextBpm = Number(
              window.prompt(
                t("transport.prompt.tempoMarkerBpm"),
                marker.bpm.toFixed(2),
              ),
            );
            if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot = await upsertSongTempoMarker(
                marker.startSeconds,
                nextBpm,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setTempoDraft(String(nextBpm));
              setStatus(
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
            await runAction(async () => {
              const nextSnapshot = await deleteSongTempoMarker(marker.id);
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.tempoMarkerDeleted", {
                  time: formatClock(marker.startSeconds),
                }),
              );
            });
          },
        },
      ];
    },
    [t, runAction, applyPlaybackSnapshot, setStatus, setTempoDraft, formatClock],
  );

  const sectionContextMenu = useCallback(
    (section: SectionMarkerSummary): ContextMenuAction[] => {
      const canEditMarker = Boolean(section);

      return [
        {
          label: t("transport.menu.jumpToMarker"),
          disabled: !canEditMarker,
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await scheduleMarkerJump(section.id);
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.markerCursorSent", {
                  name: section.name,
                }),
              );
            });
          },
        },
        {
          label: t("common.rename"),
          disabled: !canEditMarker,
          onSelect: async () => {
            const nextName = window
              .prompt(t("transport.prompt.markerRename"), section.name)
              ?.trim();
            if (!nextName) {
              return;
            }
            await runAction(async () => {
              const nextSnapshot = await updateSectionMarker(
                section.id,
                nextName,
                section.startSeconds,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.markerRenamed", { name: nextName }),
              );
            });
          },
        },
        {
          label: t("common.delete"),
          disabled: !canEditMarker,
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await deleteSectionMarker(section.id);
              applyPlaybackSnapshot(nextSnapshot);
              setSelectedSectionId(null);
              setStatus(
                t("transport.status.markerDeleted", { name: section.name }),
              );
            });
          },
        },
      ];
    },
    [t, runAction, applyPlaybackSnapshot, setStatus, setSelectedSectionId],
  );

  const timeSignatureMarkerContextMenu = useCallback(
    (marker: TimeSignatureMarkerSummary): ContextMenuAction[] => {
      return [
        {
          label: "Cambiar compas",
          onSelect: async () => {
            const nextSignature = window
              .prompt("Compas", marker.signature)
              ?.trim();
            if (!nextSignature) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot = await upsertSongTimeSignatureMarker(
                marker.startSeconds,
                nextSignature,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setTimeSignatureDraft(nextSignature);
              setStatus(`Compas actualizado a ${nextSignature}`);
            });
          },
        },
        {
          label: t("transport.menu.deleteMarker"),
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await deleteSongTimeSignatureMarker(
                marker.id,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                `Marca de compas eliminada en ${formatClock(marker.startSeconds)}`,
              );
            });
          },
        },
      ];
    },
    [
      t,
      runAction,
      applyPlaybackSnapshot,
      setStatus,
      setTimeSignatureDraft,
      formatClock,
    ],
  );

  return {
    rulerContextMenu,
    songRegionContextMenu,
    tempoMarkerContextMenu,
    sectionContextMenu,
    timeSignatureMarkerContextMenu,
  };
}
