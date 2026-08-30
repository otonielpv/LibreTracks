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

/** Qué está haciendo el gesto de dos dedos. Ver TouchGestureState.mode. */
type TouchGestureMode = "undecided" | "pan" | "zoom";

type TouchGestureState = {
  /** Los DOS dedos que gobiernan el gesto, por identificador. Si el conjunto
   * cambia (se levanta uno, aterriza un tercero) el gesto se re-siembra en vez
   * de abortarse: de otro modo un apoyo accidental cancela el zoom a medias. */
  idA: number;
  idB: number;
  /**
   * Un gesto es desplazamiento O zoom, nunca los dos.
   *
   * Aplicar ambos a la vez —aunque el zoom lleve zona muerta— es lo que hacía
   * que mover en horizontal hiciera zoom por el camino: dos dedos que recorren
   * la pantalla nunca mantienen su separación, y sobre un desplazamiento largo
   * esa deriva es de mucho más del 3% que la zona muerta descontaba. Se decide
   * UNA vez, en cuanto uno de los dos ejes se despega, y se mantiene hasta que
   * los dedos se levantan: para cambiar de modo, se levanta y se vuelve a
   * apoyar. Es lo que hace que el gesto se sienta deliberado en vez de
   * resbaladizo.
   */
  mode: TouchGestureMode;
  originZoom: number;
  startDistance: number;
  /** Punto medio en el momento de anclar, para medir cuánto se ha recorrido. */
  startMidClientX: number;
  /** El mismo punto medio en coordenadas locales del contenedor. En modo zoom
   * la cámara se resuelve contra ESTE punto y no contra el actual, así que la
   * deriva lateral de los dedos no arrastra el material mientras se hace zoom. */
  originMidLocalX: number;
  /** Punto de CONTENIDO bajo el punto medio inicial de los dedos, en unidades
   * de zoom 1 (es decir, px / zoomLevel). Es el ancla del lazo cerrado: en cada
   * movimiento la camara se resuelve para volver a poner ESTE punto bajo el
   * punto medio actual, en vez de acumular deltas cuadro a cuadro. */
  originContentUnits: number;
};

type TouchSample = {
  distance: number;
  midClientX: number;
};

/**
 * Cuánto tiene que despegarse un eje para que el gesto se decida.
 *
 * Es el único momento en que el gesto no hace nada. Con menos, un apoyo torcido
 * decide por el usuario; con mucho más, el gesto se siente pegajoso al arrancar.
 */
const GESTURE_DECISION_PX = 14;

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
      // Si React ya se llevo el elemento sobre el que aterrizo el dedo (repinta
      // constantemente durante un arrastre), el contenedor sirve igual: el
      // evento sigue burbujeando hasta `window` y hasta la raiz de React, que
      // es donde escuchan los arrastres. Saltarselo dejaba vivo justo el
      // arrastre que hay que apartar.
      const node =
        target instanceof Element && target.isConnected
          ? target
          : this.container;
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

  /** Los dos dedos que ARRANCAN el gesto: sólo cuentan los apoyados en este
   * contenedor. `event.touches` son todos los de la pantalla, así que con un
   * dedo descansando sobre una cabecera de pista cualquier toque suelto en el
   * timeline contaba como gesto de dos dedos y la cámara pegaba un salto. */
  private seedingTouches(event: TouchEvent): [Touch, Touch] | null {
    const touches = event.targetTouches;
    return touches.length < 2 ? null : [touches[0], touches[1]];
  }

  /**
   * Los dos dedos del gesto EN CURSO, buscados por identificador entre todos
   * los de la pantalla.
   *
   * Deliberadamente NO se usa `targetTouches` aquí. El destino de un toque se
   * fija al tocar y no se actualiza: cuando React vuelve a pintar la regla a
   * mitad de la pinza (cambia el nivel de zoom, se rehacen las banderas), el
   * elemento sobre el que aterrizó el dedo deja de estar en el documento y sale
   * de `targetTouches` — el gesto se moría solo a media pinza. Los
   * identificadores sobreviven a ese repintado.
   */
  private gestureTouches(event: TouchEvent): [Touch, Touch] | null {
    const gesture = this.touchGesture;
    if (!gesture) {
      return null;
    }
    let a: Touch | null = null;
    let b: Touch | null = null;
    for (let index = 0; index < event.touches.length; index += 1) {
      const touch = event.touches[index];
      if (touch.identifier === gesture.idA) a = touch;
      else if (touch.identifier === gesture.idB) b = touch;
    }
    return a && b ? [a, b] : null;
  }

  private sampleTouches(a: Touch, b: Touch): TouchSample {
    return {
      distance: Math.max(
        1,
        Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      ),
      midClientX: (a.clientX + b.clientX) / 2,
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
    const sample = this.sampleTouches(a, b);
    this.touchGesture = {
      idA: a.identifier,
      idB: b.identifier,
      mode: "undecided",
      ...this.anchorFrom(sample),
    };
  }

  /** Estado de anclaje para una muestra: dónde están los dedos AHORA y qué hay
   * bajo ellos. Se recalcula al decidir el modo, de modo que el modo elegido
   * arranque desde cero y no herede el recorrido de la fase de decisión — que
   * es lo que haría saltar la cámara justo al arrancar el gesto. */
  private anchorFrom(sample: TouchSample) {
    const state = this.options.getState();
    const bounds = this.container.getBoundingClientRect();
    const midLocalX = this.localXFromClientX(sample.midClientX, bounds);
    const zoom = state.zoomLevel > 0 ? state.zoomLevel : 1;

    return {
      originZoom: zoom,
      startDistance: sample.distance,
      startMidClientX: sample.midClientX,
      originMidLocalX: midLocalX,
      originContentUnits: (state.cameraX + midLocalX) / zoom,
    };
  }

  private handleTouchStart = (event: TouchEvent) => {
    const pair = this.seedingTouches(event);
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
    // Mientras haya dos dedos el navegador no desplaza nada por su cuenta: el
    // carril vertical es del gesto de UN dedo (`touch-action: pan-y`), y que las
    // dos cosas convivieran es la mitad del "se pisan".
    this.container.style.touchAction = "none";
  };

  private handleTouchMove = (event: TouchEvent) => {
    if (!this.touchGesture) {
      return;
    }

    const pair = this.gestureTouches(event);
    if (!pair) {
      // Uno de los dos dedos del gesto ya no está. Si quedan otros dos sobre el
      // contenedor se re-siembra en su posición actual (así levantar un dedo de
      // tres no corta el gesto ni pega un salto); si no, se acaba.
      const reseed = this.seedingTouches(event);
      if (reseed) {
        this.seedTouchGesture(reseed[0], reseed[1]);
      } else {
        this.endTouchGesture();
      }
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }

    // Se aplica AQUÍ, no en un `requestAnimationFrame`. En iOS, si el WebView
    // llega a arrancar un desplazamiento propio, deja de entregar cuadros a las
    // animaciones hasta que termina: la cámara se quedaba congelada a media
    // pinza — el "se hace el gesto y para".
    this.applyTouchSample(this.sampleTouches(pair[0], pair[1]));
  };

  /**
   * Un gesto, un trabajo: o desplaza o hace zoom.
   *
   * El modo se decide una sola vez, en cuanto uno de los dos ejes se despega
   * (ver GESTURE_DECISION_PX), comparando cuánto se han SEPARADO los dedos con
   * cuánto se ha DESPLAZADO su punto medio. Gana el que vaya por delante. Al
   * decidir se vuelve a anclar, así que el modo elegido arranca desde cero y la
   * cámara no pega un salto con el recorrido de la fase de decisión.
   *
   * Dentro de cada modo se trabaja en LAZO CERRADO contra ese ancla, no con
   * deltas acumulados: el zoom es la razón de distancias respecto a la
   * separación anclada, y la cámara se despeja para volver a poner el punto de
   * contenido anclado bajo el punto de pantalla que le toca. Unos dedos
   * temblorosos no acumulan deriva.
   *
   * Sólo horizontal: el desplazamiento vertical del carril de pistas es del
   * gesto de un dedo. Moverlo también aquí duplicaba el recorrido cuando el
   * navegador ya venía desplazando.
   */
  private applyTouchSample(sample: TouchSample) {
    const gesture = this.touchGesture;
    if (!gesture) {
      return;
    }

    const state = this.options.getState();

    if (gesture.mode === "undecided") {
      const spread = Math.abs(sample.distance - gesture.startDistance);
      const travel = Math.abs(sample.midClientX - gesture.startMidClientX);
      if (Math.max(spread, travel) < GESTURE_DECISION_PX) {
        return;
      }
      gesture.mode = state.canZoom && spread > travel ? "zoom" : "pan";
      Object.assign(gesture, this.anchorFrom(sample));
      return;
    }

    const bounds = this.container.getBoundingClientRect();
    const midLocalX = this.localXFromClientX(sample.midClientX, bounds);

    let zoomNow = state.zoomLevel;
    if (gesture.mode === "zoom") {
      const targetZoom = Math.max(
        0.01,
        (gesture.originZoom * sample.distance) / gesture.startDistance,
      );
      // Sin cambio real de zoom no se previsualiza: repetiría por cuadro todo
      // el recálculo de cámara y reloj para dejar el mismo número.
      if (Math.abs(targetZoom - zoomNow) > 1e-4) {
        const view = this.options.onPreviewZoom(
          targetZoom,
          gesture.originMidLocalX,
        );
        if (view) {
          zoomNow = view.zoomLevel;
          this.scheduleZoomCommit(view);
        }
      }
    }

    // En zoom la cámara se resuelve contra el punto medio ANCLADO, así que la
    // deriva lateral de los dedos no arrastra el material de paso; al desplazar
    // se resuelve contra el punto medio actual, que es justo lo contrario.
    const anchorLocalX =
      gesture.mode === "zoom" ? gesture.originMidLocalX : midLocalX;
    const nextCameraX = this.options.onPreviewCameraX(
      gesture.originContentUnits * zoomNow - anchorLocalX,
    );
    this.schedulePanCommit(nextCameraX);
  }

  private handleTouchEnd = (event: TouchEvent) => {
    if (!this.touchGesture) {
      return;
    }

    if (this.gestureTouches(event)) {
      return;
    }

    const reseed = this.seedingTouches(event);
    if (reseed) {
      // Se levantó uno de tres: seguir con los que quedan, re-anclados.
      this.seedTouchGesture(reseed[0], reseed[1]);
      return;
    }

    this.endTouchGesture();
  };

  private endTouchGesture() {
    this.touchGesture = null;
    this.container.style.touchAction = "";
    // Confirmar YA, sin esperar al antirrebote: hasta que el zoom se confirma,
    // el envoltorio del ruler sigue con su `scaleX` de previsualizacion y las
    // zonas tactiles siguen deformadas. Al soltar los dedos ya no llegan mas
    // muestras, asi que el antirrebote solo seria un retraso.
    this.flushCommits();
  }

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
