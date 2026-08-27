/**
 * Dónde se coloca la tarjeta de la guía respecto al control que ilumina.
 *
 * Existe porque `calculatePopoverAnchor` —pensada para popovers colgando de un
 * botón— sólo sabe poner las cosas arriba o abajo, y encaja el panel en la
 * franja que quede aunque sea mínima. Con los objetivos pequeños va de sobra,
 * pero la guía también ilumina cosas grandes: el modal de ajustes ocupa casi
 * toda la ventana y el panel de biblioteca va de arriba abajo. Ahí no quedan ni
 * 140px libres, y la tarjeta salía con el texto reducido a una línea con
 * scroll — inservible en algo cuyo único trabajo es que se lea.
 *
 * Esta función mira los cuatro lados y se queda con el primero donde la tarjeta
 * quepa ENTERA. Cuando ninguno basta, prueba las cuatro posiciones recortadas
 * contra el viewport y elige la que MENOS se solape con el objetivo. Centrarla
 * a ciegas era especialmente malo en móvil apaisado: tapaba justo el control
 * que el marco pretendía enseñar aunque quedara una esquina mucho mejor.
 */

export type PlacementRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type PlacementSize = { width: number; height: number };

export type PlacementViewport = { width: number; height: number };

/** Posición final, o `null` para "céntrala en pantalla". */
export type CardPosition = { top: number; left: number };

/** Aire mínimo contra el borde de la ventana. */
const MARGIN = 12;
/** Separación entre la tarjeta y el control iluminado. */
const GAP = 8;

type Side = "below" | "above" | "right" | "left";

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function overlapArea(
  position: CardPosition,
  card: PlacementSize,
  target: PlacementRect,
): number {
  const overlapWidth = Math.max(
    0,
    Math.min(position.left + card.width, target.left + target.width) -
      Math.max(position.left, target.left),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(position.top + card.height, target.top + target.height) -
      Math.max(position.top, target.top),
  );
  return overlapWidth * overlapHeight;
}

export function placeTourCard(
  target: PlacementRect | null,
  card: PlacementSize,
  viewport: PlacementViewport,
): CardPosition | null {
  if (!target) return null;

  const targetRight = target.left + target.width;
  const targetBottom = target.top + target.height;

  const room: Record<Side, number> = {
    below: viewport.height - targetBottom - GAP - MARGIN,
    above: target.top - GAP - MARGIN,
    right: viewport.width - targetRight - GAP - MARGIN,
    left: target.left - GAP - MARGIN,
  };

  const fits: Record<Side, boolean> = {
    below: room.below >= card.height,
    above: room.above >= card.height,
    right: room.right >= card.width,
    left: room.left >= card.width,
  };

  // Orden fijo, no "el lado con más hueco": junto a un botón pequeño siempre
  // sobra más espacio a los lados que debajo, y la tarjeta se iría a la otra
  // punta de la pantalla en vez de quedarse pegada a lo que señala. Debajo es
  // lo que se lee como "esto explica eso"; los lados son el recurso para los
  // objetivos altos, donde arriba y abajo no queda hueco.
  const order: Side[] = ["below", "above", "right", "left"];
  const chosen = order.find((side) => fits[side]);

  const maxLeft = viewport.width - card.width - MARGIN;
  const maxTop = viewport.height - card.height - MARGIN;
  // Si ni siquiera cabe dentro del viewport, CSS la centra y limita su alto;
  // no hay una posición numérica honesta que podamos devolver aquí.
  if (maxLeft < MARGIN || maxTop < MARGIN) return null;
  // Centrada sobre el eje libre y recortada contra los bordes.
  const centredLeft = target.left + target.width / 2 - card.width / 2;
  const centredTop = target.top + target.height / 2 - card.height / 2;

  const candidates: Record<Side, CardPosition> = {
    below: {
      top: clamp(targetBottom + GAP, MARGIN, maxTop),
      left: clamp(centredLeft, MARGIN, maxLeft),
    },
    above: {
      top: clamp(target.top - GAP - card.height, MARGIN, maxTop),
      left: clamp(centredLeft, MARGIN, maxLeft),
    },
    right: {
      top: clamp(centredTop, MARGIN, maxTop),
      left: clamp(targetRight + GAP, MARGIN, maxLeft),
    },
    left: {
      top: clamp(centredTop, MARGIN, maxTop),
      left: clamp(target.left - GAP - card.width, MARGIN, maxLeft),
    },
  };

  if (chosen) return candidates[chosen];

  // Ningún lado puede alojarla entera. Elegimos la alternativa que conserve
  // más objetivo visible; en empate, más espacio real en ese lado y por último
  // el orden natural debajo/encima/derecha/izquierda.
  return order
    .map((side, priority) => ({
      side,
      priority,
      position: candidates[side],
      overlap: overlapArea(candidates[side], card, target),
      room: room[side],
    }))
    .sort(
      (a, b) =>
        a.overlap - b.overlap || b.room - a.room || a.priority - b.priority,
    )[0].position;
}
