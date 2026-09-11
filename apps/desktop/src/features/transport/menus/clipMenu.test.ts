import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipSummary } from "@libretracks/shared/models";

const deleteClip = vi.fn();
const deleteClips = vi.fn();
const splitClip = vi.fn();
const splitClips = vi.fn();

vi.mock("../desktopApi", () => ({
  deleteClip: (...args: unknown[]) => deleteClip(...args),
  deleteClips: (...args: unknown[]) => deleteClips(...args),
  splitClip: (...args: unknown[]) => splitClip(...args),
  splitClips: (...args: unknown[]) => splitClips(...args),
}));

const { clipContextMenuActions } = await import("./clipMenu");
type Deps = Parameters<typeof clipContextMenuActions>[0]["deps"];

const clip = (id: string): ClipSummary =>
  ({
    id,
    trackId: "t1",
    trackName: "Bajo",
    filePath: `/${id}.wav`,
    timelineStartSeconds: 0,
    durationSeconds: 10,
    sourceStartSeconds: 0,
    color: null,
  }) as ClipSummary;

const C1 = clip("c1");
const C2 = clip("c2");

function setup(selection: ClipSummary[]) {
  const duplicateClipGroup = vi.fn();
  const handleSetClipColors = vi.fn().mockResolvedValue(undefined);
  const openColorMenu = vi.fn();
  const deps = {
    t: (key: string) => key,
    shortcutHint: () => "",
    // El cursor cae DENTRO de los clips (0-10 s), asi que partir esta activo.
    displayPositionSecondsRef: { current: 5 },
    selectedClipIds: selection.map((entry) => entry.id),
    selectedClipSummaries: selection,
    runAction: (fn: () => Promise<void>) => fn(),
    applyPlaybackSnapshot: vi.fn(),
    setSelectedClipId: vi.fn(),
    setStatus: vi.fn(),
    duplicateClipGroup,
    handleSetClipColors,
  } as unknown as Deps;

  const actions = clipContextMenuActions({ clip: C1, deps, openColorMenu });
  const byLabel = (fragment: string) =>
    actions.find((action) => action.label.includes(fragment))!;
  return { byLabel, duplicateClipGroup, handleSetClipColors, openColorMenu };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Con el dedo, sumar clips es la UNICA forma de agruparlos —no hay Ctrl que
 * mantener—, asi que una accion que se queda en el primero deja la
 * multiseleccion sin sentido. Cada accion preguntaba por su cuenta a quien
 * afectaba, y unas lo hacian y otras no: partir iba a todos, borrar y colorear
 * se quedaban en el primero.
 */
describe("el menu de un clip actua sobre TODA la seleccion", () => {
  it("borra los clips seleccionados en una sola llamada", async () => {
    const { byLabel } = setup([C1, C2]);

    await byLabel("delete").onSelect();

    expect(deleteClips).toHaveBeenCalledWith(["c1", "c2"]);
    expect(deleteClip).not.toHaveBeenCalled();
  });

  it("colorea los clips seleccionados", () => {
    const { byLabel, openColorMenu, handleSetClipColors } = setup([C1, C2]);

    byLabel("selectColor").onSelect();
    // El selector de color es un submenu: lo que importa es a quien aplica.
    const onColor = openColorMenu.mock.calls[0][2] as (
      color: string | null,
    ) => Promise<void>;
    void onColor("#ff0000");

    expect(handleSetClipColors).toHaveBeenCalledWith([C1, C2], "#ff0000");
  });

  it("duplica los clips seleccionados", async () => {
    const { byLabel, duplicateClipGroup } = setup([C1, C2]);

    await byLabel("duplicateClip").onSelect();

    expect(duplicateClipGroup).toHaveBeenCalledWith([C1, C2], 10);
  });

  it("parte los clips seleccionados", async () => {
    const { byLabel } = setup([C1, C2]);

    await byLabel("splitClipAtCursor").onSelect();

    expect(splitClips).toHaveBeenCalledWith(["c1", "c2"], 5);
  });

  // El clip sobre el que se abre el menu manda: si no forma parte de la
  // seleccion, la accion es SOLO para el.
  it("un clip de fuera de la seleccion va solo", async () => {
    const { byLabel } = setup([C2]);

    await byLabel("delete").onSelect();

    expect(deleteClip).toHaveBeenCalledWith("c1");
    expect(deleteClips).not.toHaveBeenCalled();
  });
});
