import type { SectionMarkerSummary, SongRegionSummary, TempoMarkerSummary } from "../desktopApi";
import type { TimelineGrid } from "../timelineMath";
import { screenXToSeconds, secondsToScreenX } from "../timelineMath";

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
};

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
  const blockTop = 3;
  const blockHeight = 18;

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
  const stemTop = 48;
  const stemBottom = height - 12;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 8 : snappedX + 2;
  const flagRight = flagLeft + labelWidth;
  const flagTop = 44;
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
) {
  const x = secondsToScreenX(marker.startSeconds, cameraX, pixelsPerSecond);
  const label = `${marker.bpm.toFixed(marker.bpm % 1 === 0 ? 0 : 1)}`;

  context.font = '700 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(30, Math.ceil(context.measureText(label).width) + 14);
  const snappedX = Math.round(x) + 0.5;
  const flagTop = 24;
  const flagHeight = 15;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 7 : snappedX + 3;
  const flagRight = flagLeft + labelWidth;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  context.save();
  context.strokeStyle = "rgba(87, 241, 219, 0.78)";
  context.fillStyle = "rgba(87, 241, 219, 0.16)";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(snappedX, flagTop + 2);
  context.lineTo(snappedX, height - 24);
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

  context.fillStyle = "#57f1db";
  context.textBaseline = "middle";
  context.fillText(label, flagLeft + 6, flagTop + flagHeight / 2 + 0.5);

  context.beginPath();
  context.moveTo(snappedX - 4, height - 24);
  context.lineTo(snappedX + 4, height - 24);
  context.lineTo(snappedX, height - 17);
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
}