/**
 * Reordenar arrastrando en la vista DAW.
 *
 * Mover una canción por el timeline nunca podía cambiar el orden hacia la
 * izquierda: el arrastre se topa con el final de la vecina. Como en las listas
 * de Compacta, Live y Setlist, lo que decide el orden es el CENTRO de la
 * canción arrastrada frente al de las demás: pasar el centro de otra canción
 * la reordena (y para llevarla al principio basta con pasar el de la primera).
 * Sin cruzar ningún centro, el arrastre es un movimiento normal.
 *
 * El reordenado es el mismo `reorderSongRegion` de las otras vistas, y la
 * vista previa recoloca las bandas como lo hará el backend
 * (`lay_out_songs` en state/song_reorder.rs).
 */

type RegionSpan = { id: string; startSeconds: number; endSeconds: number };

const byStart = (regions: readonly RegionSpan[]) =>
  [...regions].sort((a, b) => a.startSeconds - b.startSeconds);

/**
 * La posición final (0 = primera) de `draggedId` si empezase en
 * `draggedStartSeconds`, o null si sigue en la suya (movimiento normal).
 */
export function songDragReorderIndex(
  regions: readonly RegionSpan[],
  draggedId: string,
  draggedStartSeconds: number,
): number | null {
  const sorted = byStart(regions);
  const from = sorted.findIndex((region) => region.id === draggedId);
  if (from < 0 || sorted.length < 2) return null;
  const dragged = sorted[from];
  const center = draggedStartSeconds + (dragged.endSeconds - dragged.startSeconds) / 2;
  const to = sorted.filter(
    (region) =>
      region.id !== draggedId && (region.startSeconds + region.endSeconds) / 2 < center,
  ).length;
  return to === from ? null : to;
}

/**
 * Dónde queda cada canción con `draggedId` en la posición `targetIndex`. Igual
 * que el backend: la primera empieza donde empezaba la primera, y el hueco
 * entre dos posiciones de la lista se queda con la posición, la ocupe quien la
 * ocupe. (El backend además encaja en el tiempo fuerte las fronteras que ya
 * caían en uno; para la vista previa sobra.)
 */
export function reorderedSongLayout(
  regions: readonly RegionSpan[],
  draggedId: string,
  targetIndex: number,
): Map<string, { startSeconds: number; endSeconds: number }> {
  const sorted = byStart(regions);
  const layout = new Map<string, { startSeconds: number; endSeconds: number }>();
  const from = sorted.findIndex((region) => region.id === draggedId);
  if (from < 0 || sorted.length === 0) return layout;
  const gaps = sorted
    .slice(1)
    .map((region, index) => Math.max(0, region.startSeconds - sorted[index].endSeconds));
  const order = [...sorted];
  const [moved] = order.splice(from, 1);
  order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, moved);
  let cursor = sorted[0].startSeconds;
  order.forEach((region, slot) => {
    if (slot > 0) cursor += gaps[slot - 1];
    const length = region.endSeconds - region.startSeconds;
    layout.set(region.id, { startSeconds: cursor, endSeconds: cursor + length });
    cursor += length;
  });
  return layout;
}

/** La canción antes (-1) o después (+1) de la lista, o null en el extremo. */
export function songStepReorderIndex(
  regions: readonly RegionSpan[],
  regionId: string,
  step: -1 | 1,
): number | null {
  const sorted = byStart(regions);
  const from = sorted.findIndex((region) => region.id === regionId);
  if (from < 0) return null;
  const to = from + step;
  return to < 0 || to >= sorted.length ? null : to;
}
