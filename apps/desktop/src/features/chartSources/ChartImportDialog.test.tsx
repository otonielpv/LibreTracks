import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";

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
import { INITIAL_CHART_SOURCE_STATE, useChartSourceStore } from "./chartSourceStore";

const region = { id: "r1", name: "Camino", startSeconds: 0, endSeconds: 200, key: "A", transposeSemitones: 0 } as SongRegionSummary;
const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"]): SectionMarkerSummary => ({ id, name, startSeconds: 0, kind });
const SONG_MARKERS = [marker("i", "Intro", "intro"), marker("v1", "Verso", "verse"), marker("v2", "Verso", "verse"), marker("c", "Coro", "chorus")];

const arrangement = {
  id: "a1",
  songId: "s1",
  name: "Default Arrangement",
  chordChart: ["INTRO", "[G] [D]", "", "VERSO", "[G]Camino por la orilla", "", "CORO", "[C]Eres mi refugio"].join("\n"),
  chordChartKey: "G",
  lyrics: null,
  sequence: ["Intro", "Verso", "Verso", "Coro"],
  sequenceFull: [
    { label: "Intro", number: "1" },
    { label: "Verso", number: "1" },
    { label: "Verso", number: "1" },
    { label: "Coro", number: "1" },
  ],
  bpm: 72,
  meter: "4/4",
  updatedAt: "2026-11-20T10:00:00Z",
};
const pdfOnly = { ...arrangement, id: "a2", name: "Solo PDF", chordChart: "", lyrics: null };

async function openReview(markers = SONG_MARKERS, chart: SongChart | null = null) {
  const onSave = vi.fn(async (_chart: SongChart) => {});
  const onClose = vi.fn();
  render(<ChartImportDialog session={{ region, markers, chart, onSave }} onClose={onClose} />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "chartSources.import.search" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Camino \(LT\)/ }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Default Arrangement/ }));
  });
  return { onSave, onClose };
}

const apply = async (name = "chartSources.import.apply") => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  useChartSourceStore.setState({ ...INITIAL_CHART_SOURCE_STATE });
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPcoStatus.mockResolvedValue({ configured: true, state: "connected", account: { name: "Ana", organization: "Iglesia" }, error: null });
  api.searchPcoSongs.mockResolvedValue({ items: [{ id: "s1", title: "Camino (LT)", author: "Autor", ccliNumber: null, lastScheduledAt: null }], page: 0, hasMore: false, total: 1 });
  api.getPcoArrangements.mockResolvedValue([arrangement, pdfOnly]);
  api.getPcoArrangement.mockResolvedValue(arrangement);
});
afterEach(cleanup);

describe("importing a song from Planning Center", () => {
  it("C1: search, pick, and review the song marker by marker", async () => {
    await openReview();
    expect(api.searchPcoSongs).toHaveBeenCalledWith("Camino", 0);
    const rows = screen.getAllByTestId("chart-import-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText("Camino por la orilla")).toBeTruthy();
    expect(within(rows[2]).getByText("Camino por la orilla")).toBeTruthy();
    expect(within(rows[3]).getByText("Eres mi refugio")).toBeTruthy();
  });

  it("C2: a changed section is saved, the rest stays as matched", async () => {
    const { onSave } = await openReview();
    const rows = screen.getAllByTestId("chart-import-row");
    await act(async () => {
      fireEvent.change(within(rows[2]).getByRole("combobox", { name: /chartSources.import.section/ }), { target: { value: "2" } });
    });
    await apply();
    const saved = onSave.mock.calls[0][0];
    expect(saved.links).toEqual([
      { markerId: "i", section: 0 },
      { markerId: "v1", section: 1 },
      { markerId: "v2", section: 2 },
      { markerId: "c", section: 2 },
    ]);
  });

  it("C3: transposes to the song's key when checked, keeps the original when not", async () => {
    const chords = (chart: SongChart) =>
      parseChordPro(chart.text).sections.flatMap((section) =>
        section.lines.flatMap((line) => (line.kind === "lyrics" ? line.segments.flatMap((segment) => (segment.chord ? [segment.chord] : [])) : [])),
      );
    const first = await openReview();
    await apply();
    expect(chords(first.onSave.mock.calls[0][0])).toEqual(["A", "E", "A", "D"]);
    cleanup();

    const second = await openReview();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    await apply();
    expect(chords(second.onSave.mock.calls[0][0])).toEqual(["G", "D", "G", "C"]);
  });

  it("C4: an arrangement without text cannot be picked; a song without markers imports unlinked", async () => {
    await openReview([]);
    expect(screen.getByText("chartSources.import.noMarkers")).toBeTruthy();
    cleanup();

    const onSave = vi.fn(async (_chart: SongChart) => {});
    render(<ChartImportDialog session={{ region, markers: [], chart: null, onSave }} onClose={vi.fn()} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.import.search" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Camino \(LT\)/ }));
    });
    const pdf = screen.getByRole("button", { name: /Solo PDF/ }) as HTMLButtonElement;
    expect(pdf.disabled).toBe(true);
    expect(within(pdf).getByText("chartSources.import.pdfOnly")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Default Arrangement/ }));
    });
    await apply("chartSources.import.importUnlinked");
    expect(onSave.mock.calls[0][0].links).toEqual([]);
  });

  it("C5: what is saved remembers the source and the fingerprint", async () => {
    const { onSave, onClose } = await openReview();
    await apply();
    const saved = onSave.mock.calls[0][0];
    expect(saved.source).toMatchObject({ provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z" });
    expect(saved.source?.importedHash).toBe(chartTextHash(saved.text));
    expect(onClose).toHaveBeenCalled();
  });

  it("asks before replacing lyrics the song already has", async () => {
    await openReview(SONG_MARKERS, { text: "{section: Coro}\nVieja", links: [] });
    expect(screen.getByText("chartSources.import.replaceWarning")).toBeTruthy();
    expect(screen.getByRole("button", { name: "chartSources.import.replace" })).toBeTruthy();
  });

  it("offers to connect when the account is not connected", async () => {
    api.getPcoStatus.mockResolvedValue({ configured: true, state: "disconnected", account: null, error: null });
    render(<ChartImportDialog session={{ region, markers: SONG_MARKERS, chart: null, onSave: vi.fn() }} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("chartSources.import.connectFirst")).toBeTruthy();
  });
});
