import type {
  AutomationCueSummary,
  PendingAutomationCueSummary,
  PendingJumpSummary,
  SectionMarkerSummary,
  TempoMarkerSummary,
  TimeSignatureMarkerSummary,
} from "../desktopApi";
import { secondsToScreenX } from "../timelineMath";

import {
  drawRulerAutomationCue,
  drawRulerMarker,
  drawRulerTempoMarker,
} from "./drawBackground";

export type RulerForegroundLayerArgs = {
  width: number;
  height: number;
  cameraX: number;
  pixelsPerSecond: number;
  markers: SectionMarkerSummary[];
  tempoMarkers: TempoMarkerSummary[];
  timeSignatureMarkers: TimeSignatureMarkerSummary[];
  automationCues: AutomationCueSummary[];
  pendingMarkerJump: PendingJumpSummary | null;
  pendingAutomationCue: PendingAutomationCueSummary | null;
  selectedMarkerId: string | null;
  currentMarkerId: string | null;
  pulseAlpha: number;
};

export function drawPendingExecutionLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  executeAtSeconds: number,
) {
  const x = secondsToScreenX(executeAtSeconds, cameraX, pixelsPerSecond);
  if (x < -12 || x > width + 12) {
    return;
  }

  const snappedX = Math.round(x) + 0.5;
  context.save();
  context.strokeStyle = "rgba(255, 226, 171, 0.88)";
  context.fillStyle = "rgba(255, 226, 171, 0.92)";
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

export function drawRulerForegroundLayer(
  context: CanvasRenderingContext2D,
  args: RulerForegroundLayerArgs,
) {
  if (args.pendingMarkerJump) {
    drawPendingExecutionLine(
      context,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
      args.pendingMarkerJump.executeAtSeconds,
    );
  }

  if (args.pendingAutomationCue) {
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
        isSelected: args.selectedMarkerId === marker.id,
        isArmed: args.pendingMarkerJump?.targetMarkerId === marker.id,
        isCurrent: args.currentMarkerId === marker.id,
        pulseAlpha: args.pulseAlpha,
      },
    );
  }

  for (const marker of args.tempoMarkers) {
    drawRulerTempoMarker(
      context,
      marker,
      args.width,
      args.height,
      args.cameraX,
      args.pixelsPerSecond,
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
    );
  }

  for (const cue of args.automationCues) {
    drawRulerAutomationCue(
      context,
      cue,
      args.width,
      args.cameraX,
      args.pixelsPerSecond,
      {
        isPending: args.pendingAutomationCue?.cueId === cue.id,
        pulseAlpha: args.pulseAlpha,
      },
    );
  }
}
