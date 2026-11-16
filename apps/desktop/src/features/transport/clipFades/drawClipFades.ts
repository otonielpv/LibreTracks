import type { ClipSummary } from "@libretracks/shared/models";

import {
  clipFadesOf,
  clipViewScale,
  curveHandlePoint,
  fadeCurveGain,
  isLinearCurve,
  type ClipFades,
  type FadeCurve,
} from "./clipFadeMath";
import { resolveClipFades } from "./clipFadeCanvasState";

/** Side of the square fade length handles, in CSS px. Small on purpose: they
 * are a hint on the corner, the hit zone around them is what you grab. */
export const CLIP_FADE_HANDLE_SIZE = 5;
/** On a touch screen the selected clip's handles grow to a finger's target:
 * those are the only ones a finger can drag (select first, then edit). */
export const CLIP_FADE_TOUCH_HANDLE_SIZE = 10;
/** Radius of the curve handle drawn on a fade's midpoint. */
export const CLIP_FADE_CURVE_HANDLE_RADIUS = 2.5;
export const CLIP_FADE_TOUCH_CURVE_HANDLE_RADIUS = 5;
/** A fade narrower than this on screen shows no curve handle: no room. */
export const CLIP_FADE_CURVE_HANDLE_MIN_WIDTH = 14;
/** Narrower clips get no handles: there is no room to grab them apart. */
export const CLIP_FADE_HANDLE_MIN_CLIP_WIDTH = 36;

let touchScreen: boolean | null = null;
/** Any coarse pointer (phone, tablet, touch laptop). Read once: it does not
 * change while the app runs, and this is called per clip per frame. */
export function isTouchScreen(): boolean {
  if (touchScreen === null) {
    try {
      touchScreen =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(any-pointer: coarse)").matches;
    } catch {
      touchScreen = false;
    }
  }
  return touchScreen;
}

export type ClipFadeGeometry = {
  fades: ClipFades;
  /** Screen x of the clip's edges (unclipped). */
  left: number;
  right: number;
  /** Screen x where the fade in ends / the fade out starts. */
  fadeInX: number;
  fadeOutX: number;
  hasFadeIn: boolean;
  hasFadeOut: boolean;
};

/** Where a clip's fades sit on screen. Shared by the painter and the
 * pointer hit-test so a handle is grabbed exactly where it is drawn. */
export function clipFadeGeometry(
  clip: ClipSummary,
  left: number,
  width: number,
  pixelsPerSecond: number,
): ClipFadeGeometry {
  const fades = resolveClipFades(clip.id, clipFadesOf(clip));
  const scale = clipViewScale(clip) * pixelsPerSecond;
  const right = left + width;
  const fadeInWidth = Math.min(width, fades.fadeInSeconds * scale);
  const fadeOutWidth = Math.min(width - fadeInWidth, fades.fadeOutSeconds * scale);
  return {
    fades,
    left,
    right,
    fadeInX: left + fadeInWidth,
    fadeOutX: right - fadeOutWidth,
    hasFadeIn: fadeInWidth > 0.5,
    hasFadeOut: fadeOutWidth > 0.5,
  };
}

/** x of each length handle: on the fade's end, kept inside the clip when it
 * has no fade so it sits on the corner instead of half outside. */
export function clipFadeHandleXs(geometry: ClipFadeGeometry, size = CLIP_FADE_HANDLE_SIZE) {
  const half = size / 2;
  return {
    inX: Math.max(geometry.left + half, geometry.fadeInX),
    outX: Math.min(geometry.right - half, geometry.fadeOutX),
  };
}

/**
 * The curve handle of each fade: on the curve, half way along it, so dragging
 * it in any direction visibly pulls the line it sits on (Live's handle).
 * `null` when that fade is missing or too narrow to hold one.
 */
export function clipFadeCurveHandles(
  geometry: ClipFadeGeometry,
  top: number,
  height: number,
): { in: { x: number; y: number } | null; out: { x: number; y: number } | null } {
  const bottom = top + height;
  // `width` is negative for the fade out: its x runs from the clip's end.
  const onScreen = (point: FadeCurve, edgeX: number, width: number) => ({
    x: edgeX + point.x * width,
    y: bottom - point.y * height,
  });
  const inWidth = geometry.fadeInX - geometry.left;
  const outWidth = geometry.right - geometry.fadeOutX;
  return {
    in:
      geometry.hasFadeIn && inWidth >= CLIP_FADE_CURVE_HANDLE_MIN_WIDTH
        ? onScreen(curveHandlePoint(geometry.fades.fadeInCurve), geometry.left, inWidth)
        : null,
    out:
      geometry.hasFadeOut && outWidth >= CLIP_FADE_CURVE_HANDLE_MIN_WIDTH
        ? onScreen(curveHandlePoint(geometry.fades.fadeOutCurve), geometry.right, -outWidth)
        : null,
  };
}

/** Points along a fade's gain line, from its silent edge to full level. */
function traceFade(
  context: CanvasRenderingContext2D,
  edgeX: number,
  innerX: number,
  top: number,
  height: number,
  curve: FadeCurve,
) {
  const bottom = top + height;
  const steps = isLinearCurve(curve)
    ? 1
    : Math.max(8, Math.min(64, Math.round(Math.abs(innerX - edgeX) / 3)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = edgeX + (innerX - edgeX) * t;
    const y = bottom - fadeCurveGain(t, curve) * height;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
}

/**
 * Paint a clip's fades over its waveform: the part above the gain line is
 * shaded and the line traces the curve the engine applies. Handles stay out
 * of the way: an unselected clip only marks the end of a fade it has, and the
 * selected clip shows its length handles on the top corners plus a dot on
 * each fade to bend its curve.
 */
export function drawClipFades(
  context: CanvasRenderingContext2D,
  clip: ClipSummary,
  rect: { left: number; width: number; top: number; height: number },
  pixelsPerSecond: number,
  isSelected: boolean,
) {
  const { left, width, top, height } = rect;
  const geometry = clipFadeGeometry(clip, left, width, pixelsPerSecond);
  const showHandles =
    isSelected && width >= CLIP_FADE_HANDLE_MIN_CLIP_WIDTH && height >= 14;
  if (!geometry.hasFadeIn && !geometry.hasFadeOut && !showHandles) return;
  const { fades } = geometry;

  context.save();
  context.beginPath();
  context.rect(left, top, width, height);
  context.clip();

  const fade = (edgeX: number, innerX: number, curve: FadeCurve) => {
    // Shade above the line: trace the curve, then close along the top edge.
    context.fillStyle = "rgba(0, 0, 0, 0.3)";
    context.beginPath();
    traceFade(context, edgeX, innerX, top, height, curve);
    context.lineTo(edgeX, top);
    context.closePath();
    context.fill();
    context.strokeStyle = isSelected ? "rgba(255, 255, 255, 0.8)" : "rgba(255, 255, 255, 0.55)";
    context.lineWidth = 1;
    context.beginPath();
    traceFade(context, edgeX, innerX, top, height, curve);
    context.stroke();
  };
  if (geometry.hasFadeIn) fade(geometry.left, geometry.fadeInX, fades.fadeInCurve);
  if (geometry.hasFadeOut) fade(geometry.right, geometry.fadeOutX, fades.fadeOutCurve);

  const touch = isSelected && isTouchScreen();
  const size = touch ? CLIP_FADE_TOUCH_HANDLE_SIZE : CLIP_FADE_HANDLE_SIZE;
  const { inX, outX } = clipFadeHandleXs(geometry, size);
  const square = (x: number, alpha: number) => {
    context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    context.fillRect(Math.round(x - size / 2), top, size, size);
  };
  if (showHandles) {
    square(inX, geometry.hasFadeIn ? 0.85 : 0.5);
    square(outX, geometry.hasFadeOut ? 0.85 : 0.5);
    const radius = touch ? CLIP_FADE_TOUCH_CURVE_HANDLE_RADIUS : CLIP_FADE_CURVE_HANDLE_RADIUS;
    const curves = clipFadeCurveHandles(geometry, top, height);
    for (const point of [curves.in, curves.out]) {
      if (!point) continue;
      context.fillStyle = "rgba(255, 255, 255, 0.9)";
      context.strokeStyle = "rgba(12, 12, 12, 0.5)";
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  } else {
    // Unselected: just a faint tick where each fade ends.
    if (geometry.hasFadeIn) square(inX, 0.35);
    if (geometry.hasFadeOut) square(outX, 0.35);
  }
  context.restore();
}
