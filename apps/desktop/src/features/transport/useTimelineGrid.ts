import { useMemo } from "react";

type TimelineGridParams = {
  durationSeconds: number;
  bpm: number;
  timeSignature: string;
  zoomLevel: number;
  pixelsPerSecond: number;
};

type TimelineGrid = {
  bars: number[];
  beats: number[];
  subdivisions: number[];
  subdivisionPerBeat: number;
  snapIntervalSeconds: number;
};

function clampPositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseTimeSignature(timeSignature: string) {
  const [numeratorRaw, denominatorRaw] = timeSignature.split("/");
  const beatsPerBar = Math.max(1, Number.parseInt(numeratorRaw ?? "4", 10) || 4);
  const beatUnit = Math.max(1, Number.parseInt(denominatorRaw ?? "4", 10) || 4);
  return { beatsPerBar, beatUnit };
}

function resolveSubdivisionPerBeat(zoomLevel: number, beatPixels: number) {
  if (zoomLevel >= 20 || beatPixels >= 170) {
    return 8;
  }

  if (zoomLevel >= 10 || beatPixels >= 90) {
    return 4;
  }

  if (zoomLevel >= 5 || beatPixels >= 46) {
    return 2;
  }

  return 1;
}

function buildGridMarks(durationSeconds: number, beatDuration: number, beatsPerBar: number, subdivisionPerBeat: number) {
  const bars: number[] = [];
  const beats: number[] = [];
  const subdivisions: number[] = [];

  const totalSubdivisions = Math.ceil(
    durationSeconds / (beatDuration / subdivisionPerBeat),
  );

  for (let subdivisionIndex = 0; subdivisionIndex <= totalSubdivisions; subdivisionIndex += 1) {
    const seconds = subdivisionIndex * (beatDuration / subdivisionPerBeat);
    if (seconds > durationSeconds + 0.0001) {
      break;
    }

    const beatIndex = Math.floor(subdivisionIndex / subdivisionPerBeat);
    const withinBeatSubdivision = subdivisionIndex % subdivisionPerBeat;

    if (withinBeatSubdivision === 0) {
      if (beatIndex % beatsPerBar === 0) {
        bars.push(seconds);
      } else {
        beats.push(seconds);
      }
      continue;
    }

    subdivisions.push(seconds);
  }

  return { bars, beats, subdivisions };
}

export function snapToTimelineGrid(
  seconds: number,
  bpm: number,
  timeSignature: string,
  zoomLevel: number,
  pixelsPerSecond: number,
) {
  const safeBpm = clampPositive(bpm, 120);
  const safePixelsPerSecond = clampPositive(pixelsPerSecond, 1);
  const { beatUnit } = parseTimeSignature(timeSignature);
  const quarterNoteSeconds = 60 / safeBpm;
  const beatDuration = quarterNoteSeconds * (4 / beatUnit);
  const beatPixels = beatDuration * safePixelsPerSecond;
  const subdivisionPerBeat = resolveSubdivisionPerBeat(zoomLevel, beatPixels);
  const snapIntervalSeconds = beatDuration / subdivisionPerBeat;

  return Math.round(seconds / snapIntervalSeconds) * snapIntervalSeconds;
}

export function useTimelineGrid({
  durationSeconds,
  bpm,
  timeSignature,
  zoomLevel,
  pixelsPerSecond,
}: TimelineGridParams): TimelineGrid {
  return useMemo(() => {
    const safeDuration = Math.max(0, durationSeconds);
    const safeBpm = clampPositive(bpm, 120);
    const safePixelsPerSecond = clampPositive(pixelsPerSecond, 1);
    const { beatsPerBar, beatUnit } = parseTimeSignature(timeSignature);
    const quarterNoteSeconds = 60 / safeBpm;
    const beatDuration = quarterNoteSeconds * (4 / beatUnit);
    const beatPixels = beatDuration * safePixelsPerSecond;
    const subdivisionPerBeat = resolveSubdivisionPerBeat(zoomLevel, beatPixels);
    const snapIntervalSeconds = beatDuration / subdivisionPerBeat;

    const marks = buildGridMarks(
      safeDuration,
      beatDuration,
      beatsPerBar,
      subdivisionPerBeat,
    );

    return {
      bars: marks.bars,
      beats: marks.beats,
      subdivisions: marks.subdivisions,
      subdivisionPerBeat,
      snapIntervalSeconds,
    };
  }, [durationSeconds, bpm, timeSignature, zoomLevel, pixelsPerSecond]);
}
