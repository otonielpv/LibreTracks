import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";

const flags = vi.hoisted(() => ({ chartSources: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

const api = vi.hoisted(() => ({
  getPcoStatus: vi.fn(),
  getPcoArrangement: vi.fn(),
  setSongRegionChart: vi.fn(),
  isGuestMirrorMode: vi.fn(() => false),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useSongStore } from "../transport/songStore";
import { useRedundancyStore } from "../redundancy/redundancyStore";
import { chartSourceSongMenuItems } from "./chartSourceSongMenu";
import { useChartImportStore } from "./chartImportStore";
import { INITIAL_CHART_SOURCE_STATE, useChartSourceStore } from "./chartSourceStore";
import { PlanImportButton } from "./PlanImportButton";
import { usePlanImportStore } from "./planImportStore";

const imported: SongChart = {
  text: "{section: Coro}\n[C]Luz\n",
  links: [],
  source: { provider: "planningCenter", songId: "s1", arrangementId: "a1", importedHash: "x" },
};
const region = (chart: SongChart | null = null) =>
  ({ id: "r1", name: "Canción", startSeconds: 0, endSeconds: 60, key: null, transposeSemitones: 0, chart }) as unknown as SongRegionSummary;
const t = (key: string) => key;

beforeEach(() => {
  flags.chartSources = true;
  for (const mock of Object.values(api)) mock.mockReset();
  api.isGuestMirrorMode.mockReturnValue(false);
  useRedundancyStore.setState({ status: null });
  useChartImportStore.setState({ session: null });
  usePlanImportStore.setState({ open: false });
  useChartSourceStore.setState({ ...INITIAL_CHART_SOURCE_STATE });
  useSongStore.setState({
    song: { regions: [region()], sectionMarkers: [{ id: "c", name: "Coro", startSeconds: 0, kind: "chorus" }] } as unknown as SongView,
  });
});
afterEach(cleanup);

describe("the song menu entries", () => {
  it("offers to import, and to update only an imported chart", () => {
    expect(chartSourceSongMenuItems(region(), t).map((item) => item.label)).toEqual(["chartSources.menu.import"]);
    expect(chartSourceSongMenuItems(region(imported), t).map((item) => item.label)).toEqual([
      "chartSources.menu.import",
      "chartSources.menu.refresh",
    ]);
  });

  it("opens the import for that song with its section markers", () => {
    chartSourceSongMenuItems(region(imported), t)[1].onSelect();
    const session = useChartImportStore.getState().session;
    expect(session).toMatchObject({ mode: "refresh", chart: imported, region: { id: "r1" } });
    expect(session?.markers.map((marker) => marker.id)).toEqual(["c"]);
    expect(session?.onSave).toBeUndefined();
  });

  it("is not there with the flag off, for a network guest or a backup", () => {
    flags.chartSources = false;
    expect(chartSourceSongMenuItems(region(), t)).toEqual([]);
    flags.chartSources = true;
    api.isGuestMirrorMode.mockReturnValue(true);
    expect(chartSourceSongMenuItems(region(), t)).toEqual([]);
    api.isGuestMirrorMode.mockReturnValue(false);
    useRedundancyStore.setState({ status: { role: "backup" } as never });
    expect(chartSourceSongMenuItems(region(), t)).toEqual([]);
  });
});

describe("the plan button in the setlist", () => {
  it("shows with the account connected and opens the plan import", async () => {
    api.getPcoStatus.mockResolvedValue({ configured: true, state: "connected", account: null, error: null });
    render(<PlanImportButton />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "chartSources.plan.open" }));
    });
    expect(usePlanImportStore.getState().open).toBe(true);
  });

  it("hides without a connected account", async () => {
    api.getPcoStatus.mockResolvedValue({ configured: true, state: "disconnected", account: null, error: null });
    render(<PlanImportButton />);
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
  });
});
