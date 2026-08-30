import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InputManager } from "./InputManager";

/**
 * Gesto de dos dedos del timeline (móvil).
 *
 * Lo que se comprueba aquí no es "el zoom cambia", sino las tres propiedades por
 * las que el gesto se sentía tosco en el teléfono:
 *
 *  1. el material se queda pegado a los dedos (lazo cerrado contra el origen),
 *  2. un desplazamiento a dos dedos no hace micro-zoom (zona muerta continua),
 *  3. el arrastre de un dedo que ya estaba en vuelo se CANCELA en vez de seguir
 *     peleando con la cámara.
 */

const BASE_PIXELS_PER_SECOND = 1; // el manager trabaja en niveles de zoom

type Vec = { x: number; y: number };

function touch(identifier: number, { x, y }: Vec) {
  return { identifier, clientX: x, clientY: y } as unknown as Touch;
}

/** jsdom no implementa TouchEvent; el manager sólo lee `targetTouches` y
 * `preventDefault`, así que un Event normal con esa propiedad basta. */
function touchEvent(type: string, touches: Touch[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "targetTouches", { value: touches });
  Object.defineProperty(event, "touches", { value: touches });
  return event;
}

/** Un `touchmove` que el navegador ya no deja cancelar: ha decidido desplazar
 * el carril de pistas él mismo (`touch-action: pan-y`). */
function uncancelableTouchMove(touches: Touch[]) {
  const event = new Event("touchmove", { bubbles: true, cancelable: false });
  Object.defineProperty(event, "targetTouches", { value: touches });
  Object.defineProperty(event, "touches", { value: touches });
  return event;
}

function setup(options?: { canZoom?: boolean }) {
  const container = document.createElement("div");
  Object.defineProperty(container, "offsetWidth", { value: 800 });
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }) as DOMRect;
  document.body.append(container);

  const state = { cameraX: 0, zoomLevel: 1 };
  const commits = { camera: [] as number[], zoom: [] as number[] };
  const verticalScroll: number[] = [];

  const manager = new InputManager({
    container,
    getState: () => ({
      cameraX: state.cameraX,
      zoomLevel: state.zoomLevel,
      trackHeight: 80,
      canZoom: options?.canZoom ?? true,
      navigationScheme: "ableton",
    }),
    dragThresholdPx: 6,
    panCommitDelayMs: 100,
    zoomCommitDelayMs: 100,
    zoomMultiplier: 1.2,
    trackHeightStep: 10,
    trackHeightMin: 20,
    trackHeightMax: 400,
    onPreviewCameraX: (cameraX) => {
      state.cameraX = cameraX;
      return cameraX;
    },
    onCommitCameraX: (cameraX) => commits.camera.push(cameraX),
    onPreviewZoom: (zoomLevel) => {
      state.zoomLevel = zoomLevel;
      return { cameraX: state.cameraX, zoomLevel };
    },
    onCommitZoom: (view) => commits.zoom.push(view.zoomLevel),
    onTrackHeightChange: () => {},
    onScrollVertical: (deltaY) => verticalScroll.push(deltaY),
  });

  return { container, manager, state, commits, verticalScroll };
}

/** Segundo (unidad de contenido) que cae bajo una X de pantalla. */
function contentUnitsAt(state: { cameraX: number; zoomLevel: number }, screenX: number) {
  return (state.cameraX + screenX) / (state.zoomLevel * BASE_PIXELS_PER_SECOND);
}

/** jsdom no trae PointerEvent; el gesto sintetiza `pointercancel` con el. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

beforeEach(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: TestPointerEvent,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("InputManager: gesto de dos dedos", () => {
  it("mantiene el contenido pegado al punto medio al hacer pinza", () => {
    const { container, state } = setup();

    // Dedos a 300 y 500: punto medio en 400.
    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    const anchored = contentUnitsAt(state, 400);

    // Se separan a 200 y 600 (x2) sin mover el punto medio.
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 200, y: 200 }), touch(2, { x: 600, y: 200 })]),
    );

    expect(state.zoomLevel).toBeGreaterThan(1.8);
    expect(contentUnitsAt(state, 400)).toBeCloseTo(anchored, 6);
  });

  it("sigue anclado cuando la pinza se mueve a la vez", () => {
    const { container, state } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    const anchored = contentUnitsAt(state, 400);

    // Se separan a x2 Y el punto medio se desplaza de 400 a 250.
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 50, y: 200 }), touch(2, { x: 450, y: 200 })]),
    );

    // El material que estaba bajo 400 tiene que estar ahora bajo 250: es lo que
    // la suma de deltas incrementales no conseguía (se estorbaban).
    expect(contentUnitsAt(state, 250)).toBeCloseTo(anchored, 6);
  });

  it("no hace micro-zoom durante un desplazamiento a dos dedos", () => {
    const { container, state } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );

    // Desplazamiento de 100px con los dedos temblando un 1% (198 -> 202px).
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 201, y: 200 }), touch(2, { x: 399, y: 200 })]),
    );

    expect(state.zoomLevel).toBe(1);
    expect(state.cameraX).toBeCloseTo(100, 6);
  });

  it("aplica el zoom de forma continua al salir de la zona muerta", () => {
    const { container, state } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    // Justo por encima del 3% de zona muerta: el zoom debe arrancar desde ~1,
    // no saltar de golpe al 3% acumulado.
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 296.9, y: 200 }), touch(2, { x: 503.1, y: 200 })]),
    );

    expect(state.zoomLevel).toBeGreaterThan(1);
    expect(state.zoomLevel).toBeLessThan(1.005);
  });

  it("cancela el arrastre de un dedo que estaba en vuelo", () => {
    const { container } = setup();
    const child = document.createElement("button");
    container.append(child);

    const cancelled: number[] = [];
    window.addEventListener("pointercancel", (event) => {
      cancelled.push((event as PointerEvent).pointerId);
    });

    child.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", bubbles: true }),
    );
    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );

    expect(cancelled).toContain(7);
  });

  it("ignora los dedos que no están sobre este contenedor", () => {
    const { container, state } = setup();

    // `touches` tiene dos, `targetTouches` sólo uno: un dedo descansa fuera.
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "targetTouches", {
      value: [touch(1, { x: 300, y: 200 })],
    });
    Object.defineProperty(event, "touches", {
      value: [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })],
    });
    container.dispatchEvent(event);

    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 100, y: 200 }), touch(2, { x: 300, y: 200 })]),
    );

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });

  it("confirma cámara y zoom al levantar los dedos, sin esperar al antirrebote", () => {
    const { container, commits } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 200, y: 200 }), touch(2, { x: 600, y: 200 })]),
    );
    container.dispatchEvent(touchEvent("touchend", []));

    expect(commits.zoom).toHaveLength(1);
    expect(commits.camera).toHaveLength(1);
  });

  // Petición explícita tras probar en un iPhone 13: con dos dedos el
  // desplazamiento vertical se pisaba con el nativo del carril de pistas. El
  // vertical es del gesto de UN dedo; dos dedos son cámara y zoom, nada más.
  it("no desplaza en vertical: eso es del gesto de un dedo", () => {
    const { container, verticalScroll } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    container.dispatchEvent(
      touchEvent("touchmove", [
        touch(1, { x: 300, y: 120 }),
        touch(2, { x: 500, y: 120 }),
      ]),
    );

    expect(verticalScroll).toEqual([]);
  });

  // El destino de un toque se fija al tocar y no se actualiza. Cuando React
  // repinta la regla a mitad de pinza (cambia el zoom, se rehacen las
  // banderas), ese elemento sale del documento y con él el toque de
  // `targetTouches`: el gesto se moría solo. Los identificadores no.
  it("sobrevive a que React repinte el elemento bajo el dedo", () => {
    const { container, state } = setup();
    const child = document.createElement("div");
    container.append(child);

    const a = touch(1, { x: 300, y: 200 });
    const b = touch(2, { x: 500, y: 200 });
    const start = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(start, "targetTouches", { value: [a, b] });
    Object.defineProperty(start, "touches", { value: [a, b] });
    container.dispatchEvent(start);

    // El repintado se lleva el elemento: `targetTouches` se queda vacío.
    child.remove();
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    const movedA = touch(1, { x: 200, y: 200 });
    const movedB = touch(2, { x: 600, y: 200 });
    Object.defineProperty(move, "targetTouches", { value: [] });
    Object.defineProperty(move, "touches", { value: [movedA, movedB] });
    container.dispatchEvent(move);

    expect(state.zoomLevel).toBeGreaterThan(1.8);
  });

  it("re-siembra el ancla si cambia el par de dedos, sin saltar", () => {
    const { container, state } = setup();

    container.dispatchEvent(
      touchEvent("touchstart", [touch(1, { x: 300, y: 200 }), touch(2, { x: 500, y: 200 })]),
    );
    container.dispatchEvent(
      touchEvent("touchmove", [touch(1, { x: 200, y: 200 }), touch(2, { x: 600, y: 200 })]),
    );
    const zoomBefore = state.zoomLevel;
    const cameraBefore = state.cameraX;

    // Entra un tercer dedo y sale el primero: el par pasa a ser (2, 3).
    container.dispatchEvent(
      touchEvent("touchmove", [touch(2, { x: 600, y: 200 }), touch(3, { x: 700, y: 200 })]),
    );

    expect(state.zoomLevel).toBe(zoomBefore);
    expect(state.cameraX).toBe(cameraBefore);
  });
});
