// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTimelineBackgroundSeek } from "./timelineBackgroundSeek";
import type { TimelineBackgroundSeekDeps } from "./timelineBackgroundSeek";
import type { MouseEvent as ReactMouseEvent } from "react";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

/**
 * El fondo del timeline en táctil.
 *
 * Este camino son eventos de ratón de COMPATIBILIDAD: el WebView los emite para
 * el primer dedo. Con el reparto de escritorio, apoyar un dedo ya saltaba el
 * cabezal y empezaba un desplazamiento de cámara, y como no son eventos de
 * puntero, el `pointercancel` con el que el gesto de dos dedos aparta los
 * arrastres en vuelo no llegaba hasta aquí: la pinza y este desplazamiento
 * movían la cámara a la vez, desde orígenes distintos. Era la razón de que el
 * gesto de dos dedos «no funcionara bien».
 */

function setup() {
  const calls = {
    previewSeek: [] as number[],
    commitSeek: [] as number[],
    updateCameraX: [] as number[],
    clearSelection: 0,
  };

  const deps: TimelineBackgroundSeekDeps = {
    getSeekLimitSeconds: () => 600,
    getCameraX: () => 0,
    livePixelsPerSecondRef: { current: 40 },
    // Directo: 40 px por segundo, sin cámara.
    clientXToSeconds: (clientX) => clientX / 40,
    normalizeSeconds: (seconds) => seconds,
    panRef: { current: null },
    closeContextMenu: () => {},
    previewSeek: (seconds) => calls.previewSeek.push(seconds),
    restoreConfirmedTransportVisual: () => {},
    updateCameraX: (cameraX) => {
      calls.updateCameraX.push(cameraX);
      return cameraX;
    },
    commitSeek: (seconds) => calls.commitSeek.push(seconds),
    clearSelection: () => {
      calls.clearSelection += 1;
    },
  };

  const surface = document.createElement("div");
  Object.defineProperty(surface, "offsetWidth", { value: 800 });
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }) as DOMRect;
  document.body.append(surface);

  return {
    calls,
    begin: createTimelineBackgroundSeek(() => deps),
    press: (clientX: number) =>
      ({
        clientX,
        clientY: 200,
        currentTarget: surface,
        preventDefault: () => {},
      }) as unknown as ReactMouseEvent<HTMLElement>,
  };
}

function mouse(type: "mousemove" | "mouseup", clientX: number, clientY = 200) {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

function touchStart(count: number) {
  const event = new Event("touchstart", { bubbles: true });
  Object.defineProperty(event, "touches", { value: new Array(count).fill({}) });
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("fondo del timeline en táctil", () => {
  it("no mueve el cabezal al apoyar el dedo", () => {
    const { begin, calls, press } = setup();

    begin(press(400));

    expect(calls.previewSeek).toEqual([]);
    expect(calls.commitSeek).toEqual([]);
  });

  it("salta al soltar si el toque fue limpio", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mouseup", 400));

    expect(calls.commitSeek).toEqual([10]); // 400px / 40px por segundo
  });

  it("no desplaza la cámara: eso es del gesto de dos dedos", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mousemove", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    expect(calls.updateCameraX).toEqual([]);
    // Se movió, así que tampoco es un toque: no salta.
    expect(calls.commitSeek).toEqual([]);
  });

  // Lo que rompía la pinza: el segundo dedo llega y el WebView deja de emitir
  // eventos de ratón, así que sin esto el toque quedaba armado indefinidamente
  // y saltaba con el siguiente `mouseup` que pasara por ahí.
  it("se cae en cuanto aterriza un segundo dedo", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(touchStart(2));
    window.dispatchEvent(mouse("mouseup", 400));

    expect(calls.commitSeek).toEqual([]);
  });

  // Con el dedo no hay Escape: si el toque en el fondo no deselecciona, la
  // pista se queda marcada para siempre.
  it("un toque limpio deselecciona", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mouseup", 400));

    expect(calls.clearSelection).toBe(1);
  });

  it("arrastrar no deselecciona: eso es mover la vista, no un toque", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mousemove", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    expect(calls.clearSelection).toBe(0);
  });

  it("un solo dedo no cancela el toque", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(touchStart(1));
    window.dispatchEvent(mouse("mouseup", 400));

    expect(calls.commitSeek).toEqual([10]);
  });
});
