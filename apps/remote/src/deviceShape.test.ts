import { describe, expect, it } from "vitest";

import { isPhoneShapedScreen } from "./deviceShape";

describe("isPhoneShapedScreen", () => {
  it("classifies phones as phone-shaped in either orientation", () => {
    // Pixel 7 / iPhone 14 class screens, CSS pixels.
    expect(isPhoneShapedScreen({ width: 412, height: 915 })).toBe(true);
    expect(isPhoneShapedScreen({ width: 915, height: 412 })).toBe(true);
    expect(isPhoneShapedScreen({ width: 390, height: 844 })).toBe(true);
    // Older 16:9 phone.
    expect(isPhoneShapedScreen({ width: 360, height: 640 })).toBe(true);
  });

  it("does not classify tablets as phone-shaped", () => {
    // TCL Tab 11 Gen 2: 1200x2000 physical at devicePixelRatio 2.25. Its
    // landscape viewport is under 500 CSS px tall once the browser chrome is
    // subtracted, which is what the old height-only media query tripped on.
    expect(isPhoneShapedScreen({ width: 889, height: 533 })).toBe(false);
    // Same panel at devicePixelRatio 2.
    expect(isPhoneShapedScreen({ width: 1000, height: 600 })).toBe(false);
    // iPad and iPad mini.
    expect(isPhoneShapedScreen({ width: 1024, height: 768 })).toBe(false);
    expect(isPhoneShapedScreen({ width: 744, height: 1133 })).toBe(false);
  });

  it("keeps landscape when the geometry is unusable", () => {
    expect(isPhoneShapedScreen({ width: 0, height: 0 })).toBe(false);
    expect(isPhoneShapedScreen({ width: Number.NaN, height: 800 })).toBe(false);
  });
});
