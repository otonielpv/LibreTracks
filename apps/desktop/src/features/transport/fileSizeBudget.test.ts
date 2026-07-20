import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Presupuesto de tamaño para los ficheros grandes del panel de transporte.
 *
 * Por qué existe: entre abril y julio de 2026 este directorio creció a un ritmo
 * de ~99 líneas/día, y `TransportPanelContent.tsx` llegó a 11.543 líneas. Dos
 * rondas de refactor lo bajaron, pero un refactor no cambia la pendiente: cada
 * feature nueva vuelve a añadir estado, efectos y props al mismo sitio porque
 * es el camino de menor resistencia.
 *
 * Este test no arregla nada por sí solo. Lo que hace es convertir "el archivo
 * crece sin que nadie lo decida" en una decisión consciente: cuando lo rebases,
 * tienes que elegir entre extraer algo o subir el número a mano.
 *
 * ## Si este test falla
 *
 * La opción por defecto es EXTRAER, no subir el límite. Ver
 * `docs/REDESIGN_transport_refs_to_stores.md` para la regla de decisión: cuenta
 * cuántas de las refs del bloque que quieres sacar se usan FUERA de él. Si son
 * pocas (≤5), tiene frontera y se extrae limpio; si son muchas, busca otro
 * bloque.
 *
 * Patrones ya validados en el repo para extraer sin romper nada:
 * - Handlers → factory `create*Handlers` con inyección de dependencias,
 *   instanciada una vez con `useMemo` (ver `tracks/trackHeaderHandlers.ts`,
 *   `compact/compactSongHandlers.ts`).
 * - Efectos autocontenidos → hook propio (ver `hooks/useLibraryState.ts`,
 *   `hooks/useSongWaveforms.ts`, `hooks/useDragListeners.ts`).
 *
 * Subir un límite es legítimo, pero que sea a propósito y con una razón en el
 * mensaje del commit.
 */
const BUDGETS: Record<string, number> = {
  // El monolito. Objetivo: que baje, nunca que suba.
  "TransportPanelContent.tsx": 8500,
  "library/libraryDragDrop.ts": 2300,
  "timeline/TimelineCanvasPane.tsx": 2000,
  "menus/timelineMenus.ts": 1650,
  "panels/SettingsPanel.tsx": 1500,
  "timeline/TimelineToolbar.tsx": 1250,
  "compact/CompactView.tsx": 1150,
};

const transportDir = dirname(fileURLToPath(import.meta.url));

function countLines(relativePath: string) {
  const contents = readFileSync(resolve(transportDir, relativePath), "utf8");
  return contents.split("\n").length;
}

describe("presupuesto de tamaño de ficheros", () => {
  for (const [relativePath, budget] of Object.entries(BUDGETS)) {
    it(`${relativePath} se mantiene bajo ${budget} líneas`, () => {
      const lines = countLines(relativePath);

      expect(
        lines,
        `${relativePath} tiene ${lines} líneas (presupuesto: ${budget}).\n` +
          `Antes de subir el número, lee la cabecera de este fichero: la ` +
          `opción por defecto es extraer un bloque con frontera limpia.`,
      ).toBeLessThanOrEqual(budget);
    });
  }

  it("los presupuestos no se alejan de la realidad", () => {
    // Un presupuesto muy por encima del tamaño real deja de avisar de nada.
    // Si un fichero adelgaza de verdad, baja también su número aquí.
    const slack = Object.entries(BUDGETS).map(([path, budget]) => ({
      path,
      slack: budget - countLines(path),
    }));

    for (const entry of slack) {
      expect(
        entry.slack,
        `El presupuesto de ${entry.path} le saca ${entry.slack} líneas al ` +
          `tamaño real. Bájalo para que siga sirviendo de aviso.`,
      ).toBeLessThan(600);
    }
  });
});
