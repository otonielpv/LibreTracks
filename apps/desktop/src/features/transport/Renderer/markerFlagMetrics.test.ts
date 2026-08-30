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
const canvasTimeline = readFileSync(
  resolve(rendererDir, "../timeline/CanvasTimeline.tsx"),
  "utf8",
);

function marker(name: string, digit?: number): SectionMarkerSummary {
  return { id: "m", name, startSeconds: 0, digit } as SectionMarkerSummary;
}

/** Última regla cuyo selector sea EXACTAMENTE el dado (no una compuesta). */
function baseRuleFor(selector: string): string {
  const escaped = selector.replace(".", "\\.");
  const matches = Array.from(
    styles.matchAll(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]+)\\}`, "g")),
  );
  expect(matches.length, `falta la regla ${selector}`).toBeGreaterThan(0);
  return matches.at(-1)?.[2] ?? "";
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
    const match = styles.match(
      /((?:\.lt-ruler-overlay-content\.is-zoom-preview[^,{]+,?\s*)+)\{([^}]+)\}/,
    );
    expect(match, "falta la regla de contra-escala").toBeTruthy();
    const [, selectorList, rule] = match ?? [];

    expect(rule).toContain("scaleX(var(--lt-ruler-mark-scale-x, 1))");
    // El desplazamiento a la izquierda pasa de `margin-left` a una traslación
    // por la misma variable: el padre escala también las traslaciones.
    expect(rule).toContain("var(--lt-hotspot-offset-x)");
    expect(rule).toContain("margin-left: 0");

    // Cubre las dos zonas de ancho fijo, y sólo esas: la banda de una región
    // mide en segundos y SÍ debe estirarse con el zoom.
    expect(selectorList).toContain(".lt-marker-hotspot");
    expect(selectorList).toContain(".lt-tempo-hotspot");
    expect(selectorList).not.toContain(".lt-region-hotspot");
  });

  // Fuera del gesto la escala es 1 y la contra-escala no haría nada, pero un
  // `transform` puesto en cada hotspot obliga al WebView a tratarlos como capas
  // propias en cada cuadro que la cámara se mueve. Con decenas de marcas eso se
  // nota en un teléfono, así que la regla vive bajo una clase que sólo existe
  // mientras el zoom está sin confirmar.
  it("no deja transform en los hotspots fuera del gesto de zoom", () => {
    expect(baseRuleFor(".lt-marker-hotspot")).not.toContain("transform");
    expect(baseRuleFor(".lt-tempo-hotspot")).not.toContain("transform");
    expect(canvasTimeline).toContain('"is-zoom-preview"');
    expect(canvasTimeline).toContain("overlayScaleX !== 1");
  });
});
