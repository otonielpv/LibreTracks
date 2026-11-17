import type { SongView } from "@libretracks/shared/models";

/**
 * Colecciones de `SongView` cuyos elementos llevan `id`. Cada revisión del
 * backend trae la canción ENTERA con objetos nuevos aunque solo haya cambiado
 * un fader; sin esto, todo `useMemo` que dependa de `song.tracks` o
 * `song.clips` y todo `memo(...)` que reciba una pista se recalcula entero.
 */
const ID_COLLECTIONS = [
  "tracks",
  "clips",
  "midiClips",
  "videoClips",
  "regions",
  "sectionMarkers",
  "tempoMarkers",
  "timeSignatureMarkers",
  "automationCues",
  "mixScenes",
] as const satisfies ReadonlyArray<keyof SongView>;

/**
 * Devuelve `next` reutilizando de `previous` todo lo que no ha cambiado:
 *
 * - cada entidad (pista, clip, región, marca…) con el mismo id y el mismo
 *   contenido conserva el objeto anterior (`===`);
 * - si una colección queda igual elemento a elemento y en el mismo orden,
 *   conserva el array anterior;
 * - `automationTrack` igual conserva el objeto anterior.
 *
 * Nunca cambia el contenido: el resultado es estructuralmente igual a `next`.
 * Si las dos vistas son de canciones distintas no reutiliza nada.
 * `waveforms` no se toca: la vista nunca trae picos (los pide `useSongWaveforms`).
 */
export function mergeSongView(
  previous: SongView | null,
  next: SongView,
): SongView {
  if (!previous || previous.id !== next.id) {
    return next;
  }
  const merged: SongView = { ...next };
  for (const key of ID_COLLECTIONS) {
    const nextItems = next[key];
    const previousItems = previous[key];
    if (!Array.isArray(nextItems) || !Array.isArray(previousItems)) {
      continue;
    }
    // Las claves comparten forma (todas son arrays de objetos con id).
    (merged as Record<string, unknown>)[key] = mergeById(
      previousItems as ReadonlyArray<{ id: string }>,
      nextItems as ReadonlyArray<{ id: string }>,
    );
  }
  if (
    previous.automationTrack !== undefined &&
    next.automationTrack !== undefined &&
    jsonEqual(previous.automationTrack, next.automationTrack)
  ) {
    merged.automationTrack = previous.automationTrack;
  }
  return merged;
}

function mergeById<T extends { id: string }>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const previousById = new Map<string, T>();
  for (const item of previous) {
    previousById.set(item.id, item);
  }
  let sameAsPrevious = previous.length === next.length;
  const out = next.map((item, index) => {
    const candidate = previousById.get(item.id);
    const resolved =
      candidate !== undefined && jsonEqual(candidate, item) ? candidate : item;
    if (sameAsPrevious && resolved !== previous[index]) {
      sameAsPrevious = false;
    }
    return resolved;
  });
  return sameAsPrevious ? previous : out;
}

/**
 * Igualdad estructural de valores JSON (lo único que llega del backend).
 * Una propiedad `undefined` cuenta como ausente, igual que en JSON.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    // NaN no llega por JSON; dos números iguales ya salieron por `===`.
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!jsonEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(b)) {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  let aCount = 0;
  for (const key in aRecord) {
    if (aRecord[key] === undefined) continue;
    aCount += 1;
    if (!jsonEqual(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  let bCount = 0;
  for (const key in bRecord) {
    if (bRecord[key] !== undefined) bCount += 1;
  }
  return aCount === bCount;
}
