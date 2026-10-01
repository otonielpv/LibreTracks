import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/**
 * Reordenar canciones arrastrándolas en las vistas compacta y live.
 *
 * Las dos pintan las canciones como una lista (columnas en la compacta, filas
 * o botones en la live, que cambia de eje según el ancho de pantalla), así que
 * el gesto no habla en segundos como el de la DAW sino en posiciones: suelta
 * entre la 2ª y la 3ª y la canción pasa a ser la 3ª.
 *
 * Dos formas de agarrar una canción:
 *
 * - **El asa** (`handleProps`): arrastra al instante con ratón, dedo o lápiz.
 *   Lleva `touch-action: none` en CSS, que es lo que permite arrastrar con el
 *   dedo sin que el navegador se quede el gesto para hacer scroll. Con el
 *   teclado, las flechas la mueven un puesto.
 * - **La superficie** (`surfaceProps`): la cabecera o el botón de la canción,
 *   sólo con ratón y a partir de unos píxeles, para que un clic siga siendo un
 *   clic. Con el dedo no: ahí el gesto ya es scroll y la pulsación larga ya es
 *   el menú contextual, y robárselos rompería las dos cosas.
 *
 * Los elementos de la lista se encuentran por `data-song-reorder-id` dentro de
 * `containerRef`, que también es el contenedor que se desplaza solo al acercar
 * el puntero a un borde.
 */

/** Atributo que marca cada canción de la lista. */
export const SONG_REORDER_ID_ATTRIBUTE = "data-song-reorder-id";
/** Dentro de la superficie, lo que lleva este atributo no inicia arrastre. */
export const SONG_REORDER_IGNORE_ATTRIBUTE = "data-no-song-reorder";

const MOUSE_DRAG_THRESHOLD_PX = 5;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_MAX_STEP_PX = 18;

export type SongReorderAxis = "x" | "y";

type ItemRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

/**
 * Eje de la lista a partir de dónde está cada elemento: si los dos primeros
 * se separan más en vertical que en horizontal, la lista es vertical. La live
 * cambia de eje con una media query, así que mirarlo en vivo evita duplicar
 * aquí ese punto de corte.
 */
export function resolveReorderAxis(rects: ItemRect[]): SongReorderAxis {
  if (rects.length < 2) return "x";
  const [first, second] = rects;
  const dx = Math.abs(second.left + second.width / 2 - (first.left + first.width / 2));
  const dy = Math.abs(second.top + second.height / 2 - (first.top + first.height / 2));
  return dy > dx ? "y" : "x";
}

/**
 * Hueco de inserción (0..n) bajo el puntero: cuántos elementos tienen su
 * centro antes que él.
 */
export function resolveDropGap(
  rects: ItemRect[],
  axis: SongReorderAxis,
  pointer: { x: number; y: number },
): number {
  let gap = 0;
  for (const rect of rects) {
    const center =
      axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    if ((axis === "x" ? pointer.x : pointer.y) > center) gap += 1;
  }
  return gap;
}

/**
 * Posición final de la canción que estaba en `fromIndex` al soltarla en el
 * hueco `gap`, o `null` si la deja donde estaba. Los huecos a ambos lados de
 * la propia canción no la mueven.
 */
export function targetIndexForGap(fromIndex: number, gap: number): number | null {
  const target = gap > fromIndex ? gap - 1 : gap;
  return target === fromIndex ? null : target;
}

type DragSession = {
  id: string;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** false mientras un arrastre de superficie no supera el umbral. */
  active: boolean;
  lastX: number;
  lastY: number;
};

export type SongReorderState = {
  /** Canción que se está arrastrando, o null. */
  draggingId: string | null;
  /** Hueco donde caería (0..n), o null si soltarla no la movería. */
  dropGap: number | null;
};

export function useSongReorder({
  itemIds,
  containerRef,
  onReorder,
  disabled = false,
}: {
  /** Ids en el orden en que se pintan. */
  itemIds: readonly string[];
  containerRef: RefObject<HTMLElement | null>;
  onReorder: ((id: string, targetIndex: number) => void) | undefined;
  disabled?: boolean;
}) {
  const [state, setState] = useState<SongReorderState>({
    draggingId: null,
    dropGap: null,
  });
  const sessionRef = useRef<DragSession | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  // Lo que leen los listeners de window, que se registran una vez por gesto.
  const latestRef = useRef({ itemIds, onReorder });
  latestRef.current = { itemIds, onReorder };

  const enabled = !disabled && Boolean(onReorder) && itemIds.length > 1;

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const elements = Array.from(
      container.querySelectorAll<HTMLElement>(`[${SONG_REORDER_ID_ATTRIBUTE}]`),
    );
    const rects = elements.map((element) => element.getBoundingClientRect());
    return { container, rects, axis: resolveReorderAxis(rects) };
  }, [containerRef]);

  const updateDropGap = useCallback(() => {
    const session = sessionRef.current;
    const layout = measure();
    if (!session?.active || !layout) return;
    const gap = resolveDropGap(layout.rects, layout.axis, {
      x: session.lastX,
      y: session.lastY,
    });
    const dropGap = targetIndexForGap(session.fromIndex, gap) === null ? null : gap;
    setState((current) =>
      current.draggingId === session.id && current.dropGap === dropGap
        ? current
        : { draggingId: session.id, dropGap },
    );
  }, [measure]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  // Desplaza el contenedor mientras el puntero esté cerca de un borde, para
  // poder llevar una canción a una posición que no cabe en pantalla.
  const autoScrollStep = useCallback(() => {
    autoScrollFrameRef.current = null;
    const session = sessionRef.current;
    const layout = measure();
    if (!session?.active || !layout) return;
    const { container, axis } = layout;
    const bounds = container.getBoundingClientRect();
    const position = axis === "x" ? session.lastX : session.lastY;
    const start = axis === "x" ? bounds.left : bounds.top;
    const end = axis === "x" ? bounds.right : bounds.bottom;
    let step = 0;
    if (position < start + AUTO_SCROLL_EDGE_PX) {
      step = -AUTO_SCROLL_MAX_STEP_PX * Math.min(1, (start + AUTO_SCROLL_EDGE_PX - position) / AUTO_SCROLL_EDGE_PX);
    } else if (position > end - AUTO_SCROLL_EDGE_PX) {
      step = AUTO_SCROLL_MAX_STEP_PX * Math.min(1, (position - (end - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX);
    }
    if (step === 0) return;
    const before = axis === "x" ? container.scrollLeft : container.scrollTop;
    if (axis === "x") container.scrollLeft += step;
    else container.scrollTop += step;
    const after = axis === "x" ? container.scrollLeft : container.scrollTop;
    if (after === before) return;
    updateDropGap();
    autoScrollFrameRef.current = requestAnimationFrame(autoScrollStep);
  }, [measure, updateDropGap]);

  const finish = useCallback(
    (commit: boolean) => {
      const session = sessionRef.current;
      sessionRef.current = null;
      detachRef.current?.();
      detachRef.current = null;
      stopAutoScroll();
      document.body.classList.remove("lt-song-reordering");
      setState({ draggingId: null, dropGap: null });
      if (!session?.active) return;

      // El soltar de un arrastre de superficie llega también como clic al
      // botón o cabecera de debajo; ese clic seleccionaría o reproduciría
      // la canción, así que se traga.
      const swallowClick = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallowClick, true);
      window.setTimeout(
        () => window.removeEventListener("click", swallowClick, true),
        0,
      );

      if (!commit) return;
      const layout = measure();
      if (!layout) return;
      const gap = resolveDropGap(layout.rects, layout.axis, {
        x: session.lastX,
        y: session.lastY,
      });
      const target = targetIndexForGap(session.fromIndex, gap);
      if (target !== null) latestRef.current.onReorder?.(session.id, target);
    },
    [measure, stopAutoScroll],
  );

  useEffect(() => () => finish(false), [finish]);

  const begin = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      id: string,
      immediate: boolean,
    ) => {
      if (!enabled || sessionRef.current) return;
      const fromIndex = latestRef.current.itemIds.indexOf(id);
      if (fromIndex < 0) return;
      sessionRef.current = {
        id,
        fromIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        lastX: event.clientX,
        lastY: event.clientY,
      };

      const activate = () => {
        const session = sessionRef.current;
        if (!session || session.active) return;
        session.active = true;
        document.body.classList.add("lt-song-reordering");
        setState({ draggingId: session.id, dropGap: null });
      };

      const onMove = (moveEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) return;
        session.lastX = moveEvent.clientX;
        session.lastY = moveEvent.clientY;
        if (!session.active) {
          const distance = Math.hypot(
            moveEvent.clientX - session.startX,
            moveEvent.clientY - session.startY,
          );
          if (distance < MOUSE_DRAG_THRESHOLD_PX) return;
          activate();
        }
        moveEvent.preventDefault();
        updateDropGap();
        if (autoScrollFrameRef.current === null) {
          autoScrollFrameRef.current = requestAnimationFrame(autoScrollStep);
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== sessionRef.current?.pointerId) return;
        finish(true);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== sessionRef.current?.pointerId) return;
        finish(false);
      };
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
      detachRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
      };

      if (immediate) activate();
    },
    [autoScrollStep, enabled, finish, updateDropGap],
  );

  const handleProps = useCallback(
    (id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        // Que no lo vea la cabecera (selección) ni el scroll del contenedor.
        event.stopPropagation();
        event.preventDefault();
        begin(event, id, true);
      },
      // El asa no es un botón de acción: un clic suelto no hace nada, y que
      // no llegue a la cabecera evita que además la seleccione.
      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        const { itemIds: ids, onReorder: reorder } = latestRef.current;
        const from = ids.indexOf(id);
        if (!enabled || !reorder || from < 0) return;
        const step =
          event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : 0;
        const target =
          event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : from + step;
        if (target === from || target < 0 || target >= ids.length) return;
        event.preventDefault();
        event.stopPropagation();
        reorder(id, target);
      },
    }),
    [begin, enabled],
  );

  const surfaceProps = useCallback(
    (id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        const target = event.target as Element | null;
        if (target?.closest?.(`input, select, textarea, [${SONG_REORDER_IGNORE_ATTRIBUTE}]`)) {
          return;
        }
        begin(event, id, false);
      },
    }),
    [begin],
  );

  return { ...state, enabled, handleProps, surfaceProps };
}

/**
 * Clases de una canción de la lista según el arrastre en curso:
 * `is-reorder-source` para la que se arrastra y `is-drop-before` /
 * `is-drop-after` para la línea de inserción.
 */
export function songReorderClassName(
  state: SongReorderState,
  id: string,
  index: number,
  count: number,
): string {
  let className = "";
  if (state.draggingId === id) className += " is-reorder-source";
  if (state.dropGap !== null) {
    if (state.dropGap === index) className += " is-drop-before";
    else if (state.dropGap === count && index === count - 1) className += " is-drop-after";
  }
  return className;
}
