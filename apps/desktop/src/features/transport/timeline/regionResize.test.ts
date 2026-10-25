import { describe, expect, it } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";

import {
  MIN_REGION_DURATION_SECONDS,
  clampRegionResizeEdge,
  regionResizeBounds,
} from "./regionResize";

const region = (id: string, startSeconds: number, endSeconds: number) =>
  ({ id, name: id, startSeconds, endSeconds }) as SongRegionSummary;
const regions = [region("a", 0, 50), region("b", 60, 120), region("c", 130, 200)];

describe("regionResizeBounds", () => {
  it("neighbours are the walls; the last song may grow into the workspace", () => {
    expect(regionResizeBounds(regions, regions[1], [], 3600)).toMatchObject({
      minStartSeconds: 50,
      maxEndSeconds: 130,
    });
    expect(regionResizeBounds(regions, regions[2], [], 3600).maxEndSeconds).toBe(3600);
    expect(regionResizeBounds(regions, regions[0], [], 3600).minStartSeconds).toBe(0);
  });

  it("the song's own clips bound how far it can be trimmed", () => {
    const bounds = regionResizeBounds(
      regions,
      regions[1],
      [
        { timelineStartSeconds: 70, durationSeconds: 20 },
        { timelineStartSeconds: 80, durationSeconds: 30 },
        { timelineStartSeconds: 0, durationSeconds: 10 },
      ],
      3600,
    );
    expect(bounds.clipCeilStartSeconds).toBe(70);
    expect(bounds.clipFloorEndSeconds).toBe(110);
  });
});

describe("clampRegionResizeEdge", () => {
  const free = regionResizeBounds(regions, regions[1], [], 3600);

  it("an end before the start is pushed back to the minimum duration", () => {
    expect(clampRegionResizeEdge("end", 30, free)).toBe(60 + MIN_REGION_DURATION_SECONDS);
  });

  it("a start past the end stops at the minimum duration", () => {
    expect(clampRegionResizeEdge("start", 500, free)).toBe(120 - MIN_REGION_DURATION_SECONDS);
  });

  it("stops at the neighbours", () => {
    expect(clampRegionResizeEdge("start", 10, free)).toBe(50);
    expect(clampRegionResizeEdge("end", 999, free)).toBe(130);
  });

  it("can't trim past the song's audio", () => {
    const withClips = regionResizeBounds(
      regions,
      regions[1],
      [{ timelineStartSeconds: 70, durationSeconds: 40 }],
      3600,
    );
    expect(clampRegionResizeEdge("start", 90, withClips)).toBe(70);
    expect(clampRegionResizeEdge("end", 100, withClips)).toBe(110);
  });
});
