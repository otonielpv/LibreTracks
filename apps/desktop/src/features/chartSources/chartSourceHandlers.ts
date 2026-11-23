import { buildRefreshReview, type RefreshResult } from "@libretracks/shared/charts/chartRefresh";
import { planningCenterToImported } from "@libretracks/shared/charts/importedChart";
import {
  buildImportReview,
  finalizeImport,
  isClearReview,
  type ImportReview,
} from "@libretracks/shared/charts/chartImportReview";
import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

import * as desktopApi from "../transport/desktopApi";

import { useChartSourceStore, type ChartSourceState } from "./chartSourceStore";
import { toPcoError } from "./pcoErrors";

/**
 * Every chart-source action, defined once (plan smart-chart-import, D15). The
 * views only call these: Live, Setlist, Compact and mobile share them.
 */
export type ChartSourceApi = Pick<
  typeof desktopApi,
  | "getPcoStatus"
  | "signInPco"
  | "signOutPco"
  | "searchPcoSongs"
  | "getPcoArrangements"
  | "getPcoArrangement"
  | "getPcoServiceTypes"
  | "getPcoUpcomingPlans"
  | "getPcoPlanItems"
  | "matchPcoTitles"
>;

/** One song of a plan paired with a song of the session. */
export type PlanPair = { item: desktopApi.PcoPlanItem; regionId: string };

/** A pair once its arrangement is read and matched: ready to review. */
export type PlanEntry = PlanPair & {
  review: ImportReview | null;
  clear: boolean;
  /** Why it could not be prepared (no text, not found…). */
  error: unknown;
};

/** What the batch needs to know about a song of the session. */
export type PlanSong = { region: SongRegionSummary; markers: SectionMarkerSummary[] };

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

  const loadServiceTypes = () => api.getPcoServiceTypes();
  const loadPlans = (serviceTypeId: string) => api.getPcoUpcomingPlans(serviceTypeId);
  const loadPlanItems = (serviceTypeId: string, planId: string) => api.getPcoPlanItems(serviceTypeId, planId);

  /** The plan's songs against the session's, by title (Rust `lyrics_match`). */
  function matchPlanTitles(items: readonly desktopApi.PcoPlanItem[], regions: readonly SongRegionSummary[]) {
    return api.matchPcoTitles(
      items.map((item) => ({ id: item.id, title: item.title ?? "" })),
      regions.map((region) => ({ id: region.id, title: region.name })),
    );
  }

  /**
   * Read each pair's arrangement, one request at a time (D17), and match it
   * with the item's own sequence and key. Stops between songs when cancelled.
   */
  async function preparePlan(
    pairs: readonly PlanPair[],
    songFor: (regionId: string) => PlanSong | null,
    options: { isCancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<PlanEntry[]> {
    const entries: PlanEntry[] = [];
    for (const pair of pairs) {
      if (options.isCancelled?.()) break;
      const song = songFor(pair.regionId);
      try {
        if (!song || !pair.item.songId || !pair.item.arrangementId) throw new Error("plan-item-incomplete");
        const arrangement = await api.getPcoArrangement(pair.item.songId, pair.item.arrangementId);
        const imported = planningCenterToImported({ ...arrangement, songTitle: pair.item.title ?? null }, pair.item);
        const review = buildImportReview(imported, song.markers, song.region.key);
        entries.push({ ...pair, review, clear: isClearReview(review), error: null });
      } catch (error) {
        entries.push({ ...pair, review: null, clear: false, error });
      }
      options.onProgress?.(entries.length, pairs.length);
    }
    return entries;
  }

  /**
   * "Apply the clear ones and review the rest" (D13): saves each clear song
   * whole (one chart action each), in order, and returns what is left to
   * review. Cancelling stops between songs, never inside one.
   */
  async function applyClearEntries(
    entries: readonly PlanEntry[],
    save: (regionId: string, chart: SongChart) => Promise<void>,
    options: { isCancelled?: () => boolean } = {},
  ): Promise<{ applied: string[]; remaining: PlanEntry[] }> {
    const applied: string[] = [];
    const remaining: PlanEntry[] = [];
    for (const entry of entries) {
      if (!entry.clear || !entry.review || options.isCancelled?.()) {
        remaining.push(entry);
        continue;
      }
      await save(entry.regionId, finalizeImport(entry.review, { transpose: true, linked: true }));
      applied.push(entry.regionId);
    }
    return { applied, remaining };
  }

  return {
    loadServiceTypes,
    loadPlans,
    loadPlanItems,
    matchPlanTitles,
    preparePlan,
    applyClearEntries,
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
