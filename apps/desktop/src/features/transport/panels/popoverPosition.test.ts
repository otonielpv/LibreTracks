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

  it("keeps a tall panel clear of the bottom safe area", () => {
    // iPhone 13 landscape: 390 px tall, home indicator inset of 21 px.
    const anchor = calculatePopoverAnchor(
      { top: 20, bottom: 56, left: 600 },
      300,
      900,
      844,
      390,
      21,
    );

    expect(anchor.placement).toBe("below");
    expect(anchor.top + anchor.maxHeight).toBeLessThanOrEqual(390 - 21 - 12);
  });
});

