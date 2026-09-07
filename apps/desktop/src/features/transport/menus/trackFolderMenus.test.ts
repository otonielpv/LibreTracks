import { describe, expect, it, vi } from "vitest";
import { createTrackFolderMenus } from "./trackFolderMenus";
import type { TimelineMenuDeps } from "./timelineMenus";
import type { SongView, TrackSummary } from "../desktopApi";

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  moveTrack: vi.fn(async () => ({ projectRevision: 1 })),
  createTrack: vi.fn(async () => ({ projectRevision: 2 })),
}));

function track(
  id: string,
  kind: "audio" | "folder",
  parentTrackId: string | null = null,
): TrackSummary {
  return { id, name: id, kind, parentTrackId } as unknown as TrackSummary;
}

/**
 *  raiz
 *  ├── carpeta-a
 *  │   └── carpeta-hija
 *  ├── carpeta-b
 *  ├── voz
 *  └── bajo (dentro de carpeta-b)
 */
const song = {
  tracks: [
    track("carpeta-a", "folder"),
    track("carpeta-hija", "folder", "carpeta-a"),
    track("carpeta-b", "folder"),
    track("voz", "audio"),
    track("bajo", "audio", "carpeta-b"),
  ],
} as unknown as SongView;

function menus() {
  const deps = {
    t: ((key: string) => key) as never,
    songRef: { current: song },
    runAction: vi.fn(async (work: () => Promise<void>) => work()),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    setContextMenu: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
  } as unknown as TimelineMenuDeps;
  const bump = vi.fn(() => ({ x: 0, y: 0 }));
  return { deps, ...createTrackFolderMenus(() => deps, bump) };
}

const byId = (id: string) => song.tracks.find((entry) => entry.id === id)!;

describe("meter pistas en carpetas sin arrastrar", () => {
  it("ofrece las carpetas que existen", () => {
    const { candidateFolders } = menus();
    expect(candidateFolders([byId("voz")]).map((f) => f.id)).toEqual([
      "carpeta-a",
      "carpeta-hija",
      "carpeta-b",
    ]);
  });

  it("no se ofrece a si misma", () => {
    const { candidateFolders } = menus();
    expect(
      candidateFolders([byId("carpeta-a")]).map((f) => f.id),
    ).not.toContain("carpeta-a");
  });

  it("no ofrece una carpeta que cuelga de lo seleccionado", () => {
    // Mover una carpeta dentro de su propia descendencia deja el arbol roto.
    const { candidateFolders } = menus();
    expect(
      candidateFolders([byId("carpeta-a")]).map((f) => f.id),
    ).not.toContain("carpeta-hija");
  });

  it("sacar de la carpeta se apaga si nada esta dentro de una", () => {
    const { folderActions } = menus();
    const suelta = folderActions([byId("voz")]);
    expect(suelta.at(-1)?.disabled).toBe(true);

    const dentro = folderActions([byId("bajo")]);
    expect(dentro.at(-1)?.disabled).toBe(false);
  });

  it("basta con que UNA de la seleccion este en una carpeta", () => {
    const { folderActions } = menus();
    const mezcla = folderActions([byId("voz"), byId("bajo")]);
    expect(mezcla.at(-1)?.disabled).toBe(false);
  });
});
