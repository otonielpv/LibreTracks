import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import type { SongView } from "@libretracks/shared/models";

import { getCompactStripLayout, type CompactStripLayout } from "../compact/useMixerStripWindow";
import { isMobileApp } from "../desktopApi";
import { findTrack, isTrackDescendant } from "../helpers";
import {
  createReorderPreview,
  type ReorderLayoutAnchor,
  type ReorderPreview,
  type ReorderPreviewItem,
} from "../reorder/reorderPreview";
import type { TrackDragState, TrackDropState } from "../types";
import { useTimelineUIStore } from "../uiStore";
import type { TrackRowLayout } from "./trackLayout";
import { planTrackDrop, previewRowOrder } from "./trackMovePlan";

/**
 * Vista previa "hueco + fantasma" al arrastrar pistas, en la DAW (cabeceras y
 * carriles, en vertical) y en el mezclador de la vista compacta (tiras, en
 * horizontal). Ver reorder/reorderPreview para el efecto en sí.
 *
 * Sustituye al pintado anterior, que movía la fila con el puntero y marcaba
 * con una línea la fila de destino. Dos cosas cambian además del dibujo:
 *
 * - **El destino** se resuelve contra la disposición del inicio del arrastre
 *   (`resolveTrackDrop`), no con `elementFromPoint`: las filas se apartan para
 *   abrir el hueco, y mirar qué hay bajo el puntero haría oscilar el destino.
 * - **El resultado** que se enseña sale de `planTrackDrop`, el mismo plan que
 *   ejecuta el soltar: el fantasma no puede prometer otro orden.
 *
 * Todo es imperativo, sin estado de React: se llama desde los listeners del
 * camino caliente (hooks/useDragListeners) a cada movimiento.
 */

type Session = {
  key: string;
  preview: ReorderPreview;
  /** Donde viven las filas: el shell de la DAW o el documento (mezclador). */
  root: ParentNode;
  /** Las filas salen del layout: las que se monten luego se adjuntan. */
  fromLayout: boolean;
  ghostIds: Set<string>;
  insideFolderId: string | null;
};

const sessionKey = (drag: NonNullable<TrackDragState>) =>
  `${drag.originSurface}|${drag.trackId}|${drag.pointerId}|${drag.startClientX}|${drag.startClientY}`;

/** Lo que identifica el orden de las filas: cuando cambia, React ya ha
 * pintado el resultado del soltar. */
function trackOrderKey(song: SongView | null): string {
  if (!song) return "";
  return `${song.tracks
    .map((track) => `${track.id}:${track.parentTrackId ?? ""}`)
    .join("|")}#${song.automationTrack?.afterTrackId ?? ""}`;
}

/** La pista arrastrada y, si forma parte de una multiselección, todas las
 * seleccionadas (`roots`); `rowIds` añade sus descendientes, que viajan con
 * su carpeta. */
function draggedTracks(song: SongView, draggedTrackId: string) {
  const selected = useTimelineUIStore.getState().selectedTrackIds;
  const roots =
    selected.includes(draggedTrackId) && selected.length > 1
      ? selected
      : [draggedTrackId];
  const rowIds = new Set(roots);
  for (const track of song.tracks) {
    if (roots.some((root) => isTrackDescendant(song, track.id, root))) {
      rowIds.add(track.id);
    }
  }
  return { roots, rowIds };
}

/** Lo que una vista previa asentada espera al orden nuevo antes de rendirse. */
const SETTLE_TIMEOUT_MS = 10_000;

const HEADER_ROW_SELECTOR = ".lt-track-header-row[data-track-id]";
const LANE_ROW_SELECTOR = ".lt-track-lane-row[data-track-id]";
const COMPACT_STRIP_SELECTOR = ".lt-compact-mixer-strip[data-track-id]";
/** The Setlist view's track list: every row is in the DOM, measured as is. */
const SETLIST_ROW_SELECTOR = ".lt-setlist-track-row[data-track-id]";

/** Tiras del mezclador MONTADAS, por pista. */
function mountedCompactStrips(root: ParentNode) {
  const strips = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>(COMPACT_STRIP_SELECTOR).forEach((strip) => {
    strips.set(strip.dataset.trackId ?? "", strip);
  });
  return strips;
}

/**
 * Items del mezclador desde su geometría: con las tiras virtualizadas
 * (compact/useMixerStripWindow) las de fuera no existen en el DOM. Todas
 * miden lo mismo, así que la tira `i` empieza en `i · paso`. Ancla: la tira
 * arrastrada, que está bajo el puntero.
 */
export function compactStripItems(
  root: ParentNode,
  layout: CompactStripLayout,
  draggedTrackId: string,
): { items: ReorderPreviewItem[]; anchor: ReorderLayoutAnchor; source: HTMLElement } | null {
  const strips = mountedCompactStrips(root);
  const source = strips.get(draggedTrackId);
  const draggedIndex = layout.ids.indexOf(draggedTrackId);
  if (!source || draggedIndex < 0) return null;
  return {
    items: layout.ids.map((id, index) => ({
      id,
      element: strips.get(id) ?? null,
      offset: index * layout.pitch,
      size: layout.width,
    })),
    anchor: { element: source, offset: draggedIndex * layout.pitch },
    source,
  };
}

/** Cabeceras y carriles MONTADOS, por pista. */
function mountedTrackRows(root: ParentNode) {
  const headers = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>(HEADER_ROW_SELECTOR).forEach((row) => {
    headers.set(row.dataset.trackId ?? "", row);
  });
  const lanes = new Map<string, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>(LANE_ROW_SELECTOR).forEach((lane) => {
    const id = lane.dataset.trackId ?? "";
    lanes.set(id, [...(lanes.get(id) ?? []), lane]);
  });
  return { headers, lanes };
}

/**
 * Items de la DAW desde el layout: una fila por pista visible, monte o no.
 * Con las filas virtualizadas las de fuera de pantalla no existen en el DOM;
 * medirlas dejaba la lista sin desplazar justo donde el auto-scroll la
 * descubre. El ancla es la fila arrastrada (bajo el puntero, montada).
 */
function layoutTrackItems(
  root: ParentNode,
  layout: TrackRowLayout,
  visibleIds: readonly string[],
  draggedTrackId: string,
): { items: ReorderPreviewItem[]; anchor: ReorderLayoutAnchor; source: HTMLElement } | null {
  if (layout.heights.length !== visibleIds.length) return null;
  const { headers, lanes } = mountedTrackRows(root);
  const source = headers.get(draggedTrackId);
  const anchorOffset = layout.topOf(draggedTrackId);
  if (!source || anchorOffset === null) return null;
  return {
    items: visibleIds.map((id, index) => ({
      id,
      element: headers.get(id) ?? null,
      companions: lanes.get(id) ?? [],
      offset: layout.tops[index],
      size: layout.heights[index],
    })),
    anchor: { element: source, offset: anchorOffset },
    source,
  };
}

export function useTrackDragPreview({
  song,
  songRef,
  timelineShellRef,
  getVisibleTrackIds,
  getTrackLayout,
}: {
  song: SongView | null;
  songRef: { current: SongView | null };
  timelineShellRef: { current: HTMLElement | null };
  getVisibleTrackIds: () => string[];
  /** El layout de las filas visibles, en su orden. */
  getTrackLayout: () => TrackRowLayout;
}) {
  const sessionRef = useRef<Session | null>(null);
  /** Un soltar que espera a que llegue el orden nuevo. */
  const settlingRef = useRef<Session | null>(null);
  const visibleIdsRef = useRef(getVisibleTrackIds);
  visibleIdsRef.current = getVisibleTrackIds;
  const trackLayoutRef = useRef(getTrackLayout);
  trackLayoutRef.current = getTrackLayout;

  // Soltar DENTRO de una carpeta no abre hueco junto a ella (las pistas van
  // al final de su contenido), así que la carpeta se ilumina entera con el
  // estilo que ya tenía este caso.
  const setInsideFolder = useCallback((session: Session, folderId: string | null) => {
    if (session.insideFolderId === folderId) return;
    const mark = (id: string | null, on: boolean) => {
      if (!id) return;
      session.root
        .querySelectorAll<HTMLElement>("[data-track-id]")
        .forEach((element) => {
          if (element.dataset.trackId !== id) return;
          element.classList.toggle("is-drop-target", on);
          element.classList.toggle("is-drop-inside-folder", on);
        });
    };
    mark(session.insideFolderId, false);
    mark(folderId, true);
    session.insideFolderId = folderId;
  }, []);

  const destroy = useCallback(
    (session: Session | null, animate: boolean) => {
      if (!session) return;
      setInsideFolder(session, null);
      session.preview.destroy({ animate });
    },
    [setInsideFolder],
  );

  const ensureSession = useCallback(
    (drag: NonNullable<TrackDragState>): Session | null => {
      const key = sessionKey(drag);
      if (sessionRef.current?.key === key) return sessionRef.current;
      const currentSong = songRef.current;
      if (!currentSong) return null;

      destroy(sessionRef.current, false);
      destroy(settlingRef.current, false);
      sessionRef.current = null;
      settlingRef.current = null;

      const isCompact = drag.originSurface === "compact";
      const isSetlist = drag.originSurface === "setlist";
      const root: ParentNode = isCompact || isSetlist
        ? document
        : (timelineShellRef.current ?? document);
      const dragged = draggedTracks(currentSong, drag.trackId);
      const compactLayout = isCompact ? getCompactStripLayout() : null;
      const fromLayout = isCompact
        ? compactLayout
          ? compactStripItems(root, compactLayout, drag.trackId)
          : null
        : isSetlist
          ? null
          : layoutTrackItems(root, trackLayoutRef.current(), visibleIdsRef.current(), drag.trackId);
      let items: ReorderPreviewItem[];
      let source: HTMLElement | null;
      if (fromLayout) {
        items = fromLayout.items;
        source = fromLayout.source;
      } else {
        // El mezclador con todas sus tiras montadas y el caso raro de una fila
        // arrastrada que no está montada: se mide lo que hay en el DOM.
        const rows = Array.from(
          root.querySelectorAll<HTMLElement>(
            isCompact
              ? COMPACT_STRIP_SELECTOR
              : isSetlist
                ? SETLIST_ROW_SELECTOR
                : HEADER_ROW_SELECTOR,
          ),
        );
        // El carril de cada pista se desplaza con su cabecera.
        const lanesById = isCompact || isSetlist
          ? new Map<string, HTMLElement[]>()
          : mountedTrackRows(root).lanes;
        source = rows.find((row) => row.dataset.trackId === drag.trackId) ?? null;
        items = rows.map((row) => {
          const id = row.dataset.trackId ?? "";
          return { id, element: row, companions: lanesById.get(id) ?? [] };
        });
      }
      const preview = createReorderPreview({
        items,
        axis: isCompact ? "x" : "y",
        liftSource: source,
        liftCount: dragged.roots.length,
        pointer: { x: drag.startClientX, y: drag.startClientY },
        layoutAnchor: fromLayout?.anchor,
      });
      const session: Session = {
        key,
        preview,
        root,
        fromLayout: fromLayout !== null,
        ghostIds: dragged.rowIds,
        insideFolderId: null,
      };
      sessionRef.current = session;
      return session;
    },
    [destroy, songRef, timelineShellRef],
  );

  /** Destino bajo el puntero, contra la disposición del inicio del arrastre. */
  const resolveTrackDrop = useCallback(
    (
      drag: NonNullable<TrackDragState>,
      clientX: number,
      clientY: number,
    ): TrackDropState => {
      const currentSong = songRef.current;
      const session = ensureSession(drag);
      if (!currentSong || !session) return null;
      const hit = session.preview.hitTest(clientX, clientY);
      if (!hit || hit.id === drag.trackId) return null;
      const target = findTrack(currentSong, hit.id);
      if (!target || isTrackDescendant(currentSong, hit.id, drag.trackId)) {
        return null;
      }
      // En móvil el arrastre sólo REORDENA: el 40 % central de una fila, con
      // un dedo, es una moneda al aire entre dentro y encima. Meter pistas en
      // carpetas se hace desde el menú ("Mover a carpeta…").
      const mode =
        !isMobileApp &&
        target.kind === "folder" &&
        hit.ratio >= 0.3 &&
        hit.ratio <= 0.7
          ? "inside-folder"
          : hit.ratio < 0.5
            ? "before"
            : "after";
      return { targetTrackId: hit.id, mode };
    },
    [ensureSession, songRef],
  );

  const applyTrackDragVisuals = useCallback(
    (drag: NonNullable<TrackDragState>, drop: TrackDropState) => {
      const currentSong = songRef.current;
      const session = ensureSession(drag);
      if (!currentSong || !session) return;
      const plan = drop
        ? planTrackDrop({
            tracks: currentSong.tracks,
            visibleTrackIds: visibleIdsRef.current(),
            selectedTrackIds: useTimelineUIStore.getState().selectedTrackIds,
            draggedTrackId: drag.trackId,
            drop,
          })
        : null;
      session.preview.render(
        previewRowOrder({
          tracks: currentSong.tracks,
          rowIds: session.preview.ids,
          plan,
          automationAfterTrackId: currentSong.automationTrack?.afterTrackId ?? null,
        }),
        session.ghostIds,
      );
      session.preview.moveLift(drag.currentClientX, drag.currentClientY);
      setInsideFolder(
        session,
        plan && drop?.mode === "inside-folder" ? drop.targetTrackId : null,
      );
    },
    [ensureSession, setInsideFolder, songRef],
  );

  /**
   * `settle: true` en cuanto se acepta un soltar, ANTES de esperar al backend:
   * la lista ya está colocada como quedará, así que se quita la copia
   * flotante y lo arrastrado deja de ser translúcido, y todo se queda quieto
   * hasta que React pinte el orden nuevo (entonces se quita de golpe, ver el
   * efecto de abajo).
   *
   * Antes esto se llamaba al terminar el `moveTrack` y el refresco, y además
   * deshacía la vista previa a los 250 ms: con un backend lento (cada
   * movimiento reconstruye la estructura de audio y guarda), la copia se
   * quedaba clavada donde se soltó, las filas volvían deslizándose a su sitio
   * antiguo y luego saltaban al nuevo.
   *
   * `revert: true` deshace un soltar ya asentado que el backend rechazó. Sin
   * ninguna de las dos —arrastre cancelado o soltar en ningún sitio— la lista
   * vuelve a su sitio deslizándose.
   */
  const clearTrackDragVisuals = useCallback(
    (options?: { settle?: boolean; revert?: boolean }) => {
      if (options?.revert) {
        const settling = settlingRef.current;
        settlingRef.current = null;
        destroy(settling, true);
        return;
      }
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      if (!options?.settle) {
        destroy(session, true);
        return;
      }
      session.preview.dropLift();
      session.preview.clearGhosts();
      setInsideFolder(session, null);
      settlingRef.current = session;
      // Red de seguridad: un soltar que al final no cambió el orden nunca
      // dispara el efecto de abajo.
      window.setTimeout(() => {
        if (settlingRef.current !== session) return;
        settlingRef.current = null;
        destroy(session, true);
      }, SETTLE_TIMEOUT_MS);
    },
    [destroy, setInsideFolder],
  );

  // El soltar ya está pintado: cada fila está donde la enseñaba la vista
  // previa, así que se quita sin animar y antes de que se vea.
  const orderKey = useMemo(() => trackOrderKey(song), [song]);
  useLayoutEffect(() => {
    destroy(settlingRef.current, false);
    settlingRef.current = null;
  }, [orderKey, destroy]);

  /**
   * Adjunta a la vista previa en curso las filas montadas después de empezar
   * (las trae el auto-scroll cuando las filas están virtualizadas). Se llama
   * tras pintar una ventana de filas nueva; sin arrastre no hace nada.
   */
  const attachMountedTrackRows = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.fromLayout) return;
    if (session.key.startsWith("compact|")) {
      mountedCompactStrips(session.root).forEach((element, id) => {
        session.preview.attach(id, element);
      });
      return;
    }
    const { headers, lanes } = mountedTrackRows(session.root);
    headers.forEach((element, id) => {
      session.preview.attach(id, element, lanes.get(id) ?? []);
    });
  }, []);

  return {
    applyTrackDragVisuals,
    attachMountedTrackRows,
    clearTrackDragVisuals,
    resolveTrackDrop,
  };
}
