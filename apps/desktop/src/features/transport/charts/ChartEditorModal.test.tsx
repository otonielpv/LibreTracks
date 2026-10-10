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

const chart: SongChart = {
  text: "{section: Verso 1}\nuno\ndos\ntres\ncuatro\n{section: Coro 1}\n[G]coro",
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
  return { onSave };
}

const timeInput = (line: number) =>
  screen.getByRole("textbox", { name: `liveChart.lineTime:${line}` }) as HTMLInputElement;

describe("ChartEditorModal line times", () => {
  it("shows when each line changes, in song time, from the even spread by default", () => {
    renderEditor();
    fireEvent.click(screen.getAllByRole("button", { name: /liveChart.autoTimes/ })[0]);
    // 20 s and four lines: a line every 5 s, counted from the song start.
    expect([1, 2, 3, 4].map((line) => timeInput(line).value)).toEqual(["0:00.0", "0:05.0", "0:10.0", "0:15.0"]);
    // The first line always starts with the marker.
    expect(timeInput(1).disabled).toBe(true);
  });

  it("shows recorded times when there are some", () => {
    renderEditor({ ...chart, links: [{ markerId: "verse", section: 0, lineBeats: [0, 2, 6, 30] }, chart.links[1]] });
    fireEvent.click(screen.getAllByRole("button", { name: /liveChart.recordedTimes/ })[0]);
    expect([1, 2, 3, 4].map((line) => timeInput(line).value)).toEqual(["0:00.0", "0:01.0", "0:03.0", "0:15.0"]);
  });

  it("saves a typed time in beats from the marker", async () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getAllByRole("button", { name: /liveChart.autoTimes/ })[0]);
    fireEvent.change(timeInput(2), { target: { value: "0:07.5" } });
    fireEvent.blur(timeInput(2));
    expect(timeInput(2).value).toBe("0:07.5");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "liveChart.save" }));
    });
    const saved = (onSave.mock.calls[0] as unknown as [SongChart])[0];
    // 7.5 s → 15 beats; the untouched lines keep their spread times.
    expect(saved.links[0]).toEqual({ markerId: "verse", section: 0, lineBeats: [0, 15, 20, 30] });
  });

  it("does not let a line cross the next one", () => {
    renderEditor();
    fireEvent.click(screen.getAllByRole("button", { name: /liveChart.autoTimes/ })[0]);
    fireEvent.change(timeInput(2), { target: { value: "0:12" } });
    fireEvent.blur(timeInput(2));
    // Line 3 is at 0:10.0: line 2 stops just before it.
    expect(timeInput(2).value).toBe("0:09.9");
  });
});
