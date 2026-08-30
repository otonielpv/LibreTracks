import type { SectionMarkerSummary } from "../desktopApi";

/**
 * Geometría de la bandera de una marca de sección/aviso.
 *
 * Existe como módulo aparte porque hay DOS consumidores que deben coincidir al
 * píxel: `drawRulerMarker` (que la pinta en el canvas) y el `.lt-marker-hotspot`
 * de TimelineCanvasPane (el botón invisible que la hace tocable). Cuando cada
 * uno estimaba su propio ancho, el botón acababa siendo bastante más ancho que
 * la bandera y se tragaba los toques dirigidos a la marca de al lado — que en
 * un móvil es la diferencia entre "toco la marca" y "muevo la equivocada".
 */

/** Misma fuente con la que el canvas pinta la etiqueta de la bandera. */
export const MARKER_FLAG_FONT = '600 10px "Space Grotesk", sans-serif';

/** Alto de la banderola (sin el mástil, que ocupa el alto del carril). */
export const MARKER_FLAG_HEIGHT = 16;

/** Hueco entre el mástil y el borde izquierdo del cuerpo de la bandera. */
export const MARKER_FLAG_GAP_PX = 2;

/** Ancho mínimo: una marca sin nombre sigue teniendo que poder tocarse. */
const MARKER_FLAG_MIN_WIDTH = 30;

/** Relleno horizontal del texto dentro del cuerpo. */
const MARKER_FLAG_TEXT_PADDING = 12;

/** Texto que se dibuja dentro de la bandera (prefijo de dígito si lo tiene). */
export function markerFlagLabel(marker: SectionMarkerSummary): string {
  return marker.digit == null ? marker.name : `${marker.digit}. ${marker.name}`;
}

/** Ancho del cuerpo de la bandera para una etiqueta ya medida. */
export function markerFlagWidthFromTextWidth(textWidth: number): number {
  return Math.max(
    MARKER_FLAG_MIN_WIDTH,
    Math.ceil(textWidth) + MARKER_FLAG_TEXT_PADDING,
  );
}

/** Ancho del cuerpo medido con un contexto de canvas ya disponible (el propio
 * bucle de dibujo del ruler). */
export function markerFlagWidth(
  context: CanvasRenderingContext2D,
  label: string,
): number {
  context.font = MARKER_FLAG_FONT;
  return markerFlagWidthFromTextWidth(context.measureText(label).width);
}

// ── Medición desde el DOM ───────────────────────────────────────────────────
// El hotspot se calcula durante el render de React, donde no hay un contexto de
// canvas a mano. Se mide contra un canvas fuera de pantalla creado una sola vez
// y se memoiza por etiqueta: en una sesión con muchas marcas esto se evalúa en
// cada render del panel y `measureText` no es gratis.

let measuringContext: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function getMeasuringContext(): CanvasRenderingContext2D | null {
  if (measuringContext !== undefined) {
    return measuringContext;
  }
  if (typeof document === "undefined") {
    measuringContext = null;
    return null;
  }
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = MARKER_FLAG_FONT;
  }
  measuringContext = context;
  return context;
}

/**
 * Ancho del cuerpo de la bandera tal y como lo pintará el canvas.
 *
 * En jsdom (y en cualquier entorno sin canvas 2d) `measureText` no existe o
 * devuelve 0; ahí se cae a una estimación por caracteres, que es exactamente lo
 * que hacía el hotspot antes en TODAS partes.
 */
export function measureMarkerFlagWidth(label: string): number {
  const cached = widthCache.get(label);
  if (cached !== undefined) {
    return cached;
  }

  const context = getMeasuringContext();
  const textWidth = context ? context.measureText(label).width : 0;
  const width =
    textWidth > 0
      ? markerFlagWidthFromTextWidth(textWidth)
      : markerFlagWidthFromTextWidth(label.length * 5.5);

  widthCache.set(label, width);
  return width;
}
