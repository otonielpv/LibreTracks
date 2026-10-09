import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SongChart,
  SongRegionSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

const api = vi.hoisted(() => ({
  setSongRegionChart: vi.fn(),
  clearSongRegionChart: vi.fn(),
  setSongChartAnchor: vi.fn(),
  removeSongChartAnchor: vi.fn(),
  readSongRegionChart: vi.fn(),
}));
vi.mock("../desktopApi", () => api);

const pdf = vi.hoisted(() => ({ openChartDocument: vi.fn(), destroy: vi.fn() }));
vi.mock("./pdfLoader", () => ({ openChartDocument: pdf.openChartDocument }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChartView } from "./ChartView";

const snapshot = { marker: "snapshot" } as unknown as TransportSnapshot;

function region(chart: SongChart | null): SongRegionSummary {
  return {
    id: "song-1",
    name: "Cuan grande",
    startSeconds: 0,
    endSeconds: 60,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  };
}

function song(chart: SongChart | null): SongView {
  return {
    id: "session",
    title: "Session",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 60,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [region(chart)],
    sectionMarkers: [
      { id: "verse", name: "Estrofa", startSeconds: 0, kind: "verse" },
      { id: "chorus", name: "Coro", startSeconds: 20, kind: "chorus" },
      { id: "build", name: "Build", startSeconds: 25, kind: "build" },
    ],
    clips: [],
    tracks: [],
    projectRevision: 1,
  } as SongView;
}

/** Two pages of 100x150 (aspect 1.5). */
function fakeDocument() {
  return {
    numPages: 2,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 150 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    })),
    destroy: pdf.destroy,
  };
}

function renderView(view: SongView, position = 0) {
  const onSnapshot = vi.fn();
  const run = vi.fn(async (work: () => Promise<void>) => {
    await work();
  });
  const utils = render(
    <ChartView
      song={view}
      positionSecondsRef={{ current: position }}
      onViewModeChange={vi.fn()}
      onSnapshot={onSnapshot}
      run={run}
    />,
  );
  return { ...utils, onSnapshot, run };
}

const sizes = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
};

describe("ChartView", () => {
  beforeAll(() => {
    // The scroller is 400x300: pages lay out at 400x600 with a 12 px gap.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  });

  afterAll(() => {
    if (sizes.clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", sizes.clientWidth);
    if (sizes.clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", sizes.clientHeight);
  });

  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    pdf.openChartDocument.mockReset();
    pdf.destroy.mockReset();
    api.setSongRegionChart.mockResolvedValue(snapshot);
    api.setSongChartAnchor.mockResolvedValue(snapshot);
    api.removeSongChartAnchor.mockResolvedValue(snapshot);
    api.readSongRegionChart.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    pdf.openChartDocument.mockImplementation(async () => fakeDocument());
  });

  it("offers to add a PDF to a song without one and uploads the picked file", async () => {
    const { onSnapshot } = renderView(song(null));

    expect(screen.getByRole("button", { name: "chartView.addPdf" })).toBeTruthy();
    const file = new File([new Uint8Array([37, 80, 68, 70, 45])], "Acordes.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([37, 80, 68, 70, 45]).buffer,
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("chart-file-input"), { target: { files: [file] } });
    });

    expect(api.setSongRegionChart).toHaveBeenCalledWith(
      "song-1",
      "Acordes.pdf",
      new Uint8Array([37, 80, 68, 70, 45]),
    );
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("refuses an oversized PDF before sending it anywhere", async () => {
    const { run } = renderView(song(null));
    const file = new File(["x"], "huge.pdf");
    Object.defineProperty(file, "size", { value: 30 * 1024 * 1024 });

    let failure: unknown = null;
    run.mockImplementation(async (work) => {
      try {
        await work();
      } catch (error) {
        failure = error;
      }
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("chart-file-input"), { target: { files: [file] } });
    });

    expect((failure as Error | null)?.message).toBe("chartView.tooLarge");
    expect(api.setSongRegionChart).not.toHaveBeenCalled();
  });

  it("marks a section where the user taps and moves on to the next section", async () => {
    const { onSnapshot } = renderView(song({ filePath: "charts/a.pdf", anchors: [] }));
    await waitFor(() => expect(screen.getByTestId("chart-content")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "chartView.markSections" }));
    // Only sections are offered, never cues.
    expect(screen.getByRole("button", { name: "Estrofa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Coro" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();

    const content = screen.getByTestId("chart-content");
    content.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
    // Second page starts at 612; half of it is 612 + 300.
    await act(async () => {
      fireEvent.click(content, { clientY: 912 });
    });

    expect(api.setSongChartAnchor).toHaveBeenCalledWith("song-1", "verse", 1, 0.5);
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(screen.getByRole("button", { name: "Coro" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not take taps as anchors while not editing", async () => {
    renderView(song({ filePath: "charts/a.pdf", anchors: [] }));
    await waitFor(() => expect(screen.getByTestId("chart-content")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chart-content"), { clientY: 100 });
    expect(api.setSongChartAnchor).not.toHaveBeenCalled();
  });

  it("scrolls to the anchor of the section playing", async () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
    renderView(
      song({ filePath: "charts/a.pdf", anchors: [{ markerId: "chorus", page: 1, y: 0.5 }] }),
      22,
    );

    // 612 + 300 = 912, minus 8% of the 300 px viewport.
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 888 })),
    );
  });

  it("releases the parsed PDF when the view goes away", async () => {
    const { unmount } = renderView(song({ filePath: "charts/a.pdf", anchors: [] }));
    await waitFor(() => expect(screen.getByTestId("chart-content")).toBeTruthy());
    unmount();
    expect(pdf.destroy).toHaveBeenCalled();
  });
});
