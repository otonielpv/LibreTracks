import { describe, expect, it } from "vitest";

import { applyMarkerMovePreview } from "./CanvasTimeline";
import type { SectionMarkerSummary } from "../desktopApi";

/**
 * El arrastre de una marca llega al canvas por un REF y se aplica al dibujar,
 * no por props (docs/plans/ui-performance, paso 02). Esta función es ese punto
 * de aplicación: si se equivoca, la bandera no sigue al puntero — o peor, se
 * mueve la marca que no era.
 */
const MARKERS = [
  { id: "a", name: "Intro", startSeconds: 1, kind: "intro" },
  { id: "b", name: "Coro", startSeconds: 5, kind: "chorus" },
] as unknown as SectionMarkerSummary[];

describe("applyMarkerMovePreview", () => {
  it("devuelve la MISMA lista cuando no hay arrastre", () => {
    // Identidad, no igualdad: esto corre en cada repintado y no debe asignar.
    expect(applyMarkerMovePreview(MARKERS, null)).toBe(MARKERS);
  });

  it("sustituye posición y carril sólo de la marca arrastrada", () => {
    const result = applyMarkerMovePreview(MARKERS, {
      markerId: "b",
      startSeconds: 12.5,
      category: "cue",
    });

    expect(result[1].startSeconds).toBe(12.5);
    expect(result[1].categoryOverride).toBe("cue");
    // La otra marca se queda intacta, y por identidad: no se clona de más.
    expect(result[0]).toBe(MARKERS[0]);
    // Y el original no se muta.
    expect(MARKERS[1].startSeconds).toBe(5);
  });

  it("no toca nada si el id del arrastre no existe", () => {
    const result = applyMarkerMovePreview(MARKERS, {
      markerId: "fantasma",
      startSeconds: 99,
      category: "cue",
    });
    expect(result.map((marker) => marker.startSeconds)).toEqual([1, 5]);
  });
});
