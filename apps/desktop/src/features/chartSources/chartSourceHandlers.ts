import { buildRefreshReview, type RefreshResult } from "@libretracks/shared/charts/chartRefresh";
import { planningCenterToImported } from "@libretracks/shared/charts/importedChart";
import type { SectionMarkerSummary, SongChart } from "@libretracks/shared/models";

import * as desktopApi from "../transport/desktopApi";

import { useChartSourceStore, type ChartSourceState } from "./chartSourceStore";
import { toPcoError } from "./pcoErrors";

/**
 * Every chart-source action, defined once (plan smart-chart-import, D15). The
 * views only call these: Live, Setlist, Compact and mobile share them.
 */
export type ChartSourceApi = Pick<
  typeof desktopApi,
  "getPcoStatus" | "signInPco" | "signOutPco" | "searchPcoSongs" | "getPcoArrangements" | "getPcoArrangement"
>;

export type ChartSourceStoreApi = {
  getState: () => ChartSourceState;
  setState: (partial: Partial<ChartSourceState>) => void;
};

export type ChartSourceHandlerDeps = {
  api: ChartSourceApi;
  store: ChartSourceStoreApi;
};

export function createChartSourceHandlers({ api, store }: ChartSourceHandlerDeps) {
  /** The sign-in in flight: a second press waits for it instead of opening
   * another browser tab. */
  let signingIn: Promise<void> | null = null;

  async function refreshStatus(): Promise<void> {
    try {
      store.setState({ status: await api.getPcoStatus() });
    } catch (cause) {
      store.setState({ error: toPcoError(cause) });
    }
  }

  function connect(): Promise<void> {
    if (signingIn) return signingIn;
    store.setState({ connecting: true, error: null });
    signingIn = (async () => {
      try {
        await api.signInPco();
        await refreshStatus();
      } catch (cause) {
        store.setState({ error: toPcoError(cause) });
      } finally {
        store.setState({ connecting: false });
        signingIn = null;
      }
    })();
    return signingIn;
  }

  async function disconnect(): Promise<void> {
    try {
      await api.signOutPco();
    } catch (cause) {
      store.setState({ error: toPcoError(cause) });
    }
    await refreshStatus();
  }

  /** Songs whose title contains `query` (a page of Planning Center results). */
  function searchSongs(query: string, page = 0) {
    return api.searchPcoSongs(query, page);
  }

  function loadArrangements(songId: string) {
    return api.getPcoArrangements(songId);
  }

  /** The arrangement read fresh, chart included, right before the review. */
  function loadArrangement(songId: string, arrangementId: string) {
    return api.getPcoArrangement(songId, arrangementId);
  }

  /** Saves through the song's existing chart action (`onChartChange` →
   * `songViewHandlers.setSongChart` → `set_song_region_chart`): one undo step,
   * no parallel write. */
  function applyImport(save: (chart: SongChart) => Promise<void>, chart: SongChart) {
    return save(chart);
  }

  /** The imported chart against its arrangement now (D12). Never saves:
   * the dialog shows the result and the user applies it. */
  async function refreshFromSource(
    chart: SongChart,
    markers: readonly SectionMarkerSummary[],
    songKey: string | null,
    songTitle: string,
  ): Promise<RefreshResult> {
    const source = chart.source;
    if (!source || source.provider !== "planningCenter") throw new Error("chart-not-imported");
    const arrangement = await api.getPcoArrangement(source.songId, source.arrangementId);
    const imported = planningCenterToImported({ ...arrangement, songTitle });
    return buildRefreshReview(chart, imported, markers, songKey);
  }

  return {
    refreshStatus,
    connect,
    disconnect,
    searchSongs,
    loadArrangements,
    loadArrangement,
    applyImport,
    refreshFromSource,
  };
}

export type ChartSourceHandlers = ReturnType<typeof createChartSourceHandlers>;

export const chartSourceHandlers = createChartSourceHandlers({
  api: desktopApi,
  store: useChartSourceStore,
});
