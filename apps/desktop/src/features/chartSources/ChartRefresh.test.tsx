import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";

const flags = vi.hoisted(() => ({ chartSources: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

const api = vi.hoisted(() => ({
  getPcoStatus: vi.fn(),
  signInPco: vi.fn(),
  signOutPco: vi.fn(),
  searchPcoSongs: vi.fn(),
  getPcoArrangements: vi.fn(),
  getPcoArrangement: vi.fn(),
  isGuestMirrorMode: vi.fn(() => false),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChartImportDialog } from "./ChartImportDialog";
import { INITIAL_CHART_SOURCE_STATE, useChartSourceStore } from "./chartSourceStore";
import { useChartSourcesAvailable } from "./useChartSourcesAvailable";
import { useRedundancyStore } from "../redundancy/redundancyStore";

const region = { id: "r1", name: "Canción", startSeconds: 0, endSeconds: 100, key: "G", transposeSemitones: 0 } as SongRegionSummary;
const markers: SectionMarkerSummary[] = [
  { id: "v", name: "Verso", startSeconds: 0, kind: "verse" },
  { id: "c", name: "Coro", startSeconds: 10, kind: "chorus" },
];
const TEXT = "{section: Verse 1}\n[G]Uno\n\n{section: Chorus}\n[C]Coro\n";
const chart = (text = TEXT): SongChart => ({
  text,
  links: [{ markerId: "v", section: 0 }, { markerId: "c", section: 1 }],
  source: {
    provider: "planningCenter",
    songId: "s1",
    arrangementId: "a1",
    planItemId: "i1",
    updatedAt: "2026-11-20T10:00:00Z",
    importedHash: chartTextHash(TEXT),
  },
});
const arrangement = (updatedAt: string, chordChart: string) => ({
  id: "a1",
  songId: "s1",
  name: "Default",
  chordChart,
  chordChartKey: "G",
  lyrics: null,
  sequence: [],
  sequenceFull: [],
  bpm: null,
  meter: null,
  updatedAt,
});

async function open(current: SongChart) {
  const onSave = vi.fn(async (_chart: SongChart) => {});
  render(<ChartImportDialog session={{ region, markers, chart: current, onSave, mode: "refresh" }} onClose={vi.fn()} />);
  await act(async () => {});
  await act(async () => {});
  return onSave;
}

beforeEach(() => {
  flags.chartSources = true;
  useChartSourceStore.setState({ ...INITIAL_CHART_SOURCE_STATE });
  for (const mock of Object.values(api)) mock.mockReset();
  api.isGuestMirrorMode.mockReturnValue(false);
  api.getPcoStatus.mockResolvedValue({ configured: true, state: "connected", account: null, error: null });
  useRedundancyStore.setState({ status: null });
});
afterEach(cleanup);

describe("updating a chart from Planning Center", () => {
  it("C1: the same updated_at says it is up to date and saves nothing", async () => {
    api.getPcoArrangement.mockResolvedValue(arrangement("2026-11-20T10:00:00Z", "VERSE 1\n[G]Uno\nCHORUS\n[C]Coro"));
    const onSave = await open(chart());
    expect(screen.getByText("chartSources.refresh.upToDate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "chartSources.refresh.apply" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(api.getPcoArrangement).toHaveBeenCalledWith("s1", "a1");
  });

  it("C2: shows what changed, keeps the links, and saves the new date and fingerprint", async () => {
    api.getPcoArrangement.mockResolvedValue(
      arrangement("2026-11-22T09:00:00Z", "VERSE 1\n[G]Uno\nCHORUS\n[C]Coro\nVERSE 3\n[G]Tres"),
    );
    const onSave = await open(chart());
    expect(screen.getAllByTestId("chart-refresh-change").map((item) => item.textContent)).toEqual([
      "chartSources.refresh.added: Verse 3",
    ]);
    expect(screen.queryByText("chartSources.refresh.editedWarning")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.refresh.apply" }));
    });
    const saved = onSave.mock.calls[0][0];
    expect(saved.links).toEqual([{ markerId: "v", section: 0 }, { markerId: "c", section: 1 }]);
    expect(saved.source).toMatchObject({ updatedAt: "2026-11-22T09:00:00Z", planItemId: "i1" });
    expect(saved.source?.importedHash).toBe(chartTextHash(saved.text));
  });

  it("C3: warns when the lyrics were edited here", async () => {
    api.getPcoArrangement.mockResolvedValue(arrangement("2026-11-22T09:00:00Z", "VERSE 1\n[G]Uno\nCHORUS\n[C]Coro nuevo"));
    await open(chart(`${TEXT}Una línea mía\n`));
    expect(screen.getByText("chartSources.refresh.editedWarning")).toBeTruthy();
  });
});

describe("who may bring charts from Planning Center", () => {
  it("C4: not a network guest, not a backup", () => {
    expect(renderHook(() => useChartSourcesAvailable()).result.current).toBe(true);
    api.isGuestMirrorMode.mockReturnValue(true);
    expect(renderHook(() => useChartSourcesAvailable()).result.current).toBe(false);
    api.isGuestMirrorMode.mockReturnValue(false);
    useRedundancyStore.setState({ status: { role: "backup" } as never });
    expect(renderHook(() => useChartSourcesAvailable()).result.current).toBe(false);
    useRedundancyStore.setState({ status: null });
    flags.chartSources = false;
    expect(renderHook(() => useChartSourcesAvailable()).result.current).toBe(false);
  });
});
