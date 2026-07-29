import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "@libretracks/shared/models";
import { LANE_CUES, LANE_SECTIONS } from "../Renderer/drawBackground";
import { markerCategory } from "../markerKinds";
import { laneCategoryAtY } from "./useMarkerMoveDrag";

/**
 * Vertical hit-testing for dragging a marker between the two ruler rows. The
 * lane a drop lands in decides the marker's category — and therefore whether it
 * is announced with a count-in — so the mapping has to cover the whole ruler
 * with no ambiguous band in between.
 */
describe("laneCategoryAtY", () => {
  it("maps each lane's own body to its category", () => {
    const cueMiddle = LANE_CUES.top + LANE_CUES.height / 2;
    const sectionMiddle = LANE_SECTIONS.top + LANE_SECTIONS.height / 2;

    expect(laneCategoryAtY(cueMiddle)).toBe("cue");
    expect(laneCategoryAtY(sectionMiddle)).toBe("section");
  });

  it("splits the gap between the lanes at its midpoint", () => {
    // The lanes do not touch; without a rule for the gap a drop there would be
    // ambiguous. Everything above the midpoint reads as cue, below as section.
    const gapMidpoint =
      (LANE_CUES.top + LANE_CUES.height + LANE_SECTIONS.top) / 2;

    expect(laneCategoryAtY(gapMidpoint - 1)).toBe("cue");
    expect(laneCategoryAtY(gapMidpoint + 1)).toBe("section");
  });

  it("keeps resolving past the top and bottom of the ruler", () => {
    // Pointer capture means a drag can travel outside the ruler entirely; it
    // must still resolve to the nearest lane rather than falling through.
    expect(laneCategoryAtY(-500)).toBe("cue");
    expect(laneCategoryAtY(5000)).toBe("section");
  });
});

/**
 * CanvasTimeline repaints the ruler only when its markers signature changes.
 * A lane drag moves a flag between rows WITHOUT moving it in time, so a
 * signature built from id+startSeconds alone stays identical and the canvas
 * skips the repaint — the drag then looks completely inert on screen.
 *
 * This mirrors the signature in CanvasTimeline (it is an inline expression, not
 * exported) to pin the property that matters: category must affect it.
 */
function markersSignature(markers: SectionMarkerSummary[]): string {
  return markers
    .map((m) => `${m.id}:${m.startSeconds}:${markerCategory(m)}`)
    .join("|");
}

describe("markers signature", () => {
  const marker: SectionMarkerSummary = {
    id: "m1",
    name: "Chorus",
    startSeconds: 4,
    kind: "chorus",
  };

  it("changes when a marker switches lane without moving in time", () => {
    const before = markersSignature([marker]);
    const after = markersSignature([
      { ...marker, categoryOverride: "cue" },
    ]);
    expect(after).not.toBe(before);
  });

  it("is stable when nothing about the marker changed", () => {
    expect(markersSignature([marker])).toBe(markersSignature([{ ...marker }]));
  });
});
