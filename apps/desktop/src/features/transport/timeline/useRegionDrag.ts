import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { SongRegionSummary, SongView } from "../desktopApi";
import type { TimelineClipSummary } from "../library/pendingAudioImports";
import {
  getElementScaleX,
  getTimelineWorkspaceEndSeconds,
  snapToTimelineBar,
} from "./timelineMath";
import { snapToTimelineGrid } from "./useTimelineGrid";
import { buildSongTempoRegions } from "@libretracks/shared/models";
import {
  applyRegionHotspotBounds,
} from "./regionHotspotBounds";

/**
 * Arrastre y redimensionado de las bandas de canción del ruler.
 *
 * Extraído de `TimelineCanvasPane` por dos razones, en este orden:
 *
 * 1. **Rendimiento.** El preview en vuelo pasó de `setState` por
 *    `pointermove` a escritura directa del estilo del elemento. Medido antes
 *    del cambio: 144 renders/segundo del panel entero mientras el puntero se
 *    mueve, uno por frame (docs/plans/ui-performance/state/01.md). El
 *    arrastre de clips ya funcionaba así; los del ruler no.
 * 2. **Presupuesto de tamaño.** `TimelineCanvasPane.tsx` estaba a una línea de
 *    su límite y la regla del repo es extraer, no subir el número.
 *
 * La frontera es limpia: el bloque sólo tiene refs propias
 * (`regionResizeDragRef`, `regionMoveDragRef`, el registro de elementos) y
 * recibe el resto por parámetros.
 *
 * El long-press táctil se queda en el panel a propósito: vive dentro del JSX
 * del hotspot y necesita el menú contextual, así que su frontera está allí.
 */

export type RegionMoveDragState = {
  regionId: string;
  pointerId: number;
  pointerStartClientX: number;
  pointerScaleX: number;
  initialStartSeconds: number;
  initialEndSeconds: number;
  minStartSeconds: number;
  maxStartSeconds: number;
  previewStartSeconds: number;
  previewEndSeconds: number;
};

export type RegionDragDeps = {
  song: SongView | null;
  /** Píxeles por segundo CONFIRMADOS: la misma escala con la que React pinta
   *  la posición de reposo. El zoom en vuelo lo aplica el envoltorio del
   *  ruler con una sola transformación. */
  pixelsPerSecond: number;
  livePixelsPerSecondRef: { current: number };
  /** Clips por pista: el redimensionado se imanta a los bordes de los clips
   *  que la región contiene, para no dejar audio fuera de ninguna canción. */
  clipsByTrack: Record<string, TimelineClipSummary[]>;
  snapEnabled?: boolean;
  onRegionResizeCommit?: (
    regionId: string,
    startSeconds: number,
    endSeconds: number,
  ) => void;
  onRegionMoveCommit?: (regionId: string, deltaSeconds: number) => void;
};

export function useRegionDrag({
  song,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  clipsByTrack,
  snapEnabled,
  onRegionResizeCommit,
  onRegionMoveCommit,
}: RegionDragDeps) {
  // Local-only state for the in-flight resize. Backend is touched once on
  // pointer-up via onRegionResizeCommit; everything else is optimistic. Kept
  // in useRef + useState pair because the rAF-style move handler needs the
  // stable initial values via ref while React still has to re-render to
  // reflect the live preview width.
  type RegionResizeDrag = {
    regionId: string;
    edge: "start" | "end";
    pointerId: number;
    pointerStartClientX: number;
    pointerScaleX: number;
    initialStartSeconds: number;
    initialEndSeconds: number;
    minStartSeconds: number; // lower clamp for the moving edge (left neighbour end or 0)
    maxEndSeconds: number; // upper clamp for the moving edge (right neighbour start or duration)
    // Magnet bounds from the clips INSIDE the region: the region must not be
    // shrunk past the audio it contains, or the backend rejects it. End edge
    // can't go below the last clip's end; start edge can't go above the first
    // clip's start. null = no clips in the region (no clip constraint).
    clipFloorEndSeconds: number | null; // hard floor for the END edge
    clipCeilStartSeconds: number | null; // hard ceiling for the START edge
    previewStartSeconds: number;
    previewEndSeconds: number;
  };
  const regionResizeDragRef = useRef<RegionResizeDrag | null>(null);
  /** Banda DOM de cada región, para moverla sin re-renderizar. */
  const regionHotspotElements = useRef(new Map<string, HTMLButtonElement>());

  // Move drag (translate the entire song — region + clips + markers).
  // The math here is simpler than resize because the region's WIDTH
  // doesn't change; only its start moves and we just translate
  // everything inside by the same delta. The clamp comes from the
  // neighbour regions on either side: the moved song can't slide
  // into another song's range.
  type RegionMoveDrag = {
    regionId: string;
    pointerId: number;
    pointerStartClientX: number;
    pointerScaleX: number;
    initialStartSeconds: number;
    initialEndSeconds: number;
    // Clamps for the moving START seconds (so neighbour-end ≤ start
    // and start + duration ≤ next neighbour's start).
    minStartSeconds: number;
    maxStartSeconds: number;
    previewStartSeconds: number;
    previewEndSeconds: number;
  };
  const regionMoveDragRef = useRef<RegionMoveDrag | null>(null);
  const MIN_REGION_DURATION_SECONDS = 0.1;

  /**
   * Devuelve la banda de la región a su posición de reposo (la del modelo).
   *
   * Hace falta porque la posición en vuelo se escribe imperativamente: si el
   * commit no llega a cambiar nada (un movimiento rechazado, un redimensionado
   * que acaba donde empezó), React re-renderiza con los MISMOS valores que ya
   * tenía y no vuelve a tocar el estilo — dejando la banda donde la soltó el
   * puntero. Restaurar aquí cierra ese hueco.
   */
  function restoreRegionHotspot(regionId: string) {
    const region = song?.regions.find((entry) => entry.id === regionId);
    const element = regionHotspotElements.current.get(regionId) ?? null;
    if (!region || !element) return;
    applyRegionHotspotBounds(
      element,
      region.startSeconds,
      region.endSeconds,
      pixelsPerSecond,
    );
  }

  function beginRegionResize(
    event: ReactPointerEvent<HTMLDivElement>,
    region: SongRegionSummary,
    edge: "start" | "end",
  ) {
    if (!song) return;
    event.preventDefault();
    event.stopPropagation();

    // Build sorted neighbours to compute clamp bounds. Neighbour-end is the
    // lower bound for our start edge; neighbour-start is the upper bound
    // for our end edge.
    const sorted = [...song.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const idx = sorted.findIndex((entry) => entry.id === region.id);
    const leftNeighbour = idx > 0 ? sorted[idx - 1] : null;
    const rightNeighbour =
      idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const minStart = leftNeighbour ? leftNeighbour.endSeconds : 0;
    // With a right neighbour, that neighbour's start is the hard wall — the
    // region must not overlap it. Without one, the region is free to grow past
    // the end of the song into the empty workspace tail; growing it does not
    // move the song end or any clips (the user moves those separately if they
    // want to). The 1-hour workspace tail is the practical upper bound.
    const maxEnd = rightNeighbour
      ? rightNeighbour.startSeconds
      : getTimelineWorkspaceEndSeconds(song.durationSeconds);

    // Magnet to the clips the region contains: a region can't be shrunk past
    // its own audio (the backend rejects clips falling outside the region). A
    // clip counts as "inside" if its timeline span overlaps the region's
    // current span. The END edge can't shrink below the furthest clip end; the
    // START edge can't grow past the earliest clip start.
    let clipFloorEndSeconds: number | null = null;
    let clipCeilStartSeconds: number | null = null;
    for (const clips of Object.values(clipsByTrack)) {
      for (const clip of clips) {
        const clipStart = clip.timelineStartSeconds;
        const clipEnd = clip.timelineStartSeconds + clip.durationSeconds;
        const overlapsRegion =
          clipStart < region.endSeconds && clipEnd > region.startSeconds;
        if (!overlapsRegion) continue;
        clipFloorEndSeconds =
          clipFloorEndSeconds === null
            ? clipEnd
            : Math.max(clipFloorEndSeconds, clipEnd);
        clipCeilStartSeconds =
          clipCeilStartSeconds === null
            ? clipStart
            : Math.min(clipCeilStartSeconds, clipStart);
      }
    }

    regionResizeDragRef.current = {
      regionId: region.id,
      edge,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: region.startSeconds,
      initialEndSeconds: region.endSeconds,
      minStartSeconds: minStart,
      maxEndSeconds: maxEnd,
      clipFloorEndSeconds,
      clipCeilStartSeconds,
      previewStartSeconds: region.startSeconds,
      previewEndSeconds: region.endSeconds,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-active");
  }

  function updateRegionResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = regionResizeDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const deltaSeconds =
      (event.clientX - drag.pointerStartClientX) /
      drag.pointerScaleX /
      effectivePixelsPerSecond;

    let nextStart = drag.initialStartSeconds;
    let nextEnd = drag.initialEndSeconds;
    if (drag.edge === "start") {
      nextStart = drag.initialStartSeconds + deltaSeconds;
    } else {
      nextEnd = drag.initialEndSeconds + deltaSeconds;
    }

    // Snap to BAR grid (downbeat). Song boundaries are bar-aligned;
    // snapping mid-bar would produce off-grid edges. Alt bypasses
    // snap for ad-hoc resizing.
    const shouldSnap = Boolean(snapEnabled) && !event.altKey;
    if (shouldSnap) {
      const songBpm = song.bpm;
      const songTs = song.timeSignature;
      const tempoRegions = buildSongTempoRegions(song);
      if (drag.edge === "start") {
        nextStart = snapToTimelineBar(nextStart, songBpm, songTs, tempoRegions);
      } else {
        nextEnd = snapToTimelineBar(nextEnd, songBpm, songTs, tempoRegions);
      }
    }

    // Clamp to neighbours and minimum duration.
    if (drag.edge === "start") {
      // Magnet: the start edge can't grow past the first clip's start (would
      // leave audio outside the region → backend error). Hard-stop there.
      const startCeil =
        drag.clipCeilStartSeconds === null
          ? drag.initialEndSeconds - MIN_REGION_DURATION_SECONDS
          : Math.min(
              drag.clipCeilStartSeconds,
              drag.initialEndSeconds - MIN_REGION_DURATION_SECONDS,
            );
      nextStart = Math.max(drag.minStartSeconds, Math.min(nextStart, startCeil));
    } else {
      // Magnet: the end edge can't shrink below the last clip's end. Hard-stop
      // there so the region stays "imantado" at the clip boundary.
      const endFloor =
        drag.clipFloorEndSeconds === null
          ? drag.initialStartSeconds + MIN_REGION_DURATION_SECONDS
          : Math.max(
              drag.clipFloorEndSeconds,
              drag.initialStartSeconds + MIN_REGION_DURATION_SECONDS,
            );
      nextEnd = Math.min(drag.maxEndSeconds, Math.max(nextEnd, endFloor));
    }

    drag.previewStartSeconds = nextStart;
    drag.previewEndSeconds = nextEnd;
    applyRegionHotspotBounds(
      regionHotspotElements.current.get(drag.regionId) ?? null,
      nextStart,
      nextEnd,
      pixelsPerSecond,
    );
  }

  function endRegionResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = regionResizeDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    event.currentTarget.classList.remove("is-active");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released by the browser; ignore.
    }

    const finalStart = drag.previewStartSeconds;
    const finalEnd = drag.previewEndSeconds;
    const changed =
      finalStart !== drag.initialStartSeconds ||
      finalEnd !== drag.initialEndSeconds;

    regionResizeDragRef.current = null;
    restoreRegionHotspot(drag.regionId);

    if (changed && onRegionResizeCommit) {
      onRegionResizeCommit(drag.regionId, finalStart, finalEnd);
    }
  }

  function beginRegionMove(
    event: ReactPointerEvent<HTMLElement>,
    region: SongRegionSummary,
  ) {
    if (!song) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const sorted = [...song.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const idx = sorted.findIndex((entry) => entry.id === region.id);
    const leftNeighbour = idx > 0 ? sorted[idx - 1] : null;
    const rightNeighbour =
      idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const duration = region.endSeconds - region.startSeconds;
    const minStart = leftNeighbour ? leftNeighbour.endSeconds : 0;
    // No upper bound: moving right is always allowed. The backend
    // cascade-pushes any region that would overlap, and the user is
    // free to extend the project past its current end.
    const maxStart = Number.POSITIVE_INFINITY;

    regionMoveDragRef.current = {
      regionId: region.id,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: region.startSeconds,
      initialEndSeconds: region.endSeconds,
      minStartSeconds: minStart,
      maxStartSeconds: Math.max(minStart, maxStart),
      previewStartSeconds: region.startSeconds,
      previewEndSeconds: region.endSeconds,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-moving");
  }

  function updateRegionMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = regionMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const rawDelta =
      (event.clientX - drag.pointerStartClientX) /
      drag.pointerScaleX /
      effectivePixelsPerSecond;
    let nextStart = drag.initialStartSeconds + rawDelta;

    // Visual snap during the drag uses the FULL song grid (the moved
    // region's own tempo markers included). This makes the preview
    // land on the SAME visible grid lines the user sees on screen.
    // The commit-time logic in endRegionMove re-snaps using the
    // previous region's grid, which is what actually matters for
    // the final landing position. Holding Shift bypasses snap.
    const shouldSnap = Boolean(snapEnabled) && !event.shiftKey;
    if (shouldSnap) {
      nextStart = snapToTimelineGrid(
        nextStart,
        song.bpm,
        song.timeSignature,
        1,
        effectivePixelsPerSecond,
        buildSongTempoRegions(song),
      );
    }

    // Clamp to neighbour bounds — no overlap with adjacent songs.
    nextStart = Math.max(
      drag.minStartSeconds,
      Math.min(nextStart, drag.maxStartSeconds),
    );

    const duration = drag.initialEndSeconds - drag.initialStartSeconds;
    const nextEnd = nextStart + duration;

    drag.previewStartSeconds = nextStart;
    drag.previewEndSeconds = nextEnd;
    applyRegionHotspotBounds(
      regionHotspotElements.current.get(drag.regionId) ?? null,
      nextStart,
      nextEnd,
      pixelsPerSecond,
    );
  }

  function endRegionMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = regionMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    event.currentTarget.classList.remove("is-moving");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released — ignore.
    }

    // On commit, re-snap using the PREVIOUS region's grid (with the
    // moved region's tempo markers filtered out, since they travel
    // with the region and would otherwise grid the destination zone
    // with the moved region's own BPM). This is what makes the
    // final landing align with the destination's bars/beats. Shift
    // bypasses snap entirely.
    let finalStart = drag.previewStartSeconds;
    if (snapEnabled && !event.shiftKey && song) {
      const oldStart = drag.initialStartSeconds;
      const oldEnd = drag.initialEndSeconds;
      const insideMoved = (pos: number) =>
        pos >= oldStart - 0.001 && pos < oldEnd;
      const songWithoutMovedInternals: SongView = {
        ...song,
        tempoMarkers: song.tempoMarkers.filter(
          (m) => !insideMoved(m.startSeconds),
        ),
        timeSignatureMarkers: song.timeSignatureMarkers.filter(
          (m) => !insideMoved(m.startSeconds),
        ),
      };
      const livePps =
        livePixelsPerSecondRef.current ?? pixelsPerSecond ?? 1;
      finalStart = snapToTimelineGrid(
        finalStart,
        song.bpm,
        song.timeSignature,
        1,
        livePps,
        buildSongTempoRegions(songWithoutMovedInternals),
      );
      finalStart = Math.max(
        drag.minStartSeconds,
        Math.min(finalStart, drag.maxStartSeconds),
      );
    }
    const finalDelta = finalStart - drag.initialStartSeconds;
    regionMoveDragRef.current = null;
    restoreRegionHotspot(drag.regionId);

    if (Math.abs(finalDelta) > 1e-6 && onRegionMoveCommit) {
      onRegionMoveCommit(drag.regionId, finalDelta);
    }
  }
  return {
    /** Registra la banda DOM de una región para poder moverla sin render. */
    registerRegionHotspot(
      regionId: string,
      element: HTMLButtonElement | null,
    ) {
      if (element) {
        regionHotspotElements.current.set(regionId, element);
      } else {
        regionHotspotElements.current.delete(regionId);
      }
    },
    restoreRegionHotspot,
    regionMoveDragRef,
    beginRegionResize,
    updateRegionResize,
    endRegionResize,
    beginRegionMove,
    updateRegionMove,
    endRegionMove,
  };
}
