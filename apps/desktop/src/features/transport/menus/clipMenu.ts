import type { ClipSummary } from "@libretracks/shared/models";

import {
  deleteClip,
  deleteClips,
  splitClip,
  splitClips,
} from "../desktopApi";
import { clipDisplayName, formatClock } from "../helpers";
import type { ContextMenuAction } from "../types";
import type { TimelineMenuDeps } from "./timelineMenus";

export type ClipContextMenuArgs = {
  clip: ClipSummary;
  deps: TimelineMenuDeps;
  /** Abre el selector de color como submenu; lo aporta quien monta el menu. */
  openColorMenu: (
    title: string,
    currentColor: string | null | undefined,
    onColor: (color: string | null) => Promise<void>,
  ) => void;
};

/**
 * Menu contextual de un clip: partir, duplicar, color y borrar.
 *
 * Sale de timelineMenus porque es autocontenido —solo necesita el clip, las
 * dependencias del panel y el selector de color— y porque alli el fichero ya no
 * cabe. Lo que NO puede perderse al moverlo es la regla de `targetClips`: todas
 * las acciones actuan sobre la MISMA lista.
 */
export function clipContextMenuActions({
  clip,
  deps: d,
  openColorMenu,
}: ClipContextMenuArgs): ContextMenuAction[] {
  const { t } = d;
  const currentCursorSeconds = d.displayPositionSecondsRef.current;
  const clipName = clipDisplayName(clip);
  /**
   * A que clips afecta CADA accion de este menu.
   *
   * Si el clip pulsado forma parte de una multiseleccion, a todos; si no,
   * solo a el. Se resuelve UNA vez y lo usan todas: cuando cada accion se lo
   * preguntaba por su cuenta, unas lo hacian y otras no —con el dedo, donde
   * sumar clips es la unica forma de agruparlos, borrar y colorear se
   * quedaban en el primero mientras partir si iba a todos—.
   */
  const targetClips =
    d.selectedClipIds.includes(clip.id) && d.selectedClipSummaries.length > 1
      ? d.selectedClipSummaries
      : [clip];
  // Partir se ofrece cuando el cursor cae dentro de ALGUNO, y solo parte esos.
  const splittableClips = targetClips.filter(
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
          const sourceClips = targetClips;
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
      label: t("transport.menu.selectColor"),
      swatch: clip.color ?? undefined,
      onSelect: () =>
        openColorMenu(
          targetClips.length > 1
            ? t("transport.menu.colorOfClips", {
                count: targetClips.length,
                defaultValue: "Color de {{count}} clips",
              })
            : t("transport.menu.colorOf", { name: clipName }),
          clip.color,
          (color) => d.handleSetClipColors(targetClips, color).then(() => undefined),
        ),
    },
    {
      label: t("common.delete"),
      shortcut: d.shortcutHint("edit.delete"),
      onSelect: async () => {
        await d.runAction(async () => {
          // Una sola llamada al backend con varios: un sync del motor, un
          // snapshot y UNA entrada de historial, como ya hacen las pistas.
          const ids = targetClips.map((entry) => entry.id);
          const nextSnapshot =
            ids.length > 1 ? await deleteClips(ids) : await deleteClip(ids[0]);
          d.applyPlaybackSnapshot(nextSnapshot);
          d.setSelectedClipId(null);
          d.setStatus(
            ids.length > 1
              ? t("transport.status.clipsDeleted", {
                  count: ids.length,
                  defaultValue: "{{count}} clips borrados.",
                })
              : t("transport.status.clipDeleted", { name: clipName }),
          );
        });
      },
    },
  ];
}
