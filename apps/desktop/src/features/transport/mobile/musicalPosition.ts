import type { SongView } from "../desktopApi";
import { formatMusicalPosition } from "../helpers";

export type ParsedMusicalPosition = {
  barNumber: number;
  beatInBar: number;
  subBeat: number;
};

/**
 * Lee "5", "5.3" o "5.3.25" como compás.tiempo.subdivisión.
 *
 * Devuelve null si no hay al menos un compás valido: escribir a medias en un
 * campo de texto es lo normal, y un valor a medias no debe mover la marca.
 */
export function parseMusicalPosition(
  input: string,
): ParsedMusicalPosition | null {
  const parts = input.trim().split(/[.:]/);
  if (parts.length === 0 || parts.length > 3) {
    return null;
  }

  const numbers = parts.map((part) => (part === "" ? NaN : Number(part)));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  const barNumber = Math.floor(numbers[0]);
  if (barNumber < 1) {
    return null;
  }

  return {
    barNumber,
    beatInBar: numbers.length > 1 ? Math.max(1, Math.floor(numbers[1])) : 1,
    subBeat: numbers.length > 2 ? Math.min(99, Math.floor(numbers[2])) : 0,
  };
}

function compare(a: ParsedMusicalPosition, b: ParsedMusicalPosition) {
  if (a.barNumber !== b.barNumber) return a.barNumber - b.barNumber;
  if (a.beatInBar !== b.beatInBar) return a.beatInBar - b.beatInBar;
  return a.subBeat - b.subBeat;
}

function positionAt(
  seconds: number,
  song: SongView | null,
): ParsedMusicalPosition {
  const parsed = parseMusicalPosition(formatMusicalPosition(seconds, song));
  return parsed ?? { barNumber: 1, beatInBar: 1, subBeat: 0 };
}

/**
 * Compás.tiempo -> segundos.
 *
 * Se define como la INVERSA de `formatMusicalPosition` en vez de rehacer el
 * mapa de tempos: una busqueda binaria sobre la funcion que ya existe. La
 * conversion directa ya tiene en cuenta marcas de tempo, cambios de compás y
 * regiones acumuladas, y rehacer esa aritmetica aparte es exactamente la clase
 * de duplicado que se desincroniza en cuanto alguien toca el mapa de tempos.
 *
 * Vale porque el mapa es monotono: a mas segundos, nunca menos compás.tiempo.
 * 60 iteraciones sobre un rango de horas dejan el error por debajo del
 * microsegundo, y solo se paga al confirmar, no al escribir.
 */
export function musicalPositionToSeconds(
  target: ParsedMusicalPosition,
  song: SongView | null,
  maxSeconds: number,
): number {
  const upperBound = Math.max(1, maxSeconds);
  if (compare(positionAt(upperBound, song), target) < 0) {
    return upperBound;
  }

  let low = 0;
  let high = upperBound;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = (low + high) / 2;
    if (compare(positionAt(mid, song), target) < 0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}
