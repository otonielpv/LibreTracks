import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  markerFlagLabel,
  markerFlagWidthFromTextWidth,
  measureMarkerFlagWidth,
} from "./markerFlagMetrics";
import type { SectionMarkerSummary } from "../desktopApi";

const rendererDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(
  resolve(rendererDir, "../../../shared/styles.css"),
  "utf8",
);
const pane = readFileSync(
  resolve(rendererDir, "../timeline/TimelineCanvasPane.tsx"),
  "utf8",
);
const drawBackground = readFileSync(
  resolve(rendererDir, "drawBackground.ts"),
  "utf8",
);

function marker(name: string, digit?: number): SectionMarkerSummary {
  return { id: "m", name, startSeconds: 0, digit } as SectionMarkerSummary;
}

describe("geometría de la bandera de una marca", () => {
  it("incluye el prefijo de dígito en la etiqueta que se mide", () => {
    expect(markerFlagLabel(marker("Estribillo"))).toBe("Estribillo");
    expect(markerFlagLabel(marker("Estribillo", 3))).toBe("3. Estribillo");
  });

  it("nunca baja del mínimo tocable aunque el nombre esté vacío", () => {
    expect(markerFlagWidthFromTextWidth(0)).toBe(30);
    expect(measureMarkerFlagWidth("")).toBe(30);
  });

  it("crece con el nombre en vez de saltar a un tope fijo", () => {
    const corto = measureMarkerFlagWidth("A");
    const largo = measureMarkerFlagWidth("12. Estribillo final");

    expect(largo).toBeGreaterThan(corto);
    // El tope anterior (96 px en móvil) recortaba los nombres largos por abajo
    // y ensanchaba los cortos por arriba: ni la bandera ni el toque coincidían.
    expect(largo).toBeGreaterThan(96);
  });

  // Las dos mitades del problema: el canvas pinta la bandera y un <button>
  // invisible la hace tocable. Cuando cada uno calculaba su propio ancho, el
  // botón sobraba por la derecha y se tragaba los toques de la marca siguiente.
  it("el canvas y el hotspot miden con el mismo módulo", () => {
    expect(drawBackground).toContain('from "./markerFlagMetrics"');
    expect(drawBackground).toContain("markerFlagWidth(context, label)");
    expect(pane).toContain("measureMarkerFlagWidth(");
    expect(pane).not.toContain("androidHotspotWidth");
  });

  /**
   * Durante la previsualización del zoom, CanvasTimeline escala en X el
   * envoltorio del ruler. Lo que mide en SEGUNDOS debe estirarse con él; una
   * zona táctil, que mide en PÍXELES, no: a 2x se convertía en el doble de
   * hueco invisible alrededor de la marca.
   */
  it("las zonas táctiles de ancho fijo se contra-escalan con el zoom", () => {
    for (const selector of [".lt-marker-hotspot", ".lt-tempo-hotspot"]) {
      const rule = styles.match(
        new RegExp(`\\${selector}\\s*\\{([^}]+)\\}`),
      )?.[1];
      expect(rule, `falta la regla ${selector}`).toBeTruthy();
      expect(rule).toContain("scaleX(var(--lt-ruler-mark-scale-x, 1))");
      // El desplazamiento a la izquierda viaja por la misma variable: el padre
      // escala también las traslaciones de sus hijos.
      expect(rule).toContain("var(--lt-hotspot-offset-x)");
      expect(rule).not.toContain("margin-left");
    }
  });
});
