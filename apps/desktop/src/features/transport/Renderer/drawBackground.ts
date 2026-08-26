import {
  formatBpm,
  isMobileApp,
  transposeKey,
  type ActiveVampSummary,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type TempoMarkerSummary,
} from "../desktopApi";
import type { TimelineGrid } from "../timeline/timelineMath";
import { markerCategory, markerColor } from "../markerKinds";
import {
  firstIndexAtOrAfter,
  screenXToSeconds,
  secondsToScreenX,
} from "../timeline/timelineMath";

/** Convert a `#rrggbb` colour to an `rgba(...)` string at the given alpha. Used
 * to derive the translucent flag fill from a marker kind's solid colour. */
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Blend a `#rrggbb` marker colour onto the ruler backdrop at `alpha` and
 * return an OPAQUE colour. Marker flags used to fill with a translucent tint,
 * which let the (full-height) grid lines show straight through the label — with
 * many markers on screen the text became hard to pick out. Pre-blending against
 * the known ruler background keeps the exact same tint while making the flag
 * body solid, so it masks the grid behind it. */
function blendOnRulerBackdrop(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = (channel: number, backdrop: number) =>
    Math.round(channel * alpha + backdrop * (1 - alpha));
  return `rgb(${mix(r, RULER_BACKDROP_RGB[0])}, ${mix(g, RULER_BACKDROP_RGB[1])}, ${mix(b, RULER_BACKDROP_RGB[2])})`;
}

/** The flat colour `drawRulerBackgroundLayer` paints the ruler with. Flags
 * pre-blend against it to stay opaque without changing their apparent tint. */
const RULER_BACKDROP_RGB = [42, 42, 42] as const;
const RULER_BACKDROP = `rgb(${RULER_BACKDROP_RGB[0]}, ${RULER_BACKDROP_RGB[1]}, ${RULER_BACKDROP_RGB[2]})`;

const MIN_LABEL_WIDTH_PX = 112;

// Ruler lane layout. The Android build compacts every lane (~2/3 height,
// same stacking order) because a phone in landscape has roughly half the
// vertical pixels of a desktop window and the 122px desktop ruler was
// eating a third of the timeline. Everything that draws or hit-tests the
// ruler derives from these four exports, so the two layouts stay
// consistent by construction. Keep RULER_HEIGHT (TimelineCanvasPane) and
// the .lt-android ruler CSS heights in sync with the mobile bottom edge.
type RulerLane = { readonly top: number; readonly height: number };

const MOBILE_RULER = isMobileApp;

export const LANE_REGIONS: RulerLane = MOBILE_RULER
  ? { top: 0, height: 18 }
  : { top: 0, height: 22 };

// Dynamic-cue markers (Build, All In, ...) get their own lane just above the
// section lane. On desktop it starts BELOW the two-line bar/timecode label
// block (which runs 22→42): the cue lane used to begin at 24 and overlap that
// text, squashing the flags against it. The desktop ruler grew by 12px to make
// room — keep RULER_HEIGHT (TimelineCanvasPane), the .lt-ruler CSS heights and
// the pane's grid-template-rows in sync with the bottom edge below.
export const LANE_CUES: RulerLane = MOBILE_RULER
  ? { top: 19, height: 18 }
  : { top: 44, height: 22 };

export const LANE_SECTIONS: RulerLane = MOBILE_RULER
  ? { top: 38, height: 22 }
  : { top: 68, height: 26 };

export const LANE_TEMPO_METRIC: RulerLane = MOBILE_RULER
  ? { top: 61, height: 26 }
  : { top: 94, height: 34 };

// Bar number (line 1) and timecode (line 2) stack in the strip above the cue
// lane. The desktop ruler is sized so this two-line block and the cue flags
// each get their own vertical room instead of overlapping — see LANE_CUES and
// RULER_HEIGHT in TimelineCanvasPane.
const GRID_LABEL_TOP = MOBILE_RULER ? 20 : 22;
const GRID_LABEL_SECOND_LINE_TOP = MOBILE_RULER ? 30 : 33;
const TEMPO_LABEL_TOP = 2;
const METRIC_LABEL_TOP = MOBILE_RULER ? 13 : 20;
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
    (marker) =>
      marker.isBarStart && (marker.barNumber - 1) % grid.barLabelStep === 0,
  );
}

/**
 * Marcas candidatas a etiqueta y el hueco mínimo entre ellas, cacheado por
 * IDENTIDAD de la rejilla.
 *
 * `getPrimaryRulerMarkers` asigna un array de hasta 2400 elementos y
 * `getLabelSkipDivisor` lo recorre entero; ambos corrían en CADA pintado del
 * ruler. Ninguno de los dos depende del zoom ni de la cámara, sólo de la
 * rejilla, que desde el paso 06 ya no cambia de identidad entre frames.
 *
 * El hueco se guarda en SEGUNDOS, no en píxeles, precisamente para que el zoom
 * no invalide la caché: con `pixelsPerSecond > 0`,
 * `min(dₖ · pps) = min(dₖ) · pps`, así que el divisor sale idéntico al que
 * calculaba el código anterior.
 */
let cachedLabelGrid: TimelineGrid | null = null;
let cachedLabelPlan: {
  markers: TimelineGrid["markers"];
  minIntervalSeconds: number;
} | null = null;

function getRulerLabelPlan(grid: TimelineGrid) {
  if (cachedLabelGrid === grid && cachedLabelPlan) {
    return cachedLabelPlan;
  }

  const markers = getPrimaryRulerMarkers(grid);
  let minIntervalSeconds = Number.POSITIVE_INFINITY;
  for (let index = 1; index < markers.length; index += 1) {
    const interval = markers[index].seconds - markers[index - 1].seconds;
    if (interval > 0 && interval < minIntervalSeconds) {
      minIntervalSeconds = interval;
    }
  }

  cachedLabelGrid = grid;
  cachedLabelPlan = { markers, minIntervalSeconds };
  return cachedLabelPlan;
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

/**
 * Cada cuántas marcas candidatas se pinta una etiqueta, dado el hueco mínimo
 * entre candidatas EN PÍXELES.
 *
 * Antes recibía la lista de marcas y calculaba el mínimo recorriéndola entera
 * en cada pintado. El mínimo en segundos lo cachea ahora `getRulerLabelPlan`;
 * como `pixelsPerSecond > 0`, `min(dₖ · pps) = min(dₖ) · pps` y el resultado es
 * el mismo número que antes.
 */
function resolveLabelSkipDivisor(minimumPrimaryIntervalPx: number) {
  let labelSkipDivisor = 1;
  while (
    Number.isFinite(minimumPrimaryIntervalPx) &&
    minimumPrimaryIntervalPx * labelSkipDivisor < MIN_LABEL_WIDTH_PX
  ) {
    labelSkipDivisor *= 2;
  }

  return labelSkipDivisor;
}

/**
 * Índice de la primera marca cuyo `seconds >= target`, por búsqueda binaria.
 * Gemela de `firstIndexAtOrAfter` para la lista de marcas (que son objetos, no
 * números). Las marcas salen ordenadas de `buildVisibleTimelineGrid`; hay un
 * test en `packages/shared` que lo vigila.
 */
function firstMarkerAtOrAfter(
  markers: TimelineGrid["markers"],
  target: number,
) {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (markers[mid].seconds < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
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
  const left = secondsToScreenX(
    activeVamp.startSeconds,
    cameraX,
    pixelsPerSecond,
  );
  const right = secondsToScreenX(
    activeVamp.endSeconds,
    cameraX,
    pixelsPerSecond,
  );
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

/** Multiplier applied to the grid-line opacity inside the ruler. The ruler
 * stacks four lanes of labels and flags into 122px, so at a dense zoom the
 * full-strength grid competes with the text; dimming it there (and only there)
 * keeps the beat/bar reference without fighting the marker names. The track
 * area keeps the grid at full strength. */
const RULER_GRID_OPACITY_SCALE = 0.45;

export function drawGridLines(
  context: CanvasRenderingContext2D,
  grid: TimelineGrid,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  opacityScale = 1,
) {
  if (grid.bars.length === 0 && grid.beats.length === 0) {
    return;
  }

  const visibleStartSeconds = Math.max(
    0,
    screenXToSeconds(0, cameraX, pixelsPerSecond),
  );
  const visibleEndSeconds = screenXToSeconds(width, cameraX, pixelsPerSecond);
  const beatPath = grid.showBeatGridLines ? new Path2D() : null;
  const barPath = new Path2D();

  // Grid lines are snapped to a whole pixel (`Math.round(x) + 0.5`) so each 1px
  // line stays crisp. This is a deliberate crisp-vs-smooth tradeoff: a snapped
  // line is sharp but, as the camera glides fractionally during follow, it
  // holds a pixel then jumps 1px (visible stepping when lines are dense at low
  // zoom). Drawing at a fractional x instead would slide smoothly but shimmer
  // (the antialiasing split changes every frame). A 1px vertical line can't be
  // both perfectly crisp and perfectly smooth in a raster; we keep it crisp.
  // Las listas están ordenadas, así que el tramo visible se acota con una
  // búsqueda binaria en vez de recorrer el proyecto entero descartando: en un
  // setlist de 80 min eran ~9600 entradas por capa y por frame para pintar 16.
  // El descarte por `x` se mantiene porque el redondeo a píxel entero puede
  // sacar del lienzo un valor que en segundos sí caía dentro.
  for (
    let index = firstIndexAtOrAfter(grid.beats, visibleStartSeconds);
    index < grid.beats.length;
    index += 1
  ) {
    const seconds = grid.beats[index];
    if (seconds > visibleEndSeconds) {
      break;
    }

    const x =
      Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (x < 0 || x > width) {
      continue;
    }

    if (beatPath) {
      beatPath.moveTo(x, 0);
      beatPath.lineTo(x, height);
    }
  }

  for (
    let index = firstIndexAtOrAfter(grid.bars, visibleStartSeconds);
    index < grid.bars.length;
    index += 1
  ) {
    const seconds = grid.bars[index];
    if (seconds > visibleEndSeconds) {
      break;
    }

    const x =
      Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (x < 0 || x > width) {
      continue;
    }

    barPath.moveTo(x, 0);
    barPath.lineTo(x, height);
  }

  if (beatPath) {
    context.strokeStyle = `rgba(186, 202, 197, ${0.14 * opacityScale})`;
    context.lineWidth = 1;
    context.stroke(beatPath);
  }

  context.strokeStyle = `rgba(186, 202, 197, ${0.32 * opacityScale})`;
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
  const { markers: primaryMarkers, minIntervalSeconds } =
    getRulerLabelPlan(grid);
  const labelSkipDivisor = resolveLabelSkipDivisor(
    minIntervalSeconds * pixelsPerSecond,
  );

  context.textAlign = "left";
  context.textBaseline = "top";

  // Sólo el tramo visible, con el mismo margen de 2 s que tenía el descarte
  // lineal. El filtro por ordinal es por marca, así que acotar primero la
  // ventana y aplicarlo después produce exactamente el mismo conjunto.
  for (
    let index = firstMarkerAtOrAfter(primaryMarkers, visibleStartSeconds - 2);
    index < primaryMarkers.length;
    index += 1
  ) {
    const marker = primaryMarkers[index];
    if (marker.seconds > visibleEndSeconds + 2) {
      break;
    }
    if (getPrimaryMarkerOrdinal(marker, grid) % labelSkipDivisor !== 0) {
      continue;
    }

    const markerX = secondsToScreenX(marker.seconds, cameraX, pixelsPerSecond);
    const x = Math.round(markerX) + 4;
    const y = GRID_LABEL_TOP;

    context.fillStyle = marker.isBarStart ? "#e5e2e1" : "#bacac5";
    context.font = '600 9px "Space Grotesk", sans-serif';
    context.fillText(
      formatRulerMusicalPosition(marker.barNumber, marker.beatInBar),
      x,
      y,
    );

    if (marker.isBarStart) {
      context.fillStyle = "#57f1db";
      context.font = '400 9px "Space Grotesk", sans-serif';
      context.fillText(
        formatRulerTimecode(marker.seconds),
        x,
        GRID_LABEL_SECOND_LINE_TOP,
      );
    }
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
  const regionWidth =
    (region.endSeconds - region.startSeconds) * pixelsPerSecond;
  const right = left + regionWidth;
  if (right < -8 || left > width + 8 || regionWidth <= 0) {
    return;
  }

  const blockLeft = Math.max(-8, left);
  const blockWidth = Math.max(12, Math.min(width + 8, right) - blockLeft);
  const blockTop = LANE_REGIONS.top + 3;
  const blockHeight = LANE_REGIONS.height - 6;

  context.save();
  // Opaque block, same reasoning as the marker flags: a translucent fill let
  // the ruler's grid show through the song name. Pre-blending against the
  // backdrop keeps the familiar warm tint while masking whatever is behind.
  context.fillStyle = blendOnRulerBackdrop(
    "#ffe2ab",
    isSelected ? 0.34 : 0.2,
  );
  context.strokeStyle = isSelected
    ? "rgba(255, 226, 171, 0.85)"
    : "rgba(255, 226, 171, 0.45)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(blockLeft, blockTop, blockWidth, blockHeight, 6);
  context.fill();
  context.stroke();

  context.beginPath();
  context.rect(
    blockLeft + 6,
    blockTop,
    Math.max(0, blockWidth - 12),
    blockHeight,
  );
  context.clip();
  // Fully opaque in both states — the resting name used to sit at 92% alpha on
  // top of a translucent block, which is where it lost its edge.
  context.fillStyle = isSelected ? "#fff4d6" : "#ffefc9";
  context.font = '700 10px "Space Grotesk", sans-serif';
  context.textBaseline = "middle";
  const textLeft = blockLeft + 7;
  const textCenterY = blockTop + blockHeight / 2 + 0.5;
  context.fillText(region.name, textLeft, textCenterY);

  let badgeLeft = blockLeft + 7 + context.measureText(region.name).width + 8;
  const badges: string[] = [];
  // The transpose always shifts the key, warp or not (warp = time-ratio,
  // transpose = pitch-scale, both independent on the same Bungee voice). Shown
  // first as the key is the primary musical cue for a live performer.
  const effectiveKey = transposeKey(region.key, region.transposeSemitones);
  if (effectiveKey) {
    badges.push(effectiveKey);
  }
  if (region.warpEnabled && region.warpSourceBpm && region.warpSourceBpm > 0) {
    badges.push(`${formatBpm(region.warpSourceBpm)} BPM`);
  }
  if (region.transposeSemitones !== 0) {
    badges.push(
      `${region.transposeSemitones > 0 ? `+${region.transposeSemitones}` : region.transposeSemitones} st`,
    );
  }

  for (const badgeText of badges) {
    context.font = '700 9px "Space Grotesk", sans-serif';
    const badgeTextWidth = context.measureText(badgeText).width;
    const badgePaddingX = 5;
    const badgeHeight = 12;
    const badgeWidth = Math.ceil(badgeTextWidth + badgePaddingX * 2);
    const badgeTop = Math.round(textCenterY - badgeHeight / 2);

    context.fillStyle = "rgb(16, 16, 22)";
    context.strokeStyle = "rgba(255, 226, 171, 0.38)";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(badgeLeft, badgeTop, badgeWidth, badgeHeight, 999);
    context.fill();
    context.stroke();

    context.fillStyle = "rgb(255, 244, 210)";
    context.fillText(badgeText, badgeLeft + badgePaddingX, textCenterY + 0.1);
    badgeLeft += badgeWidth + 5;
  }
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
  const label =
    marker.digit == null ? marker.name : `${marker.digit}. ${marker.name}`;

  context.font = '600 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(
    30,
    Math.ceil(context.measureText(label).width) + 12,
  );
  const labelHeight = 16;
  const snappedX = Math.round(x) + 0.5;
  // Cues draw in their own lane above the section lane; sections keep theirs.
  // Both sit flush with the top of their lane — the cue lane itself now starts
  // below the grid labels, so no per-flag inset is needed to clear them.
  const lane = markerCategory(marker) === "cue" ? LANE_CUES : LANE_SECTIONS;
  const stemTop = lane.top + 2;
  const stemBottom = lane.top + lane.height - 2;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 2 : snappedX + 2;
  const flagRight = flagLeft + labelWidth;
  const flagTop = lane.top + 1;
  const flagBottom = flagTop + labelHeight;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  // Armed/selected/current keep their meaningful live-playback colours; only the
  // resting state takes on the marker kind's colour so sections read distinctly.
  const kindColor = markerColor(marker);
  const strokeStyle = options.isArmed
    ? `rgba(87, 241, 219, ${options.pulseAlpha})`
    : options.isSelected
      ? "rgba(255, 226, 171, 0.9)"
      : options.isCurrent
        ? "rgba(229, 226, 225, 0.88)"
        : hexToRgba(kindColor, 0.72);
  // Opaque flag bodies. The tint matches what the old translucent fills looked
  // like over the ruler, but pre-blended, so the grid lines stop reading
  // through the label. Armed keeps a live alpha because it pulses.
  const fillStyle = options.isArmed
    ? `rgba(87, 241, 219, ${0.22 + options.pulseAlpha * 0.22})`
    : options.isSelected
      ? blendOnRulerBackdrop("#ffe2ab", 0.26)
      : options.isCurrent
        ? blendOnRulerBackdrop("#e5e2e1", 0.24)
        : blendOnRulerBackdrop(kindColor, 0.24);
  const textStyle = options.isArmed
    ? "#57f1db"
    : options.isSelected
      ? "#ffe2ab"
      : options.isCurrent
        ? "#e5e2e1"
        : kindColor;

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

  const traceFlagBody = () => {
    context.beginPath();
    if (alignRight) {
      // Mirror of the right-pointing flag: the body grows leftwards from the
      // stem with the chevron notch on the left, so it never overflows the
      // right edge.
      context.moveTo(snappedX, flagTop + 1);
      context.lineTo(flagLeft + 7, flagTop + 1);
      context.lineTo(flagLeft, flagTop + labelHeight * 0.5);
      context.lineTo(flagLeft + 7, flagBottom - 1);
      context.lineTo(snappedX, flagBottom - 1);
    } else {
      context.moveTo(snappedX, flagTop + 1);
      context.lineTo(flagRight - 7, flagTop + 1);
      context.lineTo(flagRight, flagTop + labelHeight * 0.5);
      context.lineTo(flagRight - 7, flagBottom - 1);
      context.lineTo(snappedX, flagBottom - 1);
    }
    context.closePath();
  };

  // Mask the grid first: the armed fill stays translucent so it can pulse, and
  // without this backdrop the bar/beat lines would read through the flag the
  // performer most needs to see. The shadow is suppressed here so the glow is
  // cast once, by the tinted fill.
  const shadowBlurForFill = context.shadowBlur;
  const shadowColorForFill = context.shadowColor;
  context.shadowBlur = 0;
  const previousFillStyle = context.fillStyle;
  context.fillStyle = RULER_BACKDROP;
  traceFlagBody();
  context.fill();
  context.fillStyle = previousFillStyle;
  context.shadowBlur = shadowBlurForFill;
  context.shadowColor = shadowColorForFill;

  traceFlagBody();
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  context.fillStyle = textStyle;
  context.textBaseline = "middle";
  // Clear the chevron notch: shift the text right when the flag points left.
  context.fillText(
    label,
    alignRight ? flagLeft + 10 : flagLeft + 6,
    flagTop + labelHeight / 2 + 0.5,
  );

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
  const label =
    overrideLabel ?? `${marker.bpm.toFixed(marker.bpm % 1 === 0 ? 0 : 1)}`;

  context.font = '700 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(
    30,
    Math.ceil(context.measureText(label).width) + 14,
  );
  const snappedX = Math.round(x) + 0.5;
  const isMetricMarker = overrideLabel != null;
  const verticalOffset = isMetricMarker ? TIME_SIGNATURE_VERTICAL_OFFSET : 0;
  const flagTop =
    LANE_TEMPO_METRIC.top +
    (isMetricMarker ? METRIC_LABEL_TOP : TEMPO_LABEL_TOP) +
    verticalOffset;
  const flagHeight = isMetricMarker ? 12 : 13;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 7 : snappedX + 3;
  const flagRight = flagLeft + labelWidth;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  context.save();
  context.strokeStyle = overrideLabel
    ? "rgba(255, 184, 107, 0.85)"
    : "rgba(87, 241, 219, 0.85)";
  // Opaque, for the same reason as the section flags: a translucent body let
  // the grid lines show through the number.
  context.fillStyle = overrideLabel
    ? blendOnRulerBackdrop("#ffb86b", 0.24)
    : blendOnRulerBackdrop("#57f1db", 0.24);
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
  if (alignRight) {
    // Mirror the flag so it grows leftwards from the stem; otherwise the body
    // and chevron overflow past the right edge and look clipped.
    context.moveTo(snappedX, flagTop);
    context.lineTo(flagLeft + 6, flagTop);
    context.lineTo(flagLeft, flagTop + flagHeight / 2);
    context.lineTo(flagLeft + 6, flagTop + flagHeight);
    context.lineTo(snappedX, flagTop + flagHeight);
  } else {
    context.moveTo(snappedX, flagTop);
    context.lineTo(flagRight - 6, flagTop);
    context.lineTo(flagRight, flagTop + flagHeight / 2);
    context.lineTo(flagRight - 6, flagTop + flagHeight);
    context.lineTo(snappedX, flagTop + flagHeight);
  }
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = overrideLabel ? "#ffb86b" : "#57f1db";
  context.textBaseline = "middle";
  context.fillText(
    label,
    alignRight ? flagLeft + 10 : flagLeft + 6,
    flagTop + flagHeight / 2 + 0.5,
  );

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

  // Grid first, region blocks on top. The regions used to be painted first, so
  // the grid lines were drawn straight across them and read through the song
  // name; an opaque block alone would not have fixed that.
  drawGridLines(
    context,
    args.timelineGrid,
    args.width,
    args.height,
    args.cameraX,
    args.pixelsPerSecond,
    RULER_GRID_OPACITY_SCALE,
  );

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

  // Last, so the live vamp range still tints the region blocks it spans — now
  // that those are opaque, painting it underneath would hide it.
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

  drawRulerGridLabels(
    context,
    args.timelineGrid,
    args.width,
    args.cameraX,
    args.pixelsPerSecond,
  );
}
