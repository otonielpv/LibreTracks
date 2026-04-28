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
  timeSignature: string;
};

export type TimelineGrid = {
  bars: number[];
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

type ResolvedTimelineRegion = TimelineRegion & {
  beatsPerBar: number;
  beatFrames: number;
  barFrames: number;
  beatDurationSeconds: number;
  cumulativeBarsStart: number;
};

const MUSICAL_POSITION_EPSILON = 1e-9;

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
  const totalFrames = secondsToTimebaseFrames(localSeconds, timebaseHz);
  const { barNumber, beatInBar, subBeat } = getPositionFromTotalBeats(
    region.cumulativeBarsStart * region.beatsPerBar + totalFrames / region.beatFrames,
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

export function clientXToTimelineSeconds(
  clientX: number,
  boundsElement: Pick<HTMLElement, "getBoundingClientRect">,
  scrollContainerElement: Pick<HTMLElement, "scrollLeft"> | null,
  pixelsPerSecond: number,
) {
  const bounds = boundsElement.getBoundingClientRect();
  const x = Math.max(0, clientX - bounds.left + (scrollContainerElement?.scrollLeft ?? 0));
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
  const showBeatLabels = beatPixels >= 78 && params.zoomLevel >= 6.5;
  const showBeatGridLines = beatPixels >= 16;
  const barLabelStep =
    showBeatLabels ? 1 : barPixels >= 240 ? 1 : barPixels >= 120 ? 2 : barPixels >= 64 ? 4 : 8;

  const visibleStartSeconds = clamp(params.viewportStartSeconds, 0, safeDuration);
  const visibleEndSeconds = clamp(
    Math.max(visibleStartSeconds, params.viewportEndSeconds),
    0,
    Math.max(safeDuration, visibleStartSeconds),
  );

  const bars: number[] = [];
  const beats: number[] = [];
  const markers: TimelineGrid["markers"] = [];

  for (const region of resolvedRegions) {
    const regionVisibleStart = Math.max(visibleStartSeconds, region.startSeconds);
    const regionVisibleEnd = Math.min(visibleEndSeconds, region.endSeconds);
    if (regionVisibleEnd < regionVisibleStart) {
      continue;
    }

    const localVisibleStartFrames = secondsToTimebaseFrames(regionVisibleStart - region.startSeconds);
    const localVisibleEndFrames = secondsToTimebaseFrames(regionVisibleEnd - region.startSeconds);
    const totalBeatsStart = region.cumulativeBarsStart * region.beatsPerBar;
    const startBeatOrdinal = Math.max(
      0,
      Math.floor(totalBeatsStart + localVisibleStartFrames / region.beatFrames) - 1,
    );
    const endBeatOrdinal = Math.max(
      startBeatOrdinal,
      Math.ceil(totalBeatsStart + localVisibleEndFrames / region.beatFrames) + 1,
    );

    for (let beatOrdinal = startBeatOrdinal; beatOrdinal <= endBeatOrdinal; beatOrdinal += 1) {
      const seconds =
        region.startSeconds +
        timebaseFrameDeltaToSeconds((beatOrdinal - totalBeatsStart) * region.beatFrames);
      if (seconds < visibleStartSeconds - region.beatDurationSeconds || seconds > safeDuration + region.beatDurationSeconds) {
        continue;
      }
      if (seconds < region.startSeconds - timebaseFramesToSeconds(1)) {
        continue;
      }
      if (seconds >= region.endSeconds - timebaseFramesToSeconds(1)) {
        continue;
      }

      const { barNumber, beatInBar } = getPositionFromTotalBeats(beatOrdinal, region.beatsPerBar);
      const isBarStart = beatInBar === 1;

      markers.push({ seconds, barNumber, beatInBar, isBarStart });

      if (isBarStart) {
        bars.push(seconds);
      } else {
        beats.push(seconds);
      }
    }
  }

  return {
    bars,
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

export function snapToTimelineGrid(
  seconds: number,
  bpm: number,
  timeSignature: string,
  _zoomLevel: number,
  _pixelsPerSecond: number,
  regions: TimelineRegion[] = [],
) {
  if (regions.length > 0) {
    const resolvedRegions = normalizeTimelineRegions({
      durationSeconds: Math.max(0, ...regions.map((region) => region.endSeconds), seconds),
      bpm,
      timeSignature,
      regions,
    });
    const region = resolveTimelineRegionAtSeconds(seconds, resolvedRegions) ?? resolvedRegions[0];
    if (region) {
      const localFrames = secondsToTimebaseFrames(seconds - region.startSeconds);
      const totalBeats = region.cumulativeBarsStart * region.beatsPerBar + localFrames / region.beatFrames;
      const snappedTotalBeats = Math.round(totalBeats);
      const snappedFrames =
        (snappedTotalBeats - region.cumulativeBarsStart * region.beatsPerBar) * region.beatFrames;
      return clamp(
        region.startSeconds + timebaseFramesToSeconds(snappedFrames),
        region.startSeconds,
        region.endSeconds,
      );
    }
  }

  const beatFrames = getBeatFrames(bpm, timeSignature);
  const positionFrames = secondsToTimebaseFrames(seconds);
  return timebaseFramesToSeconds(Math.round(positionFrames / beatFrames) * beatFrames);
}

function normalizeTimelineRegions(
  params: Pick<TimelineGridParams, "durationSeconds" | "bpm" | "timeSignature" | "regions">,
) {
  const inputRegions = [...(params.regions ?? [])]
    .map((region) => ({
      startSeconds: Math.max(0, region.startSeconds),
      endSeconds: Math.max(0, region.endSeconds),
      bpm: clampPositive(region.bpm, params.bpm),
      timeSignature: region.timeSignature || params.timeSignature,
    }))
    .filter((region) => region.endSeconds > region.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);

  const fallbackRegion = {
    startSeconds: 0,
    endSeconds: Math.max(0, params.durationSeconds),
    bpm: clampPositive(params.bpm, 120),
    timeSignature: params.timeSignature,
  };

  const authoritativeRegions = inputRegions.length ? inputRegions : [fallbackRegion];

  const resolvedRegions: ResolvedTimelineRegion[] = [];
  let cumulativeBarsStart = 0;
  let previousTimeSignature: string | null = null;

  for (const region of authoritativeRegions) {
    const { beatsPerBar } = parseTimeSignature(region.timeSignature);
    const beatFrames = getBeatFrames(region.bpm, region.timeSignature);
    const barFrames = beatFrames * beatsPerBar;
    const beatDurationSeconds = timebaseFramesToSeconds(beatFrames);

    if (previousTimeSignature && previousTimeSignature !== region.timeSignature) {
      cumulativeBarsStart = Math.ceil(cumulativeBarsStart - MUSICAL_POSITION_EPSILON);
    }

    resolvedRegions.push({
      ...region,
      beatsPerBar,
      beatFrames,
      barFrames,
      beatDurationSeconds,
      cumulativeBarsStart,
    });
    cumulativeBarsStart += secondsToTimebaseFrames(region.endSeconds - region.startSeconds) / barFrames;
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
