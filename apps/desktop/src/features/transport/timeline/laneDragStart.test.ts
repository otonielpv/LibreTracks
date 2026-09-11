// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  COMPAT_MOUSE_GRACE_MS,
  armLaneTouchDrag,
  laneMouseDragAllowed,
} from "./laneDragStart";

const pointer = (pointerType: string) =>
  ({ pointerType }) as ReactPointerEvent<HTMLDivElement>;

describe("quien arma el arrastre de un clip", () => {
  // En iOS el `mousedown` de compatibilidad llega AL SOLTAR el dedo, asi que un
  // arrastre jamas lo ve: el clip se seleccionaba y despues no habia forma de
  // moverlo. Con el dedo arma el `pointerdown`.
  it("el dedo arma, y deja constancia", () => {
    const lastTouchAt = { current: 0 };

    expect(armLaneTouchDrag(pointer("touch"), lastTouchAt, 5_000)).toBe(true);
    expect(lastTouchAt.current).toBe(5_000);
  });

  it("el raton no pasa por ahi: el suyo es el `mousedown`", () => {
    const lastTouchAt = { current: 0 };

    expect(armLaneTouchDrag(pointer("mouse"), lastTouchAt, 5_000)).toBe(false);
    expect(lastTouchAt.current).toBe(0);
  });

  it("el eco tardio de un dedo no arma un segundo arrastre", () => {
    const lastTouchAt = { current: 5_000 };

    expect(
      laneMouseDragAllowed(lastTouchAt, 5_000 + COMPAT_MOUSE_GRACE_MS - 1),
    ).toBe(false);
  });

  it("un raton de verdad si", () => {
    const lastTouchAt = { current: 5_000 };

    expect(
      laneMouseDragAllowed(lastTouchAt, 5_000 + COMPAT_MOUSE_GRACE_MS),
    ).toBe(true);
    // Y sin ningun toque previo, siempre.
    expect(laneMouseDragAllowed({ current: 0 })).toBe(true);
  });
});
