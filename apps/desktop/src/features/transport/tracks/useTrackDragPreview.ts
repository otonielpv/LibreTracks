import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import type { SongView } from "@libretracks/shared/models";

import { isMobileApp } from "../desktopApi";
import { findTrack, isTrackDescendant } from "../helpers";
import {
  createReorderPreview,
  type ReorderPreview,
} from "../reorder/reorderPreview";
import type { TrackDragState, TrackDropState } from "../types";
import { useTimelineUIStore } from "../uiStore";
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

export function useTrackDragPreview({
  song,
  songRef,
  timelineShellRef,
  getVisibleTrackIds,
}: {
  song: SongView | null;
  songRef: { current: SongView | null };
  timelineShellRef: { current: HTMLElement | null };
  getVisibleTrackIds: () => string[];
}) {
  const sessionRef = useRef<Session | null>(null);
  /** Un soltar que espera a que llegue el orden nuevo. */
  const settlingRef = useRef<Session | null>(null);
  const visibleIdsRef = useRef(getVisibleTrackIds);
  visibleIdsRef.current = getVisibleTrackIds;

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
      const root: ParentNode = isCompact
        ? document
        : (timelineShellRef.current ?? document);
      const rows = Array.from(
        root.querySelectorAll<HTMLElement>(
          isCompact
            ? ".lt-compact-mixer-strip[data-track-id]"
            : ".lt-track-header-row[data-track-id]",
        ),
      );
      const dragged = draggedTracks(currentSong, drag.trackId);
      // El carril de cada pista se desplaza con su cabecera.
      const lanesById = new Map<string, HTMLElement[]>();
      if (!isCompact) {
        root
          .querySelectorAll<HTMLElement>(".lt-track-lane-row[data-track-id]")
          .forEach((lane) => {
            const id = lane.dataset.trackId ?? "";
            lanesById.set(id, [...(lanesById.get(id) ?? []), lane]);
          });
      }
      const source =
        rows.find((row) => row.dataset.trackId === drag.trackId) ?? null;
      const preview = createReorderPreview({
        items: rows.map((row) => {
          const id = row.dataset.trackId ?? "";
          return {
            id,
            element: row,
            companions: lanesById.get(id) ?? [],
          };
        }),
        axis: isCompact ? "x" : "y",
        liftSource: source,
        liftCount: dragged.roots.length,
        pointer: { x: drag.startClientX, y: drag.startClientY },
      });
      const session: Session = {
        key,
        preview,
        root,
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
   * `settle: true` tras un soltar que va a cambiar el orden: la vista previa
   * se queda puesta hasta que React pinte el orden nuevo (y entonces se quita
   * de golpe, ver el efecto de abajo). Sin él —arrastre cancelado o soltar en
   * ningún sitio— la lista vuelve a su sitio deslizándose.
   */
  const clearTrackDragVisuals = useCallback(
    (options?: { settle?: boolean }) => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      if (!options?.settle) {
        destroy(session, true);
        return;
      }
      session.preview.dropLift();
      setInsideFolder(session, null);
      settlingRef.current = session;
      window.setTimeout(() => {
        if (settlingRef.current !== session) return;
        settlingRef.current = null;
        destroy(session, true);
      }, 250);
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

  return { applyTrackDragVisuals, clearTrackDragVisuals, resolveTrackDrop };
}
