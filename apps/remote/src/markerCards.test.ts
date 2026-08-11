import { describe, expect, it } from "vitest";

import { markerColor, type SectionMarkerSummary } from "@libretracks/shared/models";

import { buildMarkerCards, buildTimelineMarkerChips } from "./markerCards";

function section(
  overrides: Partial<SectionMarkerSummary> &
    Pick<SectionMarkerSummary, "id" | "startSeconds">,
): SectionMarkerSummary {
  return { name: overrides.id, kind: "verse", ...overrides };
}

function cue(
  overrides: Partial<SectionMarkerSummary> &
    Pick<SectionMarkerSummary, "id" | "startSeconds">,
): SectionMarkerSummary {
  return { name: overrides.id, kind: "build", ...overrides };
}

describe("buildMarkerCards", () => {
  it("gives every section its own card, in timeline order", () => {
    const cards = buildMarkerCards([
      section({ id: "chorus", startSeconds: 20, kind: "chorus" }),
      section({ id: "verse", startSeconds: 10 }),
    ]);
    expect(cards.map((card) => [card.id, card.kind])).toEqual([
      ["verse", "section"],
      ["chorus", "section"],
    ]);
    expect(cards.every((card) => card.cues.length === 0)).toBe(true);
  });

  it("folds a cue into the section that shares its position", () => {
    const cards = buildMarkerCards([
      section({ id: "chorus", startSeconds: 20, kind: "chorus" }),
      cue({ id: "build", startSeconds: 20 }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("chorus");
    expect(cards[0].kind).toBe("section");
    expect(cards[0].cues.map((entry) => entry.id)).toEqual(["build"]);
  });

  it("tolerates sub-frame drift between a paired section and cue", () => {
    const cards = buildMarkerCards([
      section({ id: "chorus", startSeconds: 20, kind: "chorus" }),
      cue({ id: "build", startSeconds: 20.005 }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].cues.map((entry) => entry.id)).toEqual(["build"]);
  });

  it("keeps a cue standalone when no section shares its position", () => {
    const cards = buildMarkerCards([
      section({ id: "verse", startSeconds: 10 }),
      cue({ id: "build", startSeconds: 15 }),
      section({ id: "chorus", startSeconds: 20, kind: "chorus" }),
    ]);
    // Ordered by position, so the lone cue sits between the two sections.
    expect(cards.map((card) => [card.id, card.kind])).toEqual([
      ["verse", "section"],
      ["build", "cue"],
      ["chorus", "section"],
    ]);
  });

  it("attaches several cues stacked on one section", () => {
    const cards = buildMarkerCards([
      section({ id: "chorus", startSeconds: 20, kind: "chorus" }),
      cue({ id: "all_in", startSeconds: 20, kind: "all_in" }),
      cue({ id: "build", startSeconds: 20 }),
    ]);
    expect(cards).toHaveLength(1);
    // Cues keep timeline order; ties fall back to the order they arrived in.
    expect(cards[0].cues).toHaveLength(2);
    expect(cards[0].cues.map((entry) => entry.id).sort()).toEqual(["all_in", "build"]);
  });

  it("gives a lone cue card its own marker id, so it can be jumped to", () => {
    const cards = buildMarkerCards([cue({ id: "build", startSeconds: 15 })]);
    // The grid schedules a jump to `entry.id`; a cue card must carry the cue's
    // own id rather than borrowing a section's.
    expect(cards[0].id).toBe("build");
    expect(cards[0].marker.id).toBe("build");
  });

  it("honours a categoryOverride, so a dragged marker changes side", () => {
    // A "build" kind dragged into the section lane behaves as a section (and so
    // becomes a jump target); a "verse" dragged into the cue lane does not.
    const cards = buildMarkerCards([
      cue({ id: "dragged_build", startSeconds: 10, categoryOverride: "section" }),
      section({ id: "dragged_verse", startSeconds: 30, categoryOverride: "cue" }),
    ]);
    expect(cards.map((card) => [card.id, card.kind])).toEqual([
      ["dragged_build", "section"],
      ["dragged_verse", "cue"],
    ]);
  });

  it("attaches a cue to the closest of two sections on nearly the same beat", () => {
    const cards = buildMarkerCards([
      section({ id: "near", startSeconds: 20.001 }),
      section({ id: "far", startSeconds: 20.015, kind: "chorus" }),
      cue({ id: "build", startSeconds: 20 }),
    ]);
    expect(cards.find((card) => card.id === "near")?.cues.map((entry) => entry.id)).toEqual([
      "build",
    ]);
    expect(cards.find((card) => card.id === "far")?.cues).toEqual([]);
  });
});

describe("buildTimelineMarkerChips", () => {
  it("emits one chip per card, carrying the folded cue names", () => {
    const chips = buildTimelineMarkerChips(
      [
        section({ id: "chorus", name: "Estribillo", startSeconds: 20, kind: "chorus" }),
        cue({ id: "build", name: "Build", startSeconds: 20 }),
        cue({ id: "lone", name: "All in", startSeconds: 40, kind: "all_in" }),
      ],
      markerColor,
    );
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({
      id: "chorus",
      kind: "section",
      label: "Estribillo",
      cueNames: ["Build"],
    });
    expect(chips[1]).toMatchObject({ id: "lone", kind: "cue", label: "All in", cueNames: [] });
  });

  it("colours each chip from the marker it is built around", () => {
    const chips = buildTimelineMarkerChips(
      [cue({ id: "lone", startSeconds: 5, kind: "all_in" })],
      markerColor,
    );
    expect(chips[0].color).toBe(markerColor({ kind: "all_in" }));
  });
});
