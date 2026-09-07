import { clientXToLocalX, getElementScaleY } from "../timeline/timelineMath";

type Point = { x: number; y: number };

/**
 * Controles que se pintan DENTRO del area de carriles y tienen que responder
 * como botones normales.
 *
 * La navegacion escucha en captura y hace `preventDefault` +
 * `stopImmediatePropagation` sobre el `pointerdown`, y ademas suprime el
 * `click` de compatibilidad: cualquier boton que viva aqui dentro queda mudo
 * sin decir por que. Le paso el gesto entero al navegador —ni lo cedo con
 * `yielding` ni lo registro—, que es lo unico que devuelve un `click` de
 * verdad.
 */
const NATIVE_CONTROL_SELECTOR = "[data-lt-native-touch]";

function isNativeControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(NATIVE_CONTROL_SELECTOR) !== null
  );
}
export type MobileNavigationOptions = {
  container: HTMLElement;
  enabled: () => boolean;
  subscribe: (onChange: () => void) => () => void;
  getState: () => { cameraX: number; zoomLevel: number; canZoom: boolean };
  onPreviewCameraX: (camera: number) => number;
  onCommitCameraX: (camera: number) => void;
  onPreviewZoom: (zoom: number, anchorX: number) => { cameraX: number; zoomLevel: number } | null;
  onCommitZoom: (view: { cameraX: number; zoomLevel: number }) => void;
  onScrollVertical?: (delta: number) => void;
  /**
   * Si este toque debe EDITAR en vez de navegar. Devuelve true sobre un clip
   * que ya esta seleccionado: entonces la navegacion cede el gesto y corren los
   * handlers de arrastre normales. Asi no hace falta un boton de modo — tocar
   * selecciona, y arrastrar lo ya seleccionado lo mueve.
   */
  shouldEdit?: (clientX: number, clientY: number, target: EventTarget | null) => boolean;
  /** Toque limpio (sin arrastre): el consumidor decide si selecciona o busca. */
  onTap?: (clientX: number, clientY: number, target: EventTarget | null) => void;
};

/** Native mobile browsing owns the canvas BEFORE contact. No React updates per sample.
 *
 * No hay modo navegar/editar: un dedo siempre desplaza el lienzo, salvo que
 * `shouldEdit` reclame el gesto para mover algo ya seleccionado. Un toque sin
 * arrastre sale por `onTap`. Ceder el gesto tiene que decidirse ANTES del
 * primer `pointerdown`, porque una vez que el navegador ha tomado la accion no
 * se puede devolver (ver Pointer Events, `touch-action`). */
export class MobileTimelineNavigation {
  private points = new Map<number, Point>();
  private anchor: { x: number; y: number; distance: number; content: number; zoom: number; moved: boolean } | null = null;
  private zoomView: { cameraX: number; zoomLevel: number } | null = null;
  private camera: number | null = null;
  private lastTouch = -Infinity;
  /** Gesto cedido a la edicion: no lo tocamos ni suprimimos su compat-mouse. */
  private yielding = false;
  private tapTarget: EventTarget | null = null;
  private unsubscribe: () => void;

  constructor(private options: MobileNavigationOptions) {
    options.container.addEventListener("pointerdown", this.down, true);
    options.container.addEventListener("mousedown", this.suppressMouse, true);
    options.container.addEventListener("click", this.suppressMouse, true);
    options.container.addEventListener("contextmenu", this.suppressMouse, true);
    window.addEventListener("pointermove", this.move, { capture: true, passive: false });
    window.addEventListener("pointerup", this.end, true);
    window.addEventListener("pointercancel", this.end, true);
    window.addEventListener("blur", this.cancel);
    this.unsubscribe = options.subscribe(this.syncMode);
    this.syncMode();
  }

  private syncMode = () => {
    this.cancel();
    this.options.container.classList.toggle("lt-mobile-navigation-surface", this.options.enabled());
  };

  private sample() {
    const points = [...this.points.values()].slice(0, 2);
    const a = points[0], b = points[1] ?? a;
    const bounds = this.options.container.getBoundingClientRect();
    return { x: clientXToLocalX((a.x + b.x) / 2, bounds, this.options.container.offsetWidth),
      y: (a.y + b.y) / 2 / getElementScaleY(bounds, this.options.container.offsetHeight),
      distance: points.length > 1 ? Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) : 1 };
  }

  private seed() {
    if (!this.points.size) { this.anchor = null; return; }
    const sample = this.sample();
    const state = this.options.getState();
    this.anchor = { ...sample, zoom: state.zoomLevel, content: (state.cameraX + sample.x) / state.zoomLevel, moved: false };
  }

  private down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !this.options.enabled()) return;
    if (isNativeControl(event.target)) return;
    if (this.yielding) return;
    if (
      this.points.size === 0 &&
      this.options.shouldEdit?.(event.clientX, event.clientY, event.target)
    ) {
      // Cedido: ni preventDefault ni marcar lastTouch, o suprimiriamos el
      // mousedown de compatibilidad del que cuelga el arrastre existente.
      this.yielding = true;
      return;
    }
    this.lastTouch = Date.now();
    event.preventDefault(); event.stopImmediatePropagation();
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.points.size === 1) this.tapTarget = event.target;
    this.options.container.setPointerCapture?.(event.pointerId);
    this.flush(); this.seed();
  };

  private move = (event: PointerEvent) => {
    if (!this.points.has(event.pointerId) || !this.anchor) return;
    event.preventDefault(); event.stopImmediatePropagation();
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const sample = this.sample();
    const anchor = this.anchor;
    if (!anchor.moved && Math.max(Math.abs(sample.x - anchor.x), Math.abs(sample.y - anchor.y), Math.abs(sample.distance - anchor.distance)) < 5) return;
    anchor.moved = true;
    let zoom = this.options.getState().zoomLevel;
    if (this.points.size > 1 && this.options.getState().canZoom) {
      const view = this.options.onPreviewZoom(anchor.zoom * sample.distance / anchor.distance, sample.x);
      if (view) { zoom = view.zoomLevel; this.zoomView = view; }
    }
    this.camera = this.options.onPreviewCameraX(anchor.content * zoom - sample.x);
    this.options.onScrollVertical?.(anchor.y - sample.y);
    // Horizontal/zoom use a fixed content anchor; vertical scroll uses deltas.
    anchor.y = sample.y;
  };

  private end = (event: PointerEvent) => {
    if (this.yielding && !this.points.size) { this.yielding = false; return; }
    if (!this.points.has(event.pointerId)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const tapped = this.anchor?.moved === false && this.points.size === 1;
    const target = this.tapTarget;
    this.points.delete(event.pointerId);
    this.lastTouch = Date.now();
    if (this.options.container.hasPointerCapture?.(event.pointerId)) this.options.container.releasePointerCapture(event.pointerId);
    this.flush(); this.seed();
    if (tapped) {
      this.tapTarget = null;
      this.options.onTap?.(event.clientX, event.clientY, target);
    }
  };

  private suppressMouse = (event: MouseEvent) => {
    if (this.yielding) return;
    if (isNativeControl(event.target)) return;
    if (Date.now() - this.lastTouch > 800) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };

  private flush() {
    if (this.zoomView) this.options.onCommitZoom({ ...this.zoomView, cameraX: this.camera ?? this.zoomView.cameraX });
    if (this.camera !== null) this.options.onCommitCameraX(this.camera);
    this.zoomView = null; this.camera = null;
  }

  private cancel = () => {
    for (const id of this.points.keys()) if (this.options.container.hasPointerCapture?.(id)) this.options.container.releasePointerCapture(id);
    this.points.clear(); this.anchor = null; this.yielding = false; this.tapTarget = null; this.flush();
  };

  destroy() {
    this.cancel(); this.unsubscribe();
    this.options.container.classList.remove("lt-mobile-navigation-surface");
    this.options.container.removeEventListener("pointerdown", this.down, true);
    this.options.container.removeEventListener("mousedown", this.suppressMouse, true);
    this.options.container.removeEventListener("click", this.suppressMouse, true);
    this.options.container.removeEventListener("contextmenu", this.suppressMouse, true);
    window.removeEventListener("pointermove", this.move, true);
    window.removeEventListener("pointerup", this.end, true);
    window.removeEventListener("pointercancel", this.end, true);
    window.removeEventListener("blur", this.cancel);
  }
}
