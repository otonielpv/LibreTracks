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
    // Nombre entero siempre (el CSS lo recorta con puntos suspensivos): con
    // tres letras «Shaker» y «Shaker suave» eran indistinguibles.
    expect(screen.getByTestId("step-row-0").textContent).toContain("Shaker 0");
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

describe("LoopEditor container", () => {
  it("is a dialog over a backdrop, not the whole window; clicking outside asks before closing", () => {
    const confirm = vi.fn(() => false);
    const { onClose } = renderEditor({ confirm });
    const editor = screen.getByTestId("loop-editor");
    const backdrop = editor.parentElement!;
    expect(backdrop.className).toContain("lt-rhythm-backdrop");
    fireEvent.pointerDown(editor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("LoopEditor on a phone", () => {
  it("keeps the pattern settings folded behind a button", () => {
    renderEditor({ layout: "short" });
    expect(screen.queryByText("Bars")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pattern settings" }));
    expect(screen.getByText("Bars")).toBeTruthy();
  });

  it("a sound added to the kit while editing shows up as a row, without counting as unsaved", () => {
    const onClose = vi.fn();
    const confirm = vi.fn(() => false);
    const props = {
      pattern: pattern(2),
      layoutClass: "wide" as RhythmLayoutClass,
      onSave: vi.fn(),
      onClose,
      confirmDiscard: confirm,
    };
    const { rerender } = render(<LoopEditor {...props} kit={kit(2)} />);
    expect(screen.queryByText("Shaker 2")).toBeNull();
    rerender(<LoopEditor {...props} kit={kit(3)} />);
    expect(screen.getByText("Shaker 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cerrar|close/i }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("picking another kit rebuilds the rows (keeping shared sounds) and undo brings the old kit back", () => {
    const other: DrumKit = { ...kit(4), id: "other", name: "Otro" };
    other.sounds = other.sounds.slice(1); // s1, s2, s3
    render(
      <LoopEditor
        pattern={pattern(2)}
        kit={kit(2)}
        kits={[kit(2), other]}
        layoutClass="wide"
        onSave={vi.fn()}
        onClose={vi.fn()}
        onEditKit={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Shaker 1 1" }));
    fireEvent.pointerUp(window);
    fireEvent.change(screen.getByRole("combobox", { name: /kit/i }), { target: { value: "other" } });
    expect(screen.queryByText("Shaker 0")).toBeNull();
    expect(screen.getByText("Shaker 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shaker 1 1" }).getAttribute("data-velocity")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: /deshacer|undo/i }));
    expect(screen.getByText("Shaker 0")).toBeTruthy();
    expect(screen.queryByText("Shaker 3")).toBeNull();
  });

  it("«New kit…» opens the kit editor and the created kit becomes the pattern's kit", () => {
    const onEditKit = vi.fn();
    render(
      <LoopEditor
        pattern={pattern(2)}
        kit={kit(2)}
        kits={[kit(2)]}
        layoutClass="wide"
        onSave={vi.fn()}
        onClose={vi.fn()}
        onEditKit={onEditKit}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /kit/i }), { target: { value: "__new_kit__" } });
    expect(onEditKit).toHaveBeenCalledWith(null, expect.any(Function));
    const created: DrumKit = { ...kit(1), id: "mine", name: "Mío", sounds: [{ ...kit(1).sounds[0], id: "x", name: "Cajón" }] };
    act(() => onEditKit.mock.calls[0][1](created));
    expect(screen.getByText("Cajón")).toBeTruthy();
    expect(screen.queryByText("Shaker 0")).toBeNull();
  });
});
