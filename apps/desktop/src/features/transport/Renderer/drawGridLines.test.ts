import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TimelineGrid } from "../timeline/timelineMath";
import { GRID_BAR_ALPHA, drawGridLines } from "./drawBackground";

// Path2D no existe en jsdom: uno minimo que cuenta las lineas.
class FakePath {
  lines: number[] = [];
  moveTo(x: number) {
    this.lines.push(x);
  }
  lineTo() {}
}

function makeContext() {
  const strokes: Array<{ style: string; lines: number[] }> = [];
  let style = "";
  const ctx = {
    set strokeStyle(value: string) {
      style = value;
    },
    set lineWidth(_value: number) {},
    stroke(path: FakePath) {
      strokes.push({ style, lines: path.lines });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, strokes };
}

function grid(overrides: Partial<TimelineGrid> = {}): TimelineGrid {
  return {
    bars: [0, 1, 2, 3, 4, 5, 6, 7],
    barNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
    barLineStep: 1,
    beats: [],
    subdivisions: [],
    markers: [],
    beatsPerBar: 4,
    beatDurationSeconds: 0.25,
    showBeatLabels: false,
    showBeatGridLines: false,
    barLabelStep: 1,
    subdivisionPerBeat: 1,
    snapIntervalSeconds: 0.25,
    visibleStartSeconds: 0,
    visibleEndSeconds: 8,
    ...overrides,
  };
}

const original = (globalThis as Record<string, unknown>).Path2D;
beforeEach(() => {
  (globalThis as Record<string, unknown>).Path2D = FakePath;
});
afterEach(() => {
  (globalThis as Record<string, unknown>).Path2D = original;
});

describe("drawGridLines", () => {
  it("con barLineStep 4 solo dibuja los compases 1, 5, 9…", () => {
    const { ctx, strokes } = makeContext();
    drawGridLines(ctx, grid({ barLineStep: 4 }), 1000, 100, 0, 100);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].lines).toEqual([0.5, 400.5]);
  });

  it("la intensidad multiplica la opacidad de las lineas", () => {
    const { ctx, strokes } = makeContext();
    drawGridLines(ctx, grid({ lineIntensity: 0.5 }), 1000, 100, 0, 100);
    expect(strokes[0].style).toBe(`rgba(186, 202, 197, ${GRID_BAR_ALPHA * 0.5})`);
  });

  it("con intensidad 0 no dibuja nada", () => {
    const { ctx, strokes } = makeContext();
    drawGridLines(ctx, grid({ lineIntensity: 0 }), 1000, 100, 0, 100);
    expect(strokes).toHaveLength(0);
  });
});
