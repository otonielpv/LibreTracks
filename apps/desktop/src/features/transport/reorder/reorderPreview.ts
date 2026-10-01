import "./reorderPreview.css";

/**
 * Vista previa de un reordenado por arrastre: "hueco + fantasma".
 *
 * Mientras se arrastra, la lista se coloca ya como quedará al soltar:
 *
 * - Los elementos que no se arrastran se deslizan a su sitio final, abriendo
 *   el hueco donde caerá lo arrastrado.
 * - Lo arrastrado se queda EN ese hueco, translúcido: es el fantasma. Son los
 *   elementos reales, no una copia, así que en la DAW el fantasma de una pista
 *   lleva sus clips en el carril donde van a quedar.
 * - Una copia del elemento sigue al puntero (la "elevación"), para que se vea
 *   qué se lleva la mano.
 *
 * Todo es imperativo —transform y clases escritos en el DOM— y nada pasa por
 * React: la DAW reordena pistas dentro del camino caliente y no puede
 * re-renderizar por fotograma (docs/REDESIGN_transport_refs_to_stores.md).
 *
 * El destino se calcula contra la disposición capturada al EMPEZAR, no contra
 * lo que hay bajo el puntero: las filas se mueven para abrir el hueco, y si el
 * destino dependiese de su posición en pantalla oscilaría al moverlas.
 */

export type ReorderAxis = "x" | "y";

export type ReorderPreviewItem = {
  id: string;
  /** Lo que se mide y se desplaza. */
  element: HTMLElement;
  /** Se desplazan igual que `element` (el carril de una pista, por ejemplo). */
  companions?: HTMLElement[];
};

type MeasuredItem = ReorderPreviewItem & {
  /** Inicio y tamaño en px de pantalla, en coordenadas del CONTENIDO del
   * contenedor de scroll: no cambian al hacer scroll. */
  start: number;
  size: number;
};

const SHIFTING_CLASS = "lt-reorder-shifting";
const GHOST_CLASS = "lt-reorder-ghost";
const HIDDEN_CLASS = "lt-reorder-hidden";
const SETTLE_MS = 180;

/** Atributos que no deben quedar duplicados en la copia flotante: la
 * localizarían como si fuese la fila de verdad. */
const IDENTITY_ATTRIBUTES = [
  "id",
  "data-track-id",
  "data-region-id",
  "data-song-reorder-id",
  "data-testid",
];

function findScrollContainer(element: HTMLElement, axis: ReorderAxis): HTMLElement | null {
  let cursor = element.parentElement;
  while (cursor) {
    const style = getComputedStyle(cursor);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (overflow === "auto" || overflow === "scroll") return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

/** px de pantalla por px CSS del elemento (el zoom de la interfaz). */
function screenScale(element: HTMLElement, axis: ReorderAxis): number {
  const rect = element.getBoundingClientRect();
  const layout = axis === "x" ? element.offsetWidth : element.offsetHeight;
  const screen = axis === "x" ? rect.width : rect.height;
  return layout > 0 && screen > 0 ? screen / layout : 1;
}

/**
 * Posiciones finales de una lista reordenada: cada elemento se apila tras el
 * anterior, con el mismo espacio entre elementos que tenía la lista. Devuelve
 * el desplazamiento de cada uno respecto a donde está (px de pantalla).
 */
export function reflowOffsets(
  items: ReadonlyArray<{ id: string; start: number; size: number }>,
  finalOrder: readonly string[],
): Map<string, number> {
  const offsets = new Map<string, number>();
  if (items.length === 0) return offsets;
  const byId = new Map(items.map((item) => [item.id, item]));
  const gap =
    items.length > 1
      ? Math.max(0, items[1].start - (items[0].start + items[0].size))
      : 0;
  let cursor = items[0].start;
  for (const id of finalOrder) {
    const item = byId.get(id);
    if (!item) continue;
    offsets.set(id, cursor - item.start);
    cursor += item.size + gap;
  }
  return offsets;
}

export function createReorderPreview({
  items,
  axis,
  liftSource,
  liftCount = 1,
  pointer,
}: {
  /** En el orden en que se ven. */
  items: ReorderPreviewItem[];
  axis: ReorderAxis;
  /** El elemento que se copia para seguir al puntero. */
  liftSource: HTMLElement | null;
  /** Cuántas cosas se arrastran: con más de una la copia lleva un contador. */
  liftCount?: number;
  /** Dónde estaba el puntero al empezar (px de pantalla). */
  pointer: { x: number; y: number };
}) {
  const first = items[0]?.element ?? liftSource;
  const scroller = first ? findScrollContainer(first, axis) : null;
  const scale = first ? screenScale(first, axis) : 1;

  /** Desplazamiento del contenido por el scroll, en px de pantalla. */
  const scrollOrigin = () => {
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return axis === "x"
      ? scroller.scrollLeft * scale - rect.left
      : scroller.scrollTop * scale - rect.top;
  };

  const origin = scrollOrigin();
  const measured: MeasuredItem[] = items.map((item) => {
    const rect = item.element.getBoundingClientRect();
    return {
      ...item,
      start: (axis === "x" ? rect.left : rect.top) + origin,
      size: axis === "x" ? rect.width : rect.height,
    };
  });

  const lift = liftSource ? createLift(liftSource, liftCount) : null;
  let lastOrderKey = "";

  function createLift(source: HTMLElement, count: number) {
    const clone = source.cloneNode(true) as HTMLElement;
    for (const node of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))]) {
      for (const attribute of IDENTITY_ATTRIBUTES) node.removeAttribute(attribute);
    }
    clone.classList.remove(GHOST_CLASS, HIDDEN_CLASS, SHIFTING_CLASS);
    clone.classList.add("lt-drag-lift");
    clone.setAttribute("aria-hidden", "true");
    clone.style.transform = "";
    clone.style.width = `${source.offsetWidth}px`;
    clone.style.height = `${source.offsetHeight}px`;
    clone.style.left = "0px";
    clone.style.top = "0px";
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "lt-drag-lift-count";
      badge.textContent = String(count);
      clone.appendChild(badge);
    }
    // Junto al original, para heredar sus estilos y variables CSS. Con
    // position: fixed no ocupa sitio en la lista.
    source.parentElement?.appendChild(clone);

    // `fixed` se ancla al viewport salvo que un ancestro tenga transform, y el
    // zoom de la interfaz escala sus coordenadas: en vez de suponer nada, se
    // mide dónde ha caído y se corrige hasta taparlo exactamente.
    const target = source.getBoundingClientRect();
    const placed = clone.getBoundingClientRect();
    const liftScale = clone.offsetWidth > 0 ? placed.width / clone.offsetWidth : scale;
    clone.style.left = `${(target.left - placed.left) / liftScale}px`;
    clone.style.top = `${(target.top - placed.top) / liftScale}px`;
    return { element: clone, scale: liftScale };
  }

  return {
    axis,

    /** Elemento (y fracción 0..1 dentro de él) bajo el puntero, según la
     * disposición de partida. `null` fuera de todos. */
    hitTest(clientX: number, clientY: number): { id: string; ratio: number } | null {
      const position = (axis === "x" ? clientX : clientY) + scrollOrigin();
      for (const item of measured) {
        if (position >= item.start && position < item.start + item.size) {
          return { id: item.id, ratio: (position - item.start) / item.size };
        }
      }
      return null;
    },

    /** Hueco (0..n) bajo el puntero: cuántos elementos tienen el centro antes
     * que él, según la disposición de partida. */
    gapAt(clientX: number, clientY: number): number {
      const position = (axis === "x" ? clientX : clientY) + scrollOrigin();
      return measured.filter((item) => item.start + item.size / 2 < position)
        .length;
    },

    ids: measured.map((item) => item.id),

    /**
     * Coloca la lista como quedará: `finalOrder` son las filas que se verán,
     * en su orden; `ghostIds`, lo que se arrastra. Lo que no está en
     * `finalOrder` va a quedar oculto (dentro de una carpeta plegada).
     */
    render(finalOrder: readonly string[], ghostIds: ReadonlySet<string>) {
      const key = finalOrder.join("\u0000");
      if (key === lastOrderKey) return;
      lastOrderKey = key;
      const offsets = reflowOffsets(measured, finalOrder);
      for (const item of measured) {
        const offset = (offsets.get(item.id) ?? 0) / scale;
        const transform =
          offset === 0
            ? ""
            : axis === "x"
              ? `translate3d(${offset}px, 0, 0)`
              : `translate3d(0, ${offset}px, 0)`;
        for (const element of [item.element, ...(item.companions ?? [])]) {
          element.classList.add(SHIFTING_CLASS);
          element.style.transform = transform;
          element.classList.toggle(GHOST_CLASS, ghostIds.has(item.id));
          element.classList.toggle(HIDDEN_CLASS, !offsets.has(item.id));
        }
      }
    },

    /** Mueve la copia flotante con el puntero, sólo sobre el eje de la lista. */
    moveLift(clientX: number, clientY: number) {
      if (!lift) return;
      const delta = (axis === "x" ? clientX - pointer.x : clientY - pointer.y) / lift.scale;
      lift.element.style.transform =
        axis === "x" ? `translate3d(${delta}px, 0, 0)` : `translate3d(0, ${delta}px, 0)`;
    },

    /** Quita la copia flotante; la lista sigue como está. */
    dropLift() {
      lift?.element.remove();
    },

    /**
     * Deja la lista como estaba.
     *
     * `animate: true` la devuelve deslizando (un arrastre cancelado).
     * `animate: false` la suelta de golpe: es lo que toca cuando React acaba
     * de pintar el orden nuevo, en el que cada elemento ya está donde lo
     * enseñaba la vista previa — animar ahí lo haría saltar.
     */
    destroy({ animate }: { animate: boolean }) {
      lift?.element.remove();
      const elements = measured.flatMap((item) => [item.element, ...(item.companions ?? [])]);
      if (!animate) {
        for (const element of elements) {
          element.classList.remove(SHIFTING_CLASS);
          element.style.transform = "";
          element.classList.remove(GHOST_CLASS, HIDDEN_CLASS);
        }
        return;
      }
      for (const element of elements) {
        element.style.transform = "";
        element.classList.remove(GHOST_CLASS, HIDDEN_CLASS);
      }
      window.setTimeout(() => {
        for (const element of elements) {
          // Si otro arrastre ya la ha vuelto a mover, no se le quita.
          if (!element.style.transform) element.classList.remove(SHIFTING_CLASS);
        }
      }, SETTLE_MS);
    },
  };
}

export type ReorderPreview = ReturnType<typeof createReorderPreview>;
