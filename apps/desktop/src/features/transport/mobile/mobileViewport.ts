/**
 * Encuadre de la línea de tiempo para el recorrido móvil.
 *
 * Por qué vive aquí y no mide el DOM: el ancho de las lanes NO se puede leer
 * de `.lt-track-list` ni del ruler. `.lt-track-list` incluye la columna de
 * cabeceras, así que "ver toda la sesión" dejaría el final fuera de pantalla;
 * y el contenido del ruler se auto-dimensiona a `laneViewportWidth`, con lo que
 * medirlo devuelve el valor que ya teníamos (ver
 * `docs/REDESIGN_transport_refs_to_stores.md` y el efecto `updateViewportWidth`
 * de `TransportPanelContent`). El monolito ya calcula ambos valores bien; aquí
 * sólo se reciben y se convierten en cámara.
 */

const PLAYHEAD_MARGIN_RATIO = 0.5;

/**
 * Cámara que deja el cabezal centrado en el ancho útil de lanes. Centrar, y no
 * pegarlo al borde izquierdo, es lo que hace legible el contexto anterior en
 * una pantalla estrecha.
 */
export function playheadCameraX(
  positionSeconds: number,
  pixelsPerSecond: number,
  laneViewportWidth: number,
): number {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(pixelsPerSecond)) {
    return 0;
  }
  const centered =
    Math.max(0, positionSeconds) * pixelsPerSecond -
    Math.max(0, laneViewportWidth) * PLAYHEAD_MARGIN_RATIO;
  return Math.max(0, centered);
}

const PREPARATION_OPEN_KEY = "libretracks.mobile.preparationOpen";

/**
 * Si el panel de preparación arranca abierto.
 *
 * Por defecto NO: quien abre la app para ensayar una sesión ya montada debe
 * seguir cayendo en la vista de siempre. Se recuerda la última elección para
 * que quien esté montando vuelva donde lo dejó.
 */
export function readPreparationOpen(): boolean {
  try {
    return window.localStorage.getItem(PREPARATION_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writePreparationOpen(open: boolean): void {
  try {
    window.localStorage.setItem(PREPARATION_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Modo privado o almacenamiento bloqueado: la preferencia es prescindible.
  }
}
