import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompactVerticalFader } from "./CompactMixer";

// jsdom has no PointerEvent: a MouseEvent with a pointerId carries clientY.
function pointer(target: Element, type: string, clientY: number) {
  const event = new MouseEvent(type, { clientY, bubbles: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

function setup(value: number) {
  const onChange = vi.fn();
  render(
    <CompactVerticalFader value={value} onChange={onChange} onCommit={() => {}} onDoubleClick={() => {}} ariaLabel="Volume" />,
  );
  const track = screen.getByRole("slider", { name: "Volume" });
  // A 200 px track from y=100 to y=300; the cap is 22 px tall, its grab zone 44.
  track.getBoundingClientRect = () =>
    ({ top: 100, bottom: 300, height: 200, left: 0, right: 34, width: 34 }) as DOMRect;
  const cap = track.querySelector(".lt-compact-mixer-fader-thumb")!;
  cap.getBoundingClientRect = () => ({ height: 22 }) as DOMRect;
  track.setPointerCapture = () => {};
  track.hasPointerCapture = () => true;
  track.releasePointerCapture = () => {};
  return { track, onChange };
}

describe("CompactVerticalFader", () => {
  it("taking the cap by its edge does not jump the value; dragging moves it from there", () => {
    // Value 0.5: the cap's centre is at y=200; its grab zone spans 178-222.
    const { track, onChange } = setup(0.5);
    pointer(track, "pointerdown", 180);
    expect(onChange).not.toHaveBeenCalled();
    pointer(track, "pointermove", 160); // 20 px up = +0.1
    expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(0.6, 5));
  });

  it("clicking the track outside the cap still jumps there", () => {
    const { track, onChange } = setup(0.5);
    pointer(track, "pointerdown", 120);
    expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(0.9, 5));
  });
});
