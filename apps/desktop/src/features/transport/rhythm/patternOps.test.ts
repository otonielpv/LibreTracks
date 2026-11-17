// Mismos casos que crates/libretracks-core/src/drum_loops_tests.rs.
import { describe, expect, it } from "vitest";

import type { DrumKit, LoopPattern } from "@libretracks/shared/models";

import {
  clearRow,
  copyVariation,
  cycleVelocity,
  normalizePattern,
  paintSteps,
  resizeBars,
  setStepsPerBeat,
  STEP_ACCENT,
  STEP_NORMAL,
  STEP_SOFT,
  stepCount,
  toggleStep,
} from "./patternOps";

function kit(ids: string[]): DrumKit {
  return {
    id: "kit",
    name: "Kit",
    sounds: ids.map((id) => ({
      id,
      name: id,
      color: "#f00",
      sample: { source: { kind: "builtin" }, file: `${id}.wav` },
      gainDb: 0,
    })),
  };
}

function pattern(ids: string[]): LoopPattern {
  return {
    id: "p1",
    name: "Pop",
    kit: { kind: "embedded", kit: kit(ids) },
    bpm: 92,
    signature: { numerator: 4, denominator: 4 },
    stepsPerBeat: 4,
    bars: 1,
    swing: 0,
    rows: ids.map((id) => ({ soundId: id, gainDb: 0, variations: [[], [], [], []].map(() => new Array(16).fill(0)) })),
  };
}

describe("patternOps normalize", () => {
  it("caps kit rows at eight and variations at four", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const p = pattern(ids);
    p.rows[0].variations = [[1], [1], [1], [1], [1], [1]];
    const n = normalizePattern(p);
    expect(n.rows).toHaveLength(8);
    expect(n.rows[0].variations).toHaveLength(4);
    expect(n.rows[0].variations[0]).toHaveLength(16);
  });

  it("fits step count to bars and signature and caps at 64", () => {
    const p = pattern(["a"]);
    p.signature = { numerator: 7, denominator: 4 };
    p.bars = 4;
    const n = normalizePattern(p);
    expect(n.bars).toBe(2);
    expect(stepCount(n)).toBe(56);
    expect(n.rows[0].variations[0]).toHaveLength(56);
  });

  it("drops rows with unknown sounds and clamps swing, bpm and velocity", () => {
    const p = pattern(["a"]);
    p.rows.push({ soundId: "ghost", gainDb: 0, variations: [] });
    p.rows[0].variations[0][0] = 9;
    p.swing = 2;
    p.bpm = 500;
    const n = normalizePattern(p);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].variations[0][0]).toBe(3);
    expect(n.swing).toBe(0.75);
    expect(n.bpm).toBe(300);
  });
});

describe("patternOps editing", () => {
  it("toggle switches off and normal", () => {
    let p = toggleStep(pattern(["a"]), 0, 1, 5);
    expect(p.rows[0].variations[1][5]).toBe(STEP_NORMAL);
    p = toggleStep(p, 0, 1, 5);
    expect(p.rows[0].variations[1][5]).toBe(0);
    expect(toggleStep(p, 0, 1, 99)).toBe(p);
  });

  it("cycle goes normal, accent, soft, normal", () => {
    let p = pattern(["a"]);
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      p = cycleVelocity(p, 0, 0, 0);
      seen.push(p.rows[0].variations[0][0]);
    }
    expect(seen).toEqual([STEP_NORMAL, STEP_ACCENT, STEP_SOFT, STEP_NORMAL]);
  });

  it("paint fills a range and returns the same object when nothing changes", () => {
    const p = paintSteps(pattern(["a"]), 0, 2, 4, 8, 3);
    expect(p.rows[0].variations[2].slice(3, 9)).toEqual([0, 3, 3, 3, 3, 0]);
    expect(paintSteps(p, 0, 2, 4, 8, 3)).toBe(p);
  });

  it("copy variation and clear row", () => {
    let p = toggleStep(pattern(["a", "b"]), 1, 0, 4);
    p = copyVariation(p, 0, 3);
    expect(p.rows[1].variations[3][4]).toBe(STEP_NORMAL);
    p = clearRow(p, 1);
    expect(p.rows[1].variations.every((v) => v.every((s) => s === 0))).toBe(true);
  });

  it("resize bars 1 to 4 repeats and 4 to 2 truncates", () => {
    let p = toggleStep(toggleStep(pattern(["a"]), 0, 0, 0), 0, 0, 6);
    const oneBar = p.rows[0].variations[0].slice();
    p = resizeBars(p, 4);
    expect(p.rows[0].variations[0]).toHaveLength(64);
    for (let bar = 0; bar < 4; bar += 1) {
      expect(p.rows[0].variations[0].slice(bar * 16, bar * 16 + 16)).toEqual(oneBar);
    }
    p = resizeBars(toggleStep(p, 0, 0, 40), 2);
    expect(p.rows[0].variations[0]).toHaveLength(32);
    expect(p.rows[0].variations[0].slice(16)).toEqual(oneBar);
  });

  it("steps per beat 4 to 3 converts and warns when inexact", () => {
    let p = pattern(["a"]);
    for (const step of [0, 4, 8, 12]) p = toggleStep(p, 0, 0, step);
    const exact = setStepsPerBeat(p, 3);
    expect(exact.movedSteps).toBe(0);
    expect(exact.pattern.rows[0].variations[0]).toHaveLength(12);
    expect(
      exact.pattern.rows[0].variations[0].flatMap((v, i) => (v > 0 ? [i] : [])),
    ).toEqual([0, 3, 6, 9]);
    const inexact = setStepsPerBeat(toggleStep(p, 0, 0, 2), 3);
    expect(inexact.movedSteps).toBe(1);
    expect(inexact.pattern.rows[0].variations[0][2]).toBeGreaterThan(0);
  });
});
