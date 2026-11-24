import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
  }),
}));

import { ChartEditorModal } from "./ChartEditorModal";

const region = {
  id: "song",
  name: "Canción",
  startSeconds: 100,
  endSeconds: 140,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
} as SongRegionSummary;

// The verse runs 20 s (100 → 120) with four lines; the chorus to the end.
const markers: SectionMarkerSummary[] = [
  { id: "verse", name: "Estrofa", startSeconds: 100, kind: "verse" },
  { id: "chorus", name: "Coro", startSeconds: 120, kind: "chorus" },
];

const TEXT = ["{section: Verso 1}", "uno", "dos", "tres", "cuatro", "{section: Coro 1}", "[G]coro"].join("\n");

const chart: SongChart = {
  text: TEXT,
  links: [
    { markerId: "verse", section: 0 },
    { markerId: "chorus", section: 1 },
  ],
};

function renderEditor(initial: SongChart = chart) {
  const onSave = vi.fn(async () => {});
  render(
    <ChartEditorModal
      region={region}
      markers={markers}
      chart={initial}
      // 120 BPM: half a second per beat.
      secondsPerBeatAt={() => 0.5}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  const textarea = screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement;
  return { onSave, textarea };
}

async function saveAndRead(onSave: ReturnType<typeof vi.fn>): Promise<SongChart> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "liveChart.save" }));
  });
  return (onSave.mock.calls[0] as unknown as [SongChart])[0];
}

describe("ChartEditorModal line times in the text", () => {
  it("shows each line's change time on its left, in song time", () => {
    const { textarea } = renderEditor();
    expect(textarea.value.split("\n")).toEqual([
      "{section: Verso 1}",
      // 20 s and four lines: a line every 5 s.
      "[0:00.0] uno",
      "[0:05.0] dos",
      "[0:10.0] tres",
      "[0:15.0] cuatro",
      "{section: Coro 1}",
      "[0:20.0] [G]coro",
    ]);
  });

  it("shows recorded times when there are some", () => {
    const { textarea } = renderEditor({
      ...chart,
      links: [{ markerId: "verse", section: 0, lineBeats: [0, 2, 6, 30] }, chart.links[1]],
    });
    expect(textarea.value).toContain("[0:01.0] dos");
    expect(textarea.value).toContain("[0:03.0] tres");
  });

  it("saves a time edited in the text, in beats, and the lyrics without times", async () => {
    const { onSave, textarea } = renderEditor();
    fireEvent.change(textarea, { target: { value: textarea.value.replace("[0:05.0] dos", "[0:07.5] dos") } });
    const saved = await saveAndRead(onSave);
    expect(saved.text).toBe(TEXT);
    expect(saved.links).toEqual([
      // 7.5 s → 15 beats; the other lines keep the times they showed.
      { markerId: "verse", section: 0, lineBeats: [0, 15, 20, 30] },
      // Untouched: still the even spread.
      { markerId: "chorus", section: 1 },
    ]);
  });

  it("saves nothing new when no time was changed", async () => {
    const { onSave } = renderEditor();
    const saved = await saveAndRead(onSave);
    expect(saved).toEqual(chart);
  });

  it("marks a section's times as recorded as soon as one is typed, and resets them without saving", () => {
    const { textarea } = renderEditor();
    expect(screen.queryByText("liveChart.recordedTimes")).toBeNull();
    fireEvent.change(textarea, { target: { value: textarea.value.replace("[0:05.0] dos", "[0:07.5] dos") } });
    fireEvent.click(screen.getByText("liveChart.recordedTimes"));
    expect(textarea.value).toContain("[0:05.0] dos");
    expect(screen.queryByText("liveChart.recordedTimes")).toBeNull();
  });

  it("links a chart typed from scratch on save, and keeps the times typed in it", async () => {
    const { onSave, textarea } = renderEditor({ text: "", links: [] });
    fireEvent.change(textarea, {
      target: { value: ["{section: Verso 1}", "[0:00] uno", "[0:12] dos", "{section: Coro 1}", "coro"].join("\n") },
    });
    const saved = await saveAndRead(onSave);
    expect(saved.links).toEqual([
      { markerId: "verse", section: 0, lineBeats: [0, 24] },
      { markerId: "chorus", section: 1 },
    ]);
  });
});

describe("ChartEditorModal copied sections", () => {
  // The chorus replaced by a copy of the verse, times included: they belong
  // to 0-10 s, the chorus plays from 20 s.
  const pasted = [
    "{section: Verso 1}",
    "[0:00.0] uno",
    "[0:05.0] dos",
    "[0:10.0] tres",
    "[0:15.0] cuatro",
    "{section: Coro 1}",
    "[0:00.0] uno",
    "[0:05.0] dos",
  ].join("\n");

  it("recalculates the times that do not fit their section and keeps the rest", () => {
    const { textarea } = renderEditor();
    fireEvent.change(textarea, { target: { value: pasted } });
    fireEvent.click(screen.getByRole("button", { name: "liveChart.recalcTimes" }));
    expect(textarea.value.split("\n")).toEqual([
      "{section: Verso 1}",
      "[0:00.0] uno",
      "[0:05.0] dos",
      "[0:10.0] tres",
      "[0:15.0] cuatro",
      "{section: Coro 1}",
      // 20 s of chorus, two lines: one every 10 s.
      "[0:20.0] uno",
      "[0:30.0] dos",
    ]);
  });

  it("saves a pasted section's foreign times as the even spread", async () => {
    const { onSave, textarea } = renderEditor();
    fireEvent.change(textarea, { target: { value: pasted } });
    const saved = await saveAndRead(onSave);
    expect(saved.links).toEqual([
      { markerId: "verse", section: 0 },
      { markerId: "chorus", section: 1 },
    ]);
  });

  it("keeps each marker on its section when a section is pasted before it", async () => {
    const { onSave, textarea } = renderEditor();
    const lines = textarea.value.split("\n");
    lines.splice(5, 0, "{section: Puente}", "y la la la");
    fireEvent.change(textarea, { target: { value: lines.join("\n") } });
    const saved = await saveAndRead(onSave);
    expect(saved.links).toEqual([
      { markerId: "verse", section: 0 },
      { markerId: "chorus", section: 2 },
    ]);
  });
});

describe("ChartEditorModal adjust to the sequence", () => {
  const RAW = ["VERSO", "[G]uno", "", "CORO", "// [C]coro //"].join("\n");
  const imported = {
    imported: {
      title: "Canción",
      text: RAW,
      source: { provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z" },
    },
  };

  function renderImported() {
    const onSave = vi.fn(async () => {});
    render(
      <ChartEditorModal
        region={region}
        markers={markers}
        chart={null}
        secondsPerBeatAt={() => 0.5}
        onSave={onSave}
        onClose={vi.fn()}
        initialImport={imported}
      />,
    );
    return onSave;
  }

  it("a sheet brought in keeps its text until the adjust is applied", async () => {
    const onSave = renderImported();
    expect(screen.getByText("chartSources.adjust.title")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.import.cancel" }));
    });
    const textarea = screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement;
    expect(textarea.value).toContain("// [C]coro //");
    const saved = await saveAndRead(onSave);
    expect(saved.source).toMatchObject({ provider: "planningCenter", arrangementId: "a1" });
  });

  it("applying the adjust cleans the text and links the markers", async () => {
    const onSave = renderImported();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.apply" }));
    });
    const textarea = screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement;
    expect(textarea.value).not.toContain("//");
    const saved = await saveAndRead(onSave);
    expect(saved.links.map((link) => [link.markerId, link.section])).toEqual([
      ["verse", 0],
      ["chorus", 1],
    ]);
  });

  it("the adjust button opens it on any sheet", async () => {
    renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.adjust.open" }));
    });
    expect(screen.getByText("chartSources.adjust.title")).toBeTruthy();
  });
});
