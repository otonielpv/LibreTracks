import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { grabHalfReach, isOnRangeThumb, TOUCH_GRAB_REACH_PX, useCapOnlyRange } from "./faderGrab";

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

describe("useCapOnlyRange", () => {
  function setupRange(value: number) {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const hook = renderHook(() => useCapOnlyRange({ min: -1, max: 1, step: 0.01, onChange, onCommit }));
    const input = panInput(value);
    const layer = document.createElement("span");
    document.body.append(layer);
    hook.result.current.inputRef.current = input;
    act(() => hook.result.current.layerRef(layer));
    return { hook, input, layer, onChange, onCommit };
  }
  const touchStart = (layer: HTMLElement, clientX: number) => {
    const event = new Event("touchstart", { cancelable: true, bubbles: true }) as TouchEvent;
    Object.defineProperty(event, "touches", { value: [{ clientX, clientY: 10 }] });
    layer.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const down = (layer: HTMLElement, clientX: number, pointerType: string, shiftKey = false) => ({
    button: 0, clientX, pointerType, pointerId: 1, shiftKey, currentTarget: layer, preventDefault: vi.fn(),
  });
  const pointer = (type: string, clientX: number, shiftKey = false) =>
    act(() => {
      window.dispatchEvent(Object.assign(new MouseEvent(type, { clientX, shiftKey }), { pointerId: 1 }));
    });

  it("a finger on the thumb keeps the gesture; anywhere else it scrolls the mixer", () => {
    const { layer } = setupRange(0);
    expect(touchStart(layer, 108)).toBe(true); // on the thumb: no scroll
    expect(touchStart(layer, 30)).toBe(false); // the track: the browser scrolls
  });

  it("dragging the thumb moves it from where it was taken, without jumping", () => {
    const { hook, layer, onChange, onCommit } = setupRange(0);
    act(() => hook.result.current.onPointerDown(down(layer, 115, "touch") as never)); // 7 px off centre
    expect(onChange).not.toHaveBeenCalled();
    pointer("pointermove", 165);
    // 50 px over a 200 px travel of a 2-wide range = +0.5
    expect(onChange).toHaveBeenLastCalledWith(0.5);
    pointer("pointerup", 165);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("Shift crawls", () => {
    const { hook, layer, onChange } = setupRange(0);
    act(() => hook.result.current.onPointerDown(down(layer, 108, "mouse", true) as never));
    pointer("pointermove", 148, true);
    expect(onChange).toHaveBeenLastCalledWith(0.1); // 40 px = 0.4, at a quarter
    pointer("pointerup", 148, true);
  });

  it("a press away from the thumb does nothing (a finger scrolls instead)", () => {
    const { hook, layer, onChange, onCommit } = setupRange(0);
    for (const type of ["mouse", "touch"]) {
      const event = down(layer, 30, type);
      act(() => hook.result.current.onPointerDown(event as never));
      expect(event.preventDefault).not.toHaveBeenCalled();
      pointer("pointermove", 90);
      pointer("pointerup", 90);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
