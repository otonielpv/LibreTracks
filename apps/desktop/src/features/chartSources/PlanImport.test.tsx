import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";

const api = vi.hoisted(() => ({
  getPcoStatus: vi.fn(),
  signInPco: vi.fn(),
  signOutPco: vi.fn(),
  searchPcoSongs: vi.fn(),
  getPcoArrangements: vi.fn(),
  getPcoArrangement: vi.fn(),
  getPcoServiceTypes: vi.fn(),
  getPcoUpcomingPlans: vi.fn(),
  getPcoPlanItems: vi.fn(),
  matchPcoTitles: vi.fn(),
  isGuestMirrorMode: vi.fn(() => false),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { createChartSourceHandlers, type ChartSourceApi, type PlanEntry, type PlanSong } from "./chartSourceHandlers";
import { useChartSourceStore } from "./chartSourceStore";
import { PlanImportDialog } from "./PlanImportDialog";

const region = (id: string, name: string, start: number): SongRegionSummary =>
  ({ id, name, startSeconds: start, endSeconds: start + 100, key: null, transposeSemitones: 0 }) as SongRegionSummary;
const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"], start: number): SectionMarkerSummary => ({
  id,
  name,
  startSeconds: start,
  kind,
});

const REGIONS = [region("r1", "Prueba Uno", 0), region("r2", "Test Song Two", 100)];
const MARKERS = [
  marker("a", "Verso", "verse", 0),
  marker("b", "Verso", "verse", 10),
  marker("c", "Coro", "chorus", 20),
  marker("x", "Verso", "verse", 100),
  marker("y", "Coro", "chorus", 110),
];
const SONG = {
  regions: REGIONS,
  sectionMarkers: MARKERS,
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
} as unknown as SongView;
const songFor = (regionId: string): PlanSong | null => {
  const found = REGIONS.find((candidate) => candidate.id === regionId);
  return found ? { region: found, markers: MARKERS.filter((m) => m.startSeconds >= found.startSeconds && m.startSeconds < found.endSeconds) } : null;
};

const CHART = ["VERSE 1", "[G]Uno", "VERSE 2", "[G]Dos", "CHORUS", "[C]Coro"].join("\n");
const arrangement = (id: string, songId: string, chordChart = CHART) => ({
  id,
  songId,
  name: "Default",
  chordChart,
  chordChartKey: "G",
  lyrics: null,
  sequence: [],
  sequenceFull: [],
  bpm: null,
  meter: null,
  updatedAt: "2026-11-20T10:00:00Z",
});
const item = (id: string, title: string, songId: string, arrangementId: string, sequence: string[] | null = null) => ({
  id,
  title,
  songId,
  arrangementId,
  keyName: null,
  customArrangementSequenceFull: sequence?.map((label) => {
    const [name, number] = label.split(" ");
    return { label: name, number };
  }) ?? [],
});

const handlers = () => createChartSourceHandlers({ api: api as unknown as ChartSourceApi, store: useChartSourceStore });

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.isGuestMirrorMode.mockReturnValue(false);
  api.getPcoArrangement.mockImplementation(async (songId: string, id: string) => arrangement(id, songId));
});
afterEach(cleanup);

describe("preparing a plan", () => {
  it("C2: the item's own sequence reaches the matcher", async () => {
    const pair = (sequence: string[] | null) => [{ item: item("i1", "Prueba Uno", "s1", "a1", sequence), regionId: "r1" }];
    const plain = await handlers().preparePlan(pair(null), songFor);
    const guided = await handlers().preparePlan(pair(["Verse 1", "Verse 1", "Chorus 1"]), songFor);
    expect(plain[0].review?.rows.map((row) => row.section)).toEqual([0, 1, 2]);
    expect(guided[0].review?.rows.map((row) => row.section)).toEqual([0, 0, 2]);
  });

  it("asks Planning Center one arrangement at a time and reports progress", async () => {
    const progress: number[] = [];
    await handlers().preparePlan(
      [
        { item: item("i1", "Prueba Uno", "s1", "a1"), regionId: "r1" },
        { item: item("i2", "Test Song Two", "s2", "a2"), regionId: "r2" },
      ],
      songFor,
      { onProgress: (done) => progress.push(done) },
    );
    expect(api.getPcoArrangement.mock.calls).toEqual([["s1", "a1"], ["s2", "a2"]]);
    expect(progress).toEqual([1, 2]);
  });
});

describe("applying a plan", () => {
  async function entries(): Promise<PlanEntry[]> {
    // r1: two plain verse markers on a sheet with Verse 1 and Verse 2 → clear.
    // r2: a chorus marker the sheet does not have → to review.
    api.getPcoArrangement.mockImplementation(async (songId: string, id: string) =>
      songId === "s2" ? arrangement(id, songId, ["VERSE", "[G]Solo verso"].join("\n")) : arrangement(id, songId),
    );
    return handlers().preparePlan(
      [
        { item: item("i1", "Prueba Uno", "s1", "a1"), regionId: "r1" },
        { item: item("i2", "Test Song Two", "s2", "a2"), regionId: "r2" },
      ],
      songFor,
    );
  }

  it("C3: 'apply the clear ones' saves only those, the rest stays to review", async () => {
    const prepared = await entries();
    expect(prepared.map((entry) => entry.clear)).toEqual([true, false]);
    const save = vi.fn(async (_regionId: string, _chart: SongChart) => {});
    const result = await handlers().applyClearEntries(prepared, save);
    expect(save.mock.calls.map(([regionId]) => regionId)).toEqual(["r1"]);
    expect(result.remaining.map((entry) => entry.regionId)).toEqual(["r2"]);
  });

  it("C4: cancelling stops between songs; each saved song is whole", async () => {
    const prepared = await entries();
    const both = prepared.map((entry) => ({ ...entry, clear: true }));
    let cancelled = false;
    const save = vi.fn(async (_regionId: string, chart: SongChart) => {
      expect(chart.links.length).toBeGreaterThan(0);
      cancelled = true;
    });
    const result = await handlers().applyClearEntries(both, save, { isCancelled: () => cancelled });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual(["r1"]);
    expect(result.remaining.map((entry) => entry.regionId)).toEqual(["r2"]);
  });
});

describe("the plan dialog", () => {
  it("C1: picks a plan, pairs its songs by title and applies the clear ones", async () => {
    api.getPcoServiceTypes.mockResolvedValue([{ id: "t1", name: "Domingo" }]);
    api.getPcoUpcomingPlans.mockResolvedValue([{ id: "p1", title: "Culto", dates: "29 Nov", sortDate: null, seriesTitle: null }]);
    api.getPcoPlanItems.mockResolvedValue([
      item("i1", "Prueba Uno (En vivo) - E", "s1", "a1"),
      item("i2", "Test Song Two", "s2", "a2"),
      item("i3", "Otra", "s3", "a3"),
    ]);
    api.matchPcoTitles.mockResolvedValue([
      { id: "i1", exact: "r1", suggestions: [] },
      { id: "i2", exact: "r2", suggestions: [] },
      { id: "i3", exact: null, suggestions: [] },
    ]);
    const save = vi.fn(async (_regionId: string, _chart: SongChart) => {});
    render(<PlanImportDialog song={SONG} save={save} onClose={vi.fn()} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "t1" } });
    });
    await act(async () => {
      fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "p1" } });
    });
    expect(api.matchPcoTitles).toHaveBeenCalledWith(
      [
        { id: "i1", title: "Prueba Uno (En vivo) - E" },
        { id: "i2", title: "Test Song Two" },
        { id: "i3", title: "Otra" },
      ],
      [
        { id: "r1", title: "Prueba Uno" },
        { id: "r2", title: "Test Song Two" },
      ],
    );
    const rows = screen.getAllByTestId("plan-item");
    expect((within(rows[0]).getByRole("combobox") as HTMLSelectElement).value).toBe("r1");
    expect((within(rows[2]).getByRole("combobox") as HTMLSelectElement).value).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.plan.prepare" }));
    });
    expect(screen.getAllByTestId("plan-entry")).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.plan.applyClear" }));
    });
    expect(save.mock.calls.map(([regionId]) => regionId)).toEqual(["r1", "r2"]);
    expect(screen.getByText("chartSources.plan.done")).toBeTruthy();
  });
});
