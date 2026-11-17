// Las tres clases de tamaño del panel Ritmo son las del Setlist (wide /
// medium / short), medidas sobre el contenedor del panel.
import type { RefObject } from "react";

import { useSetlistLayout, type SetlistLayoutClass } from "../setlist/useSetlistLayout";

export type RhythmLayoutClass = SetlistLayoutClass;

export function useRhythmLayout(
  containerRef: RefObject<HTMLElement | null>,
  forced?: RhythmLayoutClass,
): RhythmLayoutClass {
  return useSetlistLayout(containerRef, forced);
}
