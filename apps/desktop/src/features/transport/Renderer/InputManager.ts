import {
  clamp,
  clientDeltaXToLocalDelta,
  clientXToLocalX,
  getElementScaleX,
} from "../timeline/timelineMath";

type NativeZoomView = {
  cameraX: number;
  zoomLevel: number;
};

export type TimelineNavigationScheme = "ableton" | "libretracks";

type InputManagerState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  canZoom: boolean;
  navigationScheme: TimelineNavigationScheme;
};

type InputManagerOptions = {
  container: HTMLElement;
  getState: () => InputManagerState;
  dragThresholdPx: number;
  panCommitDelayMs: number;
  zoomCommitDelayMs: number;
  zoomMultiplier: number;
  trackHeightStep: number;
  trackHeightMin: number;
  trackHeightMax: number;
  onPreviewCameraX: (cameraX: number) => number;
  onCommitCameraX: (cameraX: number) => void;
  onPreviewZoom: (nextZoomLevel: number, anchorViewportX: number) => NativeZoomView | null;
  onCommitZoom: (view: NativeZoomView) => void;
  onTrackHeightChange: (trackHeight: number) => void;
  onScrollVertical?: (deltaY: number) => void;
};

type DragPanState = {
  startClientX: number;
  originCameraX: number;
  hasMoved: boolean;
  latestCameraX: number;
};

type TouchGestureState = {
  /** Los DOS dedos que gobiernan el gesto, por identificador. Si el conjunto
   * cambia (se levanta uno, aterriza un tercero) el gesto se re-siembra en vez
   * de abortarse: de otro modo un apoyo accidental cancela el zoom a medias. */
  idA: number;
  idB: number;
  originZoom: number;
  startDistance: number;
  /** Punto de CONTENIDO bajo el punto medio inicial de los dedos, en unidades
   * de zoom 1 (es decir, px / zoomLevel). Es el ancla del lazo cerrado: en cada
   * movimiento la camara se resuelve para volver a poner ESTE punto bajo el
   * punto medio actual, en vez de acumular deltas cuadro a cuadro. */
  originContentUnits: number;
  lastMidClientY: number;
};

type TouchSample = {
  distance: number;
  midClientX: number;
  midClientY: number;
  /** El navegador ya se ha quedado con el gesto (desplazamiento nativo del
   * carril de pistas). Se detecta por `event.cancelable === false`: a partir de
   * ahi `preventDefault` no hace nada. */
  browserOwned: boolean;
};

/** Zona muerta del pinza→zoom, en escala logaritmica.
 *
 * Se RESTA en vez de usarse como puerta. Con una puerta (`if (|scale-1| > 0.02)`)
 * el zoom no se aplica hasta cruzar el umbral y entonces entra de golpe con todo
 * lo acumulado: un desplazamiento a dos dedos, cuyos dedos siempre se separan un
 * poco, alterna dentro y fuera de la zona y el timeline da tirones. Restandola,
 * la funcion es continua en el umbral: justo al cruzarlo el factor sigue siendo
 * 1 y crece desde ahi. */
const ZOOM_DEAD_ZONE_LOG = Math.log(1.03);

function zoomFactorFromScale(scale: number) {
  const logScale = Math.log(scale);
  if (Math.abs(logScale) <= ZOOM_DEAD_ZONE_LOG) {
    return 1;
  }
  return Math.exp(logScale - Math.sign(logScale) * ZOOM_DEAD_ZONE_LOG);
}

export class InputManager {
  private readonly container: HTMLElement;

  private panCommitTimer: number | null = null;

  private zoomCommitTimer: number | null = null;

  /** Ultimo valor programado por cada antirrebote. Los guarda para poder
   * confirmarlos de inmediato al soltar los dedos (ver flushCommits). */
  private pendingCameraX: number | null = null;

  private pendingZoomView: NativeZoomView | null = null;

  private dragPanState: DragPanState | null = null;

  private touchGesture: TouchGestureState | null = null;

  /** Punteros vivos sobre este contenedor, para poder CANCELARLOS cuando el
   * gesto de dos dedos toma el mando. Ver cancelPendingPointerInteractions. */
  private readonly activePointers = new Map<number, EventTarget | null>();

  /** Ultima muestra de los dos dedos, pendiente de procesar en el proximo
   * cuadro. Un WebView entrega `touchmove` mas rapido de lo que pinta, y cada
   * muestra dispara la previsualizacion completa de camara y zoom. */
  private pendingTouchSample: TouchSample | null = null;

  private touchFrameId: number | null = null;

  constructor(private readonly options: InputManagerOptions) {
    this.container = options.container;
    this.container.addEventListener("wheel", this.handleWheel, { passive: false });
    this.container.addEventListener("mousedown", this.handleMouseDown, { passive: false });
    // Touch (Android): two-finger pan + pinch zoom, DAW-tablet convention.
    // One finger stays with the existing pointer interactions (select, drag
    // clips, seek), so the gestures only engage at two touches.
    this.container.addEventListener("touchstart", this.handleTouchStart, { passive: false });
    this.container.addEventListener("touchmove", this.handleTouchMove, { passive: false });
    this.container.addEventListener("touchend", this.handleTouchEnd, { passive: false });
    this.container.addEventListener("touchcancel", this.handleTouchEnd, { passive: false });
    // En captura: hay que ver el pointerdown aunque el destino detenga la
    // propagacion (los hotspots del ruler lo hacen).
    this.container.addEventListener("pointerdown", this.handlePointerDown, true);
    this.container.addEventListener("pointerup", this.handlePointerRelease, true);
    this.container.addEventListener("pointercancel", this.handlePointerRelease, true);
  }

  destroy() {
    this.container.removeEventListener("wheel", this.handleWheel);
    this.container.removeEventListener("mousedown", this.handleMouseDown);
    this.container.removeEventListener("touchstart", this.handleTouchStart);
    this.container.removeEventListener("touchmove", this.handleTouchMove);
    this.container.removeEventListener("touchend", this.handleTouchEnd);
    this.container.removeEventListener("touchcancel", this.handleTouchEnd);
    this.container.removeEventListener("pointerdown", this.handlePointerDown, true);
    this.container.removeEventListener("pointerup", this.handlePointerRelease, true);
    this.container.removeEventListener("pointercancel", this.handlePointerRelease, true);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);

    this.activePointers.clear();
    if (this.touchFrameId !== null) {
      window.cancelAnimationFrame(this.touchFrameId);
      this.touchFrameId = null;
    }
    this.pendingTouchSample = null;

    if (this.panCommitTimer !== null) {
      window.clearTimeout(this.panCommitTimer);
      this.panCommitTimer = null;
    }

    if (this.zoomCommitTimer !== null) {
      window.clearTimeout(this.zoomCommitTimer);
      this.zoomCommitTimer = null;
    }
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    this.activePointers.set(event.pointerId, event.target);
  };

  private handlePointerRelease = (event: PointerEvent) => {
    this.activePointers.delete(event.pointerId);
  };

  /**
   * Aborta cualquier arrastre de UN dedo que estuviera en vuelo cuando el
   * segundo dedo aterriza.
   *
   * `preventDefault()` sobre el `touchstart` NO sirve para esto: el
   * `pointerdown` del primer dedo ya se entrego y quien lo escucho (el asa del
   * cabezal, la seleccion de rango del ruler, el arrastre de un clip) ya tiene
   * sus escuchas puestas en `window`. Sin esto, ese arrastre sigue moviendo el
   * cabezal o el clip mientras el gesto mueve la camara — que es exactamente el
   * "se pisan" que se ve al hacer zoom.
   *
   * Se sintetiza un `pointercancel` por puntero vivo, con su identificador real,
   * sobre el elemento que recibio el `pointerdown`: burbujea hasta `window`, asi
   * que llega tanto a las escuchas globales como a los `onPointerCancel` de
   * React. `pointercancel` (y no `pointerup`) porque un gesto interrumpido no
   * debe CONFIRMAR nada: ni un salto del cabezal ni el movimiento de un clip.
   */
  private cancelPendingPointerInteractions() {
    if (this.activePointers.size === 0) {
      return;
    }
    const pointers = [...this.activePointers.entries()];
    this.activePointers.clear();

    if (typeof PointerEvent !== "function") {
      return;
    }

    for (const [pointerId, target] of pointers) {
      const node = target instanceof Element ? target : this.container;
      if (!node.isConnected) {
        continue;
      }
      node.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId,
          pointerType: "touch",
          bubbles: true,
          cancelable: false,
        }),
      );
    }
  }

  private schedulePanCommit(cameraX: number) {
    if (this.panCommitTimer !== null) {
      window.clearTimeout(this.panCommitTimer);
    }

    this.pendingCameraX = cameraX;
    this.panCommitTimer = window.setTimeout(() => {
      this.panCommitTimer = null;
      this.pendingCameraX = null;
      this.options.onCommitCameraX(cameraX);
    }, this.options.panCommitDelayMs);
  }

  private scheduleZoomCommit(view: NativeZoomView) {
    if (this.zoomCommitTimer !== null) {
      window.clearTimeout(this.zoomCommitTimer);
    }

    this.pendingZoomView = view;
    this.zoomCommitTimer = window.setTimeout(() => {
      this.zoomCommitTimer = null;
      this.pendingZoomView = null;
      this.options.onCommitZoom(view);
    }, this.options.zoomCommitDelayMs);
  }

  private handleWheel = (event: WheelEvent) => {
    const state = this.options.getState();

    if (state.navigationScheme === "ableton") {
      this.handleWheelAbleton(event, state);
      return;
    }

    this.handleWheelLibreTracks(event, state);
  };

  private handleWheelLibreTracks(event: WheelEvent, state: InputManagerState) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const nextTrackHeight = clamp(
        Math.round(
          state.trackHeight + (event.deltaY < 0 ? this.options.trackHeightStep : -this.options.trackHeightStep),
        ),
        this.options.trackHeightMin,
        this.options.trackHeightMax,
      );
      this.options.onTrackHeightChange(nextTrackHeight);
      return;
    }

    const shouldPanHorizontally = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (shouldPanHorizontally) {
      event.preventDefault();
      const horizontalDelta =
        event.deltaX + (event.shiftKey ? event.deltaY : 0);
      const nextCameraX = this.options.onPreviewCameraX(
        state.cameraX + this.wheelDeltaXToLocalDelta(horizontalDelta),
      );
      this.schedulePanCommit(nextCameraX);
      return;
    }

    if (!state.canZoom) {
      return;
    }

    this.applyZoomFromWheel(event, state);
  }

  private handleWheelAbleton(event: WheelEvent, state: InputManagerState) {
    // Trackpad pinch gestures arrive as wheel events with ctrlKey=true on every
    // major browser/OS. Treat ctrlKey/metaKey + wheel as horizontal zoom.
    if (event.ctrlKey || event.metaKey) {
      if (!state.canZoom) {
        event.preventDefault();
        return;
      }
      this.applyZoomFromWheel(event, state);
      return;
    }

    // Alt + wheel = track height (replaces Ctrl + wheel from the legacy scheme).
    if (event.altKey) {
      event.preventDefault();
      const nextTrackHeight = clamp(
        Math.round(
          state.trackHeight + (event.deltaY < 0 ? this.options.trackHeightStep : -this.options.trackHeightStep),
        ),
        this.options.trackHeightMin,
        this.options.trackHeightMax,
      );
      this.options.onTrackHeightChange(nextTrackHeight);
      return;
    }

    // Horizontal pan: explicit horizontal scroll, or shift + vertical.
    const hasHorizontalIntent =
      event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (hasHorizontalIntent) {
      event.preventDefault();
      const horizontalDelta =
        event.deltaX + (event.shiftKey ? event.deltaY : 0);
      const nextCameraX = this.options.onPreviewCameraX(
        state.cameraX + this.wheelDeltaXToLocalDelta(horizontalDelta),
      );
      this.schedulePanCommit(nextCameraX);
      return;
    }

    // Plain vertical scroll: forward to track list scroller if provided,
    // otherwise let the browser scroll the viewport naturally.
    if (this.options.onScrollVertical) {
      event.preventDefault();
      this.options.onScrollVertical(event.deltaY);
    }
  }

  private applyZoomFromWheel(event: WheelEvent, state: InputManagerState) {
    event.preventDefault();
    const bounds = this.container.getBoundingClientRect();
    const viewportWidth = this.container.offsetWidth || bounds.width;
    const anchorViewportX = clamp(
      clientXToLocalX(event.clientX, bounds, this.container.offsetWidth),
      0,
      viewportWidth,
    );
    const nextZoomLevel = this.computeNextZoomLevel(event, state.zoomLevel);
    const nextView = this.options.onPreviewZoom(nextZoomLevel, anchorViewportX);
    if (!nextView) {
      return;
    }

    this.scheduleZoomCommit(nextView);
  }

  private wheelDeltaXToLocalDelta(deltaX: number) {
    const bounds = this.container.getBoundingClientRect();
    return deltaX / getElementScaleX(bounds, this.container.offsetWidth);
  }

  private computeNextZoomLevel(event: WheelEvent, currentZoomLevel: number) {
    // Trackpad pinch gestures fire many wheel events with very small deltaY
    // values (often 1-10), while a real mouse wheel notch is ~100. Using a
    // fixed per-event multiplier (the legacy behaviour) makes pinch zoom feel
    // explosive. Scale the multiplier exponentially by the normalized deltaY
    // magnitude so that small gestures produce small steps and large notches
    // still feel snappy.
    const lineHeightPx = 16;
    const pageHeightPx = 800;
    const normalizedDelta =
      event.deltaMode === 1
        ? event.deltaY * lineHeightPx
        : event.deltaMode === 2
          ? event.deltaY * pageHeightPx
          : event.deltaY;
    // Cap a single event's contribution so an OS that bursts a huge delta
    // (e.g. macOS momentum scroll) can't snap multiple stops at once.
    const cappedDelta = clamp(normalizedDelta, -200, 200);
    // Map a full mouse notch (~100px) to roughly the legacy 1.2x factor.
    const stepReference = 100;
    const baseStep = Math.log(Math.max(1.01, this.options.zoomMultiplier));
    const factor = Math.exp((-cappedDelta * baseStep) / stepReference);
    return Math.max(0.01, currentZoomLevel * factor);
  }

  /** Los dos primeros dedos APOYADOS EN ESTE CONTENEDOR. `event.touches` son
   * todos los de la pantalla: con un dedo descansando sobre una cabecera de
   * pista, cualquier toque suelto en el timeline contaba como gesto de dos
   * dedos y la camara pegaba un salto. */
  private gestureTouches(event: TouchEvent): [Touch, Touch] | null {
    const touches = event.targetTouches;
    if (touches.length < 2) {
      return null;
    }
    return [touches[0], touches[1]];
  }

  private sampleTouches(a: Touch, b: Touch, browserOwned = false): TouchSample {
    return {
      distance: Math.max(
        1,
        Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      ),
      midClientX: (a.clientX + b.clientX) / 2,
      midClientY: (a.clientY + b.clientY) / 2,
      browserOwned,
    };
  }

  private localXFromClientX(clientX: number, bounds: DOMRect) {
    return clamp(
      clientXToLocalX(clientX, bounds, this.container.offsetWidth),
      0,
      this.container.offsetWidth || bounds.width,
    );
  }

  /** Siembra (o re-siembra) el ancla del gesto con los dos dedos dados. */
  private seedTouchGesture(a: Touch, b: Touch) {
    const state = this.options.getState();
    const sample = this.sampleTouches(a, b);
    const bounds = this.container.getBoundingClientRect();
    const midLocalX = this.localXFromClientX(sample.midClientX, bounds);
    const zoom = state.zoomLevel > 0 ? state.zoomLevel : 1;

    this.touchGesture = {
      idA: a.identifier,
      idB: b.identifier,
      originZoom: zoom,
      startDistance: sample.distance,
      originContentUnits: (state.cameraX + midLocalX) / zoom,
      lastMidClientY: sample.midClientY,
    };
  }

  private handleTouchStart = (event: TouchEvent) => {
    const pair = this.gestureTouches(event);
    if (!pair) {
      return;
    }

    // Dos dedos se quedan con el gesto: ni el navegador desplaza ni sigue vivo
    // el arrastre de un dedo que hubiera empezado antes.
    if (event.cancelable) {
      event.preventDefault();
    }
    this.cancelPendingPointerInteractions();
    this.seedTouchGesture(pair[0], pair[1]);
  };

  private handleTouchMove = (event: TouchEvent) => {
    const pair = this.gestureTouches(event);
    if (!this.touchGesture || !pair) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    const [a, b] = pair;
    // Cambio el par de dedos (uno se levanto, entro un tercero): se re-siembra
    // el ancla en su posicion actual para que la camara NO pegue un salto.
    if (a.identifier !== this.touchGesture.idA || b.identifier !== this.touchGesture.idB) {
      this.seedTouchGesture(a, b);
      return;
    }

    this.pendingTouchSample = this.sampleTouches(a, b, !event.cancelable);
    if (this.touchFrameId === null) {
      this.touchFrameId = window.requestAnimationFrame(this.flushTouchSample);
    }
  };

  /**
   * Aplica la ultima muestra del gesto, una vez por cuadro.
   *
   * Zoom y desplazamiento salen de un unico LAZO CERRADO contra el origen del
   * gesto, no de deltas acumulados: el zoom es la razon de distancias respecto a
   * la separacion inicial, y la camara se despeja para que el punto de contenido
   * que habia bajo el punto medio inicial quede bajo el punto medio actual. Asi
   * los dedos se quedan pegados al material — separarlos y moverlos a la vez
   * hace lo que se espera, en vez de sumar dos correcciones que se estorban — y
   * unos dedos temblorosos no acumulan deriva.
   */
  private flushTouchSample = () => {
    this.touchFrameId = null;
    const gesture = this.touchGesture;
    const sample = this.pendingTouchSample;
    this.pendingTouchSample = null;
    if (!gesture || !sample) {
      return;
    }

    const state = this.options.getState();
    const bounds = this.container.getBoundingClientRect();
    const midLocalX = this.localXFromClientX(sample.midClientX, bounds);

    let zoomNow = state.zoomLevel;
    if (state.canZoom) {
      const targetZoom = Math.max(
        0.01,
        gesture.originZoom *
          zoomFactorFromScale(sample.distance / gesture.startDistance),
      );
      const view = this.options.onPreviewZoom(targetZoom, midLocalX);
      if (view) {
        zoomNow = view.zoomLevel;
        this.scheduleZoomCommit(view);
      }
    }

    const nextCameraX = this.options.onPreviewCameraX(
      gesture.originContentUnits * zoomNow - midLocalX,
    );
    this.schedulePanCommit(nextCameraX);

    // Si el navegador ya venia desplazando el carril de pistas (un dedo bajando
    // con `touch-action: pan-y`, y el segundo aterriza despues), ese scroll ya
    // no se puede detener: sumarle el nuestro haria el doble de recorrido, que
    // es parte del "se pisan". El zoom y el desplazamiento horizontal si siguen,
    // porque no compiten con un desplazamiento vertical nativo.
    const dragDeltaY = gesture.lastMidClientY - sample.midClientY;
    if (
      !sample.browserOwned &&
      this.options.onScrollVertical &&
      Math.abs(dragDeltaY) > 0.5
    ) {
      this.options.onScrollVertical(dragDeltaY);
    }
    gesture.lastMidClientY = sample.midClientY;
  };

  private handleTouchEnd = (event: TouchEvent) => {
    if (!this.touchGesture) {
      return;
    }

    const pair = this.gestureTouches(event);
    if (pair) {
      // Queda al menos otro par util (se levanto un tercer dedo): se re-siembra
      // en vez de terminar, para no cortar el gesto a mitad.
      this.seedTouchGesture(pair[0], pair[1]);
      return;
    }

    this.touchGesture = null;
    this.pendingTouchSample = null;
    if (this.touchFrameId !== null) {
      window.cancelAnimationFrame(this.touchFrameId);
      this.touchFrameId = null;
    }
    // Confirmar YA, sin esperar al antirrebote: hasta que el zoom se confirma,
    // el envoltorio del ruler sigue con su `scaleX` de previsualizacion y las
    // zonas tactiles siguen deformadas. Al soltar los dedos ya no llegan mas
    // muestras, asi que el antirrebote solo seria un retraso.
    this.flushCommits();
  };

  private flushCommits() {
    if (this.zoomCommitTimer !== null) {
      window.clearTimeout(this.zoomCommitTimer);
      this.zoomCommitTimer = null;
      if (this.pendingZoomView) {
        this.options.onCommitZoom(this.pendingZoomView);
      }
    }
    if (this.panCommitTimer !== null) {
      window.clearTimeout(this.panCommitTimer);
      this.panCommitTimer = null;
      if (this.pendingCameraX !== null) {
        this.options.onCommitCameraX(this.pendingCameraX);
      }
    }
    this.pendingZoomView = null;
    this.pendingCameraX = null;
  }

  private handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    const state = this.options.getState();
    this.dragPanState = {
      startClientX: event.clientX,
      originCameraX: state.cameraX,
      hasMoved: false,
      latestCameraX: state.cameraX,
    };

    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.dragPanState) {
      return;
    }

    const bounds = this.container.getBoundingClientRect();
    const deltaX = clientDeltaXToLocalDelta(
      this.dragPanState.startClientX - event.clientX,
      bounds,
      this.container.offsetWidth,
    );
    const exceededThreshold = Math.abs(deltaX) > this.options.dragThresholdPx;
    if (!this.dragPanState.hasMoved && !exceededThreshold) {
      return;
    }

    this.dragPanState.hasMoved = true;
    this.dragPanState.latestCameraX = this.options.onPreviewCameraX(
      this.dragPanState.originCameraX + deltaX,
    );
    this.schedulePanCommit(this.dragPanState.latestCameraX);
  };

  private handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 1) {
      return;
    }

    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);

    if (this.dragPanState?.hasMoved) {
      this.schedulePanCommit(this.dragPanState.latestCameraX);
    }

    this.dragPanState = null;
  };
}
