import {
  deleteRulerMarkers,
  duplicateRulerMarkers,
  moveRulerMarkers,
  type RulerMarkerPlacement,
  type RulerMarkerRef,
  type SongView,
  type TransportSnapshot,
} from "../desktopApi";
import { shortcutHintNow } from "../keyboard/shortcutHint";
import type { ContextMenuAction } from "../types";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import { createRulerAreaSelection } from "./rulerAreaSelection";
import {
  duplicatePlacements,
  groupMovePlacements,
  listRulerMarkers,
} from "./rulerMarkerSelection";

export type RulerMarkerHandlerDeps = {
  getSong: () => SongView | null;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: {
    sync?: boolean;
  }) => Promise<SongView | null>;
  setStatus: (status: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

/**
 * Mover, duplicar y borrar una seleccion de marcas de la regla. Cada accion es
 * UNA llamada al motor y un paso de deshacer (ver
 * `src-tauri/src/state/ruler_markers.rs`).
 *
 * Se instancia una vez: todo lo que cambia se lee por getters.
 */
export function createRulerMarkerHandlers(deps: RulerMarkerHandlerDeps) {
  const { getSong, runAction, applyPlaybackSnapshot, refreshSongView, setStatus, t } =
    deps;

  /** Persistir un arrastre de grupo: todas las marcas desplazadas lo mismo.
   * Con `copy` (Alt/Option al soltar) se escriben copias ahi y el original se
   * queda donde estaba. */
  const moveGroup = (markers: RulerMarkerRef[], deltaSeconds: number, copy = false) => {
    const moves = groupMovePlacements(getSong(), markers, deltaSeconds);
    if (moves.length === 0) return;
    if (copy) {
      writeCopies(moves);
      return;
    }
    void runAction(async () => {
      applyPlaybackSnapshot(await moveRulerMarkers(moves));
    });
  };

  /**
   * Copias justo detras del grupo. Despues queda seleccionado lo COPIADO, como
   * en Ableton: asi Ctrl+D repetido sigue encadenando copias en vez de apilar
   * todas encima de la primera.
   */
  const duplicate = (markers: RulerMarkerRef[]) => {
    writeCopies(duplicatePlacements(getSong(), markers));
  };

  /** Escribe las copias y deja seleccionado lo copiado. */
  const writeCopies = (copies: RulerMarkerPlacement[]) => {
    const song = getSong();
    if (copies.length === 0) return;
    const before = new Set(
      listRulerMarkers(song).map((entry) => `${entry.kind}:${entry.id}`),
    );
    void runAction(async () => {
      applyPlaybackSnapshot(await duplicateRulerMarkers(copies));
      const next = await refreshSongView({ sync: true });
      const created = findCopies(next, before, copies);
      if (created.length > 0) {
        useTimelineUIStore.getState().setSelectedMarkers(created, created[0]);
      }
      setStatus(
        t("transport.status.markersDuplicated", {
          count: copies.length,
          defaultValue: "Duplicated {{count}} markers.",
        }),
      );
    });
  };

  const remove = (markers: RulerMarkerRef[]) => {
    if (markers.length === 0) return;
    void runAction(async () => {
      applyPlaybackSnapshot(await deleteRulerMarkers(markers));
      useTimelineUIStore.getState().clearSelection();
      setStatus(
        t("transport.status.markersDeleted", {
          count: markers.length,
          defaultValue: "Deleted {{count}} markers.",
        }),
      );
    });
  };

  /** Las marcas seleccionadas (una o varias), o `null` si no hay. */
  const selectedGroup = () => {
    const selected = selectedRulerMarkers(useTimelineUIStore.getState());
    return selected.length > 0 ? selected : null;
  };

  /** Menu del grupo: clic derecho en escritorio, barra y hoja en movil. */
  const groupMenu = (markers: RulerMarkerRef[]): ContextMenuAction[] => [
    {
      label: t("transport.menu.duplicateMarkers", {
        count: markers.length,
        defaultValue: "Duplicate {{count}} markers",
      }),
      shortcut: shortcutHintNow("edit.duplicate"),
      onSelect: () => duplicate(markers),
    },
    {
      label: t("transport.menu.deleteMarkers", {
        count: markers.length,
        defaultValue: "Delete {{count}} markers",
      }),
      shortcut: shortcutHintNow("edit.delete"),
      onSelect: () => remove(markers),
    },
  ];

  return {
    /** Arrastrar por la regla en el modo area del movil. */
    area: createRulerAreaSelection(getSong),
    moveGroup,
    duplicate,
    remove,
    groupMenu,
    /** Supr con marcas seleccionadas (una o varias). `false` si no las hay. */
    deleteSelected() {
      const group = selectedGroup();
      if (!group) return false;
      remove(group);
      return true;
    },
    /** Ctrl+D con marcas seleccionadas (una o varias). `false` si no las hay. */
    duplicateSelected() {
      const group = selectedGroup();
      if (!group) return false;
      duplicate(group);
      return true;
    },
  };
}

export type RulerMarkerHandlers = ReturnType<typeof createRulerMarkerHandlers>;

/** Las marcas nuevas tras duplicar: no estaban antes y caen donde se pidio. */
function findCopies(
  song: SongView | null,
  before: Set<string>,
  copies: RulerMarkerPlacement[],
): RulerMarkerRef[] {
  return listRulerMarkers(song)
    .filter((entry) => !before.has(`${entry.kind}:${entry.id}`))
    .filter((entry) =>
      copies.some(
        (copy) =>
          copy.kind === entry.kind &&
          Math.abs(copy.startSeconds - entry.startSeconds) < 1e-3,
      ),
    )
    .map(({ kind, id }) => ({ kind, id }));
}
