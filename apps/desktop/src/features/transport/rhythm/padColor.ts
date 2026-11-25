/**
 * Color con el que se pinta un pad o sonido. Los pads y sonidos nuevos se
 * guardaban con el turquesa del acento escrito a mano (#57f1db); ese valor se
 * trata como "el acento" y sigue al tema elegido. Cualquier otro color lo eligió
 * el usuario y se respeta.
 */
export const LEGACY_ACCENT_COLOR = "#57f1db";

export function rhythmDisplayColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return color.trim().toLowerCase() === LEGACY_ACCENT_COLOR ? "var(--lt-accent)" : color;
}
