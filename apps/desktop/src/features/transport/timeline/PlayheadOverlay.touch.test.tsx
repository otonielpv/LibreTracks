// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlayheadOverlay } from "./PlayheadOverlay";

/**
 * El asa del cabezal frente a la pulsación larga de la regla.
 *
 * El asa mide 16 px de ancho por todo el alto de la regla, así que mantener
 * pulsado ahí para crear una marca aterriza encima de ella. Con el arrastre
 * arrancando en el `pointerdown`, al soltar el dedo se confirmaba un salto — y
 * el salto cierra el menú contextual: el menú "se abría y se cerraba al
 * instante". Con un dedo el arrastre ahora se ARMA y sólo empieza al moverse.
 */

function boundsRef() {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetWidth", { value: 800 });
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100 }) as DOMRect;
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  ref.current = element;
  return ref;
}

function renderPlayhead(onSeekCommit: (seconds: number) => void) {
  const dragStateRef = { current: null } as Parameters<
    typeof PlayheadOverlay
  >[0]["dragStateRef"];

  const view = render(
    <PlayheadOverlay
      className="lt-playhead is-handle"
      durationSeconds={120}
      pixelsPerSecond={40}
      cameraXRef={{ current: 0 }}
      livePixelsPerSecondRef={{ current: 40 }}
      dragStateRef={dragStateRef}
      positionSecondsRef={{ current: 0 }}
      positionBoundsRef={boundsRef()}
      onSeekCommit={onSeekCommit}
    />,
  );

  const handle = view.container.querySelector(".lt-playhead") as HTMLElement;
  return { handle, dragStateRef };
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientX: number,
  pointerType: "touch" | "mouse" = "touch",
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX,
    clientY: 40,
  });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerType === "touch" ? 3 : 1 },
  });
  return event;
}

const touchPointer = (
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
) => pointer(type, clientX);

describe("PlayheadOverlay: asa con el dedo", () => {
  it("no confirma ningún salto si el dedo no se mueve", () => {
    const onSeekCommit = vi.fn();
    const { handle, dragStateRef } = renderPlayhead(onSeekCommit);

    fireEvent(handle, touchPointer("pointerdown", 400));
    expect(dragStateRef.current).toBeNull();

    fireEvent(window, touchPointer("pointerup", 400));
    expect(onSeekCommit).not.toHaveBeenCalled();
  });

  it("arrastra en cuanto el dedo se desplaza", () => {
    const onSeekCommit = vi.fn();
    const { handle } = renderPlayhead(onSeekCommit);

    fireEvent(handle, touchPointer("pointerdown", 400));
    fireEvent(window, touchPointer("pointermove", 480));
    fireEvent(window, touchPointer("pointerup", 480));

    expect(onSeekCommit).toHaveBeenCalledTimes(1);
    expect(onSeekCommit).toHaveBeenCalledWith(12); // 480px / 40px por segundo
  });

  it("se aparta cuando la pulsación larga abre el menú de la regla", () => {
    const onSeekCommit = vi.fn();
    const { handle, dragStateRef } = renderPlayhead(onSeekCommit);

    fireEvent(handle, touchPointer("pointerdown", 400));
    fireEvent(window, touchPointer("pointermove", 480));
    expect(dragStateRef.current).not.toBeNull();

    window.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    fireEvent(window, touchPointer("pointerup", 480));

    expect(onSeekCommit).not.toHaveBeenCalled();
  });

  // El gesto de dos dedos sintetiza `pointercancel` para apartar los arrastres
  // de un dedo en vuelo. Cancelar no es soltar: no debe mover el cabezal.
  it("abandona sin confirmar cuando el puntero se cancela", () => {
    const onSeekCommit = vi.fn();
    const { handle } = renderPlayhead(onSeekCommit);

    fireEvent(handle, touchPointer("pointerdown", 400));
    fireEvent(window, touchPointer("pointermove", 480));

    window.dispatchEvent(pointer("pointercancel", 480));

    expect(onSeekCommit).not.toHaveBeenCalled();
  });

  it("mantiene el arranque inmediato con el ratón", () => {
    const onSeekCommit = vi.fn();
    const { handle, dragStateRef } = renderPlayhead(onSeekCommit);

    fireEvent(handle, pointer("pointerdown", 400, "mouse"));
    expect(dragStateRef.current).not.toBeNull();

    fireEvent(window, pointer("pointerup", 400, "mouse"));
    expect(onSeekCommit).toHaveBeenCalledWith(10); // 400px / 40px por segundo
  });
});
