import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  resolveDropGap,
  resolveReorderAxis,
  SONG_REORDER_ID_ATTRIBUTE,
  songReorderClassName,
  targetIndexForGap,
  useSongReorder,
} from "./useSongReorder";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const row = (left: number, top: number, width = 100, height = 40) => ({
  left,
  top,
  width,
  height,
});

describe("song reorder geometry", () => {
  it("reads the axis from where the first two items sit", () => {
    expect(resolveReorderAxis([row(0, 0), row(110, 0)])).toBe("x");
    expect(resolveReorderAxis([row(0, 0), row(0, 50)])).toBe("y");
    expect(resolveReorderAxis([row(0, 0)])).toBe("x");
  });

  it("counts the items whose centre the pointer has passed", () => {
    const rects = [row(0, 0), row(110, 0), row(220, 0)];
    expect(resolveDropGap(rects, "x", { x: 10, y: 0 })).toBe(0);
    expect(resolveDropGap(rects, "x", { x: 60, y: 0 })).toBe(1);
    expect(resolveDropGap(rects, "x", { x: 200, y: 0 })).toBe(2);
    expect(resolveDropGap(rects, "x", { x: 900, y: 0 })).toBe(3);
  });

  it("maps a gap to the final index, ignoring the gaps beside the song", () => {
    // Canción en la posición 1 de [a, b, c].
    expect(targetIndexForGap(1, 0)).toBe(0);
    expect(targetIndexForGap(1, 1)).toBeNull();
    expect(targetIndexForGap(1, 2)).toBeNull();
    expect(targetIndexForGap(1, 3)).toBe(2);
  });

  it("paints the insertion line on the song after the gap, or after the last", () => {
    const dragging = { draggingId: "a", dropGap: 3 };
    expect(songReorderClassName(dragging, "a", 0, 3)).toContain("is-reorder-source");
    expect(songReorderClassName(dragging, "c", 2, 3)).toContain("is-drop-after");
    expect(songReorderClassName({ draggingId: "c", dropGap: 0 }, "a", 0, 3)).toContain(
      "is-drop-before",
    );
  });
});

const IDS = ["a", "b", "c"];

function Harness({ onReorder }: { onReorder: (id: string, index: number) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reorder = useSongReorder({ itemIds: IDS, containerRef, onReorder });
  return (
    <div ref={containerRef}>
      {IDS.map((id, index) => (
        <div
          key={id}
          data-testid={`row-${id}`}
          className={songReorderClassName(reorder, id, index, IDS.length)}
          {...{ [SONG_REORDER_ID_ATTRIBUTE]: id }}
        >
          <span data-testid={`grip-${id}`} {...reorder.handleProps(id)} />
          <button type="button" {...reorder.surfaceProps(id)}>
            {id}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Tres filas de 100 px en horizontal: centros en 50, 160 y 270. */
function layOut(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>(`[${SONG_REORDER_ID_ATTRIBUTE}]`)
    .forEach((element, index) => {
      element.getBoundingClientRect = () =>
        ({ left: index * 110, top: 0, width: 100, height: 40, right: index * 110 + 100, bottom: 40 }) as DOMRect;
    });
}

describe("useSongReorder", () => {
  const originalPointerEvent = window.PointerEvent;
  beforeAll(() => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: TestPointerEvent,
    });
  });
  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  });

  it("drags a song by its grip with a finger and drops it at the end", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    layOut(container);

    const touch = { pointerId: 3, pointerType: "touch", button: 0 };
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
    });
    expect(screen.getByTestId("row-a").className).toContain("is-reorder-source");
    act(() => {
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
    });
    expect(screen.getByTestId("row-c").className).toContain("is-drop-after");
    act(() => {
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });

    expect(onReorder).toHaveBeenCalledWith("a", 2);
    expect(screen.getByTestId("row-a").className).not.toContain("is-reorder-source");
  });

  it("a mouse drag on the song needs a few pixels, so a click stays a click", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    layOut(container);
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByText("c"), { ...mouse, clientX: 270 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 268 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 268 });
    });
    expect(onReorder).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerDown(screen.getByText("c"), { ...mouse, clientX: 270 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 10 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 10 });
    });
    expect(onReorder).toHaveBeenCalledWith("c", 0);
  });

  it("swallows the click that follows a drag, but not a later click", async () => {
    const onReorder = vi.fn();
    const onClick = vi.fn();
    const { container } = render(
      <div onClick={onClick}>
        <Harness onReorder={onReorder} />
      </div>,
    );
    layOut(container);
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    const song = screen.getByText("c");

    act(() => {
      fireEvent.pointerDown(song, { ...mouse, clientX: 270 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 10 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 10 });
      fireEvent.click(song);
    });
    expect(onClick).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(song);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a finger on the song itself scrolls, it never drags", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 4, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByText("a"), { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("Escape cancels the drag", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("dropping next to its own place does nothing", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-b"), { ...touch, clientX: 160 });
      fireEvent.pointerMove(window, { ...touch, clientX: 200 });
      fireEvent.pointerUp(window, { ...touch, clientX: 200 });
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("arrow keys on the grip move the song one place", () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByTestId("grip-b"), { key: "ArrowRight" });
    expect(onReorder).toHaveBeenLastCalledWith("b", 2);
    fireEvent.keyDown(screen.getByTestId("grip-b"), { key: "ArrowUp" });
    expect(onReorder).toHaveBeenLastCalledWith("b", 0);
    onReorder.mockClear();
    fireEvent.keyDown(screen.getByTestId("grip-a"), { key: "ArrowLeft" });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
