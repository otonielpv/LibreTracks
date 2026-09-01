// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTimelineBackgroundSeek } from "./timelineBackgroundSeek";
import type { TimelineBackgroundSeekDeps } from "./timelineBackgroundSeek";
import type { MouseEvent as ReactMouseEvent } from "react";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
}));

/**
 * El fondo del timeline con ratón: pulsar salta ahí y arrastrar desplaza la
 * cámara. El reparto táctil vive en ./timelineBackgroundSeek.test.ts.
 *
 * Lo que se comprueba aquí es la frontera entre las dos cosas para la
 * DESELECCIÓN: un clic limpio quita la selección (antes sólo la quitaba
 * Escape), pero mover la vista tiene que conservarla.
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

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("fondo del timeline con ratón", () => {
  it("un clic limpio salta y deselecciona", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mouseup", 400));

    expect(calls.commitSeek).toEqual([10]); // 400px / 40px por segundo
    expect(calls.clearSelection).toBe(1);
  });

  it("apoyar el ratón todavía no deselecciona", () => {
    const { begin, calls, press } = setup();

    begin(press(400));

    // El cabezal ya se ha adelantado, pero la selección aguanta: el gesto
    // puede acabar siendo un desplazamiento de cámara.
    expect(calls.previewSeek).toEqual([10]);
    expect(calls.clearSelection).toBe(0);
  });

  it("desplazar la cámara conserva la selección", () => {
    const { begin, calls, press } = setup();

    begin(press(400));
    window.dispatchEvent(mouse("mousemove", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    expect(calls.updateCameraX.length).toBeGreaterThan(0);
    expect(calls.commitSeek).toEqual([]);
    expect(calls.clearSelection).toBe(0);
  });
});
