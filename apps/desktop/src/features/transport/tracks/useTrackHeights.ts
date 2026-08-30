import { useCallback, useMemo, useRef } from "react";

import type { SongView, TransportSnapshot } from "@libretracks/shared/models";
import { getElementScaleY } from "@libretracks/shared/timelineMath";

import { TRACK_HEIGHT_STEP } from "../constants";
import { updateTrackHeightOffset } from "../desktopApi";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import { useTimelineUIStore } from "../uiStore";
import { createTrackHeightHandlers } from "./trackHeightHandlers";
import { buildTrackRowLayout } from "./trackLayout";

/**
 * Everything the arrangement needs to know about row heights: the layout the
 * canvas/lanes/headers share, and the gestures that change one track's height.
 *
 * It lives outside TransportPanelContent on purpose — this is a whole feature
 * (model write included), and the panel only has to call it and pass the result
 * down. See ./trackLayout for the geometry and ./trackHeightHandlers for the
 * gestures.
 */
export type UseTrackHeightsOptions = {
  /** Rows in draw order, synthetic lanes included. */
  visibleTracks: TimelineTrackSummary[];
  /** Live mirror of the same list, for handlers that must not re-bind. */
  visibleTracksRef: { current: TimelineTrackSummary[] };
  /** The global row height (uiStore). */
  trackHeight: number;
  songRef: { current: SongView | null };
  setSong: (update: (previous: SongView | null) => SongView | null) => void;
  /** Global height setter, used by the Alt-drag "every row" gesture. */
  setTrackHeight: (trackHeight: number) => void;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
};

export function useTrackHeights({
  visibleTracks,
  visibleTracksRef,
  trackHeight,
  songRef,
  setSong,
  setTrackHeight,
  runAction,
  applyPlaybackSnapshot,
  optimisticallyAppliedRevisionsRef,
}: UseTrackHeightsOptions) {
  // Where each row starts and how tall it is, with the per-track height offsets
  // folded into the global height. The canvas, the DOM lanes, the headers and
  // the vertical clip drag all read the row geometry from here so they cannot
  // disagree.
  const trackRowLayout = useMemo(
    () => buildTrackRowLayout(visibleTracks, trackHeight),
    [trackHeight, visibleTracks],
  );
  const trackRowLayoutRef = useRef(trackRowLayout);
  trackRowLayoutRef.current = trackRowLayout;

  const { handleRowResizeStart, resetRowHeight, stepRowHeight, stepRowHeightAtY } =
    useMemo(
      () =>
        createTrackHeightHandlers({
          getBaseHeight: () => useTimelineUIStore.getState().trackHeight,
          getRowLayout: () => trackRowLayoutRef.current,
          getVisibleTrackIds: () =>
            visibleTracksRef.current.map((track) => track.id),
          getSelectedTrackIds: () =>
            useTimelineUIStore.getState().selectedTrackIds,
          getSong: () => songRef.current,
          setSong,
          setBaseHeight: setTrackHeight,
          updateTrackHeightOffset,
          runAction,
          applyPlaybackSnapshot,
          optimisticallyAppliedRevisionsRef,
        }),
      [
        applyPlaybackSnapshot,
        optimisticallyAppliedRevisionsRef,
        runAction,
        setSong,
        setTrackHeight,
        songRef,
        visibleTracksRef,
      ],
    );

  /**
   * Alt + wheel over the track headers: resize just the track under the
   * pointer. Returns true when it handled the event, so the caller's own wheel
   * handler (Ctrl = every track, Shift = horizontal scroll) can bail out.
   */
  const handleHeaderAltWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.altKey) {
        return false;
      }
      const headersList = event.currentTarget as HTMLElement | null;
      if (!headersList) {
        return false;
      }
      if (event.cancelable) {
        event.preventDefault();
      }
      const bounds = headersList.getBoundingClientRect();
      stepRowHeightAtY(
        (event.clientY - bounds.top) /
          getElementScaleY(bounds, headersList.offsetHeight),
        event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP,
      );
      return true;
    },
    [stepRowHeightAtY],
  );

  return {
    trackRowLayout,
    trackRowLayoutRef,
    handleRowResizeStart,
    handleHeaderAltWheel,
    resetRowHeight,
    stepRowHeight,
    stepRowHeightAtY,
  };
}
