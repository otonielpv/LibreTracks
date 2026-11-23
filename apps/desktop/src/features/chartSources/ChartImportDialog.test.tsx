import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";

const api = vi.hoisted(() => ({
  getPcoStatus: vi.fn(),
  signInPco: vi.fn(),
  signOutPco: vi.fn(),
  searchPcoSongs: vi.fn(),
  getPcoArrangements: vi.fn(),
  getPcoArrangement: vi.fn(),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChartImportDialog } from "./ChartImportDialog";
import type { AdjustInput } from "./chartImportStore";
import { INITIAL_CHART_SOURCE_STATE, useChartSourceStore } from "./chartSourceStore";

const region = { id: "r1", name: "Camino", startSeconds: 0, endSeconds: 200, key: "A", transposeSemitones: 0 } as SongRegionSummary;
const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"]): SectionMarkerSummary => ({ id, name, startSeconds: 0, kind });
const MARKERS = [marker("v", "Verso", "verse"), marker("c", "Coro", "chorus")];

const CHART = ["VERSO", "[G]Camino", "", "CORO", "// [C]Eres mi refugio //"].join("\n");
const arrangement = (updatedAt = "2026-11-20T10:00:00Z", chordChart = CHART) => ({
  id: "a1",
  songId: "s1",
  name: "Default Arrangement",
  chordChart,
  chordChartKey: "G",
  lyrics: null,
  sequence: [],
  sequenceFull: [{ label: "Verso", number: "1" }, { label: "Coro", number: "1" }],
  bpm: null,
  meter: null,
  updatedAt,
});
const pdfOnly = { ...arrangement(), id: "a2", name: "Solo PDF", chordChart: "" };

beforeEach(() => {
  useChartSourceStore.setState({ ...INITIAL_CHART_SOURCE_STATE });
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPcoStatus.mockResolvedValue({ configured: true, state: "connected", account: null, error: null });
  api.searchPcoSongs.mockResolvedValue({ items: [{ id: "s1", title: "Camino (LT)", author: "Autor", ccliNumber: null, lastScheduledAt: null }], page: 0, hasMore: false, total: 1 });
  api.getPcoArrangements.mockResolvedValue([arrangement(), pdfOnly]);
  api.getPcoArrangement.mockResolvedValue(arrangement());
});
afterEach(cleanup);

async function pick() {
  const onPicked = vi.fn((_input: AdjustInput) => {});
  render(<ChartImportDialog session={{ region, markers: MARKERS, chart: null }} onPicked={onPicked} onClose={vi.fn()} />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "chartSources.import.search" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Camino \(LT\)/ }));
  });
  return onPicked;
}

describe("picking a song in Planning Center", () => {
  it("hands the sheet to the editor as it comes, with the source's hints", async () => {
    const onPicked = await pick();
    expect(api.searchPcoSongs).toHaveBeenCalledWith("Camino", 0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Default Arrangement/ }));
    });
    const input = onPicked.mock.calls[0][0];
    // Not cleaned: the repeat slashes are still there for the adjust to show.
    expect(input.imported.text).toContain("//");
    expect(input.imported.sequence).toEqual(["Verso 1", "Coro 1"]);
    expect(input.imported.key).toBe("G");
    expect(input.imported.source).toMatchObject({ provider: "planningCenter", songId: "s1", arrangementId: "a1" });
  });

  it("an arrangement without text cannot be picked", async () => {
    await pick();
    const pdf = screen.getByRole("button", { name: /Solo PDF/ }) as HTMLButtonElement;
    expect(pdf.disabled).toBe(true);
  });

  it("offers to connect when the account is not connected", async () => {
    api.getPcoStatus.mockResolvedValue({ configured: true, state: "disconnected", account: null, error: null });
    render(<ChartImportDialog session={{ region, markers: MARKERS, chart: null }} onPicked={vi.fn()} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("chartSources.import.connectFirst")).toBeTruthy();
  });
});

describe("updating from Planning Center", () => {
  const TEXT = "{section: Verso}\n[G]Camino\n\n{section: Coro}\n[C]Eres mi refugio\n";
  const current: SongChart = {
    text: TEXT,
    links: [{ markerId: "v", section: 0 }, { markerId: "c", section: 1, repeat: 2 }],
    source: { provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z", importedHash: chartTextHash(TEXT) },
  };
  const open = async (chart: SongChart) => {
    const onPicked = vi.fn((_input: AdjustInput) => {});
    render(<ChartImportDialog session={{ region, markers: MARKERS, chart, mode: "refresh" }} onPicked={onPicked} onClose={vi.fn()} />);
    await act(async () => {});
    await act(async () => {});
    return onPicked;
  };

  it("says when nothing changed", async () => {
    const onPicked = await open(current);
    expect(screen.getByText("chartSources.refresh.upToDate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "chartSources.refresh.bring" })).toBeNull();
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("shows what changed and brings it with the current links to keep", async () => {
    api.getPcoArrangement.mockResolvedValue(arrangement("2026-11-22T09:00:00Z", `${CHART}\n\nPUENTE\n[D]Nuevo`));
    const onPicked = await open(current);
    expect(screen.getAllByTestId("chart-refresh-change").map((item) => item.textContent)).toEqual([
      "chartSources.refresh.added: Puente",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.refresh.bring" }));
    });
    const input = onPicked.mock.calls[0][0];
    expect(input.locked).toEqual([{ markerId: "v", section: 0 }, { markerId: "c", section: 1 }]);
    expect(input.passOverrides).toEqual({ c: 2 });
    expect(input.imported.source?.updatedAt).toBe("2026-11-22T09:00:00Z");
  });

  it("warns when the lyrics were edited here", async () => {
    api.getPcoArrangement.mockResolvedValue(arrangement("2026-11-22T09:00:00Z"));
    await open({ ...current, text: `${TEXT}Una línea mía\n` });
    expect(screen.getByText("chartSources.refresh.editedWarning")).toBeTruthy();
  });
});
