import * as desktopApi from "../transport/desktopApi";

import { useChartSourceStore, type ChartSourceState } from "./chartSourceStore";
import { toPcoError } from "./pcoErrors";

/**
 * Every chart-source action, defined once (plan smart-chart-import, D15). The
 * views only call these: Live, Setlist, Compact and mobile share them.
 */
export type ChartSourceApi = Pick<typeof desktopApi, "getPcoStatus" | "signInPco" | "signOutPco">;

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

  return { refreshStatus, connect, disconnect };
}

export type ChartSourceHandlers = ReturnType<typeof createChartSourceHandlers>;

export const chartSourceHandlers = createChartSourceHandlers({
  api: desktopApi,
  store: useChartSourceStore,
});
