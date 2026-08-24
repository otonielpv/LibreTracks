import { useMemo } from "react";

import { recordGridBuild } from "../perf/perfMetrics";
import {
  buildVisibleTimelineGrid,
  snapToTimelineGrid,
  type TimelineGrid,
  type TimelineGridParams,
} from "./timelineMath";

export { snapToTimelineGrid, type TimelineGrid, type TimelineGridParams };

export function useTimelineGrid(params: TimelineGridParams): TimelineGrid {
  return useMemo(
    () => {
      // Si este contador sube al ritmo de los renders de React en vez de al de
      // los cambios reales de canción/viewport, el memo no está acertando:
      // es la causa C6 del diagnóstico, y `params.regions` (construido en el
      // cuerpo del render) es el sospechoso.
      const grid = buildVisibleTimelineGrid(params);
      recordGridBuild(grid.markers.length);
      return grid;
    },
    [
      params.bpm,
      params.durationSeconds,
      params.pixelsPerSecond,
      params.regions,
      params.timeSignature,
      params.viewportEndSeconds,
      params.viewportStartSeconds,
      params.zoomLevel,
    ],
  );
}
