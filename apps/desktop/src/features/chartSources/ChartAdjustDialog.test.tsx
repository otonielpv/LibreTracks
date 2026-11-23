import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options && "label" in options ? `${key}:${options.label}` : key),
  }),
}));

import { ChartAdjustDialog } from "./ChartAdjustDialog";
import type { AdjustInput } from "./chartImportStore";

const region = { id: "r1", name: "Camino", startSeconds: 0, endSeconds: 200, key: "A", transposeSemitones: 0 } as SongRegionSummary;
const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"]): SectionMarkerSummary => ({ id, name, startSeconds: 0, kind });
const SONG = [marker("i", "Intro", "intro"), marker("v1", "Verso", "verse"), marker("v2", "Verso", "verse"), marker("c", "Coro", "chorus")];

// As it comes from Planning Center (chords over the words already in [C]).
const RAW = ["INTRO", "[G] [D]", "", "VERSO", "[G]Camino por la orilla", "", "CORO", "// [C]Eres mi refugio //"].join("\n");
const input = (text = RAW): AdjustInput => ({
  imported: {
    title: "Camino",
    text,
    key: "G",
    source: { provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z", key: "G" },
  },
});

function open(markers = SONG, given = input()) {
  const onApply = vi.fn((_chart: SongChart) => {});
  render(<ChartAdjustDialog region={region} markers={markers} input={given} onApply={onApply} onClose={vi.fn()} />);
  return onApply;
}
const chords = (chart: SongChart) =>
  parseChordPro(chart.text).sections.flatMap((section) =>
    section.lines.flatMap((line) => (line.kind === "lyrics" ? line.segments.flatMap((segment) => (segment.chord ? [segment.chord] : [])) : [])),
  );

afterEach(cleanup);

describe("adjusting a sheet to the song's sequence", () => {
  it("lists what will change in the sheet before changing it", () => {
    open();
    expect(screen.getAllByTestId("sheet-change").map((item) => item.textContent)).toEqual([
      "chartSources.adjust.change.repeatMarks:Coro",
    ]);
  });

  it("shows the song marker by marker with the words of each one", () => {
    open();
    const rows = screen.getAllByTestId("chart-import-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText("Camino por la orilla")).toBeTruthy();
    expect(within(rows[2]).getByText("Camino por la orilla")).toBeTruthy();
    expect(within(rows[3]).getByText("Eres mi refugio")).toBeTruthy();
  });

  it("applies the cleaned sheet with the links, a changed one included", async () => {
    const onApply = open();
    const rows = screen.getAllByTestId("chart-import-row");
    await act(async () => {
      fireEvent.change(within(rows[2]).getByRole("combobox", { name: /chartSources.import.section/ }), { target: { value: "2" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.apply" }));
    });
    const chart = onApply.mock.calls[0][0];
    expect(chart.text).not.toContain("//");
    expect(chart.links.map((link) => [link.markerId, link.section])).toEqual([
      ["i", 0],
      ["v1", 1],
      ["v2", 2],
      ["c", 2],
    ]);
    expect(chart.source).toMatchObject({ songId: "s1", arrangementId: "a1" });
    expect(chart.source?.importedHash).toBe(chartTextHash(chart.text));
  });

  it("transposes to the song's key when checked, keeps the original when not", async () => {
    const first = open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.apply" }));
    });
    expect(chords(first.mock.calls[0][0])).toEqual(["A", "E", "A", "D"]);
    cleanup();
    const second = open();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.apply" }));
    });
    expect(chords(second.mock.calls[0][0])).toEqual(["G", "D", "G", "C"]);
  });

  it("a song without section markers applies without linking", async () => {
    const onApply = open([]);
    expect(screen.getByText("chartSources.import.noMarkers")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.applyUnlinked" }));
    });
    expect(onApply.mock.calls[0][0].links).toEqual([]);
  });

  it("a clean sheet says nothing changes in it", () => {
    open(SONG, input(["VERSO", "[G]Uno", "CORO", "[C]Dos"].join("\n")));
    expect(screen.queryAllByTestId("sheet-change")).toHaveLength(0);
    expect(screen.getByText("chartSources.adjust.noChanges")).toBeTruthy();
  });
});
