import type {
  ActiveVampSummary,
  SectionMarkerSummary,
  SongRegionSummary,
  TempoMarkerSummary,
} from "../desktopApi";
import type { TimelineGrid } from "../timelineMath";
import { screenXToSeconds, secondsToScreenX } from "../timelineMath";

const MIN_LABEL_WIDTH_PX = 70;

export const LANE_REGIONS = {
  top: 0,
  height: 22,
} as const;

export const LANE_SECTIONS = {
  top: 48,
  height: 26,
} as const;

export const LANE_TEMPO_METRIC = {
  top: 72,
  height: 34,
} as const;

const GRID_LABEL_TOP = 24;
const GRID_LABEL_SECOND_LINE_TOP = 36;
const TEMPO_LABEL_TOP = 2;
const METRIC_LABEL_TOP = 20;
const TIME_SIGNATURE_VERTICAL_OFFSET = 8;

function formatRulerMusicalPosition(barNumber: number, beatInBar: number) {
  return `${barNumber}.${beatInBar}.00`;
}

function formatRulerTimecode(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function getPrimaryRulerMarkers(grid: TimelineGrid) {
  if (grid.showBeatLabels) {
    return grid.markers;
  }

  return grid.markers.filter(
    (marker) => marker.isBarStart && (marker.barNumber - 1) % grid.barLabelStep === 0,
  );
}

function getPrimaryMarkerOrdinal(
  marker: TimelineGrid["markers"][number],
  grid: TimelineGrid,
) {
  if (grid.showBeatLabels) {
    return (marker.barNumber - 1) * grid.beatsPerBar + (marker.beatInBar - 1);
  }

  return Math.floor((marker.barNumber - 1) / grid.barLabelStep);
}

function getLabelSkipDivisor(primaryMarkers: TimelineGrid["markers"], pixelsPerSecond: number) {
  let minimumPrimaryIntervalPx = Number.POSITIVE_INFINITY;

  for (let index = 1; index < primaryMarkers.length; index += 1) {
    const intervalPx = (primaryMarkers[index].seconds - primaryMarkers[index - 1].seconds) * pixelsPerSecond;
    if (intervalPx > 0) {
      minimumPrimaryIntervalPx = Math.min(minimumPrimaryIntervalPx, intervalPx);
    }
  }

  let labelSkipDivisor = 1;
  while (
    Number.isFinite(minimumPrimaryIntervalPx) &&
    minimumPrimaryIntervalPx * labelSkipDivisor < MIN_LABEL_WIDTH_PX
  ) {
    labelSkipDivisor *= 2;
  }

  return labelSkipDivisor;
}

export type RulerMarkerDrawOptions = {
  isSelected: boolean;
  isArmed: boolean;
  isCurrent: boolean;
  pulseAlpha: number;
};

export type RulerBackgroundLayerArgs = {
  width: number;
  height: number;
  cameraX: number;
  pixelsPerSecond: number;
  timelineGrid: TimelineGrid;
  regions: SongRegionSummary[];
  selectedRegionId: string | null;
  activeVamp: ActiveVampSummary | null;
};

function drawActiveVampRange(
  context: CanvasRenderingContext2D,
  activeVamp: ActiveVampSummary,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const left = secondsToScreenX(activeVamp.startSeconds, cameraX, pixelsPerSecond);
  const right = secondsToScreenX(activeVamp.endSeconds, cameraX, pixelsPerSecond);
  const highlightLeft = Math.max(0, left);
  const highlightRight = Math.min(width, right);
  const highlightWidth = highlightRight - highlightLeft;

  if (highlightWidth <= 0) {
    return;
  }

  context.save();
  context.fillStyle = "rgba(255, 176, 76, 0.18)";
  context.strokeStyle = "rgba(255, 176, 76, 0.78)";
  context.lineWidth = 1;
  context.fillRect(highlightLeft, 0, highlightWidth, height);
  context.beginPath();
  context.moveTo(highlightLeft + 0.5, 0);
  context.lineTo(highlightLeft + 0.5, height);
  context.moveTo(highlightRight - 0.5, 0);
  context.lineTo(highlightRight - 0.5, height);
  context.stroke();
  context.restore();
}

export function drawGridLines(
  context: CanvasRenderingContext2D,
  grid: TimelineGrid,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  if (grid.bars.length === 0 && grid.beats.length === 0) {
    return;
  }

  const visibleStartSeconds = Math.max(0, screenXToSeconds(0, cameraX, pixelsPerSecond));
  const visibleEndSeconds = screenXToSeconds(width, cameraX, pixelsPerSecond);
  const beatPath = grid.showBeatGridLines ? new Path2D() : null;
  const barPath = new Path2D();

  for (const seconds of grid.beats) {
    const x = Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (seconds < visibleStartSeconds || seconds > visibleEndSeconds || x < 0 || x > width) {
      continue;
    }

    if (beatPath) {
      beatPath.moveTo(x, 0);
      beatPath.lineTo(x, height);
    }
  }

  for (const seconds of grid.bars) {
    const x = Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (seconds < visibleStartSeconds || seconds > visibleEndSeconds || x < 0 || x > width) {
      continue;
    }

    barPath.moveTo(x, 0);
    barPath.lineTo(x, height);
  }

  if (beatPath) {
    context.strokeStyle = "rgba(186, 202, 197, 0.14)";
    context.lineWidth = 1;
    context.stroke(beatPath);
  }

  context.strokeStyle = "rgba(186, 202, 197, 0.32)";
  context.lineWidth = 1;
  context.stroke(barPath);
}

export function drawRulerGridLabels(
  context: CanvasRenderingContext2D,
  grid: TimelineGrid,
  width: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const visibleStartSeconds = screenXToSeconds(0, cameraX, pixelsPerSecond);
  const visibleEndSeconds = screenXToSeconds(width, cameraX, pixelsPerSecond);
  const primaryMarkers = getPrimaryRulerMarkers(grid);
  const labelSkipDivisor = getLabelSkipDivisor(primaryMarkers, pixelsPerSecond);

  context.textAlign = "left";
  context.textBaseline = "top";

  for (const marker of primaryMarkers) {
    if (getPrimaryMarkerOrdinal(marker, grid) % labelSkipDivisor !== 0) {
      continue;
    }

    const markerX = secondsToScreenX(marker.seconds, cameraX, pixelsPerSecond);
    if (marker.seconds < visibleStartSeconds - 2 || marker.seconds > visibleEndSeconds + 2) {
      continue;
    }

    const x = Math.round(markerX) + 4;
    const y = GRID_LABEL_TOP;

    context.fillStyle = marker.isBarStart ? "#e5e2e1" : "#bacac5";
    context.font = '600 9px "Space Grotesk", sans-serif';
    context.fillText(formatRulerMusicalPosition(marker.barNumber, marker.beatInBar), x, y);

    context.fillStyle = marker.isBarStart ? "#57f1db" : "rgba(186, 202, 197, 0.68)";
    context.font = '400 9px "Space Grotesk", sans-serif';
    context.fillText(formatRulerTimecode(marker.seconds), x, GRID_LABEL_SECOND_LINE_TOP);
  }
}

export function drawRulerRegion(
  context: CanvasRenderingContext2D,
  region: SongRegionSummary,
  width: number,
  cameraX: number,
  pixelsPerSecond: number,
  isSelected: boolean,
) {
  const left = secondsToScreenX(region.startSeconds, cameraX, pixelsPerSecond);
  const regionWidth = (region.endSeconds - region.startSeconds) * pixelsPerSecond;
  const right = left + regionWidth;
  if (right < -8 || left > width + 8 || regionWidth <= 0) {
    return;
  }

  const blockLeft = Math.max(-8, left);
  const blockWidth = Math.max(12, Math.min(width + 8, right) - blockLeft);
  const blockTop = LANE_REGIONS.top + 3;
  const blockHeight = LANE_REGIONS.height - 6;

  context.save();
  context.fillStyle = isSelected ? "rgba(255, 226, 171, 0.28)" : "rgba(255, 226, 171, 0.14)";
  context.strokeStyle = isSelected ? "rgba(255, 226, 171, 0.72)" : "rgba(255, 226, 171, 0.32)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(blockLeft, blockTop, blockWidth, blockHeight, 6);
  context.fill();
  context.stroke();

  context.beginPath();
  context.rect(blockLeft + 6, blockTop, Math.max(0, blockWidth - 12), blockHeight);
  context.clip();
  context.fillStyle = isSelected ? "#fff4d6" : "rgba(255, 244, 214, 0.92)";
  context.font = '700 10px "Space Grotesk", sans-serif';
  context.textBaseline = "middle";
  context.fillText(region.name, blockLeft + 7, blockTop + blockHeight / 2 + 0.5);
  context.restore();
}

export function drawRulerMarker(
  context: CanvasRenderingContext2D,
  marker: SectionMarkerSummary,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  options: RulerMarkerDrawOptions,
) {
  const x = secondsToScreenX(marker.startSeconds, cameraX, pixelsPerSecond);
  const label = marker.digit == null ? marker.name : `${marker.digit}. ${marker.name}`;

  context.font = '600 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(30, Math.ceil(context.measureText(label).width) + 12);
  const labelHeight = 16;
  const snappedX = Math.round(x) + 0.5;
  const stemTop = LANE_SECTIONS.top + 2;
  const stemBottom = LANE_SECTIONS.top + LANE_SECTIONS.height - 2;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 8 : snappedX + 2;
  const flagRight = flagLeft + labelWidth;
  const flagTop = LANE_SECTIONS.top + 1;
  const flagBottom = flagTop + labelHeight;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  const strokeStyle = options.isArmed
    ? `rgba(87, 241, 219, ${options.pulseAlpha})`
    : options.isSelected
      ? "rgba(255, 226, 171, 0.9)"
      : options.isCurrent
        ? "rgba(229, 226, 225, 0.88)"
        : "rgba(186, 202, 197, 0.48)";
  const fillStyle = options.isArmed
    ? `rgba(87, 241, 219, ${0.22 + options.pulseAlpha * 0.22})`
    : options.isSelected
      ? "rgba(255, 226, 171, 0.18)"
      : options.isCurrent
        ? "rgba(229, 226, 225, 0.16)"
        : "rgba(186, 202, 197, 0.12)";
  const textStyle = options.isArmed
    ? "#57f1db"
    : options.isSelected
      ? "#ffe2ab"
      : options.isCurrent
        ? "#e5e2e1"
        : "#bacac5";

  context.save();
  context.strokeStyle = strokeStyle;
  context.fillStyle = fillStyle;
  context.lineWidth = options.isArmed ? 1.8 : 1.2;
  if (options.isArmed) {
    context.shadowColor = "rgba(87, 241, 219, 0.55)";
    context.shadowBlur = 10;
  }

  context.beginPath();
  context.moveTo(snappedX, stemTop + 1);
  context.lineTo(snappedX, stemBottom);
  context.stroke();

  context.beginPath();
  if (alignRight) {
    context.moveTo(snappedX, flagTop + 1);
    context.lineTo(flagRight, flagTop + 1);
    context.lineTo(flagRight, flagBottom - 1);
    context.lineTo(flagLeft + 7, flagBottom - 1);
    context.lineTo(snappedX, flagTop + labelHeight * 0.55);
  } else {
    context.moveTo(snappedX, flagTop + 1);
    context.lineTo(flagRight - 7, flagTop + 1);
    context.lineTo(flagRight, flagTop + labelHeight * 0.5);
    context.lineTo(flagRight - 7, flagBottom - 1);
    context.lineTo(snappedX, flagBottom - 1);
  }
  context.closePath();
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  context.fillStyle = textStyle;
  context.textBaseline = "middle";
  context.fillText(label, flagLeft + 6, flagTop + labelHeight / 2 + 0.5);

  context.fillStyle = textStyle;
  context.beginPath();
  context.moveTo(snappedX - 4, stemBottom);
  context.lineTo(snappedX + 4, stemBottom);
  context.lineTo(snappedX, stemBottom + 6);
  context.closePath();
  context.fill();
  context.restore();
}

export function drawRulerTempoMarker(
  context: CanvasRenderingContext2D,
  marker: TempoMarkerSummary,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  overrideLabel?: string,
) {
  const x = secondsToScreenX(marker.startSeconds, cameraX, pixelsPerSecond);
  const label = overrideLabel ?? `${marker.bpm.toFixed(marker.bpm % 1 === 0 ? 0 : 1)}`;

  context.font = '700 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(30, Math.ceil(context.measureText(label).width) + 14);
  const snappedX = Math.round(x) + 0.5;
  const isMetricMarker = overrideLabel != null;
  const verticalOffset = isMetricMarker ? TIME_SIGNATURE_VERTICAL_OFFSET : 0;
  const flagTop =
    LANE_TEMPO_METRIC.top + (isMetricMarker ? METRIC_LABEL_TOP : TEMPO_LABEL_TOP) + verticalOffset;
  const flagHeight = isMetricMarker ? 12 : 13;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 7 : snappedX + 3;
  const flagRight = flagLeft + labelWidth;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  context.save();
  context.strokeStyle = overrideLabel ? "rgba(255, 184, 107, 0.78)" : "rgba(87, 241, 219, 0.78)";
  context.fillStyle = overrideLabel ? "rgba(255, 184, 107, 0.16)" : "rgba(87, 241, 219, 0.16)";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(snappedX, flagTop + 2);
  context.lineTo(
    snappedX,
    isMetricMarker
      ? LANE_TEMPO_METRIC.top + LANE_TEMPO_METRIC.height - 2 + verticalOffset
      : LANE_TEMPO_METRIC.top + TEMPO_LABEL_TOP + flagHeight - 1,
  );
  context.stroke();

  context.beginPath();
  context.moveTo(snappedX, flagTop);
  context.lineTo(flagRight - 6, flagTop);
  context.lineTo(flagRight, flagTop + flagHeight / 2);
  context.lineTo(flagRight - 6, flagTop + flagHeight);
  context.lineTo(snappedX, flagTop + flagHeight);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = overrideLabel ? "#ffb86b" : "#57f1db";
  context.textBaseline = "middle";
  context.fillText(label, flagLeft + 6, flagTop + flagHeight / 2 + 0.5);

  context.beginPath();
  const stemBottom = isMetricMarker
    ? LANE_TEMPO_METRIC.top + LANE_TEMPO_METRIC.height - 2 + verticalOffset
    : LANE_TEMPO_METRIC.top + TEMPO_LABEL_TOP + flagHeight - 1;
  context.moveTo(snappedX - 4, stemBottom);
  context.lineTo(snappedX + 4, stemBottom);
  context.lineTo(snappedX, stemBottom + 7);
  context.closePath();
  context.fill();
  context.restore();
}

export function drawRulerBackgroundLayer(
  context: CanvasRenderingContext2D,
  args: RulerBackgroundLayerArgs,
) {
  context.fillStyle = "#2a2a2a";
  context.fillRect(0, 0, args.width, args.height);

  if (args.activeVamp) {
    drawActiveVampRange(
      context,
      args.activeVamp,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
    );
  }

  for (const region of args.regions) {
    drawRulerRegion(
      context,
      region,
      args.width,
      args.cameraX,
      args.pixelsPerSecond,
      args.selectedRegionId === region.id,
    );
  }

  drawGridLines(
    context,
    args.timelineGrid,
    args.width,
    args.height,
    args.cameraX,
    args.pixelsPerSecond,
  );

  drawRulerGridLabels(
    context,
    args.timelineGrid,
    args.width,
    args.cameraX,
    args.pixelsPerSecond,
  );
}
