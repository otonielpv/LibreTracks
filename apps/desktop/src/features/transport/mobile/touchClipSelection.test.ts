// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTouchClipSelection } from "./touchClipSelection";
import type { ClipSummary } from "../desktopApi";

const clip = (id: string, start: number, duration: number): ClipSummary =>
  ({
    id,
    trackId: "t1",
    trackName: "Bajo",
    filePath: `/${id}.wav`,
    timelineStartSeconds: start,
    durationSeconds: duration,
    sourceStartSeconds: 0,
  }) as ClipSummary;

/** Fila HTML con `data-track-id`: es la superficie que recibe los toques. */
function row() {
  const element = document.createElement("div");
  element.dataset.trackId = "t1";
  Object.defineProperty(element, "offsetWidth", { value: 400 });
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 80 }) as DOMRect;
  document.body.append(element);
  return element;
}

function setup(selected: string[] = [], multiSelect = false) {
  const selectClips = vi.fn();
  const clearRegionSelection = vi.fn();
  const toggleClip = vi.fn();
  const api = createTouchClipSelection({
    // Un clip de 0 a 2 s; a 10 px/s ocupa de x=0 a x=20.
    getClipsByTrack: () => ({ t1: [clip("c1", 0, 2)] }),
    getSelectedClipIds: () => selected,
    getCameraX: () => 0,
    getPixelsPerSecond: () => 10,
    selectClips,
    clearRegionSelection,
    isMultiSelect: () => multiSelect,
    toggleClip,
  });
  return { api, selectClips, clearRegionSelection, toggleClip, target: row() };
}

describe("reglas de toque de la linea de tiempo", () => {
  it("no cede el gesto sobre un clip que aun no esta seleccionado", () => {
    // Esta es la garantia contra editar por accidente: el primer toque sobre un
    // clip nunca lo mueve, solo lo selecciona.
    const { api, target } = setup([]);
    expect(api.shouldEdit(10, 0, target)).toBe(false);
  });

  it("cede el gesto sobre un clip ya seleccionado, para poder moverlo", () => {
    const { api, target } = setup(["c1"]);
    expect(api.shouldEdit(10, 0, target)).toBe(true);
  });

  it("no cede el gesto fuera del clip aunque este seleccionado", () => {
    const { api, target } = setup(["c1"]);
    expect(api.shouldEdit(300, 0, target)).toBe(false);
  });

  it("un toque sobre el clip lo selecciona", () => {
    const { api, selectClips, target } = setup([]);
    api.onTap(10, 0, target);
    expect(selectClips).toHaveBeenCalledWith(["c1"]);
  });

  it("un toque en vacio limpia la seleccion", () => {
    const { api, selectClips, target } = setup(["c1"]);
    api.onTap(300, 0, target);
    expect(selectClips).toHaveBeenCalledWith([]);
  });

  it("ignora toques fuera de una fila de pista", () => {
    const { api, selectClips } = setup(["c1"]);
    const outside = document.createElement("div");
    expect(api.shouldEdit(10, 0, outside)).toBe(false);
    api.onTap(10, 0, outside);
    expect(selectClips).toHaveBeenCalledWith([]);
    expect(api.shouldEdit(10, 0, null)).toBe(false);
  });
});

describe("un toque en el fondo suelta TODA la seleccion", () => {
  // `selectClips([])` limpia clips, pistas y marcas —el store las limpia entre
  // si—, pero la region vive en un `useState` aparte que nadie tocaba: tras
  // tocar una region, el toque en el fondo dejaba la barra de acciones
  // mostrando sus acciones como si siguiera seleccionada.
  it("tambien suelta la region", () => {
    const { api, selectClips, clearRegionSelection, target } = setup();

    // x=200 con 10 px/s son 20 s: fuera del unico clip.
    api.onTap(200, 0, target);

    expect(selectClips).toHaveBeenCalledWith([]);
    expect(clearRegionSelection).toHaveBeenCalledTimes(1);
  });

  it("tocar un clip no suelta la region: es la seleccion nueva la que manda", () => {
    const { api, selectClips, clearRegionSelection, target } = setup();

    api.onTap(10, 0, target);

    expect(selectClips).toHaveBeenCalledWith(["c1"]);
    expect(clearRegionSelection).not.toHaveBeenCalled();
  });
});

describe("sumando clips", () => {
  // Con un dedo no hay Ctrl que mantener: sin este modo no habia forma de
  // juntar varios clips para moverlos o borrarlos de un tiron.
  it("cada toque suma o quita el clip que hay debajo", () => {
    const { api, selectClips, toggleClip, target } = setup(["c1"], true);

    api.onTap(10, 0, target);

    expect(toggleClip).toHaveBeenCalledWith("c1");
    expect(selectClips).not.toHaveBeenCalled();
  });

  // Si tocar fuera tambien sumara, no habria manera de salir del modo sin
  // borrar algo.
  it("tocar fuera lo suelta todo igual", () => {
    const { api, selectClips, clearRegionSelection, toggleClip, target } = setup(
      ["c1"],
      true,
    );

    api.onTap(200, 0, target);

    expect(toggleClip).not.toHaveBeenCalled();
    expect(selectClips).toHaveBeenCalledWith([]);
    expect(clearRegionSelection).toHaveBeenCalled();
  });
});
