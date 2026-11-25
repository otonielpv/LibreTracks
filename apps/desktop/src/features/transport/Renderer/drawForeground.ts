import { accentRgba, themedRgba } from "../../../shared/theme";
import type {
  PendingAutomationCueSummary,
  PendingJumpSummary,
  SectionMarkerSummary,
  TempoMarkerSummary,
  TimeSignatureMarkerSummary,
} from "../desktopApi";
import { secondsToScreenX } from "../timeline/timelineMath";

import { drawRulerMarker, drawRulerTempoMarker, drawRulerTempoRamp } from "./drawBackground";

export type RulerForegroundLayerArgs = {
  width: number;
  height: number;
  cameraX: number;
  pixelsPerSecond: number;
  playheadSeconds: number;
  markers: SectionMarkerSummary[];
  tempoMarkers: TempoMarkerSummary[];
  timeSignatureMarkers: TimeSignatureMarkerSummary[];
  pendingMarkerJump: PendingJumpSummary | null;
  pendingAutomationCue: PendingAutomationCueSummary | null;
  /** Seleccion (multiple) de marcas, de cualquier tipo. */
  selectedMarkerIds: readonly string[];
  currentMarkerId: string | null;
  pulseAlpha: number;
};

/**
 * Automation jumps are armed in the native engine as soon as playback starts
 * so they remain sample-exact. That internal armed state can live for several
 * minutes, though, and must not make the ruler look as if a jump is imminent
 * for all of that time (especially on a phone, where the whole song often fits
 * on screen). Keep the visual warning local to the final approach.
 */
export const AUTOMATION_JUMP_FEEDBACK_LEAD_SECONDS = 10;

export function shouldShowAutomationJumpFeedback(
  playheadSeconds: number,
  executeAtSeconds: number,
) {
  return (
    Number.isFinite(playheadSeconds) &&
    Number.isFinite(executeAtSeconds) &&
    executeAtSeconds <=
      playheadSeconds + AUTOMATION_JUMP_FEEDBACK_LEAD_SECONDS
  );
}

function drawPendingDashedLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  positionSeconds: number,
  strokeStyle: string,
  fillStyle: string,
) {
  const x = secondsToScreenX(positionSeconds, cameraX, pixelsPerSecond);
  if (x < -12 || x > width + 12) {
    return;
  }

  const snappedX = Math.round(x) + 0.5;
  context.save();
  context.strokeStyle = strokeStyle;
  context.fillStyle = fillStyle;
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(snappedX, 0);
  context.lineTo(snappedX, height);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(snappedX - 5, 0);
  context.lineTo(snappedX + 5, 0);
  context.lineTo(snappedX, 8);
  context.closePath();
  context.fill();
  context.restore();
}

export function drawPendingExecutionLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  executeAtSeconds: number,
) {
  drawPendingDashedLine(
    context,
    width,
    height,
    cameraX,
    pixelsPerSecond,
    executeAtSeconds,
    themedRgba(255, 226, 171, 0.88),
    themedRgba(255, 226, 171, 0.92),
  );
}

export function drawPendingTargetLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  targetSeconds: number,
) {
  drawPendingDashedLine(
    context,
    width,
    height,
    cameraX,
    pixelsPerSecond,
    targetSeconds,
    accentRgba(0.88),
    accentRgba(0.92),
  );
}

export function drawRulerForegroundLayer(
  context: CanvasRenderingContext2D,
  args: RulerForegroundLayerArgs,
) {
  if (args.pendingMarkerJump) {
    if (typeof args.pendingMarkerJump.targetSeconds === "number") {
      drawPendingTargetLine(
        context,
        args.width,
        args.height,
        args.cameraX,
        args.pixelsPerSecond,
        args.pendingMarkerJump.targetSeconds,
      );
    }
    drawPendingExecutionLine(
      context,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      args.pendingMarkerJump.executeAtSeconds,
    );
  }

  if (
    args.pendingAutomationCue &&
    shouldShowAutomationJumpFeedback(
      args.playheadSeconds,
      args.pendingAutomationCue.executeAtSeconds,
    )
  ) {
    drawPendingTargetLine(
      context,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      args.pendingAutomationCue.targetSeconds,
    );
    drawPendingExecutionLine(
      context,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      args.pendingAutomationCue.executeAtSeconds,
    );
  }

  for (const marker of args.markers) {
    drawRulerMarker(
      context,
      marker,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      {
        isSelected: args.selectedMarkerIds.includes(marker.id),
        isArmed: args.pendingMarkerJump?.targetMarkerId === marker.id,
        isCurrent: args.currentMarkerId === marker.id,
        pulseAlpha: args.pulseAlpha,
      },
    );
  }

  const sortedTempo = [...args.tempoMarkers].sort((a, b) => a.startSeconds - b.startSeconds);
  sortedTempo.forEach((marker, index) => {
    const next = sortedTempo[index + 1];
    if (marker.ramp && next && next.bpm !== marker.bpm) {
      drawRulerTempoRamp(context, marker, next, args.width, args.cameraX, args.pixelsPerSecond);
    }
  });
  for (const marker of args.tempoMarkers) {
    drawRulerTempoMarker(
      context,
      marker,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      undefined,
      args.selectedMarkerIds.includes(marker.id),
    );
  }

  for (const marker of args.timeSignatureMarkers) {
    drawRulerTempoMarker(
      context,
      {
        id: marker.id,
        startSeconds: marker.startSeconds,
        bpm: Number.NaN,
      },
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      marker.signature,
      args.selectedMarkerIds.includes(marker.id),
    );
  }

}
