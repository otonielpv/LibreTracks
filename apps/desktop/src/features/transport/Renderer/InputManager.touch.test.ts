import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InputManager } from "./InputManager";

/**
 * Gesto de dos dedos del timeline (móvil).
 *
 * Lo que se comprueba aquí no es "el zoom cambia", sino las propiedades por las
 * que el gesto se sentía tosco en el teléfono:
 *
 *  1. un gesto o desplaza o hace zoom, nunca los dos — mezclarlos hacía que
 *     mover en horizontal hiciera zoom por el camino;
 *  2. el material se queda pegado a los dedos (lazo cerrado contra el ancla), y
 *     unos dedos temblorosos no acumulan deriva;
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

function setup(options?: { canZoom?: boolean; getGestureBounds?: () => DOMRect | null }) {
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
    getGestureBounds: options?.getGestureBounds,
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


/** touchstart con los dos dedos donde se indique. */
function start(container: HTMLElement, x1: number, x2: number, y = 200) {
  container.dispatchEvent(
    touchEvent("touchstart", [touch(1, { x: x1, y }), touch(2, { x: x2, y })]),
  );
}

function move(container: HTMLElement, x1: number, x2: number, y = 200) {
  container.dispatchEvent(
    touchEvent("touchmove", [touch(1, { x: x1, y }), touch(2, { x: x2, y })]),
  );
}

describe("InputManager: gesto de dos dedos", () => {
  // El gesto decide UNA vez qué está haciendo y se queda con ello. Mezclar los
  // dos —aunque el zoom llevara zona muerta— era lo que hacía que mover en
  // horizontal hiciera zoom por el camino: dos dedos que recorren la pantalla
  // nunca mantienen su separación.
  it("no hace nada hasta que el gesto se decide", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    // 6 px de recorrido: por debajo del umbral de decisión.
    move(container, 306, 506);

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });

  it("un desplazamiento largo no hace zoom aunque los dedos deriven", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    // Decide: el punto medio recorre 100 px y la separación no cambia.
    move(container, 200, 400);
    // Y ahora los dedos derivan un 25% mientras se sigue desplazando. Antes
    // esto era zoom: la zona muerta sólo descontaba un 3%.
    move(container, 50, 300);

    expect(state.zoomLevel).toBe(1);
    expect(state.cameraX).toBeGreaterThan(0);
  });

  it("una pinza no arrastra el material aunque los dedos deriven", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    // Decide zoom: la separación crece 100 px y el punto medio no se mueve.
    move(container, 250, 550);
    const anchored = contentUnitsAt(state, 400);

    // Se sigue separando Y el punto medio deriva 60 px a la izquierda.
    move(container, 130, 550);

    expect(state.zoomLevel).toBeGreaterThan(1.1);
    // El material bajo el punto medio ANCLADO sigue donde estaba: la deriva no
    // se convirtió en desplazamiento.
    expect(contentUnitsAt(state, 400)).toBeCloseTo(anchored, 6);
  });

  it("mantiene el contenido pegado al punto medio al hacer pinza", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    const anchored = contentUnitsAt(state, 400);
    move(container, 250, 550); // decide zoom y re-ancla
    move(container, 100, 700); // separación x2 respecto al ancla

    expect(state.zoomLevel).toBeGreaterThan(1.9);
    expect(contentUnitsAt(state, 400)).toBeCloseTo(anchored, 6);
  });

  it("desplaza siguiendo el punto medio de los dedos", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    move(container, 250, 450); // decide pan (50 px de recorrido)
    move(container, 150, 350); // 100 px mas

    expect(state.zoomLevel).toBe(1);
    expect(state.cameraX).toBeCloseTo(100, 6);
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
    start(container, 300, 500);

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

    move(container, 100, 300);

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });

  it("confirma cámara y zoom al levantar los dedos, sin esperar al antirrebote", () => {
    const { container, commits } = setup();

    start(container, 300, 500);
    move(container, 250, 550); // decide zoom
    move(container, 100, 700);
    container.dispatchEvent(touchEvent("touchend", []));

    expect(commits.zoom).toHaveLength(1);
    expect(commits.camera).toHaveLength(1);
  });

  // Petición explícita tras probar en un iPhone 13: con dos dedos el
  // desplazamiento vertical se pisaba con el nativo del carril de pistas. El
  // vertical es del gesto de UN dedo; dos dedos son cámara y zoom, nada más.
  it("no desplaza en vertical: eso es del gesto de un dedo", () => {
    const { container, verticalScroll } = setup();

    start(container, 300, 500);
    move(container, 250, 450, 200); // decide pan
    move(container, 150, 350, 80); // y ahora tambien sube 120 px

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
    const begin = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(begin, "targetTouches", { value: [a, b] });
    Object.defineProperty(begin, "touches", { value: [a, b] });
    container.dispatchEvent(begin);

    // El repintado se lleva el elemento: `targetTouches` se queda vacío.
    child.remove();
    for (const [x1, x2] of [
      [250, 550],
      [100, 700],
    ]) {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "targetTouches", { value: [] });
      Object.defineProperty(event, "touches", {
        value: [touch(1, { x: x1, y: 200 }), touch(2, { x: x2, y: 200 })],
      });
      container.dispatchEvent(event);
    }

    expect(state.zoomLevel).toBeGreaterThan(1.9);
  });

  it("re-siembra el ancla si cambia el par de dedos, sin saltar", () => {
    const { container, state } = setup();

    start(container, 300, 500);
    move(container, 250, 550);
    move(container, 100, 700);
    const zoomBefore = state.zoomLevel;
    const cameraBefore = state.cameraX;

    // Entra un tercer dedo y sale el primero: el par pasa a ser (2, 3).
    container.dispatchEvent(
      touchEvent("touchmove", [touch(2, { x: 700, y: 200 }), touch(3, { x: 750, y: 200 })]),
    );

    expect(state.zoomLevel).toBe(zoomBefore);
    expect(state.cameraX).toBe(cameraBefore);
  });
});

/**
 * El mismo gesto, contra el DOM que hay de verdad debajo del dedo.
 *
 * El bloque de arriba despacha todo sobre el contenedor y con `targetTouches`
 * igual a `touches`. En el timeline real eso no pasa nunca: el área de pistas
 * es un `div` por carril y la regla lleva encima banderas y asas, así que dos
 * dedos aterrizan casi siempre en elementos DISTINTOS, y el navegador entrega
 * cada `touchmove` al elemento donde EMPEZÓ ese dedo, no al contenedor.
 */
describe("InputManager: gesto de dos dedos sobre el DOM real", () => {
  /** Un toque con destino propio, como el que fabrica el navegador. */
  function targetedTouch(identifier: number, x: number, target: EventTarget) {
    return { identifier, clientX: x, clientY: 200, target } as unknown as Touch;
  }

  /** Despacha como el navegador: sobre el elemento del toque que cambia, con
   * `targetTouches` filtrado a los que comparten ESE destino. */
  function dispatchAt(type: string, on: EventTarget, all: Touch[]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: all });
    Object.defineProperty(event, "targetTouches", {
      value: all.filter((each) => (each as Touch & { target: EventTarget }).target === on),
    });
    (on as HTMLElement).dispatchEvent(event);
    return event;
  }

  function lanes(container: HTMLElement, count = 3) {
    return Array.from({ length: count }, () => {
      const lane = document.createElement("div");
      container.append(lane);
      return lane;
    });
  }

  it("arranca con los dedos en carriles distintos", () => {
    const { container, state } = setup();
    const [laneA, laneB] = lanes(container);

    const a = targetedTouch(1, 300, laneA);
    const b = targetedTouch(2, 500, laneB);
    dispatchAt("touchstart", laneA, [a]);
    dispatchAt("touchstart", laneB, [a, b]);

    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 250, laneA),
      targetedTouch(2, 450, laneB),
    ]);
    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 150, laneA),
      targetedTouch(2, 350, laneB),
    ]);

    expect(state.cameraX).toBeCloseTo(100, 6);
  });

  // Lo que se vio en un iPhone 13: a media pinza React rehace la regla, el
  // elemento bajo el dedo deja de estar en el documento y el WebView reapunta
  // el evento hacia arriba. Si el gesto sólo escucha en su contenedor, ese
  // evento le pasa por encima y el gesto se muere con los dedos aún puestos.
  it("sigue vivo cuando React se lleva el elemento bajo el dedo", () => {
    const { container, state } = setup();
    const [laneA] = lanes(container);

    const a = targetedTouch(1, 300, laneA);
    const b = targetedTouch(2, 500, laneA);
    dispatchAt("touchstart", laneA, [a, b]);

    // El repintado se lleva el carril. Los toques conservan su destino muerto
    // (no se actualiza nunca) y el evento sube por encima del contenedor.
    laneA.remove();
    for (const [x1, x2] of [
      [250, 550],
      [100, 700],
    ]) {
      dispatchAt("touchmove", document.body, [
        targetedTouch(1, x1, laneA),
        targetedTouch(2, x2, laneA),
      ]);
    }

    expect(state.zoomLevel).toBeGreaterThan(1.9);
  });

  it("un tercer dedo no reinicia el gesto en marcha", () => {
    const { container, state } = setup();
    const [laneA, laneB] = lanes(container);

    dispatchAt("touchstart", laneA, [targetedTouch(1, 300, laneA)]);
    dispatchAt("touchstart", laneB, [
      targetedTouch(1, 300, laneA),
      targetedTouch(2, 500, laneB),
    ]);
    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 250, laneA),
      targetedTouch(2, 450, laneB),
    ]);

    // Se apoya el pulgar sujetando el teléfono. El gesto ya está decidido y
    // anclado: tiene que seguir donde estaba, no volver a empezar.
    dispatchAt("touchstart", laneB, [
      targetedTouch(1, 250, laneA),
      targetedTouch(2, 450, laneB),
      targetedTouch(3, 700, laneB),
    ]);
    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 150, laneA),
      targetedTouch(2, 350, laneB),
      targetedTouch(3, 700, laneB),
    ]);

    expect(state.cameraX).toBeCloseTo(100, 6);
  });

  // Si el primer dedo llegó a arrancar el desplazamiento nativo del carril, el
  // WebView ya no lo suelta: el touchstart del segundo llega sin poder
  // prevenirse. Mover además la cámara es el "se pisan", así que el gesto ni
  // nace: hay que levantar y volver a apoyar.
  it("no nace si el navegador ya se ha quedado el gesto", () => {
    const { container, state } = setup();
    const [laneA] = lanes(container);

    const stolen = new Event("touchstart", { bubbles: true, cancelable: false });
    const fingers = [targetedTouch(1, 300, laneA), targetedTouch(2, 500, laneA)];
    Object.defineProperty(stolen, "touches", { value: fingers });
    Object.defineProperty(stolen, "targetTouches", { value: fingers });
    laneA.dispatchEvent(stolen);

    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 250, laneA),
      targetedTouch(2, 450, laneA),
    ]);
    dispatchAt("touchmove", laneA, [
      targetedTouch(1, 150, laneA),
      targetedTouch(2, 350, laneA),
    ]);

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });

  it("no cuenta un dedo fuera de la parte VISIBLE del área de pistas", () => {
    const visible = {
      left: 0,
      top: 0,
      right: 800,
      bottom: 300,
      width: 800,
      height: 300,
    } as DOMRect;
    const { container, state } = setup({ getGestureBounds: () => visible });
    const [laneA] = lanes(container);

    // El contenedor llega a 400; el visor se corta en 300.
    const resting = {
      identifier: 1,
      clientX: 500,
      clientY: 360,
      target: laneA,
    } as unknown as Touch;
    dispatchAt("touchstart", laneA, [resting, targetedTouch(2, 500, laneA)]);
    // Dos muestras: la primera sólo decidiría el modo, así que con una sola
    // este test no sabría distinguir el filtro de la fase de decisión.
    dispatchAt("touchmove", laneA, [resting, targetedTouch(2, 300, laneA)]);
    dispatchAt("touchmove", laneA, [resting, targetedTouch(2, 100, laneA)]);

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });

  it("no cuenta un dedo apoyado FUERA del contenedor", () => {
    const { container, state } = setup();
    const [laneA] = lanes(container);
    const outside = document.createElement("div");
    document.body.append(outside);

    // Un dedo descansando por debajo del contenedor (la barra de transporte,
    // una cabecera de pista): no es la mitad de un gesto de cámara.
    const resting = { identifier: 1, clientX: 500, clientY: 520, target: outside } as unknown as Touch;
    const inside = targetedTouch(2, 500, laneA);
    dispatchAt("touchstart", laneA, [resting, inside]);
    // Dos muestras: con una sola, el gesto ni siquiera habría salido de la fase
    // de decisión y el test pasaría aunque el filtro no hiciera nada.
    dispatchAt("touchmove", laneA, [resting, targetedTouch(2, 300, laneA)]);
    dispatchAt("touchmove", laneA, [resting, targetedTouch(2, 100, laneA)]);

    expect(state.cameraX).toBe(0);
    expect(state.zoomLevel).toBe(1);
  });
});
