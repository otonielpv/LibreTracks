import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  moveId,
  resolveReorderAxis,
  SONG_REORDER_ID_ATTRIBUTE,
  targetIndexForGap,
  useSongReorder,
} from "./useSongReorder";

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

  it("maps a gap to the final index, ignoring the gaps beside the song", () => {
    // Canción en la posición 1 de [a, b, c].
    expect(targetIndexForGap(1, 0)).toBe(0);
    expect(targetIndexForGap(1, 1)).toBeNull();
    expect(targetIndexForGap(1, 2)).toBeNull();
    expect(targetIndexForGap(1, 3)).toBe(2);
  });

  it("moves one id to its new place", () => {
    expect(moveId(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
});

function Harness({
  ids,
  onReorder,
}: {
  ids: string[];
  onReorder: (id: string, index: number) => unknown;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reorder = useSongReorder({ itemIds: ids, containerRef, onReorder });
  return (
    <div ref={containerRef}>
      {ids.map((id) => (
        <div
          key={id}
          data-testid={`row-${id}`}
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

/** Filas de 100 px en horizontal con 10 px entre ellas, según el orden del
 * DOM: centros en 50, 160 y 270. */
function layOut(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>(`[${SONG_REORDER_ID_ATTRIBUTE}]`)
    .forEach((element, index) => {
      element.getBoundingClientRect = () =>
        ({
          left: index * 110,
          top: 0,
          width: 100,
          height: 40,
          right: index * 110 + 100,
          bottom: 40,
        }) as DOMRect;
    });
}

const lift = () => document.querySelector(".lt-drag-lift");

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
  // A fake-timer test must not leave the clock frozen for the rest, nor drop
  // its pending timers: the drop's setTimeout(0) is what removes the listener
  // that swallows the click after a drag, and lost it would eat later clicks.
  afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  });

  it("opens the gap where the song will land and shows its ghost there", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
    });
    // Recién agarrada: fantasma en su sitio y copia flotante.
    expect(screen.getByTestId("row-a").classList.contains("lt-reorder-ghost")).toBe(true);
    expect(lift()).not.toBeNull();

    act(() => {
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
    });
    // b y c se apartan un puesto a la izquierda; el fantasma de a, al final.
    expect(screen.getByTestId("row-b").style.transform).toBe("translate3d(-110px, 0, 0)");
    expect(screen.getByTestId("row-c").style.transform).toBe("translate3d(-110px, 0, 0)");
    expect(screen.getByTestId("row-a").style.transform).toBe("translate3d(220px, 0, 0)");
    expect((lift() as HTMLElement).style.transform).toBe("translate3d(250px, 0, 0)");
    // La copia no se confunde con la fila de verdad.
    expect(lift()?.hasAttribute(SONG_REORDER_ID_ATTRIBUTE)).toBe(false);

    act(() => {
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });
    expect(onReorder).toHaveBeenCalledWith("a", 2);
    expect(lift()).toBeNull();
  });

  // The song lists are at the top now: a finger on the grip drags at once,
  // with no hold first.
  it("a finger drags from the grip right away", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
    });
    expect(lift()).not.toBeNull();
    act(() => {
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });
    expect(onReorder).toHaveBeenCalledWith("a", 2);
  });

  it("keeps the preview until the new order renders, then lets go at once", () => {
    const { container, rerender } = render(
      <Harness ids={["a", "b", "c"]} onReorder={vi.fn()} />,
    );
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    vi.useFakeTimers();
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });
    // Only the drop's setTimeout(0): the 250 ms fallback that would drop the
    // preview is exactly what this test checks has not happened yet.
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    // Guardando: la lista sigue enseñando el resultado.
    expect(screen.getByTestId("row-b").style.transform).not.toBe("");

    rerender(<Harness ids={["b", "c", "a"]} onReorder={vi.fn()} />);

    for (const id of ["a", "b", "c"]) {
      const element = screen.getByTestId(`row-${id}`);
      expect(element.style.transform).toBe("");
      // Sin transición: cada fila ya está donde la enseñaba la vista previa.
      expect(element.classList.contains("lt-reorder-shifting")).toBe(false);
      expect(element.classList.contains("lt-reorder-ghost")).toBe(false);
    }
  });

  it("a mouse drag on the song needs a few pixels, so a click stays a click", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByText("c"), { ...mouse, clientX: 270 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 268 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 268 });
    });
    expect(onReorder).not.toHaveBeenCalled();
    expect(lift()).toBeNull();

    act(() => {
      fireEvent.pointerDown(screen.getByText("c"), { ...mouse, clientX: 270 });
      fireEvent.pointerMove(window, { ...mouse, clientX: 10 });
      fireEvent.pointerUp(window, { ...mouse, clientX: 10 });
    });
    expect(onReorder).toHaveBeenCalledWith("c", 0);
  });

  it("swallows the click that follows a drag, but not a later click", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <div onClick={onClick}>
        <Harness ids={["a", "b", "c"]} onReorder={vi.fn()} />
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
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 4, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByText("a"), { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });

    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.getByTestId("row-b").style.transform).toBe("");
  });

  it("Escape cancels the drag and slides everything back", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-a"), { ...touch, clientX: 50 });
      fireEvent.pointerMove(window, { ...touch, clientX: 300 });
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(window, { ...touch, clientX: 300 });
    });

    expect(onReorder).not.toHaveBeenCalled();
    expect(lift()).toBeNull();
    for (const id of ["a", "b", "c"]) {
      expect(screen.getByTestId(`row-${id}`).style.transform).toBe("");
    }
  });

  it("dropping next to its own place does nothing", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);
    layOut(container);
    const touch = { pointerId: 3, pointerType: "touch", button: 0 };

    act(() => {
      fireEvent.pointerDown(screen.getByTestId("grip-b"), { ...touch, clientX: 160 });
      fireEvent.pointerMove(window, { ...touch, clientX: 200 });
    });
    expect(screen.getByTestId("row-a").style.transform).toBe("");
    act(() => {
      fireEvent.pointerUp(window, { ...touch, clientX: 200 });
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("arrow keys on the grip move the song one place", () => {
    const onReorder = vi.fn();
    render(<Harness ids={["a", "b", "c"]} onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByTestId("grip-b"), { key: "ArrowRight" });
    expect(onReorder).toHaveBeenLastCalledWith("b", 2);
    fireEvent.keyDown(screen.getByTestId("grip-b"), { key: "ArrowUp" });
    expect(onReorder).toHaveBeenLastCalledWith("b", 0);
    onReorder.mockClear();
    fireEvent.keyDown(screen.getByTestId("grip-a"), { key: "ArrowLeft" });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
