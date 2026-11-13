// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClipSummary } from "../desktopApi";
import { buildTrackRowLayout, type TrackRowLayout } from "../tracks/trackLayout";
import {
  AreaSelectionDrag,
  areaRowsFromLayout,
  clipsInArea,
  rowsInBand,
  type AreaRow,
} from "./areaSelection";

/**
 * Paso 04 de `docs/plans/completed/track-virtualization`: la seleccion por area sale del
 * layout y no de medir cada fila en el DOM. Con todas las filas montadas tiene
 * que coger exactamente lo mismo que antes; sin ellas, lo que el DOM ya no ve.
 */

type Track = { id: string; heightOffset?: number; skip?: boolean };

const tracks: Track[] = [
  { id: "drums" },
  { id: "bass", heightOffset: 30 },
  { id: "automation", skip: true },
  { id: "gtr1", heightOffset: -12 },
  { id: "gtr2" },
  { id: "keys", heightOffset: 80 },
  { id: "pending", skip: true },
  { id: "vox" },
];

/** Filas montadas en `surface`, con el rect que daria el navegador: origen en
 * `originTop`, escaladas por el zoom de la interfaz. */
function mountRows(
  layout: TrackRowLayout,
  { originTop, scale, mounted }: { originTop: number; scale: number; mounted?: Set<string> },
) {
  const surface = document.createElement("div");
  tracks.forEach((track, index) => {
    if (mounted && !mounted.has(track.id)) return;
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.trackId = track.id;
    if (track.skip) row.setAttribute("data-area-skip", "");
    const top = originTop + layout.tops[index] * scale;
    const height = layout.heights[index] * scale;
    Object.defineProperty(row, "offsetHeight", { value: layout.heights[index] });
    row.getBoundingClientRect = () =>
      ({ top, bottom: top + height, height, left: 0, right: 200, width: 200 }) as DOMRect;
    surface.append(row);
  });
  document.body.append(surface);
  return surface;
}

/** Lo que hacia `AreaSelectionDrag.render` antes del paso: medir cada fila. */
function legacyRows(surface: HTMLElement): AreaRow[] {
  const rows: AreaRow[] = [];
  surface.querySelectorAll<HTMLElement>(".row").forEach((row) => {
    const id = row.dataset.trackId;
    if (!id || row.hasAttribute("data-area-skip")) return;
    const rect = row.getBoundingClientRect();
    rows.push({ id, top: rect.top, bottom: rect.bottom });
  });
  return rows;
}

function layoutRows(layout: TrackRowLayout, surface: HTMLElement) {
  return areaRowsFromLayout({
    layout,
    rows: tracks.map((track) => ({ id: track.id, skip: track.skip })),
    anchor: surface.querySelector<HTMLElement>(".row"),
  });
}

const clip = (id: string, start: number, duration: number) =>
  ({ id, timelineStartSeconds: start, durationSeconds: duration }) as ClipSummary;

const clipsByTrack: Record<string, ClipSummary[]> = {
  drums: [clip("d1", 0, 4), clip("d2", 10, 4)],
  bass: [clip("b1", 2, 6)],
  gtr1: [clip("g1", 5, 2)],
  gtr2: [clip("g2", 0, 20)],
  keys: [clip("k1", 12, 1)],
  vox: [clip("v1", 3, 3)],
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("area rows from the layout", () => {
  const layout = buildTrackRowLayout(tracks, 48);

  for (const scale of [1, 1.25]) {
    for (const originTop of [120, -900]) {
      it(`selects the same tracks and clips as measuring every row (scale ${scale}, origin ${originTop})`, () => {
        const surface = mountRows(layout, { originTop, scale });
        const legacy = legacyRows(surface);
        const fromLayout = layoutRows(layout, surface);
        const bands: Array<[number, number]> = [
          [originTop + 10, originTop + 20], // dentro de la primera fila
          [originTop + 60 * scale, originTop + 200 * scale], // varias filas
          [originTop - 500, originTop + 90], // empieza por encima del todo
          [originTop + 300 * scale, originTop + 5000], // se sale por debajo
          [originTop + layout.tops[3] * scale, originTop + layout.tops[3] * scale + 1], // borde exacto
          [originTop + 2000 * scale, originTop + 3000 * scale], // fuera de todo
        ];
        for (const [y0, y1] of bands) {
          expect(rowsInBand(fromLayout, y0, y1), `band ${y0}..${y1}`).toEqual(
            rowsInBand(legacy, y0, y1),
          );
          for (const [x0, x1] of [
            [0, 40],
            [35, 140],
            [-20, 400],
          ]) {
            expect(
              clipsInArea(fromLayout, clipsByTrack, { x0, x1, y0, y1 }, 0, 10),
              `box ${x0}..${x1} ${y0}..${y1}`,
            ).toEqual(clipsInArea(legacy, clipsByTrack, { x0, x1, y0, y1 }, 0, 10));
          }
        }
      });
    }
  }

  it("still reaches the rows that are not mounted", () => {
    // Solo la fila de en medio esta en el DOM, como con la ventana virtualizada.
    const surface = mountRows(layout, { originTop: 0, scale: 1, mounted: new Set(["gtr1"]) });
    const rows = layoutRows(layout, surface);
    expect(rowsInBand(rows, -100, 10_000)).toEqual(["drums", "bass", "gtr1", "gtr2", "keys", "vox"]);
  });

  it("does not search the DOM for rows while the box moves", () => {
    const surface = mountRows(layout, { originTop: 0, scale: 1 });
    Object.defineProperties(surface, {
      offsetWidth: { value: 200 },
      offsetHeight: { value: layout.totalHeight },
    });
    surface.getBoundingClientRect = () =>
      ({ top: 0, bottom: layout.totalHeight, height: layout.totalHeight, left: 0, right: 200, width: 200 }) as DOMRect;
    const anchor = surface.querySelector<HTMLElement>(".row");
    const querySelectorAll = vi.spyOn(surface, "querySelectorAll");
    let selection: string[] = [];
    const drag = new AreaSelectionDrag(
      {
        surface,
        getRows: () => ({
          layout,
          rows: tracks.map((track) => ({ id: track.id, skip: track.skip })),
          anchor,
        }),
        getViewport: () => null,
        getSelection: () => selection,
        setSelection: (ids) => {
          selection = ids;
        },
      },
      100,
      5,
    );
    drag.update(100, layout.totalHeight - 5);
    drag.end();

    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(selection).toEqual(["drums", "bass", "gtr1", "gtr2", "keys", "vox"]);
  });
});
