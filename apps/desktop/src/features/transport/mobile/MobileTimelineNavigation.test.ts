// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobileTimelineNavigation,
  isNativeTouchControl,
  type MobileNavigationOptions,
} from "./MobileTimelineNavigation";

function pointer(target: EventTarget, type: string, id: number, x: number, y: number, pointerType = "touch") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
  target.dispatchEvent(event);
}
const managers: MobileTimelineNavigation[] = [];
function setup(extra: Partial<MobileNavigationOptions> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  Object.defineProperties(container, { offsetWidth: { value: 400 }, offsetHeight: { value: 800 } });
  const measures = vi.fn(() => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect);
  container.getBoundingClientRect = measures;
  let enabled = true;
  let change = () => {};
  const state = { cameraX: 100, zoomLevel: 1, canZoom: true };
  const commit = vi.fn(), zoomCommit = vi.fn(), vertical = vi.fn(), verticalSeed = vi.fn();
  const manager = new MobileTimelineNavigation({ container, enabled: () => enabled,
    subscribe: (callback) => { change = callback; return () => {}; }, getState: () => state,
    onPreviewCameraX: (camera) => (state.cameraX = Math.max(0, camera)), onCommitCameraX: commit,
    onPreviewZoom: (zoom) => ({ cameraX: state.cameraX, zoomLevel: (state.zoomLevel = zoom) }), onCommitZoom: zoomCommit,
    onScrollVertical: vertical, onScrollVerticalSeed: verticalSeed, ...extra,
  });
  managers.push(manager);
  return { container, state, commit, zoomCommit, vertical, verticalSeed, measures, edit: () => { enabled = false; change(); } };
}
afterEach(() => { managers.splice(0).forEach((manager) => manager.destroy()); document.body.innerHTML = ""; });

describe("mobile timeline navigation", () => {
  it("pans without starting content editing or a compatibility click", () => {
    const s = setup(); const edit = vi.fn(); s.container.addEventListener("pointerdown", edit); s.container.addEventListener("mousedown", edit); s.container.addEventListener("click", edit);
    expect(s.container.classList.contains("lt-mobile-navigation-surface")).toBe(true);
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 70, 96);
    expect(s.state.cameraX).toBe(130);
    pointer(window, "pointerup", 1, 70, 96);
    s.container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); s.container.click();
    expect(edit).not.toHaveBeenCalled(); expect(s.commit).toHaveBeenLastCalledWith(130);
  });
  it("keeps the same content under the pinch midpoint and continues after one finger lifts", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100); pointer(s.container, "pointerdown", 2, 200, 100);
    pointer(window, "pointermove", 2, 300, 100);
    expect(s.state.zoomLevel).toBe(2);
    // Contra el punto medio ANCLADO (150), no contra el actual: la pinza no
    // desplaza.
    expect((s.state.cameraX + 150) / s.state.zoomLevel).toBe(250);
    pointer(window, "pointerup", 2, 300, 100);
    const camera = s.state.cameraX;
    pointer(window, "pointermove", 1, 80, 100);
    expect(s.state.cameraX).toBe(camera + 20);
    expect(s.zoomCommit).toHaveBeenCalled();
  });
  it("cancellation ends navigation; editing mode leaves pointer events alone", () => {
    const s = setup(); pointer(s.container, "pointerdown", 1, 100, 100); pointer(window, "pointercancel", 1, 100, 100);
    pointer(window, "pointermove", 1, 0, 0); expect(s.state.cameraX).toBe(100);
    s.edit(); expect(s.container.classList.contains("lt-mobile-navigation-surface")).toBe(false);
    const edit = vi.fn(); s.container.addEventListener("pointerdown", edit);
    pointer(s.container, "pointerdown", 2, 20, 20); expect(edit).toHaveBeenCalledOnce();
  });
  it("does not intercept a mouse on a tablet", () => {
    const s = setup(); const down = vi.fn(); s.container.addEventListener("pointerdown", down);
    pointer(s.container, "pointerdown", 1, 50, 50, "mouse"); expect(down).toHaveBeenCalledOnce();
  });
});

describe("tocar selecciona; arrastrar lo ya seleccionado edita", () => {
  it("avisa de un toque limpio y no lo confunde con un arrastre", () => {
    const onTap = vi.fn();
    const s = setup({ onTap });
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointerup", 1, 100, 100);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0].slice(0, 2)).toEqual([100, 100]);

    onTap.mockClear();
    pointer(s.container, "pointerdown", 2, 100, 100);
    pointer(window, "pointermove", 2, 40, 100);
    pointer(window, "pointerup", 2, 40, 100);
    expect(onTap).not.toHaveBeenCalled();
  });

  // Al levantar el primer dedo de una pinza el gesto se re-ancla con el que
  // queda, y ese ancla nace "sin mover": soltarlo salia por la puerta del toque
  // limpio y seleccionaba el clip que tuviera debajo.
  it("soltar una pinza no cuenta como toque", () => {
    const onTap = vi.fn();
    const s = setup({ onTap });
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(s.container, "pointerdown", 2, 200, 100);
    pointer(window, "pointermove", 2, 300, 100);
    pointer(window, "pointerup", 2, 300, 100);
    pointer(window, "pointerup", 1, 100, 100);

    expect(onTap).not.toHaveBeenCalled();

    // Y el gesto siguiente vuelve a poder ser un toque.
    pointer(s.container, "pointerdown", 3, 100, 100);
    pointer(window, "pointerup", 3, 100, 100);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("cede el gesto entero cuando el toque cae sobre algo ya seleccionado", () => {
    const s = setup({ shouldEdit: () => true });
    const down = vi.fn();
    const mouse = vi.fn();
    s.container.addEventListener("pointerdown", down);
    s.container.addEventListener("mousedown", mouse);

    pointer(s.container, "pointerdown", 1, 100, 100);
    // El handler de arrastre existente recibe el evento...
    expect(down).toHaveBeenCalledOnce();
    // ...y su mousedown de compatibilidad NO se suprime.
    s.container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mouse).toHaveBeenCalledOnce();
    // La camara no se movio: la navegacion no toco este gesto.
    pointer(window, "pointermove", 1, 40, 100);
    expect(s.state.cameraX).toBe(100);
    pointer(window, "pointerup", 1, 40, 100);
  });

  it("vuelve a navegar en el gesto siguiente al cedido", () => {
    let edit = true;
    const s = setup({ shouldEdit: () => edit });
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointerup", 1, 100, 100);
    edit = false;
    pointer(s.container, "pointerdown", 2, 100, 100);
    pointer(window, "pointermove", 2, 70, 100);
    expect(s.state.cameraX).toBe(130);
  });
});

describe("un dedo desplaza en un solo eje", () => {
  it("un barrido horizontal no arrastra el carril vertical", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 70, 96);
    expect(s.state.cameraX).toBe(130);
    expect(s.vertical).not.toHaveBeenCalled();
  });

  it("un barrido vertical no arrastra la camara", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 96, 60);
    expect(s.vertical).toHaveBeenCalledWith(40);
    expect(s.state.cameraX).toBe(100);
    pointer(window, "pointerup", 1, 96, 60);
    // Ni se confirma una camara que nadie movio.
    expect(s.commit).not.toHaveBeenCalled();
  });

  it("el eje no cambia a media pasada", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 96, 60);
    // El dedo se va ahora en horizontal: el gesto sigue siendo vertical.
    pointer(window, "pointermove", 1, 20, 40);
    expect(s.state.cameraX).toBe(100);
    expect(s.vertical).toHaveBeenLastCalledWith(20);
  });

  // Dos dedos nunca mantienen su punto medio: si la camara se resuelve contra
  // el punto medio actual, el material se va de lado (y de paso hacia arriba)
  // mientras se hace zoom.
  it("la pinza solo hace zoom: ni desplaza de lado ni en vertical", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(s.container, "pointerdown", 2, 200, 100);
    // Los dedos se separan Y se van los dos hacia arriba y a la derecha.
    pointer(window, "pointermove", 1, 140, 40);
    pointer(window, "pointermove", 2, 360, 40);

    expect(s.state.zoomLevel).toBeGreaterThan(1);
    expect(s.vertical).not.toHaveBeenCalled();
    // El contenido anclado sigue bajo el punto medio del arranque.
    expect((s.state.cameraX + 150) / s.state.zoomLevel).toBeCloseTo(250, 6);
  });
});

describe("el gesto no paga un reflujo por muestra", () => {
  it("mide el contenedor al anclar, no en cada movimiento", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    const afterSeed = s.measures.mock.calls.length;
    pointer(window, "pointermove", 1, 90, 100);
    pointer(window, "pointermove", 1, 80, 100);
    pointer(window, "pointermove", 1, 70, 100);
    expect(s.measures.mock.calls.length).toBe(afterSeed);
  });

  it("avisa de cada anclaje para que el desplazamiento se re-sincronice", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    expect(s.verticalSeed).toHaveBeenCalledTimes(1);
    pointer(s.container, "pointerdown", 2, 200, 100);
    expect(s.verticalSeed).toHaveBeenCalledTimes(2);
    pointer(window, "pointermove", 2, 300, 100);
    expect(s.verticalSeed).toHaveBeenCalledTimes(2);
  });
});

describe("los controles de verdad que viven dentro del timeline", () => {
  it("se reconocen por la marca, tambien desde un hijo", () => {
    const button = document.createElement("button");
    button.setAttribute("data-lt-native-touch", "");
    const icon = document.createElement("span");
    button.append(icon);

    expect(isNativeTouchControl(button)).toBe(true);
    expect(isNativeTouchControl(icon)).toBe(true);
  });

  it("el fondo del timeline no lo es", () => {
    expect(isNativeTouchControl(document.createElement("div"))).toBe(false);
    expect(isNativeTouchControl(null)).toBe(false);
  });

  it("la navegacion no toca su pointerdown: sin eso no hay click", () => {
    // El gesto se le pasa ENTERO al navegador —ni se cede con `yielding` ni se
    // registra—, que es lo unico que devuelve un click de verdad.
    const { container } = setup();
    const button = document.createElement("button");
    button.setAttribute("data-lt-native-touch", "");
    container.append(button);

    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: "touch" },
    });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
