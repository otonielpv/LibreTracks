export const BASE_PIXELS_PER_SECOND = 18;
export const TIMELINE_TIMEBASE_HZ = 48_000;
export const TIMELINE_ZOOM_MULTIPLIER = 1.15;
export const TIMELINE_WORKSPACE_TAIL_SECONDS = 3600;

export type TimelineGridParams = {
  durationSeconds: number;
  bpm: number;
  timeSignature: string;
  regions?: TimelineRegion[];
  zoomLevel: number;
  pixelsPerSecond: number;
  viewportStartSeconds: number;
  viewportEndSeconds: number;
};

export type TimelineRegion = {
  startSeconds: number;
  endSeconds: number;
  bpm: number;
  /**
   * The bpm at `endSeconds` when the region is (part of) a tempo ramp: the
   * tempo goes linearly in time from `bpm` to it. Absent: a steady tempo.
   */
  endBpm?: number;
  timeSignature: string;
  /**
   * A time signature marker sits at this region's start, so it begins a new
   * bar even when the meter does not change (the engine's metronome restarts
   * the count there too). A tempo marker alone keeps the beat phase going.
   */
  startsBar?: boolean;
};

export type TimelineGrid = {
  bars: number[];
  /** Numero de compas (1-based, global) de cada entrada de `bars`. */
  barNumbers?: number[];
  /** Solo se dibuja la linea de los compases multiplo de este paso (1, 2, 4…)
   * para que, al alejar, la rejilla no se convierta en un muro de lineas. */
  barLineStep?: number;
  /** Multiplicador de opacidad de las lineas (ajuste "Intensidad de la linea
   * de la rejilla"). Lo pone la vista; 1 si falta. */
  lineIntensity?: number;
  beats: number[];
  subdivisions: number[];
  markers: Array<{
    seconds: number;
    barNumber: number;
    beatInBar: number;
    isBarStart: boolean;
  }>;
  beatsPerBar: number;
  beatDurationSeconds: number;
  showBeatLabels: boolean;
  showBeatGridLines: boolean;
  barLabelStep: number;
  subdivisionPerBeat: number;
  snapIntervalSeconds: number;
  visibleStartSeconds: number;
  visibleEndSeconds: number;
};

export type MusicalPosition = {
  barNumber: number;
  beatInBar: number;
  subBeat: number;
  display: string;
};

/**
 * A tempo ramp: `startBpm` at `startSeconds` to `endBpm` at `endSeconds`,
 * linear in time. The same formulas live in `libretracks_core::tempo_ramp`
 * (Rust) and `tempo_ramp.h` (the engine's metronome): keep the three in step
 * or the click drifts off the grid inside a ramp.
 */
export type TempoRamp = {
  startSeconds: number;
  endSeconds: number;
  startBpm: number;
  endBpm: number;
};

function rampSlope(ramp: TempoRamp): number {
  const span = ramp.endSeconds - ramp.startSeconds;
  return span > 0 ? (ramp.endBpm - ramp.startBpm) / span : 0;
}

/** Quarter notes from the ramp's start to `seconds`; past its end the tempo
 * holds `endBpm`, before its start `startBpm`. */
function rampQuartersFromStart(ramp: TempoRamp, seconds: number): number {
  const dt = seconds - ramp.startSeconds;
  if (dt <= 0) return (dt * ramp.startBpm) / 60;
  const inside = Math.min(seconds, ramp.endSeconds) - ramp.startSeconds;
  const quarters = (ramp.startBpm * inside + 0.5 * rampSlope(ramp) * inside * inside) / 60;
  return quarters + (Math.max(0, seconds - ramp.endSeconds) * ramp.endBpm) / 60;
}

export function rampBpmAt(ramp: TempoRamp, seconds: number): number {
  if (seconds <= ramp.startSeconds) return ramp.startBpm;
  if (seconds >= ramp.endSeconds) return ramp.endBpm;
  return ramp.startBpm + rampSlope(ramp) * (seconds - ramp.startSeconds);
}

export function rampQuartersBetween(ramp: TempoRamp, from: number, to: number): number {
  return rampQuartersFromStart(ramp, to) - rampQuartersFromStart(ramp, from);
}

/** The instant `quarters` quarter notes after `from` (before it if negative). */
export function rampSecondsAfter(ramp: TempoRamp, from: number, quarters: number): number {
  const target = rampQuartersFromStart(ramp, from) + quarters;
  if (target <= 0) return ramp.startSeconds + (target * 60) / ramp.startBpm;
  const rampQuarters = rampQuartersFromStart(ramp, ramp.endSeconds);
  if (target >= rampQuarters) {
    return ramp.endSeconds + ((target - rampQuarters) * 60) / ramp.endBpm;
  }
  // a·dt + k/2·dt² = 60·q, the root that stays finite as k → 0.
  const a = ramp.startBpm;
  const q60 = 60 * target;
  return (
    ramp.startSeconds + (2 * q60) / (a + Math.sqrt(Math.max(0, a * a + 2 * rampSlope(ramp) * q60)))
  );
}

type ResolvedTimelineRegion = TimelineRegion & {
  beatsPerBar: number;
  beatFrames: number;
  barFrames: number;
  beatDurationSeconds: number;
  cumulativeBarsStart: number;
  /** Set when the region ramps (`endBpm`). */
  ramp: TempoRamp | null;
  /** Quarter notes in one beat (4 / beat unit). */
  quartersPerBeat: number;
};

/** Beats from the region's start to `seconds`. A steady region counts on the
 * timebase frames, as it always has; a ramp along its line. */
function regionBeatsAt(region: ResolvedTimelineRegion, seconds: number): number {
  if (region.ramp) {
    return rampQuartersBetween(region.ramp, region.startSeconds, seconds) / region.quartersPerBeat;
  }
  return secondsToSignedTimebaseFrames(seconds - region.startSeconds) / region.beatFrames;
}

/** The instant `beats` beats after the region's start. */
function regionSecondsAtBeats(region: ResolvedTimelineRegion, beats: number): number {
  if (region.ramp) {
    return rampSecondsAfter(region.ramp, region.startSeconds, beats * region.quartersPerBeat);
  }
  return region.startSeconds + timebaseFrameDeltaToSeconds(beats * region.beatFrames);
}

const MUSICAL_POSITION_EPSILON = 1e-9;
/**
 * How far (in bars) a time signature marker may sit from a bar line and still
 * count as on it. Markers placed from audio ("Analizar canción") land on the
 * click's real downbeat, a few milliseconds off the rounded tempo's grid.
 */
const BAR_BOUNDARY_TOLERANCE = 0.02;

/**
 * Bar count where a time signature marker starts a new bar. Within the
 * tolerance of a bar line it IS that bar line, instead of adding a sliver of
 * a bar before it.
 */
export function barCountAtTimingBoundary(cumulativeBars: number): number {
  const nearest = Math.round(cumulativeBars);
  if (Math.abs(cumulativeBars - nearest) <= BAR_BOUNDARY_TOLERANCE) {
    return nearest;
  }
  return Math.ceil(cumulativeBars - MUSICAL_POSITION_EPSILON);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampPositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseTimeSignature(timeSignature: string) {
  const [numeratorRaw, denominatorRaw] = timeSignature.split("/");
  const beatsPerBar = Math.max(1, Number.parseInt(numeratorRaw ?? "4", 10) || 4);
  const beatUnit = Math.max(1, Number.parseInt(denominatorRaw ?? "4", 10) || 4);
  return { beatsPerBar, beatUnit };
}

export function getBeatDurationSeconds(bpm: number, timeSignature: string) {
  return timebaseFramesToSeconds(getBeatFrames(bpm, timeSignature));
}

export function secondsToTimebaseFrames(
  seconds: number,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
) {
  return Math.max(0, Math.round(Math.max(0, seconds) * clampPositive(timebaseHz, 1)));
}

export function timebaseFramesToSeconds(
  frames: number,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
) {
  return Math.max(0, frames) / clampPositive(timebaseHz, 1);
}

function timebaseFrameDeltaToSeconds(
  frames: number,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
) {
  return frames / clampPositive(timebaseHz, 1);
}

function secondsToSignedTimebaseFrames(
  seconds: number,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
) {
  return Math.round(seconds * clampPositive(timebaseHz, 1));
}

export function getBeatFrames(
  bpm: number,
  timeSignature: string,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
) {
  const safeBpm = clampPositive(bpm, 120);
  const { beatUnit } = parseTimeSignature(timeSignature);
  const quarterNoteFrames = (clampPositive(timebaseHz, 1) * 60) / safeBpm;
  return Math.max(1, Math.round(quarterNoteFrames * (4 / beatUnit)));
}

function getPositionFromTotalBeats(totalBeats: number, beatsPerBar: number) {
  const safeTotalBeats = Math.max(0, totalBeats);
  const totalWholeBeats = Math.floor(safeTotalBeats + MUSICAL_POSITION_EPSILON);
  const beatProgress = safeTotalBeats - totalWholeBeats;
  const normalizedBeatProgress =
    beatProgress >= 1 - MUSICAL_POSITION_EPSILON ? 0 : Math.max(0, beatProgress);

  return {
    barNumber: Math.floor(totalWholeBeats / beatsPerBar) + 1,
    beatInBar: (totalWholeBeats % beatsPerBar) + 1,
    subBeat: Math.min(99, Math.floor(normalizedBeatProgress * 100 + MUSICAL_POSITION_EPSILON)),
  };
}

export function getMusicalPosition(
  seconds: number,
  bpm: number,
  timeSignature: string,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
): MusicalPosition {
  const { beatsPerBar } = parseTimeSignature(timeSignature);
  const beatFrames = getBeatFrames(bpm, timeSignature, timebaseHz);
  const totalFrames = secondsToTimebaseFrames(seconds, timebaseHz);
  const { barNumber, beatInBar, subBeat } = getPositionFromTotalBeats(
    totalFrames / beatFrames,
    beatsPerBar,
  );

  return {
    barNumber,
    beatInBar,
    subBeat,
    display: `${barNumber}.${beatInBar}.${String(subBeat).padStart(2, "0")}`,
  };
}

export function getCumulativeMusicalPosition(
  seconds: number,
  regions: TimelineRegion[],
  fallbackBpm = 120,
  fallbackTimeSignature = "4/4",
  timebaseHz = TIMELINE_TIMEBASE_HZ,
): MusicalPosition {
  if (!regions.length) {
    return getMusicalPosition(seconds, fallbackBpm, fallbackTimeSignature, timebaseHz);
  }

  const resolvedRegions = normalizeTimelineRegions({
    durationSeconds: Math.max(0, ...regions.map((region) => region.endSeconds), seconds),
    bpm: fallbackBpm,
    timeSignature: fallbackTimeSignature,
    regions,
  });
  const region = resolveTimelineRegionAtSeconds(seconds, resolvedRegions) ?? resolvedRegions[0];
  if (!region) {
    return getMusicalPosition(seconds, fallbackBpm, fallbackTimeSignature, timebaseHz);
  }

  const localSeconds = clamp(seconds - region.startSeconds, 0, region.endSeconds - region.startSeconds);
  const localBeats = region.ramp
    ? regionBeatsAt(region, region.startSeconds + localSeconds)
    : secondsToTimebaseFrames(localSeconds, timebaseHz) / region.beatFrames;
  const { barNumber, beatInBar, subBeat } = getPositionFromTotalBeats(
    region.cumulativeBarsStart * region.beatsPerBar + localBeats,
    region.beatsPerBar,
  );

  return {
    barNumber,
    beatInBar,
    subBeat,
    display: `${barNumber}.${beatInBar}.${String(subBeat).padStart(2, "0")}`,
  };
}

export function getPixelsPerSecond(zoomLevel: number) {
  return zoomLevel * BASE_PIXELS_PER_SECOND;
}

export function getZoomLevelDelta(
  currentZoomLevel: number,
  direction: "in" | "out",
  multiplier = TIMELINE_ZOOM_MULTIPLIER,
) {
  const safeZoomLevel = clampPositive(currentZoomLevel, 1);
  const safeMultiplier = Math.max(1.01, multiplier);
  return direction === "in"
    ? safeZoomLevel * safeMultiplier
    : safeZoomLevel / safeMultiplier;
}

export function secondsToScreenX(
  seconds: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  return seconds * pixelsPerSecond - cameraX;
}

export function secondsToAbsoluteX(seconds: number, pixelsPerSecond: number) {
  return Math.max(0, seconds) * clampPositive(pixelsPerSecond, 1);
}

export function screenXToSeconds(
  screenX: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  return (cameraX + screenX) / clampPositive(pixelsPerSecond, 1);
}

export type ClientCoordinateBounds = Pick<
  DOMRect,
  "left" | "top" | "width" | "height"
>;

export function getElementScaleX(
  bounds: Pick<ClientCoordinateBounds, "width">,
  layoutWidth?: number,
) {
  return Number.isFinite(layoutWidth) && layoutWidth && layoutWidth > 0
    ? clampPositive(bounds.width / layoutWidth, 1)
    : 1;
}

export function getElementScaleY(
  bounds: Pick<ClientCoordinateBounds, "height">,
  layoutHeight?: number,
) {
  return Number.isFinite(layoutHeight) && layoutHeight && layoutHeight > 0
    ? clampPositive(bounds.height / layoutHeight, 1)
    : 1;
}

export function clientXToLocalX(
  clientX: number,
  bounds: Pick<ClientCoordinateBounds, "left" | "width">,
  layoutWidth?: number,
) {
  return (clientX - bounds.left) / getElementScaleX(bounds, layoutWidth);
}

export function clientYToLocalY(
  clientY: number,
  bounds: Pick<ClientCoordinateBounds, "top" | "height">,
  layoutHeight?: number,
) {
  return (clientY - bounds.top) / getElementScaleY(bounds, layoutHeight);
}

export function clientDeltaXToLocalDelta(
  deltaX: number,
  bounds: Pick<ClientCoordinateBounds, "width">,
  layoutWidth?: number,
) {
  return deltaX / getElementScaleX(bounds, layoutWidth);
}

export function localXToClientX(
  localX: number,
  bounds: Pick<ClientCoordinateBounds, "left" | "width">,
  layoutWidth?: number,
) {
  return bounds.left + localX * getElementScaleX(bounds, layoutWidth);
}

export function clientXToTimelineSeconds(
  clientX: number,
  boundsElement: Pick<HTMLElement, "getBoundingClientRect"> &
    Partial<Pick<HTMLElement, "offsetWidth">>,
  scrollContainerElement: Pick<HTMLElement, "scrollLeft"> | null,
  pixelsPerSecond: number,
) {
  const bounds = boundsElement.getBoundingClientRect();
  const localX = clientXToLocalX(clientX, bounds, boundsElement.offsetWidth);
  const x = Math.max(0, localX + (scrollContainerElement?.scrollLeft ?? 0));
  return x / clampPositive(pixelsPerSecond, 1);
}

export function getTimelineWorkspaceEndSeconds(
  durationSeconds: number,
  contentEndSeconds = durationSeconds,
  tailSeconds = TIMELINE_WORKSPACE_TAIL_SECONDS,
) {
  return Math.max(0, durationSeconds, contentEndSeconds) + Math.max(0, tailSeconds);
}

export function getMaxCameraX(
  durationSeconds: number,
  pixelsPerSecond: number,
  viewportWidth: number,
  contentEndSeconds = durationSeconds,
) {
  return Math.max(
    0,
    getContentWidth(durationSeconds, pixelsPerSecond, contentEndSeconds) - Math.max(0, viewportWidth),
  );
}

export function getContentWidth(
  durationSeconds: number,
  pixelsPerSecond: number,
  contentEndSeconds = durationSeconds,
) {
  return getTimelineWorkspaceEndSeconds(durationSeconds, contentEndSeconds) * clampPositive(pixelsPerSecond, 1);
}

export function clampCameraX(
  nextCameraX: number,
  durationSeconds: number,
  pixelsPerSecond: number,
  viewportWidth: number,
  contentEndSeconds = durationSeconds,
) {
  return clamp(
    nextCameraX,
    0,
    getMaxCameraX(durationSeconds, pixelsPerSecond, viewportWidth, contentEndSeconds),
  );
}

export function getFollowPlayheadCameraX(params: {
  playheadSeconds: number;
  cameraX: number;
  pixelsPerSecond: number;
  viewportWidth: number;
  durationSeconds: number;
  contentEndSeconds?: number;
  followMode?: "ahead" | "center";
  leadingRatio?: number;
  trailingRatio?: number;
}) {
  const viewportWidth = Math.max(0, params.viewportWidth);
  if (viewportWidth <= 0 || !Number.isFinite(params.playheadSeconds)) {
    return null;
  }

  const playheadX = secondsToAbsoluteX(
    params.playheadSeconds,
    params.pixelsPerSecond,
  );
  const currentCameraX = Math.max(0, params.cameraX);
  const followMode = params.followMode ?? "ahead";
  if (followMode === "center") {
    const clampedCameraX = clampCameraX(
      playheadX - viewportWidth * 0.5,
      params.durationSeconds,
      params.pixelsPerSecond,
      viewportWidth,
      params.contentEndSeconds ?? params.durationSeconds,
    );
    return Math.abs(clampedCameraX - currentCameraX) > 0.01
      ? clampedCameraX
      : null;
  }

  const trailingRatio = clamp(params.trailingRatio ?? 0.18, 0, 0.9);
  const leadingRatio = clamp(
    params.leadingRatio ?? 0.75,
    trailingRatio + 0.05,
    0.95,
  );
  const trailingX = viewportWidth * trailingRatio;
  const leadingX = viewportWidth * leadingRatio;
  const viewportX = playheadX - currentCameraX;

  let nextCameraX: number | null = null;
  if (viewportX > leadingX) {
    nextCameraX = playheadX - leadingX;
  } else if (viewportX < trailingX) {
    nextCameraX = playheadX - trailingX;
  }

  if (nextCameraX === null) {
    return null;
  }

  const clampedCameraX = clampCameraX(
    nextCameraX,
    params.durationSeconds,
    params.pixelsPerSecond,
    viewportWidth,
    params.contentEndSeconds ?? params.durationSeconds,
  );

  // Suppress only a truly negligible move. A larger dead band (e.g. 0.5px)
  // would swallow sub-pixel-per-frame advances at low zoom, stalling the follow
  // camera every other frame and making it stutter; callers that want to batch
  // redundant writes apply their own threshold.
  return Math.abs(clampedCameraX - currentCameraX) > 0.01
    ? clampedCameraX
    : null;
}

export function zoomCameraAtViewportX(params: {
  durationSeconds: number;
  contentEndSeconds?: number;
  viewportWidth: number;
  viewportX: number;
  currentCameraX: number;
  previousPixelsPerSecond: number;
  nextPixelsPerSecond: number;
}) {
  const anchorSeconds = screenXToSeconds(
    params.viewportX,
    params.currentCameraX,
    params.previousPixelsPerSecond,
  );
  const unclampedCameraX = anchorSeconds * params.nextPixelsPerSecond - params.viewportX;
  return clampCameraX(
    unclampedCameraX,
    params.durationSeconds,
    params.nextPixelsPerSecond,
    params.viewportWidth,
    params.contentEndSeconds ?? params.durationSeconds,
  );
}

/**
 * Ancho minimo en pixeles para que la linea de un beat se dibuje.
 *
 * Lo comparten el dibujo de la rejilla y el snap A PROPOSITO. Cuando cada uno
 * decidia por su cuenta, `snapToTimelineGrid` ajustaba siempre al beat mas
 * cercano mientras la rejilla, alejada, solo pintaba compases: la marca caia
 * en una linea que no existia en pantalla y parecia "aparecer en otro sitio".
 * Si cambias este umbral, cambia para los dos.
 */
export const MIN_BEAT_GRID_PIXELS = 16;

/** Separacion minima en pixeles entre dos lineas de compas dibujadas. Por
 * debajo se salta compases (de 2 en 2, de 4 en 4…), como hace Live al alejar. */
export const MIN_BAR_GRID_PIXELS = 12;

/** Paso de compases (potencia de 2) para que las lineas no queden a menos de
 * MIN_BAR_GRID_PIXELS. Solo afecta al dibujo, no al snap. */
export function timelineBarLineStep(barPixels: number): number {
  if (!Number.isFinite(barPixels) || barPixels <= 0) {
    return 1;
  }
  let step = 1;
  while (barPixels * step < MIN_BAR_GRID_PIXELS && step < 1024) {
    step *= 2;
  }
  return step;
}

/** "beat" si su linea se dibuja a este zoom; "bar" si solo se ven compases. */
export function timelineGridResolution(
  beatDurationSeconds: number,
  pixelsPerSecond: number,
): "beat" | "bar" {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    return "beat";
  }
  return beatDurationSeconds * pixelsPerSecond >= MIN_BEAT_GRID_PIXELS
    ? "beat"
    : "bar";
}

export function buildVisibleTimelineGrid(params: TimelineGridParams): TimelineGrid {
  const safeDuration = Math.max(0, params.durationSeconds);
  const safePixelsPerSecond = clampPositive(params.pixelsPerSecond, 1);
  const resolvedRegions = normalizeTimelineRegions(params);
  const primaryVisibleRegion =
    resolveTimelineRegionAtSeconds(params.viewportStartSeconds, resolvedRegions) ?? resolvedRegions[0];
  const beatsPerBar = primaryVisibleRegion?.beatsPerBar ?? parseTimeSignature(params.timeSignature).beatsPerBar;
  const beatFrames = primaryVisibleRegion?.beatFrames ?? getBeatFrames(params.bpm, params.timeSignature);
  const beatDuration = primaryVisibleRegion?.beatDurationSeconds ?? timebaseFramesToSeconds(beatFrames);
  const beatPixels = beatDuration * safePixelsPerSecond;
  const barPixels = beatPixels * beatsPerBar;
  const subdivisionPerBeat = 1;
  const snapIntervalSeconds = beatDuration;
  const showBeatLabels = beatPixels >= 120 && params.zoomLevel >= 9;
  const showBeatGridLines =
    timelineGridResolution(beatDuration, safePixelsPerSecond) === "beat";
  const barLabelStep =
    showBeatLabels ? 1 : barPixels >= 240 ? 1 : barPixels >= 120 ? 2 : barPixels >= 64 ? 4 : 8;

  const visibleStartSeconds = clamp(params.viewportStartSeconds, 0, safeDuration);
  const visibleEndSeconds = clamp(
    Math.max(visibleStartSeconds, params.viewportEndSeconds),
    0,
    Math.max(safeDuration, visibleStartSeconds),
  );

  const bars: number[] = [];
  const barNumbers: number[] = [];
  const beats: number[] = [];
  const markers: TimelineGrid["markers"] = [];

  for (const region of resolvedRegions) {
    const regionVisibleStart = Math.max(visibleStartSeconds, region.startSeconds);
    const regionVisibleEnd = Math.min(visibleEndSeconds, region.endSeconds);
    if (regionVisibleEnd < regionVisibleStart) {
      continue;
    }

    const totalBeatsStart = region.cumulativeBarsStart * region.beatsPerBar;
    const startBeatOrdinal = Math.max(
      0,
      Math.floor(totalBeatsStart + Math.max(0, regionBeatsAt(region, regionVisibleStart))) - 1,
    );
    const endBeatOrdinal = Math.max(
      startBeatOrdinal,
      Math.ceil(totalBeatsStart + Math.max(0, regionBeatsAt(region, regionVisibleEnd))) + 1,
    );

    for (let beatOrdinal = startBeatOrdinal; beatOrdinal <= endBeatOrdinal; beatOrdinal += 1) {
      const seconds = regionSecondsAtBeats(region, beatOrdinal - totalBeatsStart);
      if (seconds < visibleStartSeconds - region.beatDurationSeconds || seconds > safeDuration + region.beatDurationSeconds) {
        continue;
      }
      if (seconds < region.startSeconds - timebaseFramesToSeconds(1)) {
        continue;
      }
      // A beat a hair before the next region's start is that region's first
      // bar line (see barCountAtTimingBoundary): drawing both doubles it.
      const endGuardSeconds = Math.max(
        timebaseFramesToSeconds(1),
        BAR_BOUNDARY_TOLERANCE * region.beatDurationSeconds * region.beatsPerBar,
      );
      if (seconds >= region.endSeconds - endGuardSeconds) {
        continue;
      }

      const { barNumber, beatInBar } = getPositionFromTotalBeats(beatOrdinal, region.beatsPerBar);
      const isBarStart = beatInBar === 1;

      markers.push({ seconds, barNumber, beatInBar, isBarStart });

      if (isBarStart) {
        bars.push(seconds);
        barNumbers.push(barNumber);
      } else {
        beats.push(seconds);
      }
    }
  }

  return {
    bars,
    barNumbers,
    barLineStep: timelineBarLineStep(barPixels),
    beats,
    subdivisions: [],
    markers,
    beatsPerBar,
    beatDurationSeconds: beatDuration,
    showBeatLabels,
    showBeatGridLines,
    barLabelStep,
    subdivisionPerBeat,
    snapIntervalSeconds,
    visibleStartSeconds,
    visibleEndSeconds,
  };
}

/**
 * Índice del primer valor `>= target` en un array ORDENADO ascendente, o
 * `values.length` si no hay ninguno. Búsqueda binaria.
 *
 * Existe para que el dibujo de la rejilla recorra sólo el tramo visible en vez
 * de recorrer el proyecto entero y descartar. En un setlist de 80 minutos son
 * ~9600 entradas por capa y por frame para pintar 16.
 *
 * La premisa (arrays ordenados) la garantiza `buildVisibleTimelineGrid`: emite
 * los beats en orden dentro de cada región y `normalizeTimelineRegions` ordena
 * las regiones por `startSeconds`. Hay un test que lo vigila.
 */
export function firstIndexAtOrAfter(
  values: readonly number[],
  target: number,
) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Duracion del beat en esa posicion, respetando los cambios de tempo. */
function beatDurationSecondsAt(
  seconds: number,
  bpm: number,
  timeSignature: string,
  regions: TimelineRegion[],
): number {
  if (regions.length > 0) {
    const resolved = normalizeTimelineRegions({
      durationSeconds: Math.max(0, ...regions.map((region) => region.endSeconds), seconds),
      bpm,
      timeSignature,
      regions,
    });
    const region = resolveTimelineRegionAtSeconds(seconds, resolved) ?? resolved[0];
    if (region) return region.beatDurationSeconds;
  }
  return timebaseFramesToSeconds(getBeatFrames(bpm, timeSignature));
}

export function snapToTimelineGrid(
  seconds: number,
  bpm: number,
  timeSignature: string,
  _zoomLevel: number,
  pixelsPerSecond: number,
  regions: TimelineRegion[] = [],
) {
  // Ajusta a lo que el usuario VE. Alejado, las lineas de beat no se dibujan
  // (ver MIN_BEAT_GRID_PIXELS) y ajustar a ellas dejaba el contenido en una
  // rejilla invisible; ahi el compas es la unidad visible.
  if (
    timelineGridResolution(
      beatDurationSecondsAt(seconds, bpm, timeSignature, regions),
      pixelsPerSecond,
    ) === "bar"
  ) {
    return snapToTimelineBar(seconds, bpm, timeSignature, regions);
  }
  if (regions.length > 0) {
    const resolvedRegions = normalizeTimelineRegions({
      durationSeconds: Math.max(0, ...regions.map((region) => region.endSeconds), seconds),
      bpm,
      timeSignature,
      regions,
    });
    const firstRegion = resolvedRegions[0];
    if (firstRegion && seconds < firstRegion.startSeconds) {
      const localFrames = secondsToSignedTimebaseFrames(seconds - firstRegion.startSeconds);
      const snappedFrames =
        Math.round(localFrames / firstRegion.beatFrames) * firstRegion.beatFrames;
      return firstRegion.startSeconds + timebaseFrameDeltaToSeconds(snappedFrames);
    }

    const region = resolveTimelineRegionAtSeconds(seconds, resolvedRegions) ?? resolvedRegions[0];
    if (region) {
      const totalBeatsStart = region.cumulativeBarsStart * region.beatsPerBar;
      const localBeats = Math.max(0, regionBeatsAt(region, seconds));
      const snappedTotalBeats = Math.round(totalBeatsStart + localBeats);
      return clamp(
        Math.max(region.startSeconds, regionSecondsAtBeats(region, snappedTotalBeats - totalBeatsStart)),
        region.startSeconds,
        region.endSeconds,
      );
    }
  }

  const beatFrames = getBeatFrames(bpm, timeSignature);
  const positionFrames = secondsToSignedTimebaseFrames(seconds);
  return timebaseFrameDeltaToSeconds(Math.round(positionFrames / beatFrames) * beatFrames);
}

/**
 * Like snapToTimelineGrid but rounds to the nearest bar (downbeat),
 * not to the nearest beat. Used when moving / resizing a whole song
 * region — songs always start on a downbeat, so snapping mid-bar
 * gives off-grid results like 215.4.00.
 */
export function snapToTimelineBar(
  seconds: number,
  bpm: number,
  timeSignature: string,
  regions: TimelineRegion[] = [],
): number {
  if (regions.length > 0) {
    const resolvedRegions = normalizeTimelineRegions({
      durationSeconds: Math.max(0, ...regions.map((region) => region.endSeconds), seconds),
      bpm,
      timeSignature,
      regions,
    });
    const firstRegion = resolvedRegions[0];
    if (firstRegion && seconds < firstRegion.startSeconds) {
      const barFrames = firstRegion.beatFrames * firstRegion.beatsPerBar;
      const localFrames = secondsToSignedTimebaseFrames(seconds - firstRegion.startSeconds);
      const snappedFrames = Math.round(localFrames / barFrames) * barFrames;
      return firstRegion.startSeconds + timebaseFrameDeltaToSeconds(snappedFrames);
    }

    const region = resolveTimelineRegionAtSeconds(seconds, resolvedRegions) ?? resolvedRegions[0];
    if (region) {
      const localBars = Math.max(0, regionBeatsAt(region, seconds)) / region.beatsPerBar;
      const snappedTotalBars = Math.round(region.cumulativeBarsStart + localBars);
      const targetBeats = (snappedTotalBars - region.cumulativeBarsStart) * region.beatsPerBar;
      return clamp(
        Math.max(region.startSeconds, regionSecondsAtBeats(region, targetBeats)),
        region.startSeconds,
        region.endSeconds,
      );
    }
  }

  const barFrames = getBeatFrames(bpm, timeSignature) * Number(timeSignature.split("/")[0] ?? 4);
  const positionFrames = secondsToSignedTimebaseFrames(seconds);
  return timebaseFrameDeltaToSeconds(Math.round(positionFrames / barFrames) * barFrames);
}

/**
 * Returns the timeline-time of the first downbeat (bar boundary) at or
 * after `seconds`. Walks the project's tempo regions so the answer
 * respects every tempo / time-signature change between `seconds` and
 * the next bar. Used by the compact view's `.ltpkg` import to land
 * imported songs on a real grid bar instead of "last region end + one
 * bar at the global BPM", which drifts off-grid whenever the previous
 * song ended under a different tempo marker.
 */
export function nextDownbeatAfter(
  seconds: number,
  bpm: number,
  timeSignature: string,
  regions: TimelineRegion[] = [],
): number {
  if (regions.length > 0) {
    const resolvedRegions = normalizeTimelineRegions({
      durationSeconds: Math.max(
        0,
        ...regions.map((region) => region.endSeconds),
        seconds,
      ),
      bpm,
      timeSignature,
      regions,
    });
    const region =
      resolveTimelineRegionAtSeconds(seconds, resolvedRegions) ??
      resolvedRegions[resolvedRegions.length - 1];
    if (region) {
      const totalBeatsStart = region.cumulativeBarsStart * region.beatsPerBar;
      const totalBeats = totalBeatsStart + Math.max(0, regionBeatsAt(region, seconds));
      const totalBars = totalBeats / region.beatsPerBar;
      // Ceil to land *on or after* the requested seconds. The epsilon
      // prevents floating drift from spuriously bumping an already-on-bar
      // position to the next one.
      const targetBars = Math.ceil(totalBars - MUSICAL_POSITION_EPSILON);
      const targetTotalBeats = targetBars * region.beatsPerBar;
      const downbeat = Math.max(
        region.startSeconds,
        regionSecondsAtBeats(region, targetTotalBeats - totalBeatsStart),
      );
      // Past this region's end the next one rules: it may restart the bar
      // before this region's grid gets there (a song after one that does
      // not end on a whole bar).
      const next = resolvedRegions[resolvedRegions.indexOf(region) + 1];
      if (next && seconds < next.startSeconds && downbeat > next.startSeconds + MUSICAL_POSITION_EPSILON) {
        return nextDownbeatAfter(next.startSeconds, bpm, timeSignature, regions);
      }
      return downbeat;
    }
  }

  const beatFrames = getBeatFrames(bpm, timeSignature);
  const { beatsPerBar } = parseTimeSignature(timeSignature);
  const barFrames = beatFrames * beatsPerBar;
  const positionFrames = secondsToTimebaseFrames(Math.max(0, seconds));
  const targetFrames =
    Math.ceil(positionFrames / barFrames - MUSICAL_POSITION_EPSILON) * barFrames;
  return timebaseFramesToSeconds(targetFrames);
}

function normalizeTimelineRegions(
  params: Pick<TimelineGridParams, "durationSeconds" | "bpm" | "timeSignature" | "regions">,
) {
  const inputRegions = [...(params.regions ?? [])]
    .map((region) => ({
      startSeconds: Math.max(0, region.startSeconds),
      endSeconds: Math.max(0, region.endSeconds),
      bpm: clampPositive(region.bpm, params.bpm),
      endBpm:
        region.endBpm !== undefined && Number.isFinite(region.endBpm) && region.endBpm > 0
          ? region.endBpm
          : undefined,
      timeSignature: region.timeSignature || params.timeSignature,
      startsBar: region.startsBar ?? false,
    }))
    .filter((region) => region.endSeconds > region.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);

  const fallbackRegion = {
    startSeconds: 0,
    endSeconds: Math.max(0, params.durationSeconds),
    bpm: clampPositive(params.bpm, 120),
    endBpm: undefined,
    timeSignature: params.timeSignature,
    startsBar: false,
  };

  const authoritativeRegions = inputRegions.length ? inputRegions : [fallbackRegion];

  const resolvedRegions: ResolvedTimelineRegion[] = [];
  let cumulativeBarsStart = 0;
  let previousTimeSignature: string | null = null;

  for (const region of authoritativeRegions) {
    const { beatsPerBar, beatUnit } = parseTimeSignature(region.timeSignature);
    const beatFrames = getBeatFrames(region.bpm, region.timeSignature);
    const barFrames = beatFrames * beatsPerBar;
    const beatDurationSeconds = timebaseFramesToSeconds(beatFrames);
    const ramp: TempoRamp | null =
      region.endBpm !== undefined && region.endBpm !== region.bpm
        ? {
            startSeconds: region.startSeconds,
            endSeconds: region.endSeconds,
            startBpm: region.bpm,
            endBpm: region.endBpm,
          }
        : null;

    // A meter change, or any time signature marker, starts a bar. A tempo
    // change alone keeps the beat phase (see the "mid-beat" test).
    if (
      previousTimeSignature &&
      (previousTimeSignature !== region.timeSignature || region.startsBar)
    ) {
      cumulativeBarsStart = barCountAtTimingBoundary(cumulativeBarsStart);
    }

    const resolved: ResolvedTimelineRegion = {
      ...region,
      beatsPerBar,
      beatFrames,
      barFrames,
      beatDurationSeconds,
      cumulativeBarsStart,
      ramp,
      quartersPerBeat: 4 / beatUnit,
    };
    resolvedRegions.push(resolved);
    cumulativeBarsStart += ramp
      ? regionBeatsAt(resolved, region.endSeconds) / beatsPerBar
      : secondsToTimebaseFrames(region.endSeconds - region.startSeconds) / barFrames;
    previousTimeSignature = region.timeSignature;
  }

  return resolvedRegions;
}

function resolveTimelineRegionAtSeconds(seconds: number, regions: ResolvedTimelineRegion[]) {
  return (
    regions.find((region) => seconds >= region.startSeconds && seconds < region.endSeconds) ??
    [...regions].reverse().find((region) => seconds >= region.endSeconds) ??
    regions[0]
  );
}
