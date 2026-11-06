import type { SongView } from "@libretracks/shared/models";

import {
  act,
  en,
  fireEvent,
  getTrackLaneRow,
  mockLaneBounds,
  mockRulerBounds,
  mockTimelineShellMetrics,
  renderApp,
  screen,
  waitFor,
} from "../../../test/testUtils";
import { setRegionStructureForTest } from "../../../app/testDesktopApiMock";
import { formatTransportError } from "../errors/formatTransportError";
import i18n from "../../../shared/i18n";
import {
  lockedRegionAt,
  parseStructureLocked,
  regionAt,
  requestMarkerEdit,
  requestStructureEdit,
} from "./structureGuard";
import { useStructureStore } from "./structureStore";
import { useSongStore } from "../songStore";

const APPLIED = {
  sections: [],
  arrangements: [
    {
      id: "domingo",
      name: "Domingo",
      blocks: [{ id: "b1", sectionMarkerId: "m1" }],
    },
  ],
  appliedArrangementId: "domingo",
};

function songWith(regions: SongView["regions"]): SongView {
  return {
    regions,
    clips: [],
    tracks: [],
    sectionMarkers: [],
  } as unknown as SongView;
}

function region(id: string, start: number, end: number, structure?: typeof APPLIED) {
  return {
    id,
    name: id,
    startSeconds: start,
    endSeconds: end,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    structure,
  };
}

describe("structure guard", () => {
  it("finds the song that owns a position with the backend's rule", () => {
    const song = songWith([region("a", 0, 10), region("b", 10, 20)]);
    expect(regionAt(song, 5)?.id).toBe("a");
    // Back to back: the song that STARTS there wins.
    expect(regionAt(song, 10)?.id).toBe("b");
    // 1 ms of tolerance on the left.
    expect(regionAt(song, 9.9995)?.id).toBe("b");
    expect(regionAt(song, 25)).toBeNull();
  });

  it("only songs with an applied arrangement are locked", () => {
    const song = songWith([
      region("a", 0, 10),
      region("b", 10, 20, APPLIED),
      region("c", 20, 30, { ...APPLIED, appliedArrangementId: null } as never),
    ]);
    expect(lockedRegionAt(song, 5)).toBeNull();
    expect(lockedRegionAt(song, 15)).toEqual({
      regionId: "b",
      regionName: "b",
      arrangementName: "Domingo",
    });
    expect(lockedRegionAt(song, 25)).toBeNull();
  });

  it("asks before editing a locked song and lets other edits through", () => {
    useSongStore.setState({
      song: songWith([region("a", 0, 10), region("b", 10, 20, APPLIED)]),
    });
    expect(requestStructureEdit([3])).toBe(true);
    expect(useStructureStore.getState().guard).toBeNull();
    expect(requestStructureEdit([3, 12])).toBe(false);
    expect(useStructureStore.getState().guard?.regionId).toBe("b");
  });

  it("recognises the backend error and turns it into a readable status", async () => {
    const raw = "song structure locked: region-1 arrangement=Domingo (corto)";
    expect(parseStructureLocked(new Error(raw))).toEqual({
      regionId: "region-1",
      arrangementName: "Domingo (corto)",
    });
    expect(parseStructureLocked("something else")).toBeNull();
    await i18n.changeLanguage("en");
    expect(formatTransportError(raw, i18n.t)).toBe(
      en.transport.structure.lockedStatus.replace("{{name}}", "Domingo (corto)"),
    );
  });

  /** C5: dragging a clip of a locked song opens the dialog and sends no
   * move command at all — not even the live preview ones. */
  it("dragging a clip in a song with an applied arrangement moves it without asking (it stays in its block)", async () => {
    const desktopApi = await import("../desktopApi");
    const moveClip = vi.spyOn(desktopApi, "moveClip");
    setRegionStructureForTest("region-1", APPLIED);

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);
    await act(async () => {
      fireEvent(window, new Event("resize"));
    });
    const drumsLane = getTrackLaneRow(container, "Drums")?.querySelector(
      ".lt-track-lane",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(drumsLane, { button: 0, clientX: 320, clientY: 140 });
      fireEvent.mouseMove(window, { clientX: 440, clientY: 140 });
      fireEvent.mouseUp(window, { button: 0, clientX: 440, clientY: 140 });
    });
    await waitFor(() => {
      expect(moveClip).toHaveBeenCalled();
    });
    expect(useStructureStore.getState().guard).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Domingo/ })).toBeNull();
  });

  it("a shape edit in an arranged song opens the dialog, and «Edit original» goes back to the original", async () => {
    const desktopApi = await import("../desktopApi");
    setRegionStructureForTest("region-1", APPLIED);
    await renderApp();
    const region = useSongStore.getState().song?.regions.find((r) => r.id === "region-1");
    expect(region).toBeTruthy();

    let allowed = true;
    await act(async () => {
      allowed = requestStructureEdit([(region?.startSeconds ?? 0) + 0.5]);
    });
    expect(allowed).toBe(false);
    await screen.findByRole("dialog", {
      name: en.transport.structure.guard.title.replace("{{name}}", "Domingo"),
    });

    const applySpy = vi.spyOn(desktopApi, "applySongArrangement");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: en.transport.structure.guard.editOriginal }),
      );
    });
    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith("region-1", null);
    });
    expect(screen.queryByRole("dialog", { name: /Domingo/ })).toBeNull();
  });

  it("only section markers ask: a cue marker in an arranged song is free", async () => {
    setRegionStructureForTest("region-1", APPLIED);
    await renderApp();
    const song = useSongStore.getState().song;
    const region = song?.regions.find((r) => r.id === "region-1");
    const at = (region?.startSeconds ?? 0) + 0.5;
    useSongStore.setState({
      song: song
        ? {
            ...song,
            sectionMarkers: [
              ...song.sectionMarkers,
              { id: "aviso", name: "Todos", startSeconds: at, digit: null, kind: "all_in" } as never,
              { id: "seccion", name: "Coro", startSeconds: at + 0.1, digit: null, kind: "chorus" } as never,
            ],
          }
        : song,
    });
    expect(requestMarkerEdit(["aviso"])).toBe(true);
    expect(useStructureStore.getState().guard).toBeNull();
    await act(async () => {
      expect(requestMarkerEdit(["aviso", "seccion"])).toBe(false);
    });
    expect(useStructureStore.getState().guard).toMatchObject({ arrangementName: "Domingo" });
  });

  it("the same drag without an applied arrangement still moves the clip", async () => {
    const desktopApi = await import("../desktopApi");
    const moveClip = vi.spyOn(desktopApi, "moveClip");
    setRegionStructureForTest("region-1", { ...APPLIED, appliedArrangementId: null } as never);

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);
    await act(async () => {
      fireEvent(window, new Event("resize"));
    });
    const drumsLane = getTrackLaneRow(container, "Drums")?.querySelector(
      ".lt-track-lane",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(drumsLane, { button: 0, clientX: 320, clientY: 140 });
      fireEvent.mouseMove(window, { clientX: 440, clientY: 140 });
      fireEvent.mouseUp(window, { button: 0, clientX: 440, clientY: 140 });
    });
    await waitFor(() => {
      expect(moveClip).toHaveBeenCalled();
    });
    expect(useStructureStore.getState().guard).toBeNull();
  });
});
