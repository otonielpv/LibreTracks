import { describe, expect, it } from "vitest";

import type { TrackSummary } from "@libretracks/shared/models";

import { AUTOMATION_TRACK_ID } from "../library/pendingAudioImports";
import { applyTrackMoves, planTrackDrop, previewRowOrder } from "./trackMovePlan";

const track = (
  id: string,
  parentTrackId: string | null = null,
  extra: Partial<TrackSummary> = {},
): TrackSummary =>
  ({ id, name: id, kind: "audio", parentTrackId, ...extra }) as TrackSummary;

// drums, F(folder){ f1, f2 }, bass, keys
const tracks = [
  track("drums"),
  track("F", null, { kind: "folder" }),
  track("f1", "F"),
  track("f2", "F"),
  track("bass"),
  track("keys"),
];
const ids = (list: TrackSummary[]) => list.map((entry) => entry.id);

function plan(
  draggedTrackId: string,
  drop: { targetTrackId: string; mode: "before" | "after" | "inside-folder" },
  selectedTrackIds: string[] = [],
  list: TrackSummary[] = tracks,
) {
  return planTrackDrop({
    tracks: list,
    visibleTrackIds: ids(list),
    selectedTrackIds,
    draggedTrackId,
    drop,
  });
}

function result(...args: Parameters<typeof plan>) {
  const p = args[3] ?? tracks;
  const planned = plan(...args);
  if (planned?.kind !== "tracks") return null;
  return ids(applyTrackMoves(p, planned.moves));
}

describe("planTrackDrop + applyTrackMoves", () => {
  it("a folder moves with its contents, and 'after' means after the whole folder", () => {
    expect(result("drums", { targetTrackId: "F", mode: "after" })).toEqual([
      "F", "f1", "f2", "drums", "bass", "keys",
    ]);
    expect(result("F", { targetTrackId: "keys", mode: "after" })).toEqual([
      "drums", "bass", "keys", "F", "f1", "f2",
    ]);
  });

  it("drops inside a folder at the end of its contents", () => {
    const moved = applyTrackMoves(
      tracks,
      (plan("keys", { targetTrackId: "F", mode: "inside-folder" }) as {
        kind: "tracks";
        moves: Parameters<typeof applyTrackMoves>[1];
      }).moves,
    );
    expect(ids(moved)).toEqual(["drums", "F", "f1", "f2", "keys", "bass"]);
    expect(moved.find((entry) => entry.id === "keys")?.parentTrackId).toBe("F");
  });

  it("a multi-selection keeps its on-screen order whatever the mode", () => {
    // Seleccionadas en orden inverso al de pantalla.
    const selection = ["keys", "drums"];
    expect(result("drums", { targetTrackId: "bass", mode: "after" }, selection)).toEqual([
      "F", "f1", "f2", "bass", "drums", "keys",
    ]);
    expect(result("drums", { targetTrackId: "F", mode: "before" }, selection)).toEqual([
      "drums", "keys", "F", "f1", "f2", "bass",
    ]);
  });

  it("a selected track inside a selected folder travels with the folder", () => {
    const planned = plan("F", { targetTrackId: "keys", mode: "after" }, ["F", "f1"]);
    expect(planned).toEqual({
      kind: "tracks",
      moves: [expect.objectContaining({ trackId: "F" })],
    });
  });

  it("dropping on itself changes nothing", () => {
    expect(plan("bass", { targetTrackId: "bass", mode: "after" })).toBeNull();
  });

  it("the automation lane only records which track it follows", () => {
    expect(
      planTrackDrop({
        tracks,
        visibleTrackIds: [AUTOMATION_TRACK_ID, ...ids(tracks)],
        selectedTrackIds: [],
        draggedTrackId: AUTOMATION_TRACK_ID,
        drop: { targetTrackId: "bass", mode: "before" },
      }),
    ).toEqual({ kind: "automation", afterTrackId: "f2" });
  });
});

describe("previewRowOrder", () => {
  it("shows the rows in the order the drop will leave them", () => {
    expect(
      previewRowOrder({
        tracks,
        rowIds: ids(tracks),
        plan: plan("keys", { targetTrackId: "drums", mode: "before" }),
        automationAfterTrackId: null,
      }),
    ).toEqual(["keys", "drums", "F", "f1", "f2", "bass"]);
  });

  it("a track dropped into a collapsed folder disappears from view", () => {
    const collapsed = tracks.map((entry) =>
      entry.id === "F" ? { ...entry, collapsed: true } : entry,
    );
    expect(
      previewRowOrder({
        tracks: collapsed,
        rowIds: ["drums", "F", "bass", "keys"],
        plan: plan("keys", { targetTrackId: "F", mode: "inside-folder" }, [], collapsed),
        automationAfterTrackId: null,
      }),
    ).toEqual(["drums", "F", "bass"]);
  });

  it("the automation lane stays after its track, or moves when dragged", () => {
    const rowIds = ["drums", AUTOMATION_TRACK_ID, "F", "f1", "f2", "bass", "keys"];
    expect(
      previewRowOrder({
        tracks,
        rowIds,
        plan: plan("drums", { targetTrackId: "keys", mode: "after" }),
        automationAfterTrackId: "drums",
      }),
    ).toEqual(["F", "f1", "f2", "bass", "keys", "drums", AUTOMATION_TRACK_ID]);
    expect(
      previewRowOrder({
        tracks,
        rowIds,
        plan: { kind: "automation", afterTrackId: null },
        automationAfterTrackId: "drums",
      }),
    ).toEqual([AUTOMATION_TRACK_ID, "drums", "F", "f1", "f2", "bass", "keys"]);
  });
});
