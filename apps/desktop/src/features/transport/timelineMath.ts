export const BASE_PIXELS_PER_SECOND = 18;
export const TIMELINE_TIMEBASE_HZ = 48_000;
export const TIMELINE_ZOOM_MULTIPLIER = 1.15;
export const TIMELINE_WORKSPACE_TAIL_SECONDS = 3600;

export type TimelineGridParams = {
  durationSeconds: number;
  bpm: number;
  timeSignature: string;
  zoomLevel: number;
  pixelsPerSecond: number;
  viewportStartSeconds: number;
  viewportEndSeconds: number;
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

export function getMusicalPosition(
  seconds: number,
  bpm: number,
  timeSignature: string,
  timebaseHz = TIMELINE_TIMEBASE_HZ,
): MusicalPosition {
  const { beatsPerBar } = parseTimeSignature(timeSignature);
  const beatFrames = getBeatFrames(bpm, timeSignature, timebaseHz);
  const totalFrames = secondsToTimebaseFrames(seconds, timebaseHz);
  const totalWholeBeats = Math.floor(totalFrames / beatFrames);
  const beatOffsetFrames = totalFrames - totalWholeBeats * beatFrames;
  const barNumber = Math.floor(totalWholeBeats / beatsPerBar) + 1;
  const beatInBar = (totalWholeBeats % beatsPerBar) + 1;
  const subBeat = Math.min(99, Math.floor((beatOffsetFrames * 100) / beatFrames));

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
  const { beatsPerBar } = parseTimeSignature(params.timeSignature);
  const beatFrames = getBeatFrames(params.bpm, params.timeSignature);
  const beatDuration = timebaseFramesToSeconds(beatFrames);
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
  const safeDurationFrames = secondsToTimebaseFrames(safeDuration);
  const visibleStartFrames = secondsToTimebaseFrames(visibleStartSeconds);
  const visibleEndFrames = secondsToTimebaseFrames(visibleEndSeconds);
  const startBeatIndex = Math.max(0, Math.floor(visibleStartFrames / beatFrames) - 1);
  const endBeatIndex = Math.max(
    startBeatIndex,
    Math.ceil(visibleEndFrames / beatFrames) + 1,
  );

  const bars: number[] = [];
  const beats: number[] = [];
  const markers: TimelineGrid["markers"] = [];

  for (let beatIndex = startBeatIndex; beatIndex <= endBeatIndex; beatIndex += 1) {
    const frame = beatIndex * beatFrames;
    if (frame < visibleStartFrames - beatFrames || frame > safeDurationFrames + beatFrames) {
      continue;
    }
    const seconds = timebaseFramesToSeconds(frame);

    const barNumber = Math.floor(beatIndex / beatsPerBar) + 1;
    const beatInBar = (beatIndex % beatsPerBar) + 1;
    const isBarStart = beatInBar === 1;

    markers.push({ seconds, barNumber, beatInBar, isBarStart });

    if (isBarStart) {
      bars.push(seconds);
    } else {
      beats.push(seconds);
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
) {
  const beatFrames = getBeatFrames(bpm, timeSignature);
  const positionFrames = secondsToTimebaseFrames(seconds);
  return timebaseFramesToSeconds(Math.round(positionFrames / beatFrames) * beatFrames);
}
