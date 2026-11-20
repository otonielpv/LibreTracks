import { describe, expect, it, vi } from "vitest";

import type { SongView, TrackEq, TrackSummary } from "../desktopApi";

const api = vi.hoisted(() => ({
  commitTrackEqChange: vi.fn(async () => ({ projectRevision: 3 })),
  commitTrackEqsChange: vi.fn(async (_args: { changes: { trackId: string; eq: TrackEq | null }[] }) => ({
    projectRevision: 4,
  })),
}));

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  commitTrackEqChange: api.commitTrackEqChange,
  commitTrackEqsChange: api.commitTrackEqsChange,
}));

import { defaultTrackEq } from "@libretracks/shared/eq/trackEqModel";
import { createTimelineMenus, type TimelineMenuDeps } from "./timelineMenus";

const sourceEq = (() => {
  const eq = defaultTrackEq();
  eq.bands[2].gainDb = 6;
  return eq;
})();

function track(id: string, kind: "audio" | "folder" | "midi", eq: TrackEq | null = null): TrackSummary {
  return { id, name: id.toUpperCase(), kind, eq, parentTrackId: null } as unknown as TrackSummary;
}

const tracks = [track("voz", "audio", sourceEq), track("bajo", "audio"), track("gtr", "audio"), track("banda", "folder"), track("luces", "midi")];
const song = { tracks, regions: [] } as unknown as SongView;

function menus() {
  const deps = {
    t: ((key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key) as never,
    songRef: { current: song },
    song,
    runAction: vi.fn(async (work: () => Promise<void>) => work()),
    applyPlaybackSnapshot: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
    shortcutHint: () => undefined,
  } as unknown as TimelineMenuDeps;
  return { deps, ...createTimelineMenus(() => deps) };
}

describe("copy EQ to the selected tracks", () => {
  it("copies the clicked track's curve to the other audio tracks with one call", async () => {
    const { multiTrackContextMenu, deps } = menus();
    const actions = multiTrackContextMenu(tracks, tracks[0]);
    const copy = actions.find((action) => action.label === "eq.copyToSelected:VOZ");
    expect(copy).toBeTruthy();
    await copy!.onSelect?.();
    expect(api.commitTrackEqsChange).toHaveBeenCalledTimes(1);
    const { changes } = api.commitTrackEqsChange.mock.calls[0][0];
    // Las carpetas también llevan EQ (plan track-eq-2, paso 08); MIDI no.
    expect(changes.map((change) => change.trackId)).toEqual(["bajo", "gtr", "banda"]);
    expect(changes.every((change) => change.eq?.bands[2].gainDb === 6)).toBe(true);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledTimes(1);
  });

  it("is not offered from a MIDI track or without other tracks that take an eq", () => {
    const { multiTrackContextMenu } = menus();
    const labels = (list: ReturnType<typeof multiTrackContextMenu>) => list.map((a) => a.label);
    expect(labels(multiTrackContextMenu(tracks, tracks[4])).some((l) => l?.startsWith("eq.copy"))).toBe(false);
    expect(
      labels(multiTrackContextMenu([tracks[0], tracks[4]], tracks[0])).some((l) => l?.startsWith("eq.copy")),
    ).toBe(false);
  });
});
