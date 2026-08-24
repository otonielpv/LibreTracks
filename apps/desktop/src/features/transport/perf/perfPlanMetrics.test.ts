import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readPerfSnapshot,
  recordGridBuild,
  recordIpcCommand,
  recordRender,
  recordWaveformTileRender,
  reportWaveformTileCache,
  settlePerfCommits,
  startPerfMetrics,
  stopPerfMetrics,
} from "./perfMetrics";

/**
 * Métricas añadidas para `docs/plans/ui-performance` (paso 01).
 *
 * Lo que estos tests protegen no es el rendimiento: es que **el banco de
 * medición mida algo**. Una instrumentación silenciosamente rota daría cero en
 * todos los gestos y se leería como "ya está arreglado", que es el peor
 * resultado posible para un plan cuya primera regla es no fiarse de las
 * suposiciones.
 *
 * En particular, la detección de gestos vive en los listeners de ventana y
 * depende de las clases CSS reales del timeline. Si alguien renombra
 * `.lt-region-hotspot`, el gesto deja de detectarse y estos tests avisan.
 */

/** Un `pointerdown`/`pointerup` real que viaja hasta window con su target. */
function dispatchPointer(
  type: string,
  target: Element,
  button = 0,
  clientX = 0,
  clientY = 0,
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      button,
      cancelable: true,
      clientX,
      clientY,
    }),
  );
}

function dispatchPointerMove(clientX: number, clientY: number) {
  window.dispatchEvent(
    new MouseEvent("pointermove", { bubbles: true, clientX, clientY }),
  );
}

function mountTarget(className: string, parentClassName?: string) {
  const parent = document.createElement("div");
  if (parentClassName) parent.className = parentClassName;
  const element = document.createElement("button");
  element.className = className;
  parent.appendChild(element);
  document.body.appendChild(parent);
  return element;
}

afterEach(() => {
  stopPerfMetrics();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("no-op mientras el HUD está apagado", () => {
  it("ignora todas las métricas nuevas antes de arrancar", () => {
    recordWaveformTileRender(12);
    reportWaveformTileCache(40, 40 * 1024 * 1024);
    recordGridBuild(9600);
    recordIpcCommand("get_song_view", 80, true);

    const snapshot = readPerfSnapshot();
    expect(snapshot.waveformTileRenders).toBe(0);
    expect(snapshot.waveformTileCacheBytes).toBe(0);
    expect(snapshot.gridBuilds).toBe(0);
    expect(snapshot.ipcByCommand).toEqual([]);
  });

  it("no abre gestos con los listeners sin instalar", () => {
    const hotspot = mountTarget("lt-region-hotspot is-selected");
    dispatchPointer("pointerdown", hotspot);
    dispatchPointer("pointerup", hotspot);
    expect(readPerfSnapshot().gestures).toEqual([]);
  });
});

describe("con el HUD arrancado", () => {
  beforeEach(() => {
    startPerfMetrics();
  });

  it("acumula rasterizaciones de tile con EMA y peor caso", () => {
    recordWaveformTileRender(10);
    expect(readPerfSnapshot().waveformTileRenderEma).toBeCloseTo(10, 6);
    recordWaveformTileRender(20);
    // EMA = 10 * 0,85 + 20 * 0,15 = 11,5.
    expect(readPerfSnapshot().waveformTileRenderEma).toBeCloseTo(11.5, 6);
    expect(readPerfSnapshot().waveformTileRenders).toBe(2);
  });

  // Regresión de un defecto REAL encontrado en la primera medición: 64 tiles
  // rasterizados y `waveformTileMsLastSecond` = 0 en las 513 muestras, porque
  // la ventana de un segundo se cerraba dentro de `recordWaveformTileRender` y
  // los tiles llegan en ráfaga y luego paran.
  //
  // El test conduce el bucle de rAF con un reloj FALSO (no espera a hilos: es
  // determinista, no viola la regla 4 del plan). Eso es lo que prueba la parte
  // que importa — que el cierre de ventana está enganchado al bucle de frames
  // y no al camino de rasterizado.
  it("cierra la ventana del segundo aunque dejen de rasterizarse tiles", () => {
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "Date",
      ],
    });
    try {
      // El `beforeEach` de este bloque ya arrancó las métricas contra el reloj
      // REAL, y `startPerfMetrics` sale por la puerta de atrás si ya está en
      // marcha. Hay que pararlas para volver a arrancarlas sobre el reloj
      // falso, o el bucle de rAF seguiría en el otro reloj y el test no
      // probaría nada.
      stopPerfMetrics();
      startPerfMetrics();
      vi.advanceTimersByTime(100);

      recordWaveformTileRender(5);
      recordWaveformTileRender(7);
      // Todavía dentro de la ventana: nada publicado.
      vi.advanceTimersByTime(500);
      expect(readPerfSnapshot().waveformTileMsLastSecond).toBe(0);

      // Pasa el segundo SIN un solo tile nuevo. El total debe publicarse igual.
      vi.advanceTimersByTime(1000);
      const snapshot = readPerfSnapshot();
      expect(snapshot.waveformTileMsLastSecond).toBe(12);
      expect(snapshot.waveformTileRenderWorstMs).toBe(7);

      // Y la ventana siguiente arranca limpia.
      vi.advanceTimersByTime(1100);
      expect(readPerfSnapshot().waveformTileMsLastSecond).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recuerda el pico de memoria de la caché de tiles", () => {
    reportWaveformTileCache(300, 300 * 1024 * 1024);
    reportWaveformTileCache(10, 10 * 1024 * 1024);
    const snapshot = readPerfSnapshot();
    expect(snapshot.waveformTileCacheBytes).toBe(10 * 1024 * 1024);
    // El pico es lo que dice si el techo de 320 MiB se está tocando.
    expect(snapshot.waveformTileCachePeakBytes).toBe(300 * 1024 * 1024);
  });

  it("cuenta reconstrucciones de rejilla y su tamaño", () => {
    recordGridBuild(1440);
    recordGridBuild(9600);
    const snapshot = readPerfSnapshot();
    expect(snapshot.gridBuilds).toBe(2);
    expect(snapshot.gridEntries).toBe(9600);
  });

  it("ordena el IPC por coste total, no por coste unitario", () => {
    // Barato pero llamado mucho (240 ms en total) vs. caro y puntual (80 ms).
    for (let index = 0; index < 40; index += 1) {
      recordIpcCommand("get_transport_snapshot", 6, true);
    }
    recordIpcCommand("get_song_view", 80, true);
    recordIpcCommand("move_song_region", 30, false);

    const [first, second] = readPerfSnapshot().ipcByCommand;
    expect(first[0]).toBe("get_transport_snapshot");
    expect(first[1]).toBe(40);
    expect(first[2]).toBeCloseTo(6, 6);
    expect(second[0]).toBe("get_song_view");

    const failed = readPerfSnapshot().ipcByCommand.find(
      ([command]) => command === "move_song_region",
    );
    expect(failed?.[4]).toBe(1);
  });
});

describe("detección de gestos", () => {
  beforeEach(() => {
    startPerfMetrics();
  });

  it.each([
    ["lt-region-hotspot", "region-move"],
    ["lt-region-resize-handle is-start", "region-resize"],
    ["lt-marker-hotspot is-selected", "marker-move"],
    ["lt-automation-hotspot", "cue-move"],
    ["lt-track-lane is-midi", "clip-drag"],
  ])("reconoce %s como gesto %s", (className, expectedKind) => {
    const target = mountTarget(className);
    dispatchPointer("pointerdown", target);
    dispatchPointer("pointerup", target);

    const [gesture] = readPerfSnapshot().gestures;
    expect(gesture?.kind).toBe(expectedKind);
  });

  // Regresión del fallo que dejó CIEGO al banco en la primera medición real:
  // `beginRegionMove` llama a `event.stopPropagation()`, así que un listener de
  // ventana en fase de BURBUJA nunca ve el pointerdown. Resultado: 8 llamadas a
  // `move_song_region` en la tabla de IPC y cero gestos `region-move`.
  it("ve el gesto aunque el elemento llame a stopPropagation", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    // Igual que hace el código real del arrastre de regiones.
    hotspot.addEventListener("pointerdown", (event) => event.stopPropagation());
    hotspot.addEventListener("pointerup", (event) => event.stopPropagation());

    dispatchPointer("pointerdown", hotspot);
    dispatchPointer("pointerup", hotspot);

    const [gesture] = readPerfSnapshot().gestures;
    expect(gesture?.kind).toBe("region-move");
  });

  it("distingue un arrastre de un clic por la distancia recorrida", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    dispatchPointer("pointerdown", hotspot, 0, 100, 100);
    // Temblor de 2 px: por debajo del umbral, no es un arrastre.
    dispatchPointerMove(101, 101);
    dispatchPointer("pointerup", hotspot, 0, 101, 101);
    expect(readPerfSnapshot().gestures[0].movedEnough).toBe(false);
    // Y por tanto NO abre un cronómetro que se quedaría colgado.
    expect(readPerfSnapshot().openCommits).toBe(0);

    dispatchPointer("pointerdown", hotspot, 0, 100, 100);
    dispatchPointerMove(140, 100);
    dispatchPointer("pointerup", hotspot, 0, 140, 100);
    expect(readPerfSnapshot().gestures[0].movedEnough).toBe(true);
    expect(readPerfSnapshot().openCommits).toBe(1);
  });

  it("cuenta los renders que ocurren DENTRO del gesto", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    recordRender("TimelineCanvasPane"); // antes del gesto: no cuenta

    dispatchPointer("pointerdown", hotspot);
    dispatchPointerMove(50, 0);
    recordRender("TimelineCanvasPane");
    dispatchPointerMove(90, 0);
    recordRender("TimelineCanvasPane");
    recordRender("TransportPanelContent");
    dispatchPointer("pointerup", hotspot);

    recordRender("TimelineCanvasPane"); // después del gesto: tampoco cuenta

    const [gesture] = readPerfSnapshot().gestures;
    expect(gesture.kind).toBe("region-move");
    expect(gesture.moves).toBe(2);
    // Éste es el número que el paso 02 debe llevar a cero.
    expect(gesture.renders).toBe(3);
    expect(gesture.rendersByComponent).toEqual({
      TimelineCanvasPane: 2,
      TransportPanelContent: 1,
    });
    // Y el contador global sigue viendo los cinco.
    expect(Object.fromEntries(readPerfSnapshot().renderCounts)).toEqual({
      TimelineCanvasPane: 4,
      TransportPanelContent: 1,
    });
  });

  it("atribuye al gesto los tiles rasterizados durante él", () => {
    const lane = mountTarget("lt-track-lane");
    dispatchPointer("pointerdown", lane);
    recordWaveformTileRender(3);
    recordWaveformTileRender(4);
    dispatchPointer("pointerup", lane);

    expect(readPerfSnapshot().gestures[0].tileRenders).toBe(2);
  });

  it("ignora los botones que no son el principal", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    dispatchPointer("pointerdown", hotspot, 2); // clic derecho: menú, no arrastre
    dispatchPointer("pointerup", hotspot, 2);
    expect(readPerfSnapshot().gestures).toEqual([]);
  });

  it("cierra el gesto al perder el foco, sin arrastrarlo al siguiente", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    dispatchPointer("pointerdown", hotspot);
    dispatchPointerMove(50, 0);
    window.dispatchEvent(new Event("blur"));

    // Un movimiento posterior ya no pertenece a ningún gesto.
    dispatchPointerMove(90, 0);
    recordRender("TimelineCanvasPane");

    const [gesture] = readPerfSnapshot().gestures;
    expect(gesture.moves).toBe(1);
    expect(gesture.renders).toBe(0);
  });
});

describe("cronómetro del commit de edición", () => {
  beforeEach(() => {
    startPerfMetrics();
  });

  it("abre un commit al soltar un arrastre que movió algo", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    dispatchPointer("pointerdown", hotspot);
    dispatchPointerMove(50, 0);
    dispatchPointer("pointerup", hotspot);

    expect(readPerfSnapshot().openCommits).toBe(1);

    settlePerfCommits();
    const snapshot = readPerfSnapshot();
    expect(snapshot.openCommits).toBe(0);
    expect(snapshot.commits).toHaveLength(1);
    expect(snapshot.commits[0].kind).toBe("region-move");
    expect(snapshot.commits[0].settledBy).toBe("song");
    expect(snapshot.commits[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("NO abre commit en un clic simple, que no edita nada", () => {
    const hotspot = mountTarget("lt-region-hotspot");
    dispatchPointer("pointerdown", hotspot);
    dispatchPointer("pointerup", hotspot);

    expect(readPerfSnapshot().openCommits).toBe(0);
    expect(readPerfSnapshot().commits).toEqual([]);
  });

  it("no abre commit para gestos que no editan (playhead, biblioteca)", () => {
    const playhead = mountTarget("lt-playhead is-handle");
    dispatchPointer("pointerdown", playhead);
    dispatchPointerMove(50, 0);
    dispatchPointer("pointerup", playhead);

    expect(readPerfSnapshot().gestures[0].kind).toBe("playhead-drag");
    expect(readPerfSnapshot().openCommits).toBe(0);
  });

  it("limpia todo el estado nuevo al parar", () => {
    recordWaveformTileRender(5);
    reportWaveformTileCache(10, 1024);
    recordGridBuild(100);
    recordIpcCommand("x", 1, true);

    stopPerfMetrics();

    const snapshot = readPerfSnapshot();
    expect(snapshot.waveformTileRenders).toBe(0);
    expect(snapshot.waveformTileCacheBytes).toBe(0);
    expect(snapshot.gridBuilds).toBe(0);
    expect(snapshot.ipcByCommand).toEqual([]);
    expect(snapshot.gestures).toEqual([]);
    expect(snapshot.commits).toEqual([]);
  });
});
