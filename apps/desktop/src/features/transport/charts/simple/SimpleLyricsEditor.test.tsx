import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";
import { analyzeSongSheet, textToSourceLines } from "@libretracks/shared/charts/chartImport";
import { parseChordProWithPlaces, serializeChordPro } from "@libretracks/shared/charts/chordChart";

const flags = vi.hoisted(() => ({ simpleLyricsEditor: true, chartSources: true, lyrics: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(",")}` : key),
  }),
}));
vi.mock("../../../chartSources/useChartSourcesAvailable", () => ({
  useChartSourcesAvailable: () => false,
  chartSourcesAvailableNow: () => false,
}));

import { ChartEditorModal } from "../ChartEditorModal";

const region = {
  id: "song",
  name: "Canción",
  startSeconds: 0,
  endSeconds: 70,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
} as SongRegionSummary;

const markers: SectionMarkerSummary[] = [
  { id: "v1", name: "Verso 1", startSeconds: 0, kind: "verse", variant: 1 },
  { id: "c1", name: "Coro", startSeconds: 10, kind: "chorus" },
  { id: "v2", name: "Verso 2", startSeconds: 20, kind: "verse", variant: 2 },
  { id: "c2", name: "Coro", startSeconds: 30, kind: "chorus" },
  { id: "b", name: "Puente", startSeconds: 40, kind: "bridge" },
  { id: "c3", name: "Coro", startSeconds: 50, kind: "chorus" },
];

function renderEditor(
  chart: SongChart | null,
  mode: "simple" | "advanced" = "simple",
  barSecondsAt?: (seconds: number) => number,
) {
  const onSave = vi.fn(async (_chart: SongChart | null) => {});
  render(
    <ChartEditorModal
      region={region}
      markers={markers}
      chart={chart}
      secondsPerBeatAt={() => 0.5}
      barSecondsAt={barSecondsAt}
      onSave={onSave}
      onClose={vi.fn()}
      initialMode={mode}
    />,
  );
  return { onSave };
}

const partButtons = (name: RegExp) => within(screen.getByRole("navigation", { name: "simpleLyrics.parts" })).getAllByRole("button", { name });
const partButton = (name: RegExp) => partButtons(name)[0];
const box = () => screen.getByRole("textbox", { name: /simpleLyrics\.textFor/ }) as HTMLTextAreaElement;
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "liveChart.save" }));
  });
};

/** Rows of each section except `skip`, as they are in the text. */
function otherRows(text: string, skip: number): string[][] {
  const { doc, sectionStarts } = parseChordProWithPlaces(text);
  const rows = text.split("\n");
  return doc.sections
    .map((_, index) => rows.slice(sectionStarts[index], sectionStarts[index + 1] ?? rows.length).join("\n").trim().split("\n"))
    .filter((_, index) => index !== skip);
}

const PC_TEXT = [
  "{title: Canción de prueba}",
  "{key: G}",
  "",
  "{section: Verso 1}",
  "[G]Camino por la [D]senda",
  "",
  "{section: Coro}",
  "[C]Santo eres [G]tú",
  "",
  "{section: Verso 2}",
  "[G]Canto en la [D]mañana",
  "",
  "{section: Puente}",
  "[Em]Siempre [C]fiel",
  "",
].join("\n");
const PC_CHART: SongChart = {
  text: PC_TEXT,
  links: [
    { markerId: "v1", section: 0 },
    { markerId: "c1", section: 1 },
    { markerId: "v2", section: 2 },
    { markerId: "c2", section: 1 },
    { markerId: "b", section: 3 },
    { markerId: "c3", section: 1 },
  ],
};

describe("simple lyrics editor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    flags.simpleLyricsEditor = true;
  });

  it("C2: picking a Coro, writing chords and lyrics and saving links only that marker", async () => {
    const { onSave } = renderEditor(null);
    fireEvent.click(partButton(/Coro/));
    fireEvent.change(box(), { target: { value: "C          G\nSanto eres tú" } });
    expect(partButtons(/Coro/).map((button) => button.querySelector(".lt-simple-lyrics-part-done") !== null)).toEqual([true, false, false]);
    await save();
    const saved = onSave.mock.calls[0][0] as SongChart;
    expect(saved.text).toBe("{section: Coro}\n[C]Santo eres [G]tú\n");
    expect(saved.links.map((link) => [link.markerId, link.section])).toEqual([["c1", 0]]);
  });

  it("C3: editing one part of a Planning Center sheet keeps the rest of the text", async () => {
    const { onSave } = renderEditor(PC_CHART);
    fireEvent.click(partButton(/Puente/));
    expect(box().value).toBe("Em      C\nSiempre fiel");
    fireEvent.change(box(), { target: { value: "Em     C\nSiempre fiel, Señor" } });
    await save();
    const saved = onSave.mock.calls[0][0] as SongChart;
    expect(saved.text).not.toBe(PC_TEXT);
    expect(otherRows(saved.text, 3)).toEqual(otherRows(PC_TEXT, 3));
    expect(saved.text.startsWith("{title: Canción de prueba}\n{key: G}\n")).toBe(true);
  });

  it("C3: editing one part of a sheet imported from a file keeps the rest", async () => {
    const sheet = ["VERSO 1", "G             D", "Camino por la senda", "CORO", "C          G", "Santo eres tú", "PUENTE", "Em      C", "Siempre fiel"].join("\n");
    const text = serializeChordPro(analyzeSongSheet(textToSourceLines(sheet)));
    const chart: SongChart = { text, links: [{ markerId: "v1", section: 0 }, { markerId: "c1", section: 1 }, { markerId: "b", section: 2 }] };
    const { onSave } = renderEditor(chart);
    fireEvent.click(partButton(/Verso 1/));
    fireEvent.change(box(), { target: { value: "G             D\nCamino por la senda angosta" } });
    await save();
    const saved = onSave.mock.calls[0][0] as SongChart;
    expect(otherRows(saved.text, 0)).toEqual(otherRows(text, 0));
  });

  it("C4: switching to Advanced and back loses nothing, both ways", async () => {
    const { onSave } = renderEditor(null);
    fireEvent.click(partButton(/Verso 1/));
    fireEvent.change(box(), { target: { value: "Camino por la senda" } });
    fireEvent.click(screen.getByRole("tab", { name: "simpleLyrics.advanced" }));
    const advanced = screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement;
    expect(advanced.value).toContain("Camino por la senda");
    fireEvent.change(advanced, { target: { value: advanced.value.replace("senda", "senda angosta") } });
    fireEvent.click(screen.getByRole("tab", { name: "simpleLyrics.simple" }));
    fireEvent.click(partButton(/Verso 1/));
    expect(box().value).toBe("Camino por la senda angosta");
    expect(window.localStorage.getItem("lt.chartEditor.mode")).toBe("simple");
    await save();
    expect((onSave.mock.calls[0][0] as SongChart).text).toContain("Camino por la senda angosta");
  });

  it("C5: paste the whole song: the preview comes assigned and Apply shares it out; Cancel changes nothing", async () => {
    const { onSave } = renderEditor(null);
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.pasteSong" }));
    fireEvent.change(screen.getByRole("textbox", { name: "simpleLyrics.pasteLabel" }), {
      target: { value: "Camino por la senda\n\nSanto eres tú\nDigno de honor\n\nCanto en la mañana\n\nSanto eres tú\nDigno de honor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.review" }));
    const selects = screen.getAllByRole("combobox", { name: /simpleLyrics\.blockFor/ }) as HTMLSelectElement[];
    expect(selects.map((select) => select.selectedOptions[0].textContent)).toEqual(["01 Verso 1", "02 Coro", "03 Verso 2", "02 Coro"]);
    // The chorus block is copied to every chorus.
    expect(screen.getAllByText(/simpleLyrics\.pasteAlso/)[0].textContent).toContain("04 Coro, 06 Coro");
    // Cancel from the review: back, then cancel; nothing written.
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.back" }));
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.cancel" }));
    expect(screen.getByRole("button", { name: "liveChart.save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.pasteSong" }));
    fireEvent.change(screen.getByRole("textbox", { name: "simpleLyrics.pasteLabel" }), {
      target: { value: "Camino por la senda\n\nSanto eres tú\nDigno de honor\n\nCanto en la mañana\n\nSanto eres tú\nDigno de honor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.review" }));
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.apply" }));
    fireEvent.click(partButtons(/Coro/)[2]);
    expect(box().value).toBe("Santo eres tú\nDigno de honor");
    await save();
    // Verso 1, three choruses and Verso 2 (the bridge got no block).
    expect((onSave.mock.calls[0][0] as SongChart).links).toHaveLength(5);
  });

  it("warns in one line when a part's recorded times are cleared", () => {
    const timed: SongChart = { ...PC_CHART, links: PC_CHART.links.map((link) => (link.markerId === "b" ? { ...link, lineBeats: [0] } : link)) };
    renderEditor(timed);
    fireEvent.click(partButton(/Puente/));
    fireEvent.change(box(), { target: { value: "Siempre fiel\nSiempre tú" } });
    expect(screen.getByRole("status").textContent).toBe("simpleLyrics.clearedTimes");
  });

  it("without markers offers quick parts that number themselves", () => {
    render(
      <ChartEditorModal region={region} markers={[]} chart={null} secondsPerBeatAt={() => 0.5} onSave={vi.fn(async () => {})} onClose={vi.fn()} initialMode="simple" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.addPart:Verso" }));
    fireEvent.change(box(), { target: { value: "Camino" } });
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.addPart:Verso" }));
    const names = within(screen.getByRole("navigation", { name: "simpleLyrics.parts" }))
      .getAllByRole("button")
      .map((button) => button.querySelector(".lt-simple-lyrics-part-name")?.textContent)
      .filter(Boolean);
    expect(names).toEqual(["Verso", "Verso 2"]);
  });

  it("C1: with the flag off there are no modes and the editor is Advanced", () => {
    flags.simpleLyricsEditor = false;
    renderEditor(PC_CHART, "simple");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("textbox", { name: "liveChart.textLabel" })).toBeTruthy();
  });

  it("07 C1: a chord put by touch gives the same chart as typing the chord line", async () => {
    const { onSave } = renderEditor(null);
    fireEvent.click(partButton(/Puente/));
    fireEvent.change(box(), { target: { value: "Santo es el Señor" } });
    fireEvent.click(screen.getByRole("tab", { name: "simpleLyrics.viewChords" }));
    fireEvent.click(screen.getByRole("button", { name: "Señor" }));
    fireEvent.click(screen.getByRole("button", { name: "D" }));
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.chordPut:D" }));
    await save();
    const byTouch = (onSave.mock.calls[0][0] as SongChart).text;
    expect(byTouch).toBe(["{section: Puente}", "Santo es el [D]Señor", ""].join("\n"));
  });

  it("chords by touch in a part without lyrics: a line of chords, then more chords", async () => {
    const { onSave } = renderEditor(null);
    fireEvent.click(partButton(/Puente/));
    fireEvent.click(screen.getByRole("tab", { name: "simpleLyrics.viewChords" }));
    fireEvent.click(screen.getByRole("button", { name: /simpleLyrics\.addChordLine/ }));
    fireEvent.click(screen.getByRole("button", { name: "C" }));
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.chordPut:C" }));
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.addChord" }));
    fireEvent.click(screen.getAllByRole("button", { name: "G" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "simpleLyrics.chordPut:G" }));
    await save();
    expect((onSave.mock.calls[0][0] as SongChart).text).toBe(["{section: Puente}", "[C] [G]", ""].join("\n"));
  });

  it("lists every marker in song order, each with its own lyrics", async () => {
    const { onSave } = renderEditor(PC_CHART);
    const names = within(screen.getByRole("navigation", { name: "simpleLyrics.parts" }))
      .getAllByRole("button")
      .map((button) => button.querySelector(".lt-simple-lyrics-part-name")?.textContent);
    expect(names).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente", "Coro"]);
    fireEvent.click(partButtons(/Coro/)[2]);
    // The sheet links the three choruses to one section: each shows it...
    expect(box().value).toBe(["C          G", "Santo eres tú"].join("\n"));
    // ...and editing the last one changes only that one.
    fireEvent.change(box(), { target: { value: "Otra letra al final" } });
    fireEvent.click(partButtons(/Coro/)[0]);
    expect(box().value).toBe(["C          G", "Santo eres tú"].join("\n"));
    await save();
    const saved = onSave.mock.calls[0][0] as SongChart;
    expect(saved.text).toContain("Otra letra al final");
    expect(saved.text).toContain("[C]Santo eres [G]tú");
  });

  it("the ChordPro box is measured when Advanced is shown after Simple (it grows, the body scrolls)", () => {
    renderEditor(PC_CHART, "simple");
    fireEvent.click(screen.getByRole("tab", { name: "simpleLyrics.advanced" }));
    const advanced = screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement;
    expect(advanced.style.height).not.toBe("");
  });

  it("a part sung twice in a row (Coro x2 from Planning Center) says ×2 on its row and above the box", () => {
    const chart: SongChart = {
      ...PC_CHART,
      links: PC_CHART.links.map((link) => (link.markerId === "c2" ? { ...link, repeat: 2 } : link)),
    };
    renderEditor(chart);
    const rows = partButtons(/Coro/);
    expect(within(rows[0]).queryByText("×2")).toBeNull();
    expect(within(rows[1]).getByText("×2")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("simpleLyrics.passesNote:1");
    fireEvent.click(rows[1]);
    expect(screen.getByRole("note").textContent).toContain("simpleLyrics.passesNote:2");
  });

  it("the ×N selector sets the passes of that marker only, and ×1 drops them", async () => {
    const chart: SongChart = {
      ...PC_CHART,
      links: PC_CHART.links.map((link) => (link.markerId === "c2" ? { ...link, repeat: 2 } : link)),
    };
    const { onSave } = renderEditor(chart);
    fireEvent.click(partButtons(/Coro/)[1]);
    const select = screen.getByRole("combobox", { name: /liveChart\.passesFor/ }) as HTMLSelectElement;
    expect(select.value).toBe("2");
    fireEvent.change(select, { target: { value: "1" } });
    expect(within(partButtons(/Coro/)[1]).queryByText("×2")).toBeNull();
    fireEvent.click(partButtons(/Coro/)[2]);
    fireEvent.change(screen.getByRole("combobox", { name: /liveChart\.passesFor/ }), { target: { value: "3" } });
    expect(within(partButtons(/Coro/)[2]).getByText("×3")).toBeTruthy();
    await save();
    const links = onSave.mock.calls.at(-1)![0]!.links;
    expect(links.find((link) => link.markerId === "c2")?.repeat).toBeUndefined();
    expect(links.find((link) => link.markerId === "c3")?.repeat).toBe(3);
    expect(links.find((link) => link.markerId === "c1")?.repeat).toBeUndefined();
  });

  it("each row says how many bars its marker lasts, until the next marker or the end", () => {
    // 2 s per bar: markers every 10 s = 5 bars; the last one runs to 70 s = 10 bars.
    renderEditor(PC_CHART, "simple", () => 2);
    const coros = partButtons(/Coro/);
    expect(within(coros[0]).getByText("transport.structure.bars:5")).toBeTruthy();
    expect(within(coros[2]).getByText("transport.structure.bars:10")).toBeTruthy();
  });

  it("a marker off the bar line shows the decimal", () => {
    renderEditor(PC_CHART, "simple", () => 4);
    expect(within(partButtons(/Verso 1/)[0]).getByText("transport.structure.bars:2.5")).toBeTruthy();
  });

  it("without the meter nothing is shown", () => {
    renderEditor(PC_CHART);
    expect(within(partButtons(/Coro/)[0]).queryByText(/transport\.structure\.bars/)).toBeNull();
  });
});
