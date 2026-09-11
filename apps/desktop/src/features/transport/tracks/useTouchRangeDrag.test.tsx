// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rangeValueAtPointer, useTouchRangeDrag } from "./useTouchRangeDrag";

afterEach(cleanup);

/** Riel de 200 px que empieza en x = 100. */
const BOUNDS = { left: 100, width: 200 };

function Fader(props: {
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const handlePointerDown = useTouchRangeDrag(props);
  return (
    <input
      aria-label="fader"
      type="range"
      min={props.min}
      max={props.max}
      step={props.step}
      defaultValue={props.min}
      onPointerDown={handlePointerDown}
      ref={(node) => {
        if (node) {
          node.getBoundingClientRect = () =>
            ({ left: BOUNDS.left, width: BOUNDS.width }) as DOMRect;
        }
      }}
    />
  );
}

function touch(target: Element | Window, type: string, clientX: number, id = 1) {
  fireEvent(
    target,
    Object.assign(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX }),
      { pointerId: id, pointerType: "touch" },
    ),
  );
}

describe("valor bajo el dedo", () => {
  it("mapea el ancho del riel al recorrido del fader", () => {
    expect(rangeValueAtPointer(100, BOUNDS, 0, 1, 0.001)).toBe(0);
    expect(rangeValueAtPointer(200, BOUNDS, 0, 1, 0.001)).toBe(0.5);
    expect(rangeValueAtPointer(300, BOUNDS, 0, 1, 0.001)).toBe(1);
  });

  it("llega a los topes exactos aunque el dedo se salga", () => {
    expect(rangeValueAtPointer(-500, BOUNDS, -1, 1, 0.01)).toBe(-1);
    expect(rangeValueAtPointer(5000, BOUNDS, -1, 1, 0.01)).toBe(1);
  });

  it("respeta el paso", () => {
    // 0.37 del recorrido de [-1, 1] con paso 0.01.
    expect(rangeValueAtPointer(174, BOUNDS, -1, 1, 0.01)).toBe(-0.26);
  });

  it("no divide por cero con un riel sin medir", () => {
    expect(rangeValueAtPointer(50, { left: 0, width: 0 }, 0, 1, 0.001)).toBe(0);
  });
});

describe("arrastre tactil del fader", () => {
  it("tocar el riel ya coloca el valor: no hace falta acertar al pulgar", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <Fader min={0} max={1} step={0.001} onChange={onChange} onCommit={onCommit} />,
    );

    touch(screen.getByLabelText("fader"), "pointerdown", 250);

    expect(onChange).toHaveBeenCalledWith(0.75);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("sigue al dedo fuera del control y confirma al soltar", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <Fader min={0} max={1} step={0.001} onChange={onChange} onCommit={onCommit} />,
    );
    const fader = screen.getByLabelText("fader");

    touch(fader, "pointerdown", 150);
    touch(window, "pointermove", 200);
    touch(window, "pointermove", 260);
    touch(window, "pointerup", 260);

    expect(onChange).toHaveBeenLastCalledWith(0.8);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Ya soltado: el dedo de otro gesto no mueve este fader.
    touch(window, "pointermove", 100);
    expect(onChange).toHaveBeenLastCalledWith(0.8);
  });

  it("le quita el gesto al control nativo, que en iOS solo responde al pulgar", () => {
    render(
      <Fader min={0} max={1} step={0.001} onChange={vi.fn()} onCommit={vi.fn()} />,
    );
    const event = Object.assign(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 250 }),
      { pointerId: 1, pointerType: "touch" },
    );
    fireEvent(screen.getByLabelText("fader"), event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("el raton se queda con el arrastre nativo de siempre", () => {
    const onChange = vi.fn();
    render(
      <Fader min={0} max={1} step={0.001} onChange={onChange} onCommit={vi.fn()} />,
    );
    const event = Object.assign(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 250 }),
      { pointerId: 1, pointerType: "mouse" },
    );
    fireEvent(screen.getByLabelText("fader"), event);

    expect(onChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
