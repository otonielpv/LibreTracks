import { create } from "zustand";

import type { PcoErrorInfo, PcoStatus } from "../transport/desktopApi";

/**
 * The Planning Center account as the UI shows it. Only state: every action is
 * in `chartSourceHandlers.ts`. Reset between tests in `src/test/testUtils.tsx`.
 */
export type ChartSourceState = {
  status: PcoStatus | null;
  connecting: boolean;
  /** The last failure, typed when it came from `libretracks-pco`. */
  error: PcoErrorInfo | string | null;
};

export const INITIAL_CHART_SOURCE_STATE: ChartSourceState = {
  status: null,
  connecting: false,
  error: null,
};

export const useChartSourceStore = create<ChartSourceState>(() => ({ ...INITIAL_CHART_SOURCE_STATE }));
