import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  getEffectiveBpmAt,
  type SongRegionSummary,
  type SongView,
  type TempoMarkerSummary,
  type TimeSignatureMarkerSummary,
} from "@libretracks/shared/models";

import type { TimelineMenus } from "../../menus/timelineMenus";
import type { SongTimeScale } from "../songTimeScale";

export const TEMPO_LANE_HEIGHT = 48;
const CURVE_TOP = 16;
const CURVE_BOTTOM = TEMPO_LANE_HEIGHT - 6;

type SongBounds = Pick<SongRegionSummary, "startSeconds" | "endSeconds">;

export type TempoPoint = { seconds: number; bpm: number; marker: TempoMarkerSummary | null; ramp: boolean };

/**
 * The song's tempo as points in time: the tempo in force at its start, then
 * every tempo marker inside it. A `ramp` point glides to the next one (the
 * same `TempoMarker.ramp` the engine reads); the last point holds to the end.
 */
export function songTempoPoints(song: SongView, region: SongBounds): TempoPoint[] {
  const inside = (song.tempoMarkers ?? [])
    .filter((marker) => marker.startSeconds >= region.startSeconds && marker.startSeconds < region.endSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const points: TempoPoint[] = [];
  const atStart = inside[0] && Math.abs(inside[0].startSeconds - region.startSeconds) < 1e-3 ? inside[0] : null;
  if (!atStart) {
    // The tempo coming in from before the song (or the session's base).
    const before = (song.tempoMarkers ?? [])
      .filter((marker) => marker.startSeconds < region.startSeconds)
      .sort((left, right) => right.startSeconds - left.startSeconds)[0];
    points.push({
      seconds: region.startSeconds,
      bpm: getEffectiveBpmAt(song, region.startSeconds),
      marker: null,
      ramp: Boolean(before?.ramp),
    });
  }
  for (const marker of inside) {
    points.push({ seconds: marker.startSeconds, bpm: marker.bpm, marker, ramp: Boolean(marker.ramp) });
  }
  return points;
}

/** The song's meter changes (the one in force at its start is the region's
 * own and is shown by the song settings, not here). */
export function songMeterChanges(song: SongView, region: SongBounds): TimeSignatureMarkerSummary[] {
  return (song.timeSignatureMarkers ?? [])
    .filter((marker) => marker.startSeconds > region.startSeconds + 1e-3 && marker.startSeconds < region.endSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

type TempoLaneProps = {
  song: SongView;
  region: SongRegionSummary;
  scale: SongTimeScale;
  menus: Pick<TimelineMenus, "openMenu" | "tempoMarkerContextMenu" | "timeSignatureMarkerContextMenu" | "rulerContextMenu">;
};

/**
 * Edit → Lanes, top row: the song's tempo curve (flat segments, ramps as
 * slopes) with a BPM label per tempo marker and the meter changes. Every
 * action is the DAW's: a marker's label opens its menu (BPM, ramp, delete /
 * change, delete), a right click on the lane opens the DAW ruler menu at
 * that point (create a tempo or meter marker there). Markers are not
 * dragged: the DAW does not drag them either.
 */
function TempoLaneComponent({ song, region, scale, menus }: TempoLaneProps) {
  const { t } = useTranslation();
  const points = songTempoPoints(song, region);
  const meters = songMeterChanges(song, region);
  const bpms = points.map((point) => point.bpm);
  const low = Math.min(...bpms);
  const high = Math.max(...bpms);
  const yOf = (bpm: number) =>
    high - low < 0.01
      ? (CURVE_TOP + CURVE_BOTTOM) / 2
      : CURVE_BOTTOM - ((bpm - low) / (high - low)) * (CURVE_BOTTOM - CURVE_TOP);

  // One polyline: flat to the next point, or a slope when the point ramps.
  const path: string[] = [];
  points.forEach((point, index) => {
    const next = points[index + 1];
    const x0 = scale.secondsToPx(point.seconds);
    const x1 = scale.secondsToPx(next ? next.seconds : region.endSeconds);
    const y0 = yOf(point.bpm);
    const y1 = next && point.ramp ? yOf(next.bpm) : y0;
    path.push(`${index === 0 ? "M" : "L"}${x0.toFixed(1)},${y0.toFixed(1)}`, `L${x1.toFixed(1)},${y1.toFixed(1)}`);
  });

  const secondsAt = (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const zoomFactor = rect.width > 0 ? event.currentTarget.offsetWidth / rect.width : 1;
    return scale.clampSeconds(scale.pxToSeconds((event.clientX - rect.left) * (zoomFactor || 1)));
  };

  return (
    <div className="lt-setlist-lane-row is-tempo" style={{ height: `${TEMPO_LANE_HEIGHT}px` } as CSSProperties} data-lane-kind="tempo">
      <div className="lt-setlist-lane-header">
        <span className="material-symbols-outlined lt-setlist-lane-kind-icon" aria-hidden="true">speed</span>
        <strong className="lt-setlist-lane-name">{t("setlistView.tempo.lane")}</strong>
      </div>
      <div
        className="lt-setlist-lane-cell lt-setlist-tempo-cell"
        aria-label={t("setlistView.tempo.lane")}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget && !(event.target instanceof SVGElement)) return;
          event.preventDefault();
          menus.openMenu(event, t("transport.menu.createMarker"), menus.rulerContextMenu(secondsAt(event), null));
        }}
      >
        <svg className="lt-setlist-tempo-curve" width={scale.widthPx} height={TEMPO_LANE_HEIGHT} aria-hidden="true">
          <path d={path.join(" ")} />
        </svg>
        {points.map((point) => {
          const x = scale.secondsToPx(point.seconds);
          if (x < -60 || x > scale.widthPx + 10) return null;
          const label = `${Math.round(point.bpm * 100) / 100} BPM${point.ramp ? " ↗" : ""}`;
          return point.marker ? (
            <button
              key={point.marker.id}
              type="button"
              className={`lt-setlist-tempo-marker${point.ramp ? " is-ramp" : ""}`}
              data-tempo-marker-id={point.marker.id}
              style={{ left: `${x}px` }}
              aria-label={t("setlistView.tempo.markerAria", { label })}
              title={t("setlistView.tempo.markerAria", { label })}
              onClick={(event) => {
                const marker = point.marker as TempoMarkerSummary;
                menus.openMenu(event, label, menus.tempoMarkerContextMenu(marker));
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const marker = point.marker as TempoMarkerSummary;
                menus.openMenu(event, label, menus.tempoMarkerContextMenu(marker));
              }}
            >
              {label}
            </button>
          ) : (
            <span key="base" className="lt-setlist-tempo-marker is-base" style={{ left: `${x}px` }}>
              {label}
            </span>
          );
        })}
        {meters.map((marker) => {
          const x = scale.secondsToPx(marker.startSeconds);
          if (x < -40 || x > scale.widthPx + 10) return null;
          return (
            <button
              key={marker.id}
              type="button"
              className="lt-setlist-meter-marker"
              data-meter-marker-id={marker.id}
              style={{ left: `${x}px` }}
              aria-label={t("setlistView.tempo.meterAria", { signature: marker.signature })}
              title={t("setlistView.tempo.meterAria", { signature: marker.signature })}
              onClick={(event) => menus.openMenu(event, marker.signature, menus.timeSignatureMarkerContextMenu(marker))}
              onContextMenu={(event) => {
                event.preventDefault();
                menus.openMenu(event, marker.signature, menus.timeSignatureMarkerContextMenu(marker));
              }}
            >
              {marker.signature}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const TempoLane = memo(TempoLaneComponent);
