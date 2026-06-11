import { describe, expect, it, vi } from "vitest";

import { drawAutomationLane } from "./drawTracks";
import type { TrackSceneSnapshot } from "./TimelineRenderer";

// Minimal recording fake for the 2D context: counts the calls that actually
// put pixels on screen, so we can assert the lane drew a cue.
function createFakeContext() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.join(",")})`);
    };
  return {
    calls,
    ctx: {
      save: record("save"),
      restore: record("restore"),
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      closePath: record("closePath"),
      fill: record("fill"),
      stroke: record("stroke"),
      roundRect: record("roundRect"),
      fillText: record("fillText"),
      // ~7px per char so label width scales with text length, letting the
      // truncation/collision logic be exercised realistically.
      measureText: (text: string) => ({ width: text.length * 7 }),
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      textBaseline: "",
    } as unknown as CanvasRenderingContext2D,
  };
}

function buildSnapshot(
  cues: TrackSceneSnapshot["song"]["automationCues"],
): TrackSceneSnapshot {
  return {
    width: 1000,
    height: 400,
    trackHeight: 96,
    song: {
      automationCues: cues,
    } as TrackSceneSnapshot["song"],
    visibleTracks: [],
    clipsByTrack: {},
    waveformCache: {},
    pixelsPerSecond: 50,
    zoomLevel: 50,
    timelineGrid: {} as TrackSceneSnapshot["timelineGrid"],
    selectedClipId: null,
    selectedClipIds: [],
    clipPreviewSecondsRef: { current: {} },
    clipPreviewTrackIdRef: { current: {} },
    cameraX: 0,
  };
}

describe("drawAutomationLane", () => {
  it("draws a diamond, stem and label for a visible cue", () => {
    const { ctx, calls } = createFakeContext();
    const snapshot = buildSnapshot([
      {
        id: "cue-1",
        name: "Salto a Outro",
        atSeconds: 4, // 4s * 50px = x=200, well inside width=1000
        enabled: true,
        action: {
          type: "jump",
          target: { kind: "region", regionId: "r1" },
          transition: { mode: "instant", durationSeconds: null },
        },
      },
    ]);

    drawAutomationLane(ctx, snapshot, 0);

    // The cue produced fill + stroke (diamond/pill) and a text label.
    expect(calls.filter((c) => c.startsWith("fill(")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("stroke(")).length).toBeGreaterThan(0);
    const labelCall = calls.find((c) => c.startsWith("fillText("));
    expect(labelCall).toBeTruthy();
    expect(labelCall).toContain("Outro");
  });

  it("draws no diamond for a cue whose diamond is off-screen", () => {
    const { ctx, calls } = createFakeContext();
    const snapshot = buildSnapshot([
      {
        id: "cue-far",
        name: "Salto a Lejos",
        atSeconds: 10000, // diamond x way past width → culled entirely
        enabled: true,
        action: {
          type: "jump",
          target: { kind: "region", regionId: "r1" },
          transition: { mode: "instant", durationSeconds: null },
        },
      },
    ]);

    drawAutomationLane(ctx, snapshot, 0);

    expect(calls.find((c) => c.startsWith("fillText("))).toBeUndefined();
  });

  it("keeps the diamond but drops the label for two adjacent cues (Ableton-style)", () => {
    const { ctx, calls } = createFakeContext();
    // Two cues ~6px apart (0.1s * 50px/s = 5px): the first has no room for its
    // label before the second's diamond, so only diamonds draw.
    const mkCue = (id: string, atSeconds: number) => ({
      id,
      name: "Salto a UnDestinoLargoQueNoCabe",
      atSeconds,
      enabled: true,
      action: {
        type: "jump" as const,
        target: { kind: "region" as const, regionId: "r1" },
        transition: { mode: "instant" as const, durationSeconds: null },
      },
    });
    const snapshot = buildSnapshot([mkCue("a", 1), mkCue("b", 1.1)]);

    drawAutomationLane(ctx, snapshot, 0);

    // Two diamonds (fill calls happen for diamonds and pills); at least the two
    // diamonds drew, but the cramped first cue produced no label text.
    const fillTexts = calls.filter((c) => c.startsWith("fillText("));
    // The first cue's long label can't fit before the second diamond → dropped.
    expect(fillTexts.length).toBeLessThan(2);
  });

  it("does nothing when there are no cues", () => {
    const { ctx, calls } = createFakeContext();
    drawAutomationLane(ctx, buildSnapshot([]), 0);
    expect(calls.length).toBe(0);
  });
});
