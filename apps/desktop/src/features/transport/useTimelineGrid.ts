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

function buildGridMarks(durationSeconds: number, beatDuration: number, beatsPerBar: number) {
  const bars: number[] = [];
  const beats: number[] = [];
  const markers: TimelineGrid["markers"] = [];

  const totalBeats = Math.ceil(durationSeconds / beatDuration);

  for (let beatIndex = 0; beatIndex <= totalBeats; beatIndex += 1) {
    const seconds = beatIndex * beatDuration;
    if (seconds > durationSeconds + 0.0001) {
      break;
    }

    const barNumber = Math.floor(beatIndex / beatsPerBar) + 1;
    const beatInBar = (beatIndex % beatsPerBar) + 1;
    const isBarStart = beatInBar === 1;

    markers.push({ seconds, barNumber, beatInBar, isBarStart });

    if (isBarStart) {
      bars.push(seconds);
      continue;
    }

    beats.push(seconds);
  }

  return { bars, beats, markers };
}

export function snapToTimelineGrid(
  seconds: number,
  bpm: number,
  timeSignature: string,
  zoomLevel: number,
  pixelsPerSecond: number,
) {
  const safeBpm = clampPositive(bpm, 120);
  const { beatUnit } = parseTimeSignature(timeSignature);
  const quarterNoteSeconds = 60 / safeBpm;
  const beatDuration = quarterNoteSeconds * (4 / beatUnit);
  const snapIntervalSeconds = beatDuration;

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
    const barPixels = beatPixels * beatsPerBar;
    const subdivisionPerBeat = 1;
    const snapIntervalSeconds = beatDuration;
    const showBeatLabels = beatPixels >= 78 && zoomLevel >= 6.5;
    const showBeatGridLines = beatPixels >= 16;
    const barLabelStep =
      showBeatLabels ? 1 : barPixels >= 240 ? 1 : barPixels >= 120 ? 2 : barPixels >= 64 ? 4 : 8;

    const marks = buildGridMarks(
      safeDuration,
      beatDuration,
      beatsPerBar,
    );

    return {
      bars: marks.bars,
      beats: marks.beats,
      subdivisions: [],
      markers: marks.markers,
      beatsPerBar,
      beatDurationSeconds: beatDuration,
      showBeatLabels,
      showBeatGridLines,
      barLabelStep,
      subdivisionPerBeat,
      snapIntervalSeconds,
    };
  }, [durationSeconds, bpm, timeSignature, zoomLevel, pixelsPerSecond]);
}
