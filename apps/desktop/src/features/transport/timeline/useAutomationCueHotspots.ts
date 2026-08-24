import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { secondsToScreenX } from "./timelineMath";
import type { AutomationCueSummary } from "../desktopApi";

export type MarkerMovePreview = {
  markerId: string;
  startSeconds: number;
} | null;

export type AutomationCueHotspotDeps = {
  cues: AutomationCueSummary[] | undefined;
  cameraXRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  /** Committed zoom, used only as a fallback before the live ref is seeded. */
  pixelsPerSecond: number;
  /** In-flight drag position, so a dragged diamond follows the pointer. */
  markerMovePreviewRef: MutableRefObject<MarkerMovePreview>;
};

/**
 * Keeps the automation-cue hit targets glued to the diamonds the canvas paints.
 *
 * Cue hotspots sit in the track-lane area, which — unlike the ruler overlay —
 * has no camera/zoom wrapper. The canvas paints each diamond at
 * `secondsToScreenX(atSeconds, cameraX, livePixelsPerSecond)`, so the hotspot
 * has to be placed identically. Positioning it at `atSeconds * pixelsPerSecond`
 * (no camera term, committed zoom) only matches at cameraX = 0 with a settled
 * zoom; after any scroll or zoom the invisible button drifts off the visible
 * diamond and the cue can't be grabbed.
 *
 * `cameraX` and the live zoom are refs that change without re-rendering, so the
 * placement runs on rAF rather than through React — the same approach
 * PlayheadOverlay uses for the playhead.
 */
export function useAutomationCueHotspots({
  cues,
  cameraXRef,
  livePixelsPerSecondRef,
  pixelsPerSecond,
  markerMovePreviewRef,
}: AutomationCueHotspotDeps) {
  const hotspotsRef = useRef(new Map<string, HTMLButtonElement>());
  const positionsRef = useRef(new Map<string, number>());
  /** Identidad de la lista con la que se construyó `positionsRef`. */
  const positionsSourceRef = useRef<AutomationCueSummary[] | undefined>(
    undefined,
  );

  // El mapa se reconstruía en CADA render; sólo cambia cuando cambia la lista.
  if (positionsSourceRef.current !== cues) {
    positionsSourceRef.current = cues;
    positionsRef.current = new Map(
      (cues ?? []).map((cue) => [cue.id, cue.atSeconds]),
    );
  }

  const registerHotspot = useCallback(
    (cueId: string, element: HTMLButtonElement | null) => {
      if (element) {
        hotspotsRef.current.set(cueId, element);
      } else {
        hotspotsRef.current.delete(cueId);
      }
    },
    [],
  );

  useEffect(() => {
    let animationFrameId = 0;
    const lastLeftByCue = new Map<string, number>();

    const sync = () => {
      const cameraX = cameraXRef.current;
      const livePixelsPerSecond =
        livePixelsPerSecondRef.current ?? pixelsPerSecond;
      const preview = markerMovePreviewRef.current;

      for (const [cueId, element] of hotspotsRef.current.entries()) {
        const atSeconds =
          preview?.markerId === cueId
            ? preview.startSeconds
            : positionsRef.current.get(cueId);
        if (atSeconds === undefined) continue;

        const left = secondsToScreenX(atSeconds, cameraX, livePixelsPerSecond);
        // Only touch style when it actually changes; this runs every frame.
        if (lastLeftByCue.get(cueId) !== left) {
          // `transform`, no `left`: escribir `left` invalida el layout, y esto
          // corre en cada frame para CADA cue — durante un pan o un zoom
          // cambian todas a la vez. Una transformación se queda en el
          // compositor. El `left: 0` lo fija el CSS del hotspot; el centrado
          // sobre el diamante lo sigue haciendo su `margin-left` negativo.
          element.style.transform = `translateX(${left}px)`;
          lastLeftByCue.set(cueId, left);
        }
      }

      animationFrameId = window.requestAnimationFrame(sync);
    };

    animationFrameId = window.requestAnimationFrame(sync);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [cameraXRef, livePixelsPerSecondRef, markerMovePreviewRef, pixelsPerSecond]);

  return { registerHotspot };
}
