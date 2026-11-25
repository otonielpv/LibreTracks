import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChartSource, SectionMarkerSummary, SongRegionSummary, SongView } from "@libretracks/shared/models";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";

const api = vi.hoisted(() => ({
  getPcoArrangement: vi.fn(),
  getPcoArrangements: vi.fn(),
  createPcoArrangement: vi.fn(),
  updatePcoArrangement: vi.fn(),
  searchPcoSongs: vi.fn(),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SaveToPlanningCenterDialog, songTimingFor } from "./SaveToPlanningCenterDialog";

const region = { id: "r1", name: "Camino", startSeconds: 0, endSeconds: 100, key: "D", transposeSemitones: 0 } as SongRegionSummary;
const markers: SectionMarkerSummary[] = [
  { id: "v", name: "Verso", startSeconds: 0, kind: "verse" },
  { id: "c", name: "Coro", startSeconds: 20, kind: "chorus" },
];
const TEXT = "{section: Verso 1}\n[D]Camino\n\n{section: Coro}\n[G]Luz\n";
const links = [{ markerId: "v", section: 0 }, { markerId: "c", section: 1, repeat: 2 }];
const source: ChartSource = {
  provider: "planningCenter",
  songId: "s1",
  arrangementId: "a1",
  planItemId: "i1",
  key: "C",
  updatedAt: "2026-11-20T10:00:00Z",
  importedHash: "x",
};
const original = (updatedAt = "2026-11-20T10:00:00Z") => ({
  id: "a1",
  songId: "s1",
  name: "Default Arrangement",
  chordChart: "VERSO 1\n[C]Camino viejo\n\nCORO\n[F]Luz",
  chordChartKey: "C",
  updatedAt,
});

function open() {
  const onSaved = vi.fn((_source: ChartSource) => {});
  render(
    <SaveToPlanningCenterDialog region={region} markers={markers} text={TEXT} links={links} source={source} onSaved={onSaved} onClose={vi.fn()} />,
  );
  return onSaved;
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPcoArrangement.mockResolvedValue(original());
  api.getPcoArrangements.mockResolvedValue([original()]);
  api.createPcoArrangement.mockResolvedValue({ ...original("2026-11-23T12:00:00Z"), id: "a9", name: "LibreTracks" });
  api.updatePcoArrangement.mockResolvedValue({ ...original("2026-11-23T12:00:00Z") });
});
afterEach(cleanup);

describe("saving to Planning Center", () => {
  it("creates a new arrangement by default, with the chart, key and sequence", async () => {
    const onSaved = open();
    await act(async () => {});
    expect(screen.getByTestId("pco-save-sequence").textContent).toBe("Verso 1 · Coro · Coro");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.save" }));
    });
    expect(api.updatePcoArrangement).not.toHaveBeenCalled();
    const [songId, write] = api.createPcoArrangement.mock.calls[0];
    expect(songId).toBe("s1");
    expect(write).toEqual({
      name: "chartSources.save.defaultName",
      chordChart: "VERSO 1\n[D]Camino\n\nCORO\n[G]Luz\n",
      chordChartKey: "D",
      sequence: ["Verso 1", "Coro", "Coro"],
      // The region's whole duration, in seconds.
      length: 100,
    });
    expect(onSaved.mock.calls[0][0]).toEqual({
      provider: "planningCenter",
      songId: "s1",
      arrangementId: "a9",
      key: "D",
      updatedAt: "2026-11-23T12:00:00Z",
      importedHash: chartTextHash(TEXT),
    });
  });

  it("updates the arrangement that already has the name instead of making another", async () => {
    api.getPcoArrangements.mockResolvedValue([original(), { ...original(), id: "a7", name: "LibreTracks" }]);
    open();
    await act(async () => {});
    const nameInput = screen.getByDisplayValue("chartSources.save.defaultName");
    expect(screen.queryByTestId("pco-save-same-name")).toBeNull();
    fireEvent.change(nameInput, { target: { value: " libretracks " } });
    expect(screen.getByTestId("pco-save-same-name")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.save" }));
    });
    expect(api.createPcoArrangement).not.toHaveBeenCalled();
    const [songId, arrangementId, write] = api.updatePcoArrangement.mock.calls[0];
    expect([songId, arrangementId]).toEqual(["s1", "a7"]);
    expect(write.name).toBeUndefined();
  });

  it("replaces the original only after confirming, and shows what changes", async () => {
    const onSaved = open();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getAllByRole("radio")[1]);
    });
    expect(screen.getAllByTestId("pco-save-change").length).toBeGreaterThan(0);
    const save = screen.getByRole("button", { name: "chartSources.save.save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(api.createPcoArrangement).not.toHaveBeenCalled();
    expect(api.updatePcoArrangement.mock.calls[0][0]).toBe("s1");
    expect(api.updatePcoArrangement.mock.calls[0][1]).toBe("a1");
    expect(onSaved.mock.calls[0][0]).toMatchObject({ arrangementId: "a1", planItemId: "i1" });
  });

  it("warns when the arrangement changed in Planning Center since the import", async () => {
    api.getPcoArrangement.mockResolvedValue(original("2026-11-22T09:00:00Z"));
    open();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getAllByRole("radio")[1]);
    });
    expect(screen.getByText("chartSources.save.changedThere")).toBeTruthy();
  });

  it("explains a user who may not edit songs", async () => {
    api.createPcoArrangement.mockRejectedValue({ code: "noEditPermission" });
    open();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.save" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("chartSources.errors.noEditPermission");
  });

  it("can save the repeats with slashes in the sheet instead of in the sequence", async () => {
    open();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "chartSources.save.repeatsInSheet" }));
    });
    expect(screen.getByTestId("pco-save-sequence").textContent).toBe("chartSources.save.sequenceUntouched");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.save" }));
    });
    const write = api.createPcoArrangement.mock.calls[0][1];
    expect(write.sequence).toBeUndefined();
    expect(write.chordChart).toContain("// [G]Luz //");
  });
});


describe("the arrangement's BPM and meter", () => {
  const song = (overrides: Partial<SongView> = {}) =>
    ({
      id: "song",
      title: "Set",
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 400,
      tempoMarkers: [],
      timeSignatureMarkers: [],
      regions: [],
      sectionMarkers: [],
      clips: [],
      ...overrides,
    }) as unknown as SongView;
  const second = { ...region, id: "r2", startSeconds: 200, endSeconds: 300 } as SongRegionSummary;

  it("takes the tempo and time signature the song starts with", () => {
    const timed = song({
      tempoMarkers: [{ id: "t", startSeconds: 200, bpm: 72.5 }],
      timeSignatureMarkers: [{ id: "m", startSeconds: 200, signature: "6/8" }] as SongView["timeSignatureMarkers"],
    });
    expect(songTimingFor(timed, second)).toEqual({ bpm: 72.5, meter: "6/8" });
    expect(songTimingFor(timed, region)).toEqual({ bpm: 120, meter: "4/4" });
  });

  it("sends nothing without a song", () => {
    expect(songTimingFor(null, region)).toEqual({});
  });

  it("lyrics not from Planning Center: the song is picked there first, then saved and linked to it", async () => {
    api.searchPcoSongs.mockResolvedValue({ items: [{ id: "s1", title: "Camino", author: null }] });
    const onSaved = vi.fn((_source: ChartSource) => {});
    render(<SaveToPlanningCenterDialog region={region} markers={markers} text={TEXT} links={links} onSaved={onSaved} onClose={vi.fn()} />);
    expect(screen.getByText("chartSources.save.pickTitle")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.import.search" }));
    });
    expect(api.searchPcoSongs).toHaveBeenCalledWith("Camino", 0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Camino/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.pickNew" }));
    });
    // The usual form, saving a new arrangement in that song.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.save.save" }));
    });
    expect(api.createPcoArrangement.mock.calls[0][0]).toBe("s1");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ provider: "planningCenter", songId: "s1", arrangementId: "a9" }));
  });
});
