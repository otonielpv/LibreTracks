import type { TrackSummary } from "@libretracks/shared/models";

import type { TrackDropState } from "../types";
import { AUTOMATION_TRACK_ID } from "../library/pendingAudioImports";

/**
 * Qué movimientos hace soltar una o varias pistas, calculado en UN sitio.
 *
 * Lo usan las dos mitades del gesto: el soltar de verdad (que manda cada
 * movimiento al backend) y la vista previa (que enseña dónde quedará todo
 * antes de soltar). Si cada una calculase el resultado por su cuenta, el
 * fantasma podría prometer un orden y el backend dejar otro.
 *
 * `applyTrackMoves` es una copia de `reparent_track`
 * (src-tauri/src/state/track_tree.rs): una pista se mueve con todo su subárbol
 * y "después de X" significa después del subárbol entero de X.
 */

export type MoveTrackArgs = {
  trackId: string;
  insertAfterTrackId: string | null;
  insertBeforeTrackId: string | null;
  parentTrackId: string | null;
};

export type TrackDropPlan =
  /** El carril sintético de automatización: no es una pista, sólo se guarda
   * detrás de qué pista va (`null` = primero). */
  | { kind: "automation"; afterTrackId: string | null }
  | { kind: "tracks"; moves: MoveTrackArgs[] };

type PlanInput = {
  tracks: readonly TrackSummary[];
  /** Orden visible de filas, incluido AUTOMATION_TRACK_ID si está. */
  visibleTrackIds: readonly string[];
  selectedTrackIds: readonly string[];
  draggedTrackId: string;
  drop: NonNullable<TrackDropState>;
};

function moveArgsFor(
  trackId: string,
  target: TrackSummary,
  mode: NonNullable<TrackDropState>["mode"],
): MoveTrackArgs {
  if (mode === "inside-folder") {
    return {
      trackId,
      insertAfterTrackId: null,
      insertBeforeTrackId: null,
      parentTrackId: target.id,
    };
  }
  if (mode === "before") {
    return {
      trackId,
      insertAfterTrackId: null,
      insertBeforeTrackId: target.id,
      parentTrackId: target.parentTrackId ?? null,
    };
  }
  return {
    trackId,
    insertAfterTrackId: target.id,
    insertBeforeTrackId: null,
    parentTrackId: target.parentTrackId ?? null,
  };
}

/** Detrás de qué pista queda el carril de automatización al soltarlo. */
function automationAfterIdFor(
  visibleTrackIds: readonly string[],
  targetTrackId: string,
  mode: NonNullable<TrackDropState>["mode"],
): string | null {
  if (mode === "after" || mode === "inside-folder") {
    return targetTrackId;
  }
  // "before": detrás de la pista visible anterior al destino.
  const order = visibleTrackIds.filter((id) => id !== AUTOMATION_TRACK_ID);
  const targetIndex = order.indexOf(targetTrackId);
  return targetIndex <= 0 ? null : order[targetIndex - 1];
}

function isAncestorOf(
  byId: Map<string, TrackSummary>,
  ancestorId: string,
  trackId: string,
): boolean {
  let cursor = byId.get(trackId)?.parentTrackId ?? null;
  while (cursor) {
    if (cursor === ancestorId) return true;
    cursor = byId.get(cursor)?.parentTrackId ?? null;
  }
  return false;
}

/** `null` = soltar ahí no cambia nada. */
export function planTrackDrop({
  tracks,
  visibleTrackIds,
  selectedTrackIds,
  draggedTrackId,
  drop,
}: PlanInput): TrackDropPlan | null {
  const byId = new Map(tracks.map((track) => [track.id, track]));

  if (draggedTrackId === AUTOMATION_TRACK_ID) {
    if (drop.targetTrackId === AUTOMATION_TRACK_ID) return null;
    return {
      kind: "automation",
      afterTrackId: automationAfterIdFor(
        visibleTrackIds,
        drop.targetTrackId,
        drop.mode,
      ),
    };
  }

  if (drop.targetTrackId === AUTOMATION_TRACK_ID) {
    // Soltar junto al carril de automatización: se ancla a la pista real más
    // cercana en esa dirección. Sólo la pista arrastrada, como siempre.
    const laneIndex = visibleTrackIds.indexOf(AUTOMATION_TRACK_ID);
    const anchorId =
      drop.mode === "before"
        ? visibleTrackIds
            .slice(laneIndex + 1)
            .find((id) => id !== AUTOMATION_TRACK_ID)
        : visibleTrackIds
            .slice(0, laneIndex)
            .reverse()
            .find((id) => id !== AUTOMATION_TRACK_ID);
    const anchor = anchorId ? byId.get(anchorId) : undefined;
    if (!anchor || anchor.id === draggedTrackId) return null;
    return {
      kind: "tracks",
      moves: [moveArgsFor(draggedTrackId, anchor, drop.mode)],
    };
  }

  const target = byId.get(drop.targetTrackId);
  if (!target || target.id === draggedTrackId) return null;

  const dragged =
    selectedTrackIds.includes(draggedTrackId) && selectedTrackIds.length > 1
      ? selectedTrackIds
      : [draggedTrackId];
  const draggedSet = new Set(dragged);
  const order = new Map(tracks.map((track, index) => [track.id, index]));

  const roots = dragged
    .filter((id) => byId.has(id) && id !== target.id)
    // Una pista cuya carpeta también se mueve ya viaja dentro de ella;
    // moverla aparte la sacaría de la carpeta.
    .filter(
      (id) => ![...draggedSet].some((other) => isAncestorOf(byId, other, id)),
    )
    // Una carpeta no puede caer junto a (ni dentro de) su propia descendiente:
    // el backend lo rechaza y tumbaría el soltar entero.
    .filter((id) => !isAncestorOf(byId, id, target.id))
    // En el orden en que se ven, no en el que se seleccionaron.
    .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));

  if (roots.length === 0) return null;
  // "Después de X" inserta cada pista justo tras el subárbol de X: moverlas
  // en orden las dejaría invertidas. Al revés, quedan como se veían.
  const sequence = drop.mode === "after" ? [...roots].reverse() : roots;
  return {
    kind: "tracks",
    moves: sequence.map((id) => moveArgsFor(id, target, drop.mode)),
  };
}

function depthOf(byId: Map<string, TrackSummary>, trackId: string): number {
  let depth = 0;
  let cursor = byId.get(trackId)?.parentTrackId ?? null;
  while (cursor) {
    depth += 1;
    cursor = byId.get(cursor)?.parentTrackId ?? null;
  }
  return depth;
}

function subtreeBounds(tracks: TrackSummary[], trackId: string): [number, number] | null {
  const start = tracks.findIndex((track) => track.id === trackId);
  if (start < 0) return null;
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const rootDepth = depthOf(byId, trackId);
  let end = start + 1;
  while (end < tracks.length && depthOf(byId, tracks[end].id) > rootDepth) {
    end += 1;
  }
  return [start, end];
}

/** Aplica los movimientos sobre una copia, como haría el backend. */
export function applyTrackMoves(
  tracks: readonly TrackSummary[],
  moves: readonly MoveTrackArgs[],
): TrackSummary[] {
  let next = [...tracks];
  for (const move of moves) {
    const bounds = subtreeBounds(next, move.trackId);
    if (!bounds) continue;
    const block = next.slice(bounds[0], bounds[1]);
    next = [...next.slice(0, bounds[0]), ...next.slice(bounds[1])];
    block[0] = { ...block[0], parentTrackId: move.parentTrackId };

    let insertIndex = next.length;
    const anchorAfter = move.insertAfterTrackId
      ? subtreeBounds(next, move.insertAfterTrackId)
      : null;
    const anchorBefore = move.insertBeforeTrackId
      ? subtreeBounds(next, move.insertBeforeTrackId)
      : null;
    const parent = move.parentTrackId ? subtreeBounds(next, move.parentTrackId) : null;
    if (anchorAfter) insertIndex = anchorAfter[1];
    else if (anchorBefore) insertIndex = anchorBefore[0];
    else if (parent) insertIndex = parent[1];
    next.splice(insertIndex, 0, ...block);
  }
  return next;
}

/**
 * Orden de las filas que se ven (`rowIds`, tal como están ahora en pantalla)
 * después de aplicar `plan`. Una pista que cae dentro de una carpeta plegada
 * deja de verse y no aparece en el resultado.
 */
export function previewRowOrder({
  tracks,
  rowIds,
  plan,
  automationAfterTrackId,
}: {
  tracks: readonly TrackSummary[];
  rowIds: readonly string[];
  plan: TrackDropPlan | null;
  /** Dónde está ahora el carril de automatización (`null` = primero). */
  automationAfterTrackId: string | null;
}): string[] {
  const shown = new Set(rowIds);
  const nextTracks =
    plan?.kind === "tracks" ? applyTrackMoves(tracks, plan.moves) : [...tracks];
  const byId = new Map(nextTracks.map((track) => [track.id, track]));
  const hiddenByFolder = (track: TrackSummary) => {
    let cursor = track.parentTrackId ?? null;
    while (cursor) {
      const parent = byId.get(cursor);
      if (parent?.collapsed) return true;
      cursor = parent?.parentTrackId ?? null;
    }
    return false;
  };

  const order = nextTracks
    .filter((track) => shown.has(track.id) && !hiddenByFolder(track))
    .map((track) => track.id);

  if (shown.has(AUTOMATION_TRACK_ID)) {
    const afterId =
      plan?.kind === "automation" ? plan.afterTrackId : automationAfterTrackId;
    const anchor = afterId === null ? -1 : order.indexOf(afterId);
    order.splice(anchor + 1, 0, AUTOMATION_TRACK_ID);
  }

  // Filas que no son pistas (importaciones en curso): siguen al final.
  const real = new Set(tracks.map((track) => track.id));
  for (const id of rowIds) {
    if (id !== AUTOMATION_TRACK_ID && !real.has(id)) order.push(id);
  }
  return order;
}
