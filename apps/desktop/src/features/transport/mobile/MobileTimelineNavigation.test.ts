// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTimelineNavigation, type MobileNavigationOptions } from "./MobileTimelineNavigation";

function pointer(target: EventTarget, type: string, id: number, x: number, y: number, pointerType = "touch") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
  target.dispatchEvent(event);
}
const managers: MobileTimelineNavigation[] = [];
function setup(extra: Partial<MobileNavigationOptions> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  Object.defineProperties(container, { offsetWidth: { value: 400 }, offsetHeight: { value: 800 } });
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect;
  let enabled = true;
  let change = () => {};
  const state = { cameraX: 100, zoomLevel: 1, canZoom: true };
  const commit = vi.fn(), zoomCommit = vi.fn(), vertical = vi.fn();
  const manager = new MobileTimelineNavigation({ container, enabled: () => enabled,
    subscribe: (callback) => { change = callback; return () => {}; }, getState: () => state,
    onPreviewCameraX: (camera) => (state.cameraX = Math.max(0, camera)), onCommitCameraX: commit,
    onPreviewZoom: (zoom) => ({ cameraX: state.cameraX, zoomLevel: (state.zoomLevel = zoom) }), onCommitZoom: zoomCommit,
    onScrollVertical: vertical, ...extra,
  });
  managers.push(manager);
  return { container, state, commit, zoomCommit, vertical, edit: () => { enabled = false; change(); } };
}
afterEach(() => { managers.splice(0).forEach((manager) => manager.destroy()); document.body.innerHTML = ""; });

describe("mobile timeline navigation", () => {
  it("pans both axes without starting content editing or a compatibility click", () => {
    const s = setup(); const edit = vi.fn(); s.container.addEventListener("pointerdown", edit); s.container.addEventListener("mousedown", edit); s.container.addEventListener("click", edit);
    expect(s.container.classList.contains("lt-mobile-navigation-surface")).toBe(true);
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 70, 60);
    expect(s.state.cameraX).toBe(130); expect(s.vertical).toHaveBeenCalledWith(40);
    pointer(window, "pointerup", 1, 70, 60);
    s.container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); s.container.click();
    expect(edit).not.toHaveBeenCalled(); expect(s.commit).toHaveBeenLastCalledWith(130);
  });
  it("keeps the same content under the pinch midpoint and continues after one finger lifts", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100); pointer(s.container, "pointerdown", 2, 200, 100);
    pointer(window, "pointermove", 2, 300, 100);
    expect(s.state.zoomLevel).toBe(2);
    expect((s.state.cameraX + 200) / s.state.zoomLevel).toBe(250);
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
