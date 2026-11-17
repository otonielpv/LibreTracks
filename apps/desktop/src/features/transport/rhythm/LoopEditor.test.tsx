import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DrumKit, LoopPattern } from "@libretracks/shared/models";

import { act, fireEvent, render, screen } from "../../../test/testUtils";
import { resetFrameGateForTests } from "../frameGate";
import { LoopEditor } from "./LoopEditor";
import { LONG_PRESS_MS } from "./LoopStepGrid";
import type { RhythmLayoutClass } from "./useRhythmLayout";

function installPointerEvent() {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
}

beforeEach(() => {
  installPointerEvent();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function kit(rows: number): DrumKit {
  return {
    id: "kit",
    name: "Kit",
    sounds: Array.from({ length: rows }, (_, i) => ({
      id: `s${i}`,
      name: `Shaker ${i}`,
      color: "#57f1db",
      sample: { source: { kind: "builtin" as const }, file: `s${i}.wav` },
      gainDb: 0,
    })),
  };
}

function pattern(rows = 3, bars: 1 | 2 | 4 = 1): LoopPattern {
  return {
    id: "pop",
    name: "Pop",
    kit: { kind: "library", kitId: "kit" },
    bpm: 92,
    signature: { numerator: 4, denominator: 4 },
    stepsPerBeat: 4,
    bars,
    swing: 0,
    rows: Array.from({ length: rows }, (_, i) => ({ soundId: `s${i}`, gainDb: 0, variations: [] })),
  };
}

function renderEditor(
  options: { layout?: RhythmLayoutClass; rows?: number; bars?: 1 | 2 | 4; touch?: boolean; confirm?: () => boolean } = {},
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onChangeSpy = vi.fn();
  const utils = render(
    <LoopEditor
      pattern={pattern(options.rows ?? 3, options.bars ?? 1)}
      kit={kit(options.rows ?? 3)}
      layoutClass={options.layout ?? "wide"}
      touch={options.touch}
      songRegionId="r1"
      onSave={onSave}
      onClose={onClose}
      confirmDiscard={options.confirm}
      newId={() => "pattern-new"}
    />,
  );
  return { ...utils, onSave, onClose, onChangeSpy };
}

const cell = (row: number, step: number) =>
  screen.getByTestId(`step-row-${row}`).querySelector<HTMLElement>(`[data-step="${step}"]`)!;

describe.each([false, true])("LoopEditor gestures (touch=%s)", (touch) => {
  it("tap toggles normal and silence", () => {
    renderEditor({ touch });
    fireEvent.pointerDown(cell(0, 2));
    fireEvent.pointerUp(window);
    expect(cell(0, 2).dataset.velocity).toBe("2");
    fireEvent.pointerDown(cell(0, 2));
    fireEvent.pointerUp(window);
    expect(cell(0, 2).dataset.velocity).toBe("0");
  });

  it("holding 400 ms cycles soft, normal and accent; right click too", () => {
    vi.useFakeTimers();
    renderEditor({ touch });
    fireEvent.pointerDown(cell(1, 0));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerUp(window);
    expect(cell(1, 0).dataset.velocity).toBe("2");
    fireEvent.contextMenu(cell(1, 0));
    expect(cell(1, 0).dataset.velocity).toBe("3");
    fireEvent.contextMenu(cell(1, 0));
    expect(cell(1, 0).dataset.velocity).toBe("1");
  });

  it("dragging over ten cells paints them with one draft update", () => {
    renderEditor({ touch });
    const undo = screen.getByRole("button", { name: "Undo" });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(cell(2, 0));
    for (let step = 1; step < 10; step += 1) fireEvent.pointerEnter(cell(2, step));
    // Vista previa local durante el arrastre: aún no hay historial.
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect(cell(2, 9).dataset.velocity).toBe("2");
    fireEvent.pointerUp(window);
    for (let step = 0; step < 10; step += 1) expect(cell(2, step).dataset.velocity).toBe("2");
    expect(cell(2, 10).dataset.velocity).toBe("0");
    // Una sola actualización del borrador = un solo paso de deshacer.
    fireEvent.click(undo);
    for (let step = 0; step < 10; step += 1) expect(cell(2, step).dataset.velocity).toBe("0");
    expect((undo as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("LoopEditor sizes", () => {
  it.each([
    ["wide", 32, 2],
    ["medium", 16, 4],
    ["short", 16, 4],
  ] as const)("%s shows %i steps and %i pages for 4 bars", (layout, steps, pages) => {
    renderEditor({ layout, bars: 4, rows: 8 });
    expect(screen.getByTestId("loop-editor").dataset.layout).toBe(layout);
    expect(screen.getByTestId("step-row-0").querySelectorAll(".lt-step-cell")).toHaveLength(steps);
    expect(screen.getByTestId("loop-editor-pages").querySelectorAll("button")).toHaveLength(pages);
    fireEvent.click(screen.getByRole("tab", { name: "2" }));
    expect(cell(0, steps).dataset.step).toBe(String(steps));
    if (layout === "short") {
      expect(screen.getByTestId("step-row-0").textContent).toContain("Sha");
      expect(screen.getByTestId("step-row-0").textContent).not.toContain("Shaker");
    }
  });
});

describe("LoopEditor saving", () => {
  it("saves to the library, assigns to the song or saves as new with the normalized pattern", async () => {
    const { onSave } = renderEditor();
    fireEvent.pointerDown(cell(0, 0));
    fireEvent.pointerUp(window);
    for (const [label, target] of [
      ["Save to library", "library"],
      ["Assign to this song", "song"],
      ["Save as new", "new"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Save ▾" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: label }));
      });
      const [saved, savedTarget] = onSave.mock.calls.at(-1)!;
      expect(savedTarget).toBe(target);
      expect(saved.rows[0].variations).toHaveLength(4);
      expect(saved.rows[0].variations[0]).toHaveLength(16);
      expect(saved.rows[0].variations[0][0]).toBe(2);
      expect(saved.id).toBe(target === "new" ? "pattern-new" : "pop");
    }
  });

  it("closing with changes asks first; without changes it just closes", () => {
    const confirm = vi.fn(() => false);
    const { onClose } = renderEditor({ confirm });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(cell(0, 3));
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
