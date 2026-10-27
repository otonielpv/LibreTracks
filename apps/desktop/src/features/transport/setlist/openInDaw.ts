import { BASE_PIXELS_PER_SECOND } from "@libretracks/shared/timelineMath";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { ZOOM_MAX, ZOOM_MIN } from "../constants";
import { useTimelineUIStore } from "../uiStore";

/** Space left on each side of the song when it is framed in the DAW. */
export const DAW_FRAME_MARGIN = 0.06;
/** The DAW's lane width before it was ever measured (its ref's default). */
const UNMEASURED_LANE_WIDTH = 320;
/** Track headers and gutters, to guess the lanes from the window. */
const ESTIMATED_HEADERS_PX = 300;

/**
 * The DAW camera that shows `region` whole and centred in `viewportWidth`
 * pixels of lanes: the zoom that fits its length in the width minus a
 * margin on each side (`DAW_FRAME_MARGIN`), clamped to the DAW's zoom range,
 * and the camera that centres it.
 *
 *   zoom    = clamp(width · (1 − 2·margin) / (duration · BASE_PX_PER_SECOND))
 *   pps     = zoom · BASE_PX_PER_SECOND
 *   cameraX = max(0, start · pps − (width − duration · pps) / 2)
 */
export function frameRegionInDaw(
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  viewportWidth: number,
): { zoomLevel: number; cameraX: number } {
  const duration = Math.max(0.001, region.endSeconds - region.startSeconds);
  const usable = viewportWidth * (1 - 2 * DAW_FRAME_MARGIN);
  const zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, usable / (duration * BASE_PIXELS_PER_SECOND)));
  const pixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
  const cameraX = Math.max(0, region.startSeconds * pixelsPerSecond - (viewportWidth - duration * pixelsPerSecond) / 2);
  return { zoomLevel, cameraX };
}

/** The DAW's lane width: its last measurement, or a guess from the window
 * when the DAW has not been shown yet in this session. */
export function dawLaneWidth(measured: number, windowWidth: number): number {
  if (measured > UNMEASURED_LANE_WIDTH) return measured;
  return Math.max(UNMEASURED_LANE_WIDTH, windowWidth - ESTIMATED_HEADERS_PX);
}

export type OpenInDawDeps = {
  getRegion: (regionId: string) => SongRegionSummary | null;
  /** The DAW's `laneViewportWidthRef`. */
  getLaneViewportWidth: () => number;
  selectRegion: (regionId: string) => void;
};

/**
 * «Open in the DAW» from Setlist: select the song, frame it, switch to the
 * DAW and remember where to come back. The camera goes through the store:
 * the panel adopts an external `cameraX` (and mirrors `zoomLevel` into its
 * render refs) in its own effects, so no ref of the hot path is touched here
 * (docs/REDESIGN_transport_refs_to_stores.md).
 */
export function openInDaw(regionId: string, deps: OpenInDawDeps) {
  const region = deps.getRegion(regionId);
  if (!region) return;
  const width = dawLaneWidth(deps.getLaneViewportWidth(), typeof window === "undefined" ? 0 : window.innerWidth);
  const { zoomLevel, cameraX } = frameRegionInDaw(region, width);
  const ui = useTimelineUIStore.getState();
  deps.selectRegion(region.id);
  ui.setZoomLevel(zoomLevel);
  ui.setCameraX(cameraX);
  const from = ui.viewMode;
  ui.setViewMode("daw");
  // After the switch: changing views clears it.
  useTimelineUIStore.getState().setReturnViewMode(from === "daw" ? null : from);
}
