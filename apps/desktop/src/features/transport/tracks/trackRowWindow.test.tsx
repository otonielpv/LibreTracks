import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useManyTracksSongForTest } from "../../../app/testDesktopApiMock";
import { act, fireEvent, renderApp, TIMELINE_DEFAULT_TRACK_HEIGHT } from "../../../test/testUtils";
import { TIMELINE_RULER_HEIGHT, TRACK_VIRTUALIZATION_MIN_ROWS } from "../constants";
import { readPerfSnapshot, startPerfMetrics, stopPerfMetrics } from "../perf/perfMetrics";
import { useTimelineUIStore } from "../uiStore";
import { meterTickerStats } from "./meterTicker";
import { buildTrackRowLayout } from "./trackLayout";
import { trackRowSegments } from "./trackRowWindowing";
import { useTrackRowWindowStore } from "./useTrackRowWindow";
import { resolveVisibleTrackRows } from "./useVisibleTrackRows";

/**
 * Paso 05 de `docs/plans/completed/track-virtualization`, sobre la app entera: con una
 * sesion de 138 pistas (como `TestMultiplesAnalisis`) y un viewport con alto,
 * solo se montan las cabeceras y carriles cercanos, con la geometria exacta.
 */

const VIEWPORT_HEIGHT = 600;
const TRACK_COUNT = 138;

let restoreClientHeight: (() => void) | null = null;

/** jsdom no tiene layout: el visor de scroll del timeline mide `height`. */
function giveTimelineViewportHeight(height: number) {
  // jsdom lo define en Element; se tapa en HTMLElement y se destapa borrándolo.
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("lt-timeline-scroll-viewport")
        ? height
        : original.get!.call(this);
    },
  });
  restoreClientHeight = () => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  };
}

function viewport() {
  return document.querySelector<HTMLElement>(".lt-timeline-scroll-viewport")!;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Espera a que la app deje de renderizar: tres tandas seguidas de 20 ms sin
 * renders nuevos. Lo que el arranque deja pendiente (promesas del mock,
 * efectos diferidos) llega antes o despues segun la carga de la maquina, y
 * con la suite entera en paralelo podia caer dentro del bucle que cuenta los
 * renders del scroll y pasar por uno de el.
 */
async function settleRenders(read: () => number) {
  let last = read();
  for (let quiet = 0, round = 0; quiet < 3 && round < 50; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const now = read();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
}

let scrollTop = 0;
async function scrollViewportTo(value: number) {
  const element = viewport();
  if (!Object.getOwnPropertyDescriptor(element, "scrollTop")) {
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });
  }
  scrollTop = value;
  await act(async () => {
    element.dispatchEvent(new Event("scroll"));
    await nextFrame();
  });
}

/** Ids de las filas montadas de una columna, con su `top` sumando las
 * alturas en linea de espaciadores y filas, en orden de DOM. */
function columnRows(listSelector: string, rowSelector: string) {
  const list = document.querySelector<HTMLElement>(listSelector)!;
  const tops = new Map<string, number>();
  let cursor = 0;
  for (const child of Array.from(list.children) as HTMLElement[]) {
    const isSpacer = child.classList.contains("lt-track-row-spacer");
    const isRow = child.matches(rowSelector) && child.dataset.trackId;
    if (!isSpacer && !isRow) continue;
    if (isRow) tops.set(child.dataset.trackId!, cursor);
    cursor += Number.parseFloat(child.style.height);
  }
  return { tops, totalHeight: cursor };
}

const headerColumn = () => columnRows(".lt-track-headers-list", ".lt-track-header-row");
const laneColumn = () => columnRows(".lt-track-layers", ".lt-track-lane-row");
const trackId = (index: number) => `many-track-${index}`;

function expectedLayout(count = TRACK_COUNT) {
  return buildTrackRowLayout(
    Array.from({ length: count }, (_, index) => ({ id: trackId(index) })),
    TIMELINE_DEFAULT_TRACK_HEIGHT,
  );
}

beforeEach(() => {
  scrollTop = 0;
});

afterEach(() => {
  restoreClientHeight?.();
  restoreClientHeight = null;
  stopPerfMetrics();
});

describe("virtualized track rows", () => {
  it("mounts only the rows near a 600 px viewport out of 138", async () => {
    giveTimelineViewportHeight(VIEWPORT_HEIGHT);
    useManyTracksSongForTest(TRACK_COUNT);
    await renderApp();

    const headers = headerColumn();
    const lanes = laneColumn();
    const visibleRows = Math.ceil((VIEWPORT_HEIGHT - TIMELINE_RULER_HEIGHT) / TIMELINE_DEFAULT_TRACK_HEIGHT);
    expect(headers.tops.size).toBeGreaterThanOrEqual(visibleRows);
    // Lo visible, un viewport de margen por abajo y el redondeo a bloques.
    expect(headers.tops.size).toBeLessThanOrEqual(2 * visibleRows + 2 + 8);
    expect(lanes.tops.size).toBe(headers.tops.size);
    // Los medidores de las filas no montadas no estan registrados.
    expect(meterTickerStats().registered).toBe(headers.tops.size);
  });

  it("keeps the total content height and lines up headers with lanes", async () => {
    giveTimelineViewportHeight(VIEWPORT_HEIGHT);
    useManyTracksSongForTest(TRACK_COUNT);
    await renderApp();
    const layout = expectedLayout();

    for (const position of [0, 3000, layout.totalHeight - 200]) {
      await scrollViewportTo(position);
      const headers = headerColumn();
      const lanes = laneColumn();
      expect(headers.totalHeight, `scroll ${position}`).toBe(layout.totalHeight);
      expect(lanes.totalHeight, `scroll ${position}`).toBe(layout.totalHeight);
      expect([...lanes.tops]).toEqual([...headers.tops]);
      for (const [id, top] of headers.tops) {
        expect(top).toBe(layout.topOf(id));
      }
    }
  });

  it("keeps the geometry exact with own row heights and a folded folder", async () => {
    giveTimelineViewportHeight(VIEWPORT_HEIGHT);
    // Pista 10 es una carpeta plegada con 11..20 dentro; varias con alto propio.
    useManyTracksSongForTest(TRACK_COUNT, (index) => ({
      ...(index % 5 === 0 ? { heightOffset: 40 } : index % 7 === 0 ? { heightOffset: -20 } : {}),
      ...(index === 10 ? { kind: "folder" as const, hasChildren: true, collapsed: true } : {}),
      ...(index > 10 && index <= 20 ? { parentTrackId: trackId(10) } : {}),
    }));
    await renderApp();
    const visible = Array.from({ length: TRACK_COUNT }, (_, index) => index).filter(
      (index) => index <= 10 || index > 20,
    );
    const layout = buildTrackRowLayout(
      visible.map((index) => ({
        id: trackId(index),
        heightOffset: index % 5 === 0 ? 40 : index % 7 === 0 ? -20 : null,
      })),
      TIMELINE_DEFAULT_TRACK_HEIGHT,
    );

    for (const position of [0, 2500, layout.totalHeight - 200]) {
      await scrollViewportTo(position);
      const headers = headerColumn();
      const lanes = laneColumn();
      expect(headers.totalHeight, `scroll ${position}`).toBe(layout.totalHeight);
      expect(lanes.totalHeight, `scroll ${position}`).toBe(layout.totalHeight);
      expect([...lanes.tops]).toEqual([...headers.tops]);
      for (const [id, top] of headers.tops) {
        expect(top, id).toBe(layout.topOf(id));
      }
      expect(headers.tops.has(trackId(15))).toBe(false);
    }
  });

  it("re-renders the headers once per block crossed, never per scroll event", async () => {
    giveTimelineViewportHeight(VIEWPORT_HEIGHT);
    useManyTracksSongForTest(TRACK_COUNT);
    await renderApp();
    startPerfMetrics();
    const layout = expectedLayout();
    const windowAt = (position: number) =>
      JSON.stringify(
        resolveVisibleTrackRows(
          layout,
          { scrollTop: position, clientHeight: VIEWPORT_HEIGHT },
          { headerOffsetPx: TIMELINE_RULER_HEIGHT },
        ),
      );

    await scrollViewportTo(2000);
    const rendersAt = () =>
      readPerfSnapshot().renderCounts.find(([name]) => name === "TrackHeadersPane")?.[1] ?? 0;
    await settleRenders(rendersAt);
    const before = rendersAt();
    let publications = 0;
    const unsubscribe = useTrackRowWindowStore.subscribe(() => {
      publications += 1;
    });
    let position = 2000;
    for (let step = 0; step < 20 && windowAt(position + 5) === windowAt(2000); step += 1) {
      position += 5;
      await scrollViewportTo(position);
    }
    expect(position).toBeGreaterThan(2000);
    expect(rendersAt() - before).toBe(0);
    // Ni siquiera el store se entera: no hay nada que publicar.
    expect(publications).toBe(0);
    unsubscribe();

    const crossing = 2000 + 8 * TIMELINE_DEFAULT_TRACK_HEIGHT;
    expect(windowAt(crossing)).not.toBe(windowAt(2000));
    await scrollViewportTo(crossing);
    expect(rendersAt() - before).toBe(1);
  });

  it("below the threshold the DOM is the same as without virtualization", async () => {
    giveTimelineViewportHeight(VIEWPORT_HEIGHT);
    useManyTracksSongForTest(TRACK_VIRTUALIZATION_MIN_ROWS);
    await renderApp();

    expect(document.querySelectorAll(".lt-track-row-spacer")).toHaveLength(0);
    expect(headerColumn().tops.size).toBe(TRACK_VIRTUALIZATION_MIN_ROWS);
    expect(laneColumn().tops.size).toBe(TRACK_VIRTUALIZATION_MIN_ROWS);
  });

  it("with an unknown viewport height every row is mounted", async () => {
    useManyTracksSongForTest(TRACK_COUNT);
    await renderApp();

    expect(document.querySelectorAll(".lt-track-row-spacer")).toHaveLength(0);
    expect(headerColumn().tops.size).toBe(TRACK_COUNT);
    expect(laneColumn().tops.size).toBe(TRACK_COUNT);
  });

  describe("pinned rows", () => {
    const farAway = () => expectedLayout().totalHeight - 300;

    it("keeps the row under a pressed pointer (drag, resize) in place", async () => {
      giveTimelineViewportHeight(VIEWPORT_HEIGHT);
      useManyTracksSongForTest(TRACK_COUNT);
      await renderApp();
      const row = document.querySelector<HTMLElement>(`.lt-track-header-row[data-track-id="${trackId(1)}"]`)!;

      fireEvent.pointerDown(row.querySelector(".lt-track-header")!);
      await scrollViewportTo(farAway());
      expect(headerColumn().tops.get(trackId(1))).toBe(expectedLayout().topOf(trackId(1)));
      expect(laneColumn().tops.get(trackId(1))).toBe(expectedLayout().topOf(trackId(1)));
      expect(headerColumn().tops.has(trackId(2))).toBe(false);
      expect(headerColumn().totalHeight).toBe(expectedLayout().totalHeight);

      await act(async () => {
        window.dispatchEvent(new Event("pointerup"));
      });
      expect(headerColumn().tops.has(trackId(1))).toBe(false);
    });

    it("keeps the row holding keyboard focus", async () => {
      giveTimelineViewportHeight(VIEWPORT_HEIGHT);
      useManyTracksSongForTest(TRACK_COUNT);
      await renderApp();
      const fader = document.querySelector<HTMLElement>(
        `.lt-track-header-row[data-track-id="${trackId(2)}"] input`,
      )!;

      act(() => fader.focus());
      await scrollViewportTo(farAway());

      expect(headerColumn().tops.get(trackId(2))).toBe(expectedLayout().topOf(trackId(2)));
      expect(document.activeElement).toBe(fader);
    });

    it("keeps the expanded track", async () => {
      giveTimelineViewportHeight(VIEWPORT_HEIGHT);
      useManyTracksSongForTest(TRACK_COUNT);
      await renderApp();

      act(() => useTimelineUIStore.getState().setExpandedTrackId(trackId(3)));
      await scrollViewportTo(farAway());

      expect(headerColumn().tops.get(trackId(3))).toBe(expectedLayout().topOf(trackId(3)));
      expect(headerColumn().totalHeight).toBe(expectedLayout().totalHeight);
    });
  });
});

describe("trackRowSegments", () => {
  const layout = buildTrackRowLayout(
    Array.from({ length: 60 }, (_, index) => ({ id: `t${index}`, heightOffset: [0, 30, -6, 90][index % 4] })),
    40,
  );

  it("adds up to the layout height with pinned rows on both sides", () => {
    for (const [startIndex, endIndex, pinnedIndices] of [
      [16, 32, [2, 59]],
      [0, 8, [40]],
      [48, 60, [0, 1]],
      [24, 24, [10]],
    ] as Array<[number, number, number[]]>) {
      const segments = trackRowSegments(layout, { startIndex, endIndex, pinnedIndices });
      let cursor = 0;
      for (const segment of segments) {
        if (segment.kind === "row") {
          expect(cursor).toBe(layout.tops[segment.index]);
          cursor += layout.heights[segment.index];
        } else {
          expect(segment.height).toBeGreaterThan(0);
          cursor += segment.height;
        }
      }
      expect(cursor).toBe(layout.totalHeight);
      const rows = segments.filter((segment) => segment.kind === "row").map((segment) => segment.index);
      expect(rows).toEqual([...new Set([...pinnedIndices, ...Array.from({ length: endIndex - startIndex }, (_, i) => startIndex + i)])].sort((a, b) => a - b));
    }
  });
});
