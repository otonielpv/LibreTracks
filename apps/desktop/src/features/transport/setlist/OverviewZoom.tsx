import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cancelGatedFrame, markFrameActivity, requestGatedFrame, useFrameGateWake } from "../frameGate";
import { useSetlistStore } from "./setlistStore";

export const OVERVIEW_MAX_ZOOM = 8;

/** How far to slide a `zoom`× wide layer so `fraction` of it sits in the
 * middle of a `viewportWidth` window, never past its edges. */
export function followOffset(fraction: number, viewportWidth: number, zoom: number): number {
  if (zoom <= 1 || viewportWidth <= 0) return 0;
  const layerWidth = viewportWidth * zoom;
  const centred = fraction * layerWidth - viewportWidth / 2;
  return Math.max(0, Math.min(layerWidth - viewportWidth, centred));
}

type OverviewZoomProps = {
  startSeconds: number;
  endSeconds: number;
  positionSecondsRef: { readonly current: number };
  /** Inside the zoomed layer: the waveform, the section blocks, the edit
   * handles. They place things in % of the song, so they stay aligned. */
  children: ReactNode;
  /** Outside the layer (they must not slide): loop / next. */
  overlay?: ReactNode;
};

/**
 * The band's zoom (the iPhone report: the whole song at once was too small
 * to aim at). At 1× the song fits; zoomed in, the layer is that many times
 * wider and always follows the playhead (centred), by rAF with no React
 * render. Tapping still seeks: the waveform maps the pointer through its own
 * (moved) bounds.
 */
export function OverviewZoom({ startSeconds, endSeconds, positionSecondsRef, children, overlay }: OverviewZoomProps) {
  const { t } = useTranslation();
  useFrameGateWake();
  const zoom = useSetlistStore((state) => state.overviewZoom);
  const setZoom = useSetlistStore((state) => state.setOverviewZoom);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frameId = 0;
    let last = Number.NaN;
    const frame = () => {
      const viewport = viewportRef.current;
      const layer = layerRef.current;
      if (viewport && layer) {
        const duration = Math.max(0.001, endSeconds - startSeconds);
        const fraction = Math.max(0, Math.min(1, (positionSecondsRef.current - startSeconds) / duration));
        const offset = Math.round(followOffset(fraction, viewport.clientWidth, zoom));
        if (offset !== last) {
          layer.style.setProperty("transform", offset ? `translate3d(${-offset}px, 0, 0)` : "none");
          last = offset;
          markFrameActivity();
        }
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, [endSeconds, positionSecondsRef, startSeconds, zoom]);

  return (
    <>
      <div ref={viewportRef} className="lt-setlist-zoom-viewport">
        <div
          ref={layerRef}
          className="lt-setlist-zoom-layer"
          style={{ width: `${zoom * 100}%` }}
          data-zoom={zoom}
        >
          {children}
        </div>
      </div>
      {overlay}
      <div className="lt-setlist-zoom-controls" role="group" aria-label={t("setlistView.overview.zoomGroup")}>
        <button
          type="button"
          className="lt-setlist-map-action"
          aria-label={t("setlistView.lanes.zoomOut")}
          title={t("setlistView.lanes.zoomOut")}
          disabled={zoom <= 1}
          onClick={() => setZoom(zoom / 2)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">zoom_out</span>
        </button>
        <button
          type="button"
          className="lt-setlist-map-action"
          aria-label={t("setlistView.lanes.zoomIn")}
          title={t("setlistView.lanes.zoomIn")}
          disabled={zoom >= OVERVIEW_MAX_ZOOM}
          onClick={() => setZoom(zoom * 2)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">zoom_in</span>
        </button>
        {zoom > 1 ? (
          <button
            type="button"
            className="lt-setlist-map-action"
            aria-label={t("setlistView.overview.fit")}
            title={t("setlistView.overview.fit")}
            onClick={() => setZoom(1)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">fit_screen</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
