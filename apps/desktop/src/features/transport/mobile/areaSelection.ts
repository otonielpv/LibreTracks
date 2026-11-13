import type { ClipSummary } from "../desktopApi";
import type { TrackRowLayout } from "../tracks/trackLayout";
import {
  clientXToLocalX,
  getElementScaleY,
  secondsToScreenX,
} from "../timeline/timelineMath";

/**
 * Seleccion por area en movil: un dedo dibuja un recuadro y todo lo que toca
 * queda seleccionado.
 *
 * Sustituye a los modos de "sumar de uno en uno", que obligaban a tocar cada
 * pista o clip por separado. Los toques sueltos siguen sumando o quitando
 * dentro del modo: un recuadro coge las tres guitarras con el bajo en medio, y
 * un toque saca el bajo.
 *
 * Lo que se selecciona lo decide DONDE empieza el recuadro: en la columna de
 * cabeceras son pistas; en los carriles, clips. Nunca las dos cosas, para que
 * "Eliminar" no pueda significar dos cosas distintas.
 */

/** Fila tal y como esta en pantalla, en coordenadas de cliente. */
export type AreaRow = { id: string; top: number; bottom: number };

/**
 * Las filas como DATOS: el layout dice donde esta cada una y una fila montada
 * cualquiera (`anchor`) lo clava en pantalla. Antes se buscaban todas en el DOM
 * y se median una a una; con las filas virtualizadas
 * (`docs/plans/completed/track-virtualization`) las que no estan montadas no existen en
 * el DOM, y un recuadro con auto-scroll las dejaba sin seleccionar sin ningun
 * error.
 */
export type AreaRowSource = {
  layout: TrackRowLayout;
  /** En el orden del layout. `skip`: tiene fila pero no es una pista de
   * verdad (automatizacion, importandose). */
  rows: ReadonlyArray<{ id: string; skip?: boolean }>;
  /** Una fila montada (`data-track-id`), la que sea. */
  anchor: HTMLElement | null;
};

/** Filas en coordenadas de cliente, sin medir mas elemento que el ancla. */
export function areaRowsFromLayout({ layout, rows, anchor }: AreaRowSource): AreaRow[] {
  const anchorTop = anchor?.dataset.trackId ? layout.topOf(anchor.dataset.trackId) : null;
  if (!anchor || anchorTop === null) return [];
  const rect = anchor.getBoundingClientRect();
  // El zoom de la interfaz: px de pantalla por px del layout.
  const scaleY = getElementScaleY(rect, anchor.offsetHeight);
  const origin = rect.top - anchorTop * scaleY;
  const result: AreaRow[] = [];
  rows.forEach((row, index) => {
    if (row.skip || index >= layout.tops.length) return;
    const top = origin + layout.tops[index] * scaleY;
    result.push({ id: row.id, top, bottom: top + layout.heights[index] * scaleY });
  });
  return result;
}

/** Lo que toca una banda vertical. Tocar cuenta, aunque sea en parte: exigir
 * que la fila quede entera dentro es dificil con el dedo. */
export function rowsInBand(rows: AreaRow[], y0: number, y1: number): string[] {
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return rows
    .filter((row) => row.top < bottom && row.bottom > top)
    .map((row) => row.id);
}

/** Ancho minimo con el que se pinta un clip; igual que `lanePointerToClip`. */
export const MIN_CLIP_WIDTH_PX = 28;

/**
 * Clips que toca el recuadro. `x0`/`x1` son locales al carril (0 = borde
 * izquierdo del area de pistas), igual que lo que pinta el canvas.
 */
export function clipsInArea(
  rows: AreaRow[],
  clipsByTrack: Record<string, ClipSummary[]>,
  area: { x0: number; x1: number; y0: number; y1: number },
  cameraX: number,
  pixelsPerSecond: number,
): string[] {
  const left = Math.min(area.x0, area.x1);
  const right = Math.max(area.x0, area.x1);
  const hits: string[] = [];
  for (const trackId of rowsInBand(rows, area.y0, area.y1)) {
    for (const clip of clipsByTrack[trackId] ?? []) {
      const clipLeft = secondsToScreenX(
        clip.timelineStartSeconds,
        cameraX,
        pixelsPerSecond,
      );
      const clipWidth = Math.max(
        clip.durationSeconds * pixelsPerSecond,
        MIN_CLIP_WIDTH_PX,
      );
      if (clipLeft < right && clipLeft + clipWidth > left) {
        hits.push(clip.id);
      }
    }
  }
  return hits;
}

/** Lo que ya habia mas lo nuevo, sin duplicados y en orden. */
export function mergeSelection(base: string[], hits: string[]): string[] {
  const seen = new Set(base);
  const merged = [...base];
  for (const id of hits) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Margen junto al borde del visor en el que el recuadro arrastra la vista. */
const AUTO_SCROLL_EDGE_PX = 48;
/** Velocidad maxima del auto-scroll, en px por cuadro. */
const AUTO_SCROLL_MAX_STEP_PX = 18;

function edgeStep(position: number, start: number, end: number): number {
  if (position < start + AUTO_SCROLL_EDGE_PX) {
    const depth = Math.min(1, (start + AUTO_SCROLL_EDGE_PX - position) / AUTO_SCROLL_EDGE_PX);
    return -Math.ceil(depth * AUTO_SCROLL_MAX_STEP_PX);
  }
  if (position > end - AUTO_SCROLL_EDGE_PX) {
    const depth = Math.min(1, (position - (end - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX);
    return Math.ceil(depth * AUTO_SCROLL_MAX_STEP_PX);
  }
  return 0;
}

export type AreaSelectionDeps = {
  /** Contenedor posicionado donde se pinta el recuadro y viven las filas. */
  surface: HTMLElement;
  /** Las filas, en el momento de pintar. Ver `AreaRowSource`. */
  getRows: () => AreaRowSource | null;
  /** Quien desplaza en vertical: el visor que comparten cabeceras y carriles. */
  getViewport: () => HTMLElement | null;
  getSelection: () => string[];
  setSelection: (ids: string[]) => void;
  /**
   * Solo para clips. Sin esto el recuadro es una banda de filas (pistas) y no
   * se mueve en horizontal.
   */
  clips?: {
    getClipsByTrack: () => Record<string, ClipSummary[]>;
    getCameraX: () => number;
    getPixelsPerSecond: () => number;
    previewCameraX: (cameraX: number) => number;
    commitCameraX: (cameraX: number) => void;
  };
};

/**
 * Un recuadro en curso. Se crea al despegar el dedo y muere al levantarlo.
 *
 * El punto de partida se guarda en coordenadas de CONTENIDO (segundos y
 * `scrollTop`), no de pantalla: asi el recuadro sigue anclado a lo que habia
 * bajo el dedo mientras el auto-scroll mueve la vista. Todo va por el DOM y
 * refs, sin `setState` por muestra; lo unico que toca el store es la seleccion,
 * y solo cuando cambia.
 */
export class AreaSelectionDrag {
  private box: HTMLDivElement;
  private base: string[];
  private last: string[];
  private startSeconds = 0;
  private startContentY = 0;
  private pointer: { x: number; y: number };
  private frame = 0;
  private camera: number | null = null;

  constructor(private deps: AreaSelectionDeps, clientX: number, clientY: number) {
    this.base = deps.getSelection();
    this.last = this.base;
    this.pointer = { x: clientX, y: clientY };
    const viewport = deps.getViewport();
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const scaleY = getElementScaleY(bounds, viewport.offsetHeight);
      this.startContentY = (clientY - bounds.top) / scaleY + viewport.scrollTop;
    } else {
      this.startContentY = clientY;
    }
    if (deps.clips) {
      const surfaceBounds = deps.surface.getBoundingClientRect();
      const localX = clientXToLocalX(clientX, surfaceBounds, deps.surface.offsetWidth);
      this.startSeconds =
        (deps.clips.getCameraX() + localX) / deps.clips.getPixelsPerSecond();
    }
    this.box = document.createElement("div");
    this.box.className = `lt-area-select-box ${deps.clips ? "is-clips" : "is-tracks"}`;
    deps.surface.appendChild(this.box);
    this.render();
  }

  update(clientX: number, clientY: number) {
    this.pointer = { x: clientX, y: clientY };
    this.render();
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  /** Suelta el dedo: la seleccion se queda como esta. */
  end() {
    this.dispose();
  }

  /** Gesto interrumpido (entra un segundo dedo): vuelve a lo de antes. */
  cancel() {
    this.dispose();
    if (!sameIds(this.last, this.base)) this.deps.setSelection(this.base);
  }

  private dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.camera !== null) this.deps.clips?.commitCameraX(this.camera);
    this.camera = null;
    this.box.remove();
  }

  /** Auto-scroll mientras el dedo este junto a un borde del visor. */
  private tick = () => {
    this.frame = 0;
    const viewport = this.deps.getViewport();
    let moved = false;
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const dy = edgeStep(this.pointer.y, bounds.top, bounds.bottom);
      if (dy) {
        const before = viewport.scrollTop;
        viewport.scrollTop = before + dy;
        moved ||= viewport.scrollTop !== before;
      }
      const clips = this.deps.clips;
      if (clips) {
        const surfaceBounds = this.deps.surface.getBoundingClientRect();
        const dx = edgeStep(
          this.pointer.x,
          Math.max(surfaceBounds.left, bounds.left),
          Math.min(surfaceBounds.right, bounds.right),
        );
        if (dx) {
          const current = this.camera ?? clips.getCameraX();
          const next = clips.previewCameraX(current + dx);
          moved ||= next !== current;
          this.camera = next;
        }
      }
    }
    if (moved) {
      this.render();
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  private render() {
    const { surface, getRows, clips } = this.deps;
    const surfaceBounds = surface.getBoundingClientRect();
    const scaleY = getElementScaleY(surfaceBounds, surface.offsetHeight);

    // Donde esta AHORA, en pantalla, el punto donde empezo el recuadro.
    const viewport = this.deps.getViewport();
    let startClientY = this.startContentY;
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const viewportScaleY = getElementScaleY(bounds, viewport.offsetHeight);
      startClientY =
        bounds.top + (this.startContentY - viewport.scrollTop) * viewportScaleY;
    }
    const cameraX = clips ? this.camera ?? clips.getCameraX() : 0;
    const pixelsPerSecond = clips?.getPixelsPerSecond() ?? 1;
    const startLocalX = clips
      ? this.startSeconds * pixelsPerSecond - cameraX
      : 0;
    // Con pistas el recuadro es una banda: ocupa la columna entera.
    const pointerLocalX = clips
      ? clientXToLocalX(this.pointer.x, surfaceBounds, surface.offsetWidth)
      : surface.offsetWidth;

    const left = Math.min(startLocalX, pointerLocalX);
    const width = Math.abs(pointerLocalX - startLocalX);
    const top = (Math.min(startClientY, this.pointer.y) - surfaceBounds.top) / scaleY;
    const height = Math.abs(this.pointer.y - startClientY) / scaleY;
    const style = this.box.style;
    style.transform = `translate(${left}px, ${top}px)`;
    style.width = `${width}px`;
    style.height = `${height}px`;

    const source = getRows();
    const rows = source ? areaRowsFromLayout(source) : [];
    const hits = clips
      ? clipsInArea(
          rows,
          clips.getClipsByTrack(),
          { x0: startLocalX, x1: pointerLocalX, y0: startClientY, y1: this.pointer.y },
          cameraX,
          pixelsPerSecond,
        )
      : rowsInBand(rows, startClientY, this.pointer.y);
    const next = mergeSelection(this.base, hits);
    if (!sameIds(next, this.last)) {
      this.last = next;
      this.deps.setSelection(next);
    }
  }
}
