// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTouchContextMenu } from "./useTouchContextMenu";

function touchPointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: pointerId },
  });
  return event;
}

function Harness({ onContextMenu }: { onContextMenu: () => void }) {
  const gesture = useTouchContextMenu({ delayMs: 500 });
  return (
    <div
      data-testid="ruler"
      onPointerDown={gesture.begin}
      onPointerMove={gesture.move}
      onPointerUp={gesture.cancel}
      onPointerCancel={gesture.cancel}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu();
      }}
    />
  );
}

describe("useTouchContextMenu", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the context menu after a stationary touch long-press", () => {
    vi.useFakeTimers();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(<Harness onContextMenu={onContextMenu} />);
    fireEvent(getByTestId("ruler"), touchPointer("pointerdown", 4, 120, 30));

    act(() => vi.advanceTimersByTime(500));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("cancels when the finger moves or is released early", () => {
    vi.useFakeTimers();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(<Harness onContextMenu={onContextMenu} />);
    const ruler = getByTestId("ruler");

    fireEvent(ruler, touchPointer("pointerdown", 5, 10, 10));
    fireEvent(ruler, touchPointer("pointermove", 5, 30, 10));
    act(() => vi.advanceTimersByTime(500));

    fireEvent(ruler, touchPointer("pointerdown", 6, 10, 10));
    fireEvent(ruler, touchPointer("pointerup", 6, 10, 10));
    act(() => vi.advanceTimersByTime(500));
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
