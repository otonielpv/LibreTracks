import { afterEach, describe, expect, it } from "vitest";

import { act, renderApp } from "../test/testUtils";
import { useTimelineUIStore } from "../features/transport/uiStore";
import {
  readPerfSnapshot,
  startPerfMetrics,
  stopPerfMetrics,
} from "../features/transport/perf/perfMetrics";

/**
 * Regresión del paso 06 de `docs/plans/ui-performance`.
 *
 * La rejilla del timeline se reconstruía en CADA render de
 * `TransportPanelContent`, porque `buildSongTempoRegions(song)` se evaluaba en
 * el cuerpo del render y le daba identidad nueva a la dep `params.regions` del
 * memo de `useTimelineGrid`.
 *
 * No era un desperdicio menor: `timelineGrid` viaja al snapshot del renderer, y
 * un cambio de identidad ahí hace que `TimelineRenderer.updateState` marque
 * `sceneChanged` y llame a `markAllDirty()` — las TRES capas de canvas
 * repintadas enteras, cada render.
 *
 * La medición del 2026-08-24 en el build de medición mostró `gridBuilds`
 * IDÉNTICO al contador de renders del panel en las 25 muestras comprobadas
 * (1:1, sin excepción), y hasta 11 reconstrucciones por un solo notch de rueda.
 */

afterEach(() => {
  stopPerfMetrics();
});

/** Renders del panel que provocamos sin tocar la canción. */
function forcePanelRenders(count: number) {
  const { trackHeight } = useTimelineUIStore.getState();
  for (let index = 0; index < count; index += 1) {
    // La altura de pista NO es parámetro de la rejilla (que sólo depende de
    // duración, bpm, compás, regiones de tempo y zoom), así que re-renderiza el
    // panel sin dar ninguna razón legítima para reconstruirla.
    act(() => {
      useTimelineUIStore
        .getState()
        .setTrackHeight(trackHeight + ((index % 3) + 1));
    });
  }
  act(() => {
    useTimelineUIStore.getState().setTrackHeight(trackHeight);
  });
}

describe("reconstrucciones de la rejilla del timeline", () => {
  it("no reconstruye la rejilla en un render que no cambia la canción", async () => {
    // Arrancar las métricas DESPUÉS de montar: `App` monta el `PerfHud`, y su
    // efecto llama a `stopPerfMetrics()` en cuanto ve la bandera del HUD
    // apagada. Hacerlo antes deja los contadores a cero y el test no mide nada
    // (lo detectó la guarda de más abajo).
    await renderApp();
    startPerfMetrics();

    const before = readPerfSnapshot();
    const gridBuildsBefore = before.gridBuilds;
    const rendersBefore =
      Object.fromEntries(before.renderCounts).TransportPanelContent ?? 0;

    forcePanelRenders(6);

    const after = readPerfSnapshot();
    const rendersAfter =
      Object.fromEntries(after.renderCounts).TransportPanelContent ?? 0;

    // Guarda contra un test que no prueba nada: si no forzamos renders de
    // verdad, la aserción de abajo pasaría sola.
    expect(rendersAfter - rendersBefore).toBeGreaterThanOrEqual(4);

    // Y el criterio del paso: esos renders no reconstruyen la rejilla.
    expect(after.gridBuilds).toBe(gridBuildsBefore);
  });
});
