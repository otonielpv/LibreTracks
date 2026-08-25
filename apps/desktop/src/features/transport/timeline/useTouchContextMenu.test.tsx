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

function Harness({
  onContextMenu,
  onClick = () => undefined,
}: {
  onContextMenu: () => void;
  onClick?: () => void;
}) {
  const gesture = useTouchContextMenu({ delayMs: 500 });
  return (
    <div
      data-testid="ruler"
      onPointerDown={gesture.begin}
      onPointerMove={gesture.move}
      onPointerUp={gesture.cancel}
      onPointerCancel={gesture.cancel}
      onClick={() => {
        if (!gesture.consumeTriggered()) onClick();
      }}
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

  it("consumes the click emitted after a completed long-press", () => {
    vi.useFakeTimers();
    const onContextMenu = vi.fn();
    const onClick = vi.fn();
    const { getByTestId } = render(
      <Harness onContextMenu={onContextMenu} onClick={onClick} />,
    );
    const target = getByTestId("ruler");
    fireEvent(target, touchPointer("pointerdown", 7, 20, 20));
    act(() => vi.advanceTimersByTime(500));
    fireEvent(target, touchPointer("pointerup", 7, 20, 20));
    fireEvent.click(target);

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
