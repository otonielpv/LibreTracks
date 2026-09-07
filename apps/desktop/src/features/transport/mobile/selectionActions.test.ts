import { describe, expect, it, vi } from "vitest";
import {
  mobileSelectionBarModel,
  resolveMobileSelection,
  type MobileSelectionMenus,
} from "./selectionActions";
import type { ContextMenuAction } from "../types";
import type { SongView } from "../desktopApi";

const t = ((key: string, options?: Record<string, unknown>) =>
  `${key}${options?.count != null ? `:${options.count}` : ""}`) as never;

function action(label: string): ContextMenuAction {
  return { label, onSelect: () => {} };
}

/** El MISMO objeto que consume el clic derecho del escritorio. */
const desktopMenus: MobileSelectionMenus = {
  clipContextMenu: vi.fn(() => [
    action("Cortar en el cabezal"),
    action("Duplicar"),
    action("Seleccionar color..."),
    action("Eliminar"),
  ]),
  sectionContextMenu: vi.fn(() => [
    action("Ir a la marca"),
    action("Renombrar"),
    action("Tipo de marca"),
    action("Eliminar"),
  ]),
  tempoMarkerContextMenu: vi.fn(() => [action("Cambiar BPM")]),
  timeSignatureMarkerContextMenu: vi.fn(() => [action("Cambiar compas")]),
  songRegionContextMenu: vi.fn(() => [action("Renombrar cancion")]),
  trackContextMenu: vi.fn(() => [action("Renombrar pista")]),
};

const creation = {
  onCreateSection: vi.fn(),
  onCreateCue: vi.fn(),
  onAddAudios: vi.fn(),
};

const song = {
  id: "s",
  title: "Sesion",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 100,
  tempoMarkers: [
    { id: "tempo-1", startSeconds: 10, bpm: 90 },
  ],
  timeSignatureMarkers: [
    { id: "ts-1", startSeconds: 12, signature: "3/4" },
  ],
  regions: [{ id: "r1", name: "Cancion 1", startSeconds: 0, endSeconds: 50 }],
  sectionMarkers: [{ id: "m1", name: "Estrofa", startSeconds: 8 }],
  clips: [
    { id: "c1", trackId: "t1", timelineStartSeconds: 0, durationSeconds: 4 },
    { id: "c2", trackId: "t1", timelineStartSeconds: 4, durationSeconds: 4 },
  ],
  tracks: [{ id: "t1", name: "Voz", kind: "audio" }],
  projectRevision: 1,
} as unknown as SongView;

const empty = {
  song,
  selectedClipIds: [],
  selectedSectionId: null,
  selectedRegionId: null,
  selectedTrackIds: [],
};

describe("que da por seleccionado la barra tactil", () => {
  it("sin cancion no hay nada que seleccionar", () => {
    expect(resolveMobileSelection({ ...empty, song: null })).toEqual({
      kind: "none",
    });
  });

  it("resuelve los ids sueltos al objeto de la cancion", () => {
    expect(
      resolveMobileSelection({ ...empty, selectedClipIds: ["c1", "c2"] }),
    ).toMatchObject({ kind: "clips" });
    expect(
      resolveMobileSelection({ ...empty, selectedSectionId: "m1" }),
    ).toMatchObject({ kind: "marker" });
    expect(
      resolveMobileSelection({ ...empty, selectedRegionId: "r1" }),
    ).toMatchObject({ kind: "region" });
    expect(
      resolveMobileSelection({ ...empty, selectedTrackIds: ["t1"] }),
    ).toMatchObject({ kind: "track" });
  });

  it("ignora un id que ya no existe en la cancion", () => {
    expect(
      resolveMobileSelection({ ...empty, selectedSectionId: "borrada" }),
    ).toEqual({ kind: "none" });
  });

  it("la region no le gana a lo que el usuario acaba de tocar", () => {
    // Clip, marca y pista se limpian entre si en el store; la region vive en un
    // useState aparte que nadie limpia, asi que va la ultima.
    expect(
      resolveMobileSelection({
        ...empty,
        selectedRegionId: "r1",
        selectedClipIds: ["c1"],
      }),
    ).toMatchObject({ kind: "clips" });
    expect(
      resolveMobileSelection({
        ...empty,
        selectedRegionId: "r1",
        selectedSectionId: "m1",
      }),
    ).toMatchObject({ kind: "marker" });
  });
});

describe("las acciones de la barra son las del escritorio", () => {
  const cases = [
    {
      name: "clip",
      input: { ...empty, selectedClipIds: ["c1"] },
      desktop: () => desktopMenus.clipContextMenu(song.clips[0]),
    },
    {
      name: "marca",
      input: { ...empty, selectedSectionId: "m1" },
      desktop: () => desktopMenus.sectionContextMenu(song.sectionMarkers[0]),
    },
    {
      name: "region",
      input: { ...empty, selectedRegionId: "r1" },
      desktop: () => desktopMenus.songRegionContextMenu(song.regions[0]),
    },
    {
      name: "pista",
      input: { ...empty, selectedTrackIds: ["t1"] },
      desktop: () => desktopMenus.trackContextMenu(song.tracks[0]),
    },
    {
      name: "marca de tempo",
      input: { ...empty, selectedTempoMarkerId: "tempo-1" },
      desktop: () => desktopMenus.tempoMarkerContextMenu(song.tempoMarkers[0]),
    },
    {
      name: "marca de compas",
      input: { ...empty, selectedTimeSignatureMarkerId: "ts-1" },
      desktop: () =>
        desktopMenus.timeSignatureMarkerContextMenu(
          song.timeSignatureMarkers[0],
        ),
    },
  ];

  for (const entry of cases) {
    it(`para ${entry.name} ofrece la misma lista, sin recortar`, () => {
      const model = mobileSelectionBarModel({
        target: resolveMobileSelection(entry.input),
        menus: desktopMenus,
        creation,
        t,
      });
      expect(model.actions.map((a) => a.label)).toEqual(
        entry.desktop().map((a) => a.label),
      );
    });
  }

  it("sin seleccion ofrece crear, que es lo que no tiene menu contextual", () => {
    const model = mobileSelectionBarModel({
      target: resolveMobileSelection(empty),
      menus: desktopMenus,
      creation,
      t,
    });
    // Seccion y aviso son vocabularios distintos y van separados: preguntar
    // por el grupo en el gesto mas repetido del montaje sobra.
    expect(model.actions).toHaveLength(3);

    model.actions[0].onSelect();
    expect(creation.onCreateSection).toHaveBeenCalledTimes(1);
    model.actions[1].onSelect();
    expect(creation.onCreateCue).toHaveBeenCalledTimes(1);
    model.actions[2].onSelect();
    expect(creation.onAddAudios).toHaveBeenCalledTimes(1);
  });

  it("dice cuantos clips van a recibir la accion", () => {
    const model = mobileSelectionBarModel({
      target: resolveMobileSelection({
        ...empty,
        selectedClipIds: ["c1", "c2"],
      }),
      menus: desktopMenus,
      creation,
      t,
    });
    expect(model.count).toBe(2);
  });
});
