import { useMemo } from "react";

import {
  buildVisibleTimelineGrid,
  snapToTimelineGrid,
  type TimelineGrid,
  type TimelineGridParams,
} from "./timelineMath";

export { snapToTimelineGrid, type TimelineGrid, type TimelineGridParams };

export function useTimelineGrid(params: TimelineGridParams): TimelineGrid {
  return useMemo(
    () => buildVisibleTimelineGrid(params),
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
