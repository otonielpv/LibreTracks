import { describe, expect, it } from "vitest";

import { grabHalfReach, isOnRangeThumb, TOUCH_GRAB_REACH_PX } from "./faderGrab";

function panInput(value: number) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "-1";
  input.max = "1";
  input.step = "0.01";
  input.value = String(value);
  input.style.setProperty("--lt-fader-cap-w", "16px");
  document.body.append(input);
  // 216 px wide from x=0: the thumb's centre runs from 8 to 208.
  input.getBoundingClientRect = () => ({ left: 0, right: 216, width: 216, top: 0, bottom: 20, height: 20 }) as DOMRect;
  return input;
}

describe("faderGrab", () => {
  it("a finger gets a finger's width, a mouse the cap and a little margin", () => {
    expect(grabHalfReach(22, "touch")).toBe(TOUCH_GRAB_REACH_PX / 2);
    expect(grabHalfReach(22, "mouse")).toBe(14);
  });

  it("finds the pan thumb where its value puts it", () => {
    const centred = panInput(0); // thumb at x=108
    expect(isOnRangeThumb(centred, 108, "mouse")).toBe(true);
    expect(isOnRangeThumb(centred, 118, "mouse")).toBe(true);
    expect(isOnRangeThumb(centred, 130, "mouse")).toBe(false);
    expect(isOnRangeThumb(centred, 130, "touch")).toBe(true);
    expect(isOnRangeThumb(centred, 20, "touch")).toBe(false);
    const left = panInput(-1); // thumb at x=8
    expect(isOnRangeThumb(left, 8, "mouse")).toBe(true);
    expect(isOnRangeThumb(left, 108, "touch")).toBe(false);
  });
});
