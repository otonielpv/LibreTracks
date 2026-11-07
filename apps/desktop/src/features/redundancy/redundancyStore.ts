import { create } from "zustand";

import type { RedundancyStatus } from "./redundancyApi";

/**
 * Redundancy as the UI sees it, fed by `redundancy:status` (4 Hz at most).
 * Narrow selectors below: the transport bar only re-renders when the lock
 * flips, not on every offset update.
 */
export type RedundancyStoreState = {
  status: RedundancyStatus | null;
  detailOpen: boolean;
  /** Short notice after a refused local order («this machine is the backup»). */
  notice: string | null;
  /** When the main was lost (ms since epoch), for the banner's timer. */
  mainLostAt: number | null;
  setStatus: (status: RedundancyStatus) => void;
  openDetail: () => void;
  closeDetail: () => void;
  showNotice: (notice: string) => void;
  clearNotice: () => void;
};

export const INITIAL_REDUNDANCY_STATE = {
  status: null,
  detailOpen: false,
  notice: null,
  mainLostAt: null,
} satisfies Partial<RedundancyStoreState>;

export const useRedundancyStore = create<RedundancyStoreState>((set, get) => ({
  ...INITIAL_REDUNDANCY_STATE,
  setStatus: (status) => {
    const previous = get().status;
    const lostNow = status.role === "backup" && status.state === "mainLost";
    const wasLost = previous?.role === "backup" && previous.state === "mainLost";
    set({
      status,
      mainLostAt: lostNow ? (wasLost ? get().mainLostAt : Date.now()) : null,
    });
  },
  openDetail: () => set({ detailOpen: true }),
  closeDetail: () => set({ detailOpen: false }),
  showNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),
}));

/** The backup follows its main: only the follower moves the transport. */
export function selectTransportLocked(state: RedundancyStoreState): boolean {
  const status = state.status;
  return (
    status?.role === "backup" && (status.state === "following" || status.state === "armed")
  );
}

export function selectMainName(state: RedundancyStoreState): string | null {
  return state.status?.otherName ?? null;
}
