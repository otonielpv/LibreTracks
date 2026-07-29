import { describe, expect, it, vi } from "vitest";

import { createMarkerMoveHandlers } from "./markerMoveHandlers";
import type {
  AutomationCueSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

function cue(
  id: string,
  atSeconds: number,
  extra: Partial<AutomationCueSummary> = {},
): AutomationCueSummary {
  return {
    id,
    name: id,
    atSeconds,
    enabled: true,
    maxRuns: null,
    exhausted: false,
    actions: [],
    ...extra,
  } as AutomationCueSummary;
}

/**
 * The handlers only need `automationCues` / `sectionMarkers`; the rest of the
 * song view is irrelevant to the move commit.
 */
function songWith(cues: AutomationCueSummary[]): SongView {
  return {
    sectionMarkers: [],
    automationCues: cues,
  } as unknown as SongView;
}

function setup(initialCues: AutomationCueSummary[]) {
  // Mirrors the backend: cues are re-sorted by position on every upsert, and
  // the refreshed song view is what the next drag reads from.
  let song = songWith(initialCues);
  const upsertAutomationCue = vi.fn(async (next: AutomationCueSummary) => {
    const rest = (song.automationCues ?? []).filter(
      (candidate) => candidate.id !== next.id,
    );
    song = songWith(
      [...rest, next].sort((left, right) => left.atSeconds - right.atSeconds),
    );
    return {} as TransportSnapshot;
  });

  const handlers = createMarkerMoveHandlers({
    getSong: () => song,
    runAction: (action) => action(),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => song),
    updateSectionMarker: vi.fn(async () => ({}) as TransportSnapshot),
    upsertAutomationCue,
    getEditAutomationCue: () => vi.fn(),
  });

  return { handlers, upsertAutomationCue, getSong: () => song };
}

describe("handleAutomationCueMoveCommit", () => {
  it("persists a cue move", async () => {
    const { handlers, upsertAutomationCue, getSong } = setup([cue("a", 1)]);

    handlers.handleAutomationCueMoveCommit("a", 5);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalled());

    expect(upsertAutomationCue).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", atSeconds: 5 }),
    );
    expect(getSong().automationCues?.[0]?.atSeconds).toBe(5);
  });

  it("moves the same cue again after a first move", async () => {
    // Regression: a cue could only be dragged once per session. The commit
    // refreshes the song view and the backend re-sorts cues, so the diamond's
    // DOM node is replaced and never fires the synthetic click that used to be
    // the only thing resetting the "did drag" latch.
    const { handlers, upsertAutomationCue, getSong } = setup([cue("a", 1)]);

    handlers.handleAutomationCueMoveCommit("a", 5);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalledTimes(1));

    handlers.handleAutomationCueMoveCommit("a", 9);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalledTimes(2));

    expect(getSong().automationCues?.[0]?.atSeconds).toBe(9);
  });

  it("keeps the cue's other fields across a move", async () => {
    const { handlers, upsertAutomationCue } = setup([
      cue("a", 1, { name: "Chorus jump", enabled: false, maxRuns: 2 }),
    ]);

    handlers.handleAutomationCueMoveCommit("a", 4);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalled());

    expect(upsertAutomationCue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Chorus jump",
        enabled: false,
        maxRuns: 2,
        atSeconds: 4,
      }),
    );
  });

  it("moves a cue that the backend re-sorted past its neighbour", async () => {
    // After dragging "a" beyond "b", the cue list order changes. The next drag
    // must still find "a" by id rather than by position.
    const { handlers, upsertAutomationCue, getSong } = setup([
      cue("a", 1),
      cue("b", 3),
    ]);

    handlers.handleAutomationCueMoveCommit("a", 7);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalledTimes(1));
    expect(getSong().automationCues?.map((c) => c.id)).toEqual(["b", "a"]);

    handlers.handleAutomationCueMoveCommit("a", 2);
    await vi.waitFor(() => expect(upsertAutomationCue).toHaveBeenCalledTimes(2));

    expect(getSong().automationCues?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(
      getSong().automationCues?.find((c) => c.id === "a")?.atSeconds,
    ).toBe(2);
  });
});
