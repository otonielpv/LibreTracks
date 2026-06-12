import { describe, expect, it } from "vitest";

import {
  calculateTapTempoBpm,
  filterOutputChannelsForOutputCount,
  isAudioDeviceVisibleForBackend,
  nextTapTempoTimes,
  normalizeEnabledOutputChannelsForOutputCount,
  selectNativeDropCandidate,
  type NativeDropCandidateDebug,
  type NativeDropCoordinateMode,
} from "./TransportPanelContent";
import { buildAudioRoutingOptions } from "./helpers";
import {
  buildTimelineDropPreviewGeometry,
  resolveExternalDropGuideLeft,
} from "./dragDrop";

function candidate(
  label: NativeDropCoordinateMode,
  overrides: Partial<NativeDropCandidateDebug> = {},
): NativeDropCandidateDebug {
  return {
    label,
    clientX: 100,
    clientY: 80,
    elementFromPoint: ".lt-track-lane",
    laneBounds: null,
    rulerBounds: null,
    dropSeconds: 4,
    rawSeconds: 4,
    snappedSeconds: 4,
    rawLeftPx: 100,
    rawClientX: 100,
    snappedLeftPx: 100,
    snappedClientX: 100,
    previewLeftPx: 100,
    previewClientX: 100,
    rawDeltaPx: 0,
    snapDeltaPx: 0,
    snapApplied: false,
    score: 100,
    isOverTimeline: true,
    targetTrackId: null,
    ...overrides,
  };
}

describe("selectNativeDropCandidate", () => {
  it("selects raw/dpr when raw is over the timeline but raw/dpr has the smaller raw delta", () => {
    const selected = selectNativeDropCandidate([
      candidate("raw", {
        rawClientX: 126,
        rawDeltaPx: 26,
        score: 300,
      }),
      candidate("raw/dpr", {
        rawClientX: 101,
        rawDeltaPx: 1,
        score: 120,
      }),
    ]);

    expect(selected?.label).toBe("raw/dpr");
  });

  it("does not select candidates outside the timeline", () => {
    const selected = selectNativeDropCandidate([
      candidate("raw", {
        isOverTimeline: false,
        dropSeconds: null,
        rawLeftPx: null,
        rawClientX: null,
        rawDeltaPx: null,
        score: 0,
      }),
      candidate("raw/dpr", {
        isOverTimeline: false,
        dropSeconds: 4,
      }),
    ]);

    expect(selected).toBeNull();
  });

  it("uses score as the tiebreaker when candidates have the same visual delta", () => {
    const selected = selectNativeDropCandidate([
      candidate("raw", {
        rawClientX: 104,
        rawDeltaPx: 4,
        score: 220,
      }),
      candidate("raw/dpr", {
        rawClientX: 96,
        rawDeltaPx: 4,
        score: 340,
      }),
    ]);

    expect(selected?.label).toBe("raw/dpr");
  });

  it("selects by raw pointer alignment, not snapped preview alignment", () => {
    const selected = selectNativeDropCandidate([
      candidate("raw", {
        clientX: 620,
        rawClientX: 600,
        previewClientX: 624,
        rawDeltaPx: 20,
        snapDeltaPx: 4,
        score: 500,
        snapApplied: true,
      }),
      candidate("raw/dpr", {
        clientX: 620,
        rawClientX: 620.3,
        previewClientX: 644,
        rawDeltaPx: 0.3,
        snapDeltaPx: 24,
        score: 300,
        snapApplied: true,
      }),
    ]);

    expect(selected?.label).toBe("raw/dpr");
  });
});

describe("isAudioDeviceVisibleForBackend", () => {
  it("does not show ASIO devices while audio system is System Default", () => {
    expect(isAudioDeviceVisibleForBackend({ backend: "asio" }, null)).toBe(false);
    expect(isAudioDeviceVisibleForBackend({ backend: "wasapi" }, null)).toBe(true);
  });

  it("shows ASIO devices only when ASIO is explicitly selected", () => {
    expect(isAudioDeviceVisibleForBackend({ backend: "asio" }, "asio")).toBe(true);
    expect(isAudioDeviceVisibleForBackend({ backend: "wasapi" }, "asio")).toBe(false);
  });
});

describe("output channel routing helpers", () => {
  it("drops channels that are not available on the selected output device", () => {
    expect(
      filterOutputChannelsForOutputCount([0, 1, 2, 3, 63], 2),
    ).toEqual([0, 1]);
  });

  it("falls back to the first available outputs when a device change leaves no valid channels", () => {
    expect(normalizeEnabledOutputChannelsForOutputCount([8, 9], 2)).toEqual([
      0, 1,
    ]);
    expect(normalizeEnabledOutputChannelsForOutputCount([8, 9], 1)).toEqual([
      0,
    ]);
  });

  it("builds track routing options only from channels active on the current device", () => {
    const t = (_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? "");
    const activeChannels = normalizeEnabledOutputChannelsForOutputCount(
      Array.from({ length: 64 }, (_, index) => index),
      2,
    );

    expect(
      buildAudioRoutingOptions(activeChannels, t).map(
        (option) => option.value,
      ),
    ).toEqual(["master", "ext:0-1", "ext:0", "ext:1"]);
  });
});

describe("tap tempo helpers", () => {
  it("calculates BPM from the average tap interval", () => {
    expect(calculateTapTempoBpm([0, 500, 1000, 1500])).toBeCloseTo(120);
    expect(calculateTapTempoBpm([0, 600, 1200])).toBeCloseTo(100);
  });

  it("requires at least two taps", () => {
    expect(calculateTapTempoBpm([])).toBeNull();
    expect(calculateTapTempoBpm([1000])).toBeNull();
  });

  it("resets a tap run after a long pause and keeps only recent taps", () => {
    expect(nextTapTempoTimes([0, 500], 3201)).toEqual([3201]);

    const taps = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500];
    expect(nextTapTempoTimes(taps, 4000)).toEqual([
      500, 1000, 1500, 2000, 2500, 3000, 3500, 4000,
    ]);
  });
});

describe("resolveExternalDropGuideLeft", () => {
  it("converts previewClientX to the local origin of the rendered guide container", () => {
    expect(
      resolveExternalDropGuideLeft(
        {
          kind: "audio",
          seconds: 10,
          previewLeftPx: 240,
          previewClientX: 620,
        },
        { left: 300 },
        180,
      ),
    ).toBe(320);
  });

  it("converts previewClientX through CSS zoomed guide bounds", () => {
    expect(
      resolveExternalDropGuideLeft(
        {
          kind: "audio",
          seconds: 10,
          previewLeftPx: 240,
          previewClientX: 240,
        },
        { left: 80, width: 800, layoutWidth: 1000 },
        180,
      ),
    ).toBe(200);
  });

  it("uses the rounded timeline seconds fallback for snapped previews", () => {
    expect(
      resolveExternalDropGuideLeft(
        {
          kind: "audio",
          seconds: 10,
          previewLeftPx: 241.8,
          previewClientX: 620,
          snapApplied: true,
        },
        { left: 300 },
        241.3,
      ),
    ).toBe(241);
  });
});

describe("buildTimelineDropPreviewGeometry", () => {
  it("uses raw seconds and raw client position when snap is disabled", () => {
    const geometry = buildTimelineDropPreviewGeometry({
      clientX: 123.4,
      viewportLeft: 100,
      viewportWidth: 500,
      cameraX: 0,
      pixelsPerSecond: 10,
      snappedSeconds: 5,
      snapEnabled: false,
    });

    expect(geometry.rawSeconds).toBeCloseTo(2.34);
    expect(geometry.dropSeconds).toBe(geometry.rawSeconds);
    expect(geometry.previewClientX).toBeCloseTo(123.4);
  });

  it("uses snapped seconds and snapped client position when snap is enabled", () => {
    const geometry = buildTimelineDropPreviewGeometry({
      clientX: 123.4,
      viewportLeft: 100,
      viewportWidth: 500,
      cameraX: 0,
      pixelsPerSecond: 10,
      snappedSeconds: 2.5,
      snapEnabled: true,
    });

    expect(geometry.rawSeconds).toBeCloseTo(2.34);
    expect(geometry.dropSeconds).toBe(2.5);
    expect(geometry.previewClientX).toBeCloseTo(125);
    expect(geometry.previewLeftPx).toBe(25);
  });

  it("normalizes drop geometry through CSS zoomed viewport bounds", () => {
    const geometry = buildTimelineDropPreviewGeometry({
      clientX: 240,
      viewportLeft: 80,
      viewportWidth: 800,
      viewportLayoutWidth: 1000,
      cameraX: 0,
      pixelsPerSecond: 10,
      snappedSeconds: 25,
      snapEnabled: false,
    });

    expect(geometry.viewportX).toBeCloseTo(200);
    expect(geometry.rawSeconds).toBeCloseTo(20);
    expect(geometry.previewLeftPx).toBeCloseTo(200);
    expect(geometry.previewClientX).toBeCloseTo(240);
  });
});
