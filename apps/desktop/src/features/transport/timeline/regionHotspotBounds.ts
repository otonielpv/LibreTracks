/**
 * Geometría de la banda de una canción en el ruler.
 *
 * Existe para que el arrastre pueda mover la banda **sin pasar por React**.
 * Antes, cada `pointermove` hacía `setRegionMovePreview(...)`, y el único
 * consumidor de ese estado eran el `left` y el `width` de un botón invisible.
 * El precio de esa comodidad, medido en el build de medición
 * (docs/plans/ui-performance/state/01.md): **144 renders por segundo** de
 * `TimelineCanvasPane` mientras el puntero se mueve, uno por frame.
 *
 * El arrastre de clips ya evitaba eso escribiendo refs que lee el canvas
 * (ver `hooks/useDragListeners.ts`); los arrastres del ruler nacieron después y
 * fueron por el camino corto.
 *
 * La fórmula vive aquí, y no repetida en el manejador y en el JSX, porque las
 * dos rutas TIENEN que coincidir: React pinta la posición de reposo y el
 * arrastre la posición en vuelo. Si divergen, la banda pega un salto al soltar.
 */

/** Ancho mínimo del hotspot en píxeles: una canción muy corta o un zoom muy
 *  bajo dejarían un objetivo imposible de agarrar. */
export const MIN_REGION_HOTSPOT_WIDTH_PX = 24;

export type RegionHotspotBounds = {
  leftPx: number;
  widthPx: number;
};

export function regionHotspotBounds(
  startSeconds: number,
  endSeconds: number,
  pixelsPerSecond: number,
): RegionHotspotBounds {
  return {
    leftPx: startSeconds * pixelsPerSecond,
    widthPx: Math.max(
      MIN_REGION_HOTSPOT_WIDTH_PX,
      (endSeconds - startSeconds) * pixelsPerSecond,
    ),
  };
}

/**
 * Escribe esa geometría en el elemento, imperativamente.
 *
 * Las coordenadas son las del CONTENIDO del ruler (segundos × píxeles por
 * segundo **confirmados**), no las de pantalla: el envoltorio del ruler ya
 * aplica la cámara y el zoom en vuelo con una sola transformación. Por eso hay
 * que pasarle el `pixelsPerSecond` confirmado y no el vivo — igual que hace el
 * JSX.
 */
export function applyRegionHotspotBounds(
  element: HTMLElement | null,
  startSeconds: number,
  endSeconds: number,
  pixelsPerSecond: number,
) {
  if (!element) {
    return;
  }
  const { leftPx, widthPx } = regionHotspotBounds(
    startSeconds,
    endSeconds,
    pixelsPerSecond,
  );
  element.style.left = `${leftPx}px`;
  element.style.width = `${widthPx}px`;
}
