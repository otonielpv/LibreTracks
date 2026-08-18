import { describe, expect, it } from "vitest";

import { calculatePopoverAnchor } from "./popoverPosition";

describe("calculatePopoverAnchor", () => {
  it("opens below controls near the top bar", () => {
    expect(
      calculatePopoverAnchor(
        { top: 40, bottom: 70, left: 100 },
        300,
        420,
        1200,
        800,
      ),
    ).toMatchObject({ placement: "below", top: 76, left: 100 });
  });

  it("opens above Live View controls near the bottom edge", () => {
    const anchor = calculatePopoverAnchor(
      { top: 720, bottom: 760, left: 1100 },
      300,
      420,
      1280,
      800,
    );

    expect(anchor.placement).toBe("above");
    expect(anchor.top).toBe(294);
    expect(anchor.left).toBe(968);
    expect(anchor.maxHeight).toBe(702);
  });
});
